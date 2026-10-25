/**
 * core/config.js - loads settings.json and resolves secrets.
 *
 * - Any string value "ENV:NAME" is replaced with process.env.NAME at boot ("" if unset).
 * - SETTINGS_OVERRIDE (JSON env var) is deep-merged on top (handy on Railway/Render/Actions).
 * - Convenience env overrides: MC_HOST, MC_PORT, MC_VERSION, BOT_USERNAME/MC_USERNAME, BOT_PASSWORD/MC_PASSWORD,
 *   BOT_AUTH_PASSWORD, AI_PROVIDER, DISCORD_GUILD_ID, DISCORD_BRIDGE_CHANNEL_ID.
 * - launcher_accounts.json accounts are appended to settings.accounts.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_PATH = process.env.SETTINGS_PATH || path.join(ROOT, "settings.json");

const { resolveEnv } = require("./util");

function isObj(x) { return x && typeof x === "object" && !Array.isArray(x); }
function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function build() {
  let raw = readJson(SETTINGS_PATH, null);
  if (!raw) throw new Error(`Cannot read/parse ${SETTINGS_PATH}`);
  if (process.env.SETTINGS_OVERRIDE) {
    try { raw = deepMerge(raw, JSON.parse(process.env.SETTINGS_OVERRIDE)); }
    catch (e) { console.warn("[config] SETTINGS_OVERRIDE is not valid JSON:", e.message); }
  }
  const cfg = resolveEnv(raw);
  const env = process.env;

  cfg.server = cfg.server || {};
  if (env.MC_HOST) cfg.server.host = env.MC_HOST;
  if (env.MC_PORT) cfg.server.port = Number(env.MC_PORT);
  if (env.MC_VERSION) cfg.server.version = env.MC_VERSION;
  if (env.AI_PROVIDER && cfg.ai) cfg.ai.primary = env.AI_PROVIDER;
  if (env.DISCORD_GUILD_ID && cfg.discord) cfg.discord.guildId = env.DISCORD_GUILD_ID;
  if (env.DISCORD_BRIDGE_CHANNEL_ID && cfg.discord?.chat_bridge) cfg.discord.chat_bridge.channelId = env.DISCORD_BRIDGE_CHANNEL_ID;

  // Accounts: settings + launcher_accounts.json, normalised.
  const extra = readJson(path.join(ROOT, "launcher_accounts.json"), { accounts: [] }).accounts || [];
  const accounts = [...(cfg.accounts || []), ...extra.map(resolveEnv)];
  if (accounts[0]) {
    if (env.BOT_USERNAME || env.MC_USERNAME) accounts[0].username = env.BOT_USERNAME || env.MC_USERNAME;
    if (env.BOT_PASSWORD || env.MC_PASSWORD) accounts[0].password = env.BOT_PASSWORD || env.MC_PASSWORD;
  }
  const seen = new Set();
  cfg.accounts = accounts
    .filter((a) => a && a.username && a.enabled !== false)
    .map((a, i) => {
      let id = String(a.id || a.username).replace(/[^A-Za-z0-9_-]/g, "_") || `acct${i}`;
      while (seen.has(id)) id += "_";
      seen.add(id);
      return { type: "offline", autoStart: true, ...a, id };
    });
  if (cfg.auto_auth && !cfg.auto_auth.password && env.BOT_AUTH_PASSWORD) cfg.auto_auth.password = env.BOT_AUTH_PASSWORD;
  return cfg;
}

const config = build();

/** Dot-path getter: get("modules.auto_mine.radius", 32) */
function get(p, def) {
  let cur = config;
  for (const k of p.split(".")) { if (cur == null) return def; cur = cur[k]; }
  return cur === undefined ? def : cur;
}

module.exports = { config, get, ROOT, DATA_DIR, SETTINGS_PATH, resolveEnv, deepMerge };
