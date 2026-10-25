/**
 * modules/scheduler.js - cron + delay task scheduler (tasks persisted in SQLite).
 * Config: settings.tasks[] seeds the DB on boot (matched by label); the dashboard can add/remove/toggle more.
 *   { label, cron:"0 0 * * *" | delay_sec:3600, repeat:true, action, params:{}, account?, enabled? }
 * Actions: cmd, say, walk_to, mine, farm, fish, chop, branchmine, loot, smelt, store, explore, base, boss, guard, idle, stop_brain, start_brain
 * Without "account" a task runs on every online instance. Delay tasks repeat unless repeat:false.
 */
const cron = require("node-cron");
const database = require("../core/database");
const state = require("../core/state");
const { addLog } = require("../logger");

const ACTIONS = ["cmd", "say", "walk_to", "mine", "farm", "fish", "chop", "branchmine", "loot", "smelt", "store", "explore", "base", "boss", "guard", "idle", "stop_brain", "start_brain"];

class Scheduler {
  constructor(config) {
    this.config = config;
    this.crons = new Map();   // id -> cron task
    this.next = new Map();    // id -> next run ts (delay tasks)
    this.ticker = null;
  }

  init() {
    for (const t of this.config.tasks || []) {
      if (!t.label || !ACTIONS.includes(t.action) || (!t.cron && !t.delay_sec)) { addLog(`[Scheduler] skipping invalid settings task ${JSON.stringify(t.label)}`, "warn"); continue; }
      if (database.get("SELECT id FROM tasks WHERE label=?", t.label)) continue;
      database.run("INSERT INTO tasks(label,cron,delay_sec,repeat,action,params,account,enabled,source) VALUES(?,?,?,?,?,?,?,?,'settings')",
        t.label, t.cron || null, t.delay_sec || null, t.repeat === false ? 0 : 1, t.action, JSON.stringify(t.params || {}), t.account || null, t.enabled === false ? 0 : 1);
    }
    for (const t of this.list()) if (t.enabled) this._schedule(t);
    this.ticker = setInterval(() => this._tick(), 1000);
    addLog(`[Scheduler] ${this.list().filter((t) => t.enabled).length} active task(s)`, "info");
  }

  stop() {
    clearInterval(this.ticker);
    for (const c of this.crons.values()) c.stop();
    this.crons.clear(); this.next.clear();
  }

  _row(r) { return { ...r, params: JSON.parse(r.params || "{}"), enabled: !!r.enabled, repeat: !!r.repeat }; }
  list() { return database.all("SELECT * FROM tasks ORDER BY id").map((r) => this._row(r)); }

  validate(t) {
    if (!t.label || !/^[\w .-]{1,40}$/.test(t.label)) throw new Error("label required (1-40 chars)");
    if (!ACTIONS.includes(t.action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
    if (t.cron) { if (!cron.validate(t.cron)) throw new Error("invalid cron expression"); }
    else if (!(Number(t.delay_sec) >= 5)) throw new Error("provide a cron expression or delay_sec >= 5");
    if (t.params && typeof t.params !== "object") throw new Error("params must be an object");
  }

  add(t) {
    this.validate(t);
    if (database.get("SELECT id FROM tasks WHERE label=?", t.label)) throw new Error("a task with that label already exists");
    const r = database.run("INSERT INTO tasks(label,cron,delay_sec,repeat,action,params,account,enabled,source) VALUES(?,?,?,?,?,?,?,?,'dashboard')",
      t.label, t.cron || null, t.cron ? null : Number(t.delay_sec), t.repeat === false ? 0 : 1, t.action, JSON.stringify(t.params || {}), t.account || null, t.enabled === false ? 0 : 1);
    const row = this._row(database.get("SELECT * FROM tasks WHERE id=?", r.lastInsertRowid));
    if (row.enabled) this._schedule(row);
    return row;
  }

  update(id, patch) {
    const cur = database.get("SELECT * FROM tasks WHERE id=?", id);
    if (!cur) throw new Error("task not found");
    const merged = { ...this._row(cur), ...patch };
    this.validate(merged);
    database.run("UPDATE tasks SET label=?,cron=?,delay_sec=?,repeat=?,action=?,params=?,account=?,enabled=? WHERE id=?",
      merged.label, merged.cron || null, merged.cron ? null : Number(merged.delay_sec), merged.repeat === false ? 0 : 1, merged.action, JSON.stringify(merged.params || {}), merged.account || null, merged.enabled === false ? 0 : 1, id);
    this._unschedule(id);
    const row = this._row(database.get("SELECT * FROM tasks WHERE id=?", id));
    if (row.enabled) this._schedule(row);
    return row;
  }

  remove(id) {
    this._unschedule(id);
    return database.run("DELETE FROM tasks WHERE id=?", id).changes > 0;
  }

  _unschedule(id) { this.crons.get(id)?.stop(); this.crons.delete(id); this.next.delete(id); }
  _schedule(t) {
    this._unschedule(t.id);
    if (t.cron) this.crons.set(t.id, cron.schedule(t.cron, () => this.run(t.id), { timezone: process.env.TZ || undefined }));
    else if (t.delay_sec) this.next.set(t.id, Date.now() + t.delay_sec * 1000);
  }

  _tick() {
    const now = Date.now();
    for (const [id, at] of this.next) {
      if (now < at) continue;
      const row = database.get("SELECT * FROM tasks WHERE id=?", id);
      if (!row || !row.enabled) { this.next.delete(id); continue; }
      this.run(id);
      if (row.repeat) this.next.set(id, now + row.delay_sec * 1000);
      else { this.next.delete(id); database.run("UPDATE tasks SET enabled=0 WHERE id=?", id); }
    }
  }

  run(id) {
    const row = database.get("SELECT * FROM tasks WHERE id=?", id);
    if (!row) return;
    const t = this._row(row);
    database.run("UPDATE tasks SET last_run=? WHERE id=?", Date.now(), id);
    const targets = t.account ? [state.getInstance(t.account)].filter(Boolean) : [...state.instances.values()];
    addLog(`[Scheduler] running "${t.label}" (${t.action})`, "control");
    for (const inst of targets) {
      if (!inst.isOnline() && !["stop_brain", "start_brain"].includes(t.action)) { inst.addLog(`Task "${t.label}" skipped: bot offline`, "warn"); continue; }
      try { Scheduler.execute(inst, t.action, t.params); } catch (e) { inst.addLog(`Task "${t.label}" failed: ${e.message}`, "error"); }
    }
  }

  static execute(inst, action, p = {}) {
    switch (action) {
      case "cmd": return inst.runCommand(p.command);
      case "say": return inst.chat(p.message, { force: true });
      // v3.1: scheduler tasks rank below tasks the user started by hand (they log "Busy with ..." instead of cancelling them)
      case "walk_to": return inst.runActivity("move", p, { source: "scheduler" });
      case "mine": case "farm": case "fish": case "chop": case "branchmine": case "loot": case "smelt": case "store": case "explore": case "base": case "boss": case "guard": return inst.runActivity(action, p, { source: "scheduler" });
      case "idle": return inst.stopActivity({ source: "scheduler" });
      case "stop_brain": return inst.setBrain(false);
      case "start_brain": return inst.setBrain(true);
      default: throw new Error(`unknown action ${action}`);
    }
  }
}

module.exports = { Scheduler, ACTIONS };
