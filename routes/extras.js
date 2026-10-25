/**
 * routes/extras.js - API for the v3.1 features. Mounted in index.js BEFORE apiRoutes(), after requireAuth, so it uses the
 * same login / x-api-key protection and the same JSON conventions as routes/api.js ({ok:true,...} or {error:"..."}).
 *
 *   POST /api/autojump        {account?, enabled:boolean}
 *   POST /api/follow          {account?, player, distance?}
 *   POST /api/stopmove        {account?}
 *   GET  /api/task?account=   current task, live detail, last result
 *   GET  /api/grind/resources
 *   POST /api/grind/check     {account?, resource, amount}     read-only pre-flight
 *   POST /api/grind           {account?, resource, amount}
 *   POST /api/house/plan      {account?, size?, material?, x?, y?, z?, allowPartial?}   read-only
 *   POST /api/house           same body - starts building
 *   GET  /api/inventory/items?account=
 *   POST /api/inventory/drop  {account?, name, count, confirmProtected?}
 */
const express = require("express");
const state = require("../core/state");
const database = require("../core/database");
const readWorldMemory = (id) => {
  const v = database.kvGet(`world_memory:${id}`, {});
  return { waypoints: [], explored: [], resources: [], events: [], ...(v && typeof v === "object" ? v : {}) };
};

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    const status = e.status || (/^Bot is not online|Busy with|in progress/i.test(e.message) ? 409 : 400);
    res.status(status).json({ error: e.message, ...(e.requiresConfirm ? { requiresConfirm: true, reason: e.reason } : {}) });
  }
};
const instOf = (req) => {
  const id = req.body?.account || req.query?.account, inst = state.getInstance(id);
  if (!inst) throw Object.assign(new Error(`Unknown account "${id || ""}"`), { status: 404 });
  return inst;
};
const online = (inst) => { if (!inst.isOnline()) throw Object.assign(new Error("Bot is not online"), { status: 409 }); return inst; };
const mod = (inst, name) => { const m = online(inst).modules[name]; if (!m) throw Object.assign(new Error(`Feature "${name}" is disabled in settings.json`), { status: 409 }); return m; };

