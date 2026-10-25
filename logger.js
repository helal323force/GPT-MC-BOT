/**
 * logger.js - central log sink (extended in v3).
 *
 * addLog(message, type = "info", account = "system")
 *   type: info | warn | error | chat | success | control | ai
 * Keeps a 300-line ring buffer per account (same size as v2), prints ANSI-coloured
 * lines to the console and emits "log" events so Socket.IO / xterm.js can stream them.
 */
const { EventEmitter } = require("events");

const MAX_LINES = 300;
const events = new EventEmitter();
events.setMaxListeners(50);

// ANSI colour per log type (also used by the xterm.js terminal on the dashboard)
const ANSI = {
  info: "\x1b[37m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  chat: "\x1b[36m",
  success: "\x1b[32m",
  control: "\x1b[35m",
  ai: "\x1b[95m",
  reset: "\x1b[0m",
};

const buffers = new Map(); // account -> entry[]

function addLog(message, type = "info", account = "system") {
  if (!ANSI[type] || type === "reset") type = "info";
  const entry = { ts: Date.now(), type, account, msg: String(message) };
  let buf = buffers.get(account);
  if (!buf) buffers.set(account, (buf = []));
  buf.push(entry);
  if (buf.length > MAX_LINES) buf.shift();

  const time = new Date(entry.ts).toISOString().substring(11, 19);
  const tag = account === "system" ? "" : `[${account}] `;
  console.log(`${ANSI[type]}${time} ${tag}${entry.msg}${ANSI.reset}`);
  try { events.emit("log", entry); } catch { /* listeners must never break logging */ }
  return entry;
}

/** Last n log entries for an account (plus system entries merged by time). */
function getLogs(n = 100, account = null) {
  n = Math.max(1, Math.min(MAX_LINES, Number(n) || 100));
  let list = [];
  if (account) list = [...(buffers.get(account) || []), ...(buffers.get("system") || [])];
  else for (const b of buffers.values()) list.push(...b);
  list.sort((a, b) => a.ts - b.ts);
  return list.slice(-n);
}

/** Format an entry as an ANSI string (used by REST + terminal). */
function formatAnsi(e) {
  const time = new Date(e.ts).toISOString().substring(11, 19);
  return `${ANSI[e.type] || ANSI.info}${time} ${e.msg}${ANSI.reset}`;
}

module.exports = { addLog, getLogs, formatAnsi, events, ANSI, MAX_LINES };
