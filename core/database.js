/**
 * core/database.js - SQLite (better-sqlite3) init + tiny helpers.
 * Tables: ai_logs, ai_memory, player_sessions, backups, tasks, metrics, events, kv, sessions.
 * File: <DATA_DIR>/bot.sqlite  (set DATA_DIR to a persistent volume in production).
 */
const path = require("path");
const { DATA_DIR } = require("./config");

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT, account TEXT, player TEXT,
  question TEXT, response TEXT, provider TEXT, model TEXT, tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0, ok INTEGER DEFAULT 1, error TEXT);
CREATE INDEX IF NOT EXISTS idx_ai_logs_ts ON ai_logs(ts);
CREATE TABLE IF NOT EXISTS ai_memory(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, player TEXT, role TEXT, content TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_ai_memory ON ai_memory(account, player, ts);
CREATE TABLE IF NOT EXISTS player_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, username TEXT, uuid TEXT,
  joined_at INTEGER, left_at INTEGER, duration_sec INTEGER);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON player_sessions(username, joined_at);
CREATE TABLE IF NOT EXISTS backups(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, ts INTEGER, x REAL, y REAL, z REAL, dimension TEXT,
  health REAL, food REAL, inventory_json TEXT, experience INTEGER);
CREATE INDEX IF NOT EXISTS idx_backups ON backups(account, ts);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE, cron TEXT, delay_sec INTEGER, repeat INTEGER DEFAULT 1,
  action TEXT NOT NULL, params TEXT DEFAULT '{}', account TEXT, enabled INTEGER DEFAULT 1,
  source TEXT DEFAULT 'dashboard', last_run INTEGER);
CREATE TABLE IF NOT EXISTS metrics(
  ts INTEGER, account TEXT, online INTEGER, rss_mb REAL, heap_mb REAL, chat_count INTEGER);
CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(account, ts);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, account TEXT, type TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_events ON events(type, ts);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
`;

function init() {
  if (db) return db;
  const Database = require("better-sqlite3");
  db = new Database(path.join(DATA_DIR, "bot.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

function handle() { if (!db) init(); return db; }
function run(sql, ...params) { return handle().prepare(sql).run(...params); }
function get(sql, ...params) { return handle().prepare(sql).get(...params); }
function all(sql, ...params) { return handle().prepare(sql).all(...params); }

function kvGet(key, def = null) {
  const row = get("SELECT value FROM kv WHERE key = ?", key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return def; }
}
function kvSet(key, value) {
  run("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
}

/** Record a notable event (disconnect, reconnect, kick...) used by analytics. */
function logEvent(account, type, detail = "") {
  try { run("INSERT INTO events(ts,account,type,detail) VALUES(?,?,?,?)", Date.now(), account, type, String(detail).slice(0, 300)); }
  catch { /* analytics must never break the bot */ }
}

function close() { try { db && db.close(); } catch { /* ignore */ } db = null; }

module.exports = { init, handle, run, get, all, kvGet, kvSet, logEvent, close };