function extrasRoutes() {
  const r = express.Router();

  // Friend / co-op controls. The selected friend is persisted per bot account.
  r.get("/api/friend", wrap((req, res) => {
    const inst = instOf(req), saved = database.kvGet(`friend:${inst.id}`, { username: null, enabled: false, distance: 3, autoTasks: false });
    res.json({ ok: true, friend: inst.modules.coop?.status() || saved });
  }));
  r.post("/api/friend", wrap((req, res) => {
    const inst = instOf(req), username = String(req.body?.username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('Friend username must be 3-16 letters, numbers, or underscores');
    if (username.toLowerCase() === inst.account.username.toLowerCase()) throw new Error('A bot cannot be its own friend');
    const old = database.kvGet(`friend:${inst.id}`, { username: null, enabled: false, distance: 3, autoTasks: true });
    const next = { ...old, username, enabled: req.body?.enabled !== false, distance: Math.max(2, Math.min(8, Number(req.body?.distance) || 3)) };
    database.kvSet(`friend:${inst.id}`, next);
    if (inst.modules.coop) inst.modules.coop.setFriend(username, next.enabled, next.distance);
    res.json({ ok: true, friend: inst.modules.coop?.status() || next });
  }));
  r.post("/api/friend/enable", wrap((req, res) => {
    const inst = instOf(req), enabled = !!req.body?.enabled;
    const old = database.kvGet(`friend:${inst.id}`, { username: null, enabled: false, distance: 3, autoTasks: true });
    if (enabled && !old.username) throw new Error('Select a friend first');
    old.enabled = enabled; database.kvSet(`friend:${inst.id}`, old);
    if (inst.modules.coop) inst.modules.coop.enable(enabled);
    res.json({ ok: true, friend: inst.modules.coop?.status() || old });
  }));
  r.post("/api/friend/auto-tasks", wrap((req, res) => {
    const inst = instOf(req), old = database.kvGet(`friend:${inst.id}`, { username: null, enabled: false, distance: 3, autoTasks: false });
    old.autoTasks = !!req.body?.enabled; database.kvSet(`friend:${inst.id}`, old);
    if (inst.modules.coop) inst.modules.coop.setAutoTasks(old.autoTasks);
    res.json({ ok: true, autoTasks: old.autoTasks });
  }));

  // Persistent priority task queue; each task has a bounded execution time.
  r.get("/api/queue", wrap((req, res) => {
    const inst = instOf(req), queue = inst.modules.taskQueue;
    if (!queue) throw Object.assign(new Error('Task queue is not initialized; spawn the bot first'), { status: 409 });
    res.json({ ok: true, ...queue.status() });
  }));
  r.post("/api/queue", wrap((req, res) => {
    const inst = instOf(req), queue = inst.modules.taskQueue;
    if (!queue) throw Object.assign(new Error('Task queue is not initialized; spawn the bot first'), { status: 409 });
    const item = queue.enqueue(String(req.body?.name || ''), req.body?.params || {}, req.body?.priority, req.body?.durationSec);
    res.status(201).json({ ok: true, item, ...queue.status() });
  }));
  r.delete("/api/queue/:id", wrap((req, res) => {
    const inst = instOf(req), queue = inst.modules.taskQueue;
    if (!queue) throw Object.assign(new Error('Task queue is not initialized; spawn the bot first'), { status: 409 });
    if (!queue.remove(String(req.params.id))) throw Object.assign(new Error('Queue item not found'), { status: 404 });
    res.json({ ok: true, ...queue.status() });
  }));
  r.delete("/api/queue", wrap((req, res) => {
    const inst = instOf(req), queue = inst.modules.taskQueue;
    if (!queue) throw Object.assign(new Error('Task queue is not initialized; spawn the bot first'), { status: 409 });
    queue.clear(); res.json({ ok: true, ...queue.status() });
  }));


  // Settings backups store the raw settings file (including ENV placeholders, not resolved process secrets).
  r.get("/api/config-backups", wrap((_req, res) => {
    const service = state.services.configBackup;
    if (!service) throw Object.assign(new Error("Config backup service unavailable"), { status: 503 });
    res.json({ ok: true, backups: service.list() });
  }));
  r.post("/api/config-backups", wrap((_req, res) => {
    const service = state.services.configBackup;
    if (!service) throw Object.assign(new Error("Config backup service unavailable"), { status: 503 });
    res.status(201).json({ ok: true, backup: service.backup(), backups: service.list() });
  }));

  // Advanced survival activities and persistent world memory.
  r.get("/api/automation/memory", wrap((req, res) => {
    const inst = instOf(req);
    res.json({ ok: true, memory: readWorldMemory(inst.id) });
  }));
  r.post("/api/automation/waypoint", wrap((req, res) => {
    const inst = instOf(req);
    const name = String(req.body?.name || "waypoint").trim().slice(0, 32) || "waypoint";
    const x = Number(req.body?.x), z = Number(req.body?.z);
    const y = req.body?.y === null || req.body?.y === "" || req.body?.y === undefined ? null : Number(req.body.y);
    if (!Number.isFinite(x) || !Number.isFinite(z) || (y !== null && !Number.isFinite(y))) throw new Error("Valid x and z coordinates are required; y is optional");
    const memory = readWorldMemory(inst.id);
    const waypoint = { name, x, y, z, dimension: inst.bot?.game?.dimension || null, ts: Date.now() };
    memory.waypoints = memory.waypoints.filter(w => String(w.name).toLowerCase() !== name.toLowerCase());
    memory.waypoints.push(waypoint); memory.waypoints = memory.waypoints.slice(-500);
    database.kvSet(`world_memory:${inst.id}`, memory);
    res.status(201).json({ ok: true, waypoint, memory });
  }));
  r.delete("/api/automation/memory", wrap((req, res) => {
    const inst = instOf(req);
    const memory = { waypoints: [], explored: [], resources: [], events: [] };
    database.kvSet(`world_memory:${inst.id}`, memory);
    res.json({ ok: true, memory });
  }));
  r.post("/api/automation/waypoint/go", wrap(async (req, res) => {
    const inst = online(instOf(req));
    const name = String(req.body?.name || "").trim().toLowerCase();
    const waypoint = readWorldMemory(inst.id).waypoints.find(w => String(w.name).toLowerCase() === name);
    if (!waypoint) throw Object.assign(new Error("Waypoint not found"), { status: 404 });
    if (waypoint.dimension && inst.bot?.game?.dimension && waypoint.dimension !== inst.bot.game.dimension) throw new Error("Waypoint is in a different dimension; cross-dimension travel is not automated");
    await inst.startActivity("move", { x: waypoint.x, y: waypoint.y, z: waypoint.z });
    res.json({ ok: true, waypoint, task: inst.state.task });
  }));
  r.post("/api/automation/run", wrap(async (req, res) => {
    const inst = online(instOf(req));
    const allowed = new Set(["branchmine", "loot", "smelt", "store", "explore", "base", "boss", "guard"]);
    const name = String(req.body?.name || "");
    if (!allowed.has(name)) throw new Error("Unknown advanced activity");
    const params = req.body?.params && typeof req.body.params === "object" && !Array.isArray(req.body.params) ? req.body.params : {};
    await inst.startActivity(name, params);
    res.json({ ok: true, task: inst.state.task, name });
  }));
  r.post("/api/automation/stop", wrap((req, res) => {
    const inst = online(instOf(req));
    const stopped = inst.stopActivity();
    res.json({ ok: true, stopped: stopped || null });
  }));

  r.post("/api/autojump", wrap((req, res) => {
    if (typeof req.body?.enabled !== "boolean") throw new Error("enabled (true/false) is required");
    const inst = instOf(req); inst.setAutoJump(req.body.enabled);
    res.json({ ok: true, enabled: inst.runtime.autoJump });
  }));

  r.post("/api/follow", wrap(async (req, res) => {
    const inst = instOf(req);
    await inst.startActivity("follow", { player: String(req.body?.player || ""), distance: req.body?.distance });
    res.json({ ok: true, task: inst.state.task });
  }));

  r.post("/api/stopmove", wrap((req, res) => {
    const inst = instOf(req), was = inst.stopMovement();
    res.json({ ok: true, stopped: was || null });
  }));

  r.get("/api/task", wrap((req, res) => {
    const inst = instOf(req), s = inst.statusPayload();
    res.json({ task: s.task, detail: s.detail, lastResult: s.lastResult, rest: s.rest, nav: s.nav });
  }));

  r.get("/api/grind/resources", wrap((req, res) => res.json({ resources: Object.entries(require("../modules/grinder").RESOURCES).map(([key, d]) => ({ key, blocks: d.blocks })) })));
  r.post("/api/grind/check", wrap(async (req, res) => { const plan = await mod(instOf(req), "grind").prepare(req.body || {}); res.json({ ok: true, plan }); }));
  r.post("/api/grind", wrap(async (req, res) => {
    const inst = instOf(req); mod(inst, "grind");
    await inst.startActivity("grind", { resource: req.body?.resource, amount: req.body?.amount });
    res.json({ ok: true, task: inst.state.task });
  }));

  r.post("/api/house/plan", wrap((req, res) => res.json({ ok: true, plan: mod(instOf(req), "house").plan(req.body || {}) })));
  r.post("/api/house", wrap(async (req, res) => {
    const inst = instOf(req); mod(inst, "house");
    const { account, ...params } = req.body || {};
    await inst.startActivity("house", params);
    res.json({ ok: true, task: inst.state.task });
  }));

  r.get("/api/inventory/items", wrap((req, res) => res.json({ items: mod(instOf(req), "invtools").list() })));
  r.post("/api/inventory/drop", wrap(async (req, res) => {
    const out = await mod(instOf(req), "invtools").drop({ name: req.body?.name, count: req.body?.count, confirmProtected: req.body?.confirmProtected === true });
    res.json({ ok: true, ...out });
  }));

  return r;
}

module.exports = { extrasRoutes };
