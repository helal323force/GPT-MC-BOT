/**
 * modules/ai-chat.js - ".ai <question>" in-game chat assistant (service + per-bot listener).
 * Config: ai_chat { enabled, per_player_cooldown_sec (10), global_per_minute (20), memory_messages (10) }
 * - Trigger: /\.ai\b/i anywhere in the message; the question is the text after it.
 * - Limits: 1 reply / player / 10 s and 20 replies / minute globally (in-game only).
 * - Memory: last N messages per player (RAM + SQLite 24 h); cleared when the player leaves.
 * - Reply: "@player <answer>" truncated to Minecraft's 256-char limit.
 */
const database = require("../core/database");
const state = require("../core/state");
const { truncateChat } = require("../core/util");

const TRIGGER = /\.ai\b/i;

/** Pure parser (exported for tests). Returns {kind:"none"|"help"|"ask", question?} */
function parse(message) {
  const m = TRIGGER.exec(message);
  if (!m) return { kind: "none" };
  const before = message.slice(0, m.index).trim();
  const after = message.slice(m.index + 3).trim();
  if (!after && !before) return { kind: "help" };
  return { kind: "ask", question: after || before };
}

class AiChatService {
  constructor(config, ai) {
    this.cfg = config.ai_chat || {};
    this.ai = ai;
    this.mem = new Map();          // "account:player" -> [{role,content}]
    this.playerLast = new Map();   // "account:player" -> ts
    this.window = [];              // global reply timestamps (last minute)
    this.pruner = setInterval(() => { try { database.run("DELETE FROM ai_memory WHERE ts < ?", Date.now() - 86400000); } catch { /* ignore */ } }, 3600000);
    this.pruner.unref();
  }
  stop() { clearInterval(this.pruner); }

  limit(account, player) {
    const now = Date.now(), k = `${account}:${player}`;
    this.window = this.window.filter((t) => now - t < 60000);
    if (now - (this.playerLast.get(k) || 0) < (this.cfg.per_player_cooldown_sec || 10) * 1000) return "player cooldown";
    if (this.window.length >= (this.cfg.global_per_minute || 20)) return "global limit";
    this.playerLast.set(k, now); this.window.push(now);
    if (this.playerLast.size > 500) for (const [kk, t] of this.playerLast) if (now - t > 60000) this.playerLast.delete(kk);
    return null;
  }

  history(account, player) {
    const k = `${account}:${player}`;
    if (!this.mem.has(k)) {
      const rows = database.all("SELECT role,content FROM ai_memory WHERE account=? AND player=? AND ts>? ORDER BY id DESC LIMIT ?", account, player, Date.now() - 86400000, this.cfg.memory_messages || 10).reverse();
      this.mem.set(k, rows);
    }
    return this.mem.get(k);
  }
  remember(account, player, role, content) {
    const h = this.history(account, player), max = this.cfg.memory_messages || 10;
    h.push({ role, content }); while (h.length > max) h.shift();
    database.run("INSERT INTO ai_memory(account,player,role,content,ts) VALUES(?,?,?,?,?)", account, player, role, content.slice(0, 500), Date.now());
  }
  clear(account, player) {
    this.mem.delete(`${account}:${player}`);
    try { database.run("DELETE FROM ai_memory WHERE account=? AND player=?", account, player); } catch { /* ignore */ }
  }

  /** Core ask used by in-game chat, dashboard and Discord. Returns plain answer text. */
  async ask({ account, botName, player, question, source = "game" }) {
    const h = this.history(account, player);
    let prompt = String(question).slice(0, 500);
    if (h.length) prompt = `Recent conversation with ${player}:\n${h.map((m) => `${m.role === "user" ? player : botName}: ${m.content}`).join("\n")}\n\nCurrent message from ${player}: ${prompt}`;
    const res = await this.ai.ask({ system: this.ai.systemPrompt(botName), prompt, meta: { source, account, player }, maxTokens: 160 });
    this.remember(account, player, "user", String(question).slice(0, 300));
    this.remember(account, player, "assistant", res.text.slice(0, 300));
    return res.text;
  }
}

function create(inst) {
  const svc = state.services.aiChat;
  let warned = false;

  async function onChat({ username, message }) {
    if (!svc) return;
    const p = parse(message);
    if (p.kind === "none") return;
    if (!inst.isOnline()) return;
    if (p.kind === "help") { inst.chat(`@${username} Usage: .ai <question>  e.g. .ai how do I find diamonds?`); return; }
    const why = svc.limit(inst.id, username);
    if (why) { inst.addLog(`AI request from ${username} ignored (${why})`, "ai"); return; }
    inst.addLog(`AI question from ${username}: ${p.question}`, "ai");
    try {
      const text = await svc.ask({ account: inst.id, botName: inst.bot.username, player: username, question: p.question, source: "game" });
      const reply = `@${username} ${truncateChat(text, 256 - username.length - 2)}`;
      if (inst.isOnline() && inst.chat(reply)) state.bus.emit("ai_reply", { account: inst.id, username, question: p.question, reply: text });
    } catch (e) {
      if (!warned) { warned = true; inst.addLog(`AI chat unavailable: ${e.message}`, "warn"); setTimeout(() => { warned = false; }, 60000).unref(); }
    }
  }

  return {
    init() {
      inst.listen(inst, "chat", onChat);
      inst.listen(inst, "playerLeftTracked", (name) => svc && svc.clear(inst.id, name));
      inst.listen(inst, "playerLeft", (p) => svc && p?.username && svc.clear(inst.id, p.username));
    },
    stop() {},
  };
}

module.exports = { create, AiChatService, parse };
