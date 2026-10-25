/**
 * modules/ai-providers.js - Gemini / Groq / OpenAI behind one ask() call (plain REST via axios).
 * Config: settings.ai { enabled, primary, fallbacks[], personality, system_prompt, <provider>{apiKey,model} }
 * - Fallback chain: primary -> fallbacks. 10 s timeout; 429/5xx retried once with exponential backoff.
 * - 60 s cache for identical (system+prompt) requests.
 * - If every provider fails, calls fail fast for an exponentially growing cool-down (max 5 min).
 * - Every request is logged to SQLite (ai_logs): source, player, question, response, tokens, latency.
 */
const axios = require("axios");
const crypto = require("crypto");
const database = require("../core/database");
const { addLog } = require("../logger");

const PRESETS = {
  friendly: "friendly, warm and playful, uses a bit of Bangla + English mix, keeps answers under 200 chars",
  serious: "serious, precise and professional, no jokes, keeps answers under 200 chars",
  funny: "funny and witty, loves puns and Minecraft memes, keeps answers under 200 chars",
  roaster: "sarcastic playful roaster who teases players lightly but never insults seriously, under 200 chars",
  helpful: "patient helpful Minecraft expert giving practical tips and crafting help, under 200 chars",
};

const TIMEOUT_MS = 10000;
const CACHE_MS = 60000;

class AiService {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map();
    this.down = new Map();      // provider -> retry timestamp
    this.failStreak = 0;
    this.pausedUntil = 0;
  }

  providers() {
    const c = this.cfg;
    const order = [c.primary, ...(c.fallbacks || [])].filter((v, i, a) => v && a.indexOf(v) === i);
    return order.filter((n) => c[n]?.apiKey);
  }
  get enabled() { return !!this.cfg.enabled && this.providers().length > 0; }

  personality() { return database.kvGet("ai:personality", this.cfg.personality); }
  setPersonality(text) { database.kvSet("ai:personality", String(text).slice(0, 500)); }
  systemPrompt(botName, extra = "") {
    return `${String(this.cfg.system_prompt || "").replace("{name}", botName)}\nPersonality: ${this.personality()}.\nReply in plain text, no markdown, no newlines, max 200 characters.${extra ? "\n" + extra : ""}`;
  }

  async _call(name, { system, prompt, json, maxTokens, temperature }) {
    const c = this.cfg[name], t0 = Date.now();
    const common = { timeout: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS + 500) };
    if (name === "gemini") {
      const gen = { temperature, maxOutputTokens: maxTokens };
      if (json) gen.responseMimeType = "application/json";
      if (/2\.5-flash/.test(c.model)) gen.thinkingConfig = { thinkingBudget: 0 }; // else thinking eats the token budget
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`,
        { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gen },
        { ...common, headers: { "x-goog-api-key": c.apiKey, "Content-Type": "application/json" } });
      const text = (r.data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      return { text, tokens: r.data.usageMetadata?.totalTokenCount || 0, latency: Date.now() - t0 };
    }
    const url = name === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
    const body = { model: c.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_completion_tokens: maxTokens, temperature };
    if (json) body.response_format = { type: "json_object" };
    const r = await axios.post(url, body, { ...common, headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" } });
    return { text: (r.data.choices?.[0]?.message?.content || "").trim(), tokens: r.data.usage?.total_tokens || 0, latency: Date.now() - t0 };
  }

  /**
   * @param {{prompt:string, system:string, json?:boolean, maxTokens?:number, temperature?:number,
   *          cache?:boolean, meta?:{source?:string, account?:string, player?:string}}} o
   */
  async ask(o) {
    const meta = o.meta || {};
    const now = Date.now();
    if (!this.enabled) throw new Error("AI is disabled or no API key is configured");
    if (now < this.pausedUntil) throw new Error(`AI cooling down for ${Math.ceil((this.pausedUntil - now) / 1000)}s after repeated failures`);

    const key = crypto.createHash("sha1").update(JSON.stringify([o.system, o.prompt, !!o.json])).digest("hex");
    if (o.cache !== false) {
      const hit = this.cache.get(key);
      if (hit && now - hit.ts < CACHE_MS) { this._log(meta, o.prompt, hit.res.text, { ...hit.res, provider: "cache", tokens: 0, latency: 0 }, true); return { ...hit.res, cached: true, tokens: 0 }; }
    }

    const args = { system: o.system, prompt: o.prompt, json: !!o.json, maxTokens: o.maxTokens || 300, temperature: o.temperature ?? 0.8 };
    let order = this.providers();
    const healthy = order.filter((n) => (this.down.get(n) || 0) < now);
    if (healthy.length) order = healthy;
    let lastErr;
    for (const name of order) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await this._call(name, args);
          if (!r.text) throw new Error("empty response");
          const res = { text: r.text, provider: name, model: this.cfg[name].model, tokens: r.tokens, latency: r.latency };
          this.failStreak = 0; this.pausedUntil = 0; this.down.delete(name);
          if (o.cache !== false) { this.cache.set(key, { ts: Date.now(), res }); if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value); }
          this._log(meta, o.prompt, r.text, res, true);
          return res;
        } catch (e) {
          lastErr = e;
          const status = e.response?.status;
          const retryable = status === 429 || (status >= 500 && status < 600);
          if (retryable && attempt === 0) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250)); continue; }
          this.down.set(name, Date.now() + (status === 401 || status === 403 ? 300000 : 20000));
          addLog(`AI ${name} failed (${status || e.code || e.message}); trying next provider`, "warn");
          break;
        }
      }
    }
    this.failStreak++;
    this.pausedUntil = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(this.failStreak, 6));
    this._log(meta, o.prompt, "", { provider: "none", model: "", tokens: 0, latency: 0 }, false, lastErr?.message);
    throw new Error(`All AI providers failed: ${lastErr?.response?.status || lastErr?.message || "unknown"}`);
  }

  _log(meta, question, response, res, ok, error = null) {
    try {
      database.run("INSERT INTO ai_logs(ts,source,account,player,question,response,provider,model,tokens,latency_ms,ok,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        Date.now(), meta.source || "api", meta.account || null, meta.player || null, String(question).slice(0, 2000), String(response).slice(0, 2000),
        res.provider, res.model || "", res.tokens || 0, res.latency || 0, ok ? 1 : 0, error);
      addLog(`AI[${meta.source || "api"}] ${res.provider} ${res.latency}ms ${res.tokens}tok`, "ai");
    } catch { /* logging must not break AI */ }
  }

  recent(limit = 50) { return database.all("SELECT * FROM ai_logs ORDER BY id DESC LIMIT ?", Math.min(200, limit)); }
  stats() {
    const hour = Date.now() - 3600000, day = Date.now() - 86400000;
    return {
      enabled: this.enabled, providers: this.providers(), primary: this.cfg.primary,
      lastHour: database.get("SELECT COUNT(*) n, COALESCE(SUM(tokens),0) t FROM ai_logs WHERE ts>? AND provider!='cache'", hour),
      last24h: database.get("SELECT COUNT(*) n, COALESCE(SUM(tokens),0) t FROM ai_logs WHERE ts>? AND provider!='cache'", day),
      cooldownSec: Math.max(0, Math.ceil((this.pausedUntil - Date.now()) / 1000)),
      personality: this.personality(), presets: PRESETS,
    };
  }
}

module.exports = { AiService, PRESETS };
