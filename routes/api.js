/**
 * routes/api.js - JSON API used by the dashboard (all routes require login or x-api-key).
 * Also provides backward-compatible POST /start and POST /stop.
 */
const express = require("express");
const state = require("../core/state");
const database = require("../core/database");
const { config } = require("../core/config");
const { Scheduler } = require("../modules/scheduler");
const { BotInstance } = require("../core/bot-instance");

const ok = (res, data = {}) => res.json({ ok: true, ...data });
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
const need = (req) => {
  const id = req.body?.account || req.query?.account;
  const inst = state.getInstance(id);
  if (!inst) { const e = new Error(`Unknown account "${id || ""}"`); e.status = 404; throw e; }
  return inst;
};
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

function apiRoutes() {
  const r = express.Router();

  // ----- persistent dashboard profiles -----
  r.get("/api/profiles", wrap((_req, res) => {
    const profiles = database.kvGet("dynamic_profiles", []);
    res.json({ profiles: (Array.isArray(profiles) ? profiles : []).map((p) => ({ id: p.id, username: p.username, type: p.type || "offline", host: p.host || config.server.host, port: Number(p.port) || Number(config.server.port) || 25565, version: p.version || config.server.version || "auto", autoStart: !!p.autoStart, autoAuth: !!p.autoAuth?.enabled })) });
  }));
  r.post("/api/profiles", wrap(async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const type = String(req.body?.type || "offline").toLowerCase();
    const host = String(req.body?.host || config.server.host || "").trim();
    const port = Number(req.body?.port || config.server.port || 25565);
    const version = String(req.body?.version || config.server.version || "auto").trim();
    if (!host || host.length > 253 || /\s/.test(host)) throw new Error("Enter a valid server host/IP");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535");
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error("Username must be 3-16 letters, numbers, or underscores");
    if (!["offline", "microsoft"].includes(type)) throw new Error("type must be offline or microsoft");
    const profiles = database.kvGet("dynamic_profiles", []);
    const list = Array.isArray(profiles) ? profiles : [];
    if (config.accounts.some((a) => String(a.username).toLowerCase() === username.toLowerCase()) || [...state.instances.values()].some((i) => i.account.username.toLowerCase() === username.toLowerCase())) throw new Error("That username is already configured");
    const idBase = username.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    let id = idBase, n = 2;
    while (state.instances.has(id) || list.some((p) => p.id === id)) id = `${idBase}_${n++}`;
    const aa = req.body?.autoAuth || {};
    const autoAuth = { enabled: !!(aa.enabled ?? req.body?.autoAuthEnabled), password: String(aa.password ?? req.body?.autoAuthPassword ?? ""), registerCommand: String(aa.registerCommand || req.body?.registerCommand || "/register {password} {password}"), loginCommand: String(aa.loginCommand || req.body?.loginCommand || "/login {password}") };
    const profile = { id, username, type, host, port, version, autoAuth, enabled: true, autoStart: !!req.body?.autoStart, createdAt: Date.now() };
    list.push(profile); database.kvSet("dynamic_profiles", list); config.accounts.push(profile);
    state.instances.set(id, new BotInstance(profile, config));
    state.services.socket?.broadcastInstances();
    res.status(201).json({ ok: true, profile: { id, username, type, host, port, version, autoStart: profile.autoStart, autoAuth: !!autoAuth.enabled } });
  }));
  r.delete("/api/profiles/:id", wrap(async (req, res) => {
    const id = String(req.params.id || ""), profiles = database.kvGet("dynamic_profiles", []);
    const list = Array.isArray(profiles) ? profiles : [], profile = list.find((p) => p.id === id);
    if (!profile) { const e = new Error("Profile not found or it is a settings.json account"); e.status = 404; throw e; }
    const inst = state.instances.get(id);
    if (inst) { await inst.stop("Profile deleted"); inst.destroy(); state.instances.delete(id); }
    database.kvSet("dynamic_profiles", list.filter((p) => p.id !== id));
    const idx = config.accounts.findIndex((a) => a.id === id); if (idx >= 0) config.accounts.splice(idx, 1);
    state.services.socket?.broadcastInstances(); ok(res, { deleted: id });
  }));

  r.put("/api/profiles/:id", wrap((req, res) => {
    const id = String(req.params.id || "");
    const profiles = database.kvGet("dynamic_profiles", []);
    const list = Array.isArray(profiles) ? profiles : [];
    const profile = list.find(p => p.id === id);
    if (!profile) { const e = new Error("Profile not found or it is not dashboard-created"); e.status = 404; throw e; }
    if (req.body?.autoStart !== undefined && typeof req.body.autoStart !== "boolean") throw new Error("autoStart must be true or false");
    if (req.body?.type !== undefined) { const type = String(req.body.type).toLowerCase(); if (!["offline", "microsoft"].includes(type)) throw new Error("type must be offline or microsoft"); profile.type = type; }
    if (req.body?.host !== undefined) { const host = String(req.body.host).trim(); if (!host || host.length > 253 || /\s/.test(host)) throw new Error("Enter a valid server host/IP"); profile.host = host; }
    if (req.body?.port !== undefined) { const port = Number(req.body.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535"); profile.port = port; }
    if (req.body?.version !== undefined) profile.version = String(req.body.version || "auto").trim();
    if (req.body?.autoAuth !== undefined || req.body?.autoAuthEnabled !== undefined) { const a = req.body.autoAuth || {}; profile.autoAuth = { enabled: !!(a.enabled ?? req.body.autoAuthEnabled), password: String(a.password ?? req.body.autoAuthPassword ?? profile.autoAuth?.password ?? ""), registerCommand: String(a.registerCommand || req.body.registerCommand || "/register {password} {password}"), loginCommand: String(a.loginCommand || req.body.loginCommand || "/login {password}") }; }
    if (req.body?.autoStart !== undefined) profile.autoStart = req.body.autoStart;
    database.kvSet("dynamic_profiles", list);
    const acc = config.accounts.find(a => a.id === id);
    if (acc) Object.assign(acc, { type: profile.type, host: profile.host, port: profile.port, version: profile.version, autoAuth: profile.autoAuth, autoStart: profile.autoStart });
    const inst = state.instances.get(id); if (inst) { inst.account = acc || profile; inst.config = { ...inst.config, server: { ...inst.config.server, host: profile.host || config.server.host, port: Number(profile.port) || config.server.port, version: profile.version || config.server.version }, auto_auth: profile.autoAuth ? { enabled: !!profile.autoAuth.enabled, password: profile.autoAuth.password, register_command: profile.autoAuth.registerCommand, login_command: profile.autoAuth.loginCommand } : config.auto_auth }; }
    res.json({ ok: true, profile: { id: profile.id, username: profile.username, type: profile.type || "offline", host: profile.host || config.server.host, port: Number(profile.port) || config.server.port, version: profile.version || "auto", autoStart: !!profile.autoStart, autoAuth: !!profile.autoAuth?.enabled } });
  }));

  r.get("/api/diagnostics", wrap((_req, res) => {
    const modules = config.modules || {};
    const instances = [...state.instances.values()].map((i) => ({ id: i.id, username: i.account.username, status: i.state.status, online: i.isOnline(), lastError: i.state.lastError || null, task: i.state.task || "idle", reconnects: i.state.reconnects || 0 }));
    const enabled = Object.entries(modules).filter(([, value]) => value && typeof value === "object" && value.enabled).map(([name]) => name);
    res.json({ ok: true, checkedAt: Date.now(), server: { host: config.server.host, port: config.server.port, version: config.server.version || "auto" }, instances, enabledModules: enabled, services: { ai: !!state.services.ai?.enabled, discord: !!config.discord?.enabled, scheduler: !!state.services.scheduler, socket: !!state.services.socket }, storage: { dataDirConfigured: !!process.env.DATA_DIR, persistentProfiles: (database.kvGet("dynamic_profiles", []) || []).length } });
  }));

  // ----- instances -----
  r.get("/api/instances", wrap((req, res) => res.json({ instances: [...state.instances.values()].map((i) => ({ ...i.summary(), status: i.statusPayload() })) })));
  r.get("/api/status", wrap((req, res) => res.json(need(req).statusPayload())));
  const startFn = wrap(async (req, res) => { const t = req.body?.account === "all" ? [...state.instances.values()] : [need(req)]; for (const i of t) await i.start(); ok(res); });
  const stopFn = wrap(async (req, res) => { const t = req.body?.account === "all" ? [...state.instances.values()] : [need(req)]; for (const i of t) await i.stop("Stopped from dashboard"); ok(res); });
  r.post("/start", startFn); r.post("/stop", stopFn); r.post("/api/start", startFn); r.post("/api/stop", stopFn);
  r.post("/api/restart", wrap(async (req, res) => { await need(req).restart(); ok(res); }));
  r.get("/api/config", wrap((req, res) => {
    const m = config.modules || {};
    res.json({
      accounts: config.accounts.map((a) => ({ id: a.id, username: a.username })), server: `${config.server.host}:${config.server.port}`,
      modules: { mine: !!m.auto_mine?.enabled, farm: !!m.auto_farm?.enabled, fish: !!m.auto_fish?.enabled, chop: !!m.auto_chop?.enabled, trade: !!m.auto_trade?.enabled, build: !!m.auto_build?.enabled },
      ai: { enabled: !!state.services.ai?.enabled }, bridge: !!config.discord?.chat_bridge?.enabled, version: state.version,
      warnDefaultPassword: !process.env.DASHBOARD_PASSWORD,
    });
  }));

  // ----- chat / inventory / players -----
  r.post("/api/chat", wrap((req, res) => {
    const msg = String(req.body?.message || "").trim();
    if (!msg || msg.length > 256) throw new Error("message must be 1-256 chars");
    need(req).chat(msg, { force: true }); ok(res);
  }));
  r.get("/api/inventory", wrap((req, res) => res.json(need(req).getInventory())));
  r.get("/api/players", wrap((req, res) => res.json({ players: need(req).getPlayers() })));
  r.get("/api/players/history", wrap((req, res) => {
    const u = String(req.query.username || "");
    if (!u) throw new Error("username required");
    res.json({ username: u, sessions: database.all("SELECT account,username,uuid,joined_at,left_at,duration_sec FROM player_sessions WHERE username=? ORDER BY joined_at DESC LIMIT 20", u) });
  }));

  // ----- activities / waypoint / brain -----
  r.post("/api/move", wrap((req, res) => {
    const x = num(req.body.x), y = num(req.body.y), z = num(req.body.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error("x and z are required numbers");
    need(req).runActivity("move", { x, y, z }); ok(res);
  }));
  r.post("/api/activity", wrap((req, res) => {
    const inst = need(req), name = String(req.body.name || "");
    if (name === "idle" || name === "stop") { inst.stopActivity(); return ok(res); }
    inst.runActivity(name, req.body.params || {}); ok(res);
  }));
  r.post("/api/brain", wrap((req, res) => { need(req).setBrain(!!req.body.enabled); ok(res); }));
  r.get("/api/rpg", wrap((req, res) => {
    const inst = need(req), controls = state.services.rpgControls?.[inst.id];
    if (!controls) throw new Error("RPG controls plugin unavailable. Install plugins/rpg-controls.js and redeploy.");
    const survival = state.services.rpgSurvival?.[inst.id];
    res.json({ ok: true, ...controls.status(), survivalEnabled: survival ? survival.status().enabled : false });
  }));
  r.post("/api/rpg", wrap(async (req, res) => {
    const inst = need(req), controls = state.services.rpgControls?.[inst.id];
    if (!controls) throw new Error("RPG controls plugin unavailable. Install plugins/rpg-controls.js and redeploy.");
    const action = String(req.body?.action || "");
    if (action === "follow") { const player = String(req.body?.player || "").trim(); if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) throw new Error("Enter a valid Minecraft username"); controls.follow(player); }
    else if (action === "stop") controls.stop();
    else if (action === "grind") { const mode = String(req.body?.mode || ""); if (!['logs','ores'].includes(mode)) throw new Error("Unknown grind type"); controls.grind(mode); }
    else if (action === "stopgrind") controls.stopgrind();
    else if (action === "jump_toggle") controls.jump(!controls.status().jumpEnabled);
    else if (action === "survival_toggle") { const survival = state.services.rpgSurvival?.[inst.id]; if (!survival) throw new Error("RPG Survival plugin unavailable. Install plugins/rpg-survival.js and redeploy."); survival.toggle(); }
    else if (action === "buildhouse") controls.buildhouse();
    else if (action === "drop") { const item = String(req.body?.item || "").trim(); const amount = Number(req.body?.amount); if (!/^[a-z0-9_]{1,64}$/i.test(item)) throw new Error("Invalid item ID"); if (!Number.isInteger(amount) || amount < 1 || amount > 2304) throw new Error("Amount must be 1-2304"); await controls.drop(item, amount); }
    else if (action === "dropall") await controls.dropall();
    else throw new Error("Unknown RPG action");
    const survival = state.services.rpgSurvival?.[inst.id];
    ok(res, { ...controls.status(), survivalEnabled: survival ? survival.status().enabled : false });
  }));

  // ----- AI -----
  r.post("/api/ai/ask", wrap(async (req, res) => {
    const q = String(req.body?.question || "").trim();
    if (!q) throw new Error("question required");
    const svc = state.services.aiChat, inst = need(req);
    if (!svc || !state.services.ai?.enabled) throw new Error("AI is not configured (set an API key)");
    const text = await svc.ask({ account: inst.id, botName: inst.account.username, player: String(req.body.player || "dashboard"), question: q, source: "dashboard" });
    res.json({ ok: true, answer: text });
  }));
  r.get("/api/ai/logs", wrap((req, res) => res.json({ logs: state.services.ai?.recent(Math.min(200, Number(req.query.limit) || 50)) || [] })));
  r.get("/api/ai/stats", wrap((req, res) => res.json(state.services.ai?.stats() || { enabled: false })));
  r.post("/api/ai/personality", wrap((req, res) => {
    const ai = state.services.ai; if (!ai) throw new Error("AI disabled");
    const text = String(req.body?.personality || "").trim();
    if (text.length < 5) throw new Error("personality too short");
    ai.setPersonality(text); ok(res);
  }));

  // ----- tasks -----
  const sched = () => { if (!state.services.scheduler) throw new Error("scheduler unavailable"); return state.services.scheduler; };
  r.get("/api/tasks", wrap((req, res) => res.json({ tasks: sched().list() })));
  r.post("/api/tasks", wrap((req, res) => res.json({ ok: true, task: sched().add(req.body) })));
  r.patch("/api/tasks/:id", wrap((req, res) => res.json({ ok: true, task: sched().update(Number(req.params.id), req.body) })));
  r.post("/api/tasks/:id/run", wrap((req, res) => { sched().run(Number(req.params.id)); ok(res); }));
  r.delete("/api/tasks/:id", wrap((req, res) => { if (!sched().remove(Number(req.params.id))) throw new Error("task not found"); ok(res); }));

  // ----- builder -----
  r.post("/api/build", express.json({ limit: "12mb" }), wrap((req, res) => {
    const inst = need(req);
    if (!req.body.schematic) throw new Error("schematic (base64) required");
    inst.runActivity("build", { data: req.body.schematic, x: req.body.x, y: req.body.y, z: req.body.z }); ok(res);
  }));

  // ----- backups -----
  r.get("/api/backups", wrap((req, res) => {
    const id = req.query.account || state.defaultInstance()?.id;
    res.json({ backups: database.all("SELECT id,account,ts,x,y,z,dimension,health,food,experience,inventory_json FROM backups WHERE account=? ORDER BY ts DESC LIMIT 100", id).map((b) => ({ ...b, inventory: JSON.parse(b.inventory_json || "[]"), inventory_json: undefined })) });
  }));
  r.post("/api/restore/:id", wrap(async (req, res) => {
    const row = database.get("SELECT * FROM backups WHERE id=?", Number(req.params.id));
    if (!row) throw new Error("backup not found");
    const inst = state.getInstance(row.account);
    if (!inst?.modules.backup) throw new Error("bot is offline or backups are disabled");
    res.json({ ok: true, ...(await inst.modules.backup.restore(row)) });
  }));

  // ----- analytics -----
  r.get("/api/analytics", wrap((req, res) => {
    const acct = req.query.account || state.defaultInstance()?.id, now = Date.now(), hour = 3600000, day = 86400000;
    const since = now - 24 * hour;
    const upRows = database.all("SELECT ts/? AS h, AVG(online)*100 AS pct FROM metrics WHERE account=? AND ts>? GROUP BY h", hour, acct, since);
    const upMap = new Map(upRows.map((x) => [x.h, x.pct]));
    const baseH = Math.floor(now / hour), uptime = [];
    for (let h = baseH - 23; h <= baseH; h++) uptime.push({ ts: h * hour, pct: upMap.has(h) ? Math.round(upMap.get(h)) : null });
    const rcRows = database.all("SELECT ts/? AS d, COUNT(*) AS n FROM events WHERE account=? AND type='reconnect' AND ts>? GROUP BY d", day, acct, now - 7 * day);
    const rcMap = new Map(rcRows.map((x) => [x.d, x.n])), baseD = Math.floor(now / day), reconnects = [];
    for (let d = baseD - 6; d <= baseD; d++) reconnects.push({ ts: d * day, n: rcMap.get(d) || 0 });
    let mem = database.all("SELECT ts, rss_mb, heap_mb FROM metrics WHERE account=? AND ts>? ORDER BY ts", acct, since);
    const step = Math.ceil(mem.length / 240) || 1; mem = mem.filter((_, i) => i % step === 0);
    const chRows = database.all("SELECT ts/? AS h, SUM(chat_count) AS n FROM metrics WHERE account=? AND ts>? GROUP BY h", hour, acct, since);
    const chMap = new Map(chRows.map((x) => [x.h, x.n])), chat = [];
    for (let h = baseH - 23; h <= baseH; h++) chat.push({ ts: h * hour, n: chMap.get(h) || 0 });
    res.json({ account: acct, uptime, reconnects, memory: mem, chat });
  }));

  r.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
  return r;
}

module.exports = { apiRoutes, Scheduler };
