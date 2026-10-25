/**
 * modules/tracker.js - player join/leave tracker.
 * Config (settings.tracker): enabled, notify_join_leave, watch_list[], ops[]
 * Writes sessions to SQLite (player_sessions), emits Socket.IO "player_event".
 * Note: the Minecraft protocol does not reveal OP status, so "ops" is a configured list.
 */
const database = require("../core/database");
const state = require("../core/state");

function create(inst) {
  const bot = inst.bot;
  const cfg = () => inst.config.tracker || {};

  function joined(p) {
    if (!p?.username || p.username === bot.username) return;
    const open = database.get("SELECT id FROM player_sessions WHERE account=? AND username=? AND left_at IS NULL", inst.id, p.username);
    if (open) return;
    database.run("INSERT INTO player_sessions(account,username,uuid,joined_at) VALUES(?,?,?,?)", inst.id, p.username, p.uuid || null, Date.now());
    const c = cfg();
    const watched = (c.watch_list || []).includes(p.username), isOp = (c.ops || []).includes(p.username);
    inst.addLog(`${p.username} joined${isOp ? " (OP)" : ""}`, "info");
    inst.emitSocket("player_event", { type: "join", username: p.username, watched, op: isOp });
    state.bus.emit("player_join", { account: inst.id, username: p.username });
    if (watched || isOp) inst.notify("watch_alert", `${isOp ? "OP" : "Watched player"} **${p.username}** joined`, { color: "warn" });
    else if (c.notify_join_leave) inst.notify("player_join", `${p.username} joined`, { color: "info" });
  }

  function left(p) {
    if (!p?.username) return;
    closeSession(p.username);
    inst.addLog(`${p.username} left`, "info");
    inst.emitSocket("player_event", { type: "leave", username: p.username });
    inst.emit("playerLeftTracked", p.username);
    if (cfg().notify_join_leave) inst.notify("player_leave", `${p.username} left`, { color: "info" });
  }

  function closeSession(username) {
    const now = Date.now();
    database.run("UPDATE player_sessions SET left_at=?, duration_sec=CAST((?-joined_at)/1000 AS INTEGER) WHERE account=? AND username=? AND left_at IS NULL", now, now, inst.id, username);
  }

  return {
    init() {
      inst.listen(bot, "playerJoined", joined);
      inst.listen(bot, "playerLeft", left);
      for (const p of Object.values(bot.players || {})) joined(p); // players already online at spawn
    },
    /** Close every open session (bot disconnected - we can no longer observe them). */
    stop() {
      const now = Date.now();
      try { database.run("UPDATE player_sessions SET left_at=?, duration_sec=CAST((?-joined_at)/1000 AS INTEGER) WHERE account=? AND left_at IS NULL", now, now, inst.id); } catch { /* ignore */ }
    },
  };
}
module.exports = { create };
