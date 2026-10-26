/**
 * core/bot-instance.js - one mineflayer bot per account.
 *
 * Owns ALL per-account state (status, timers, listeners, pathfinder, modules).
 * Lifecycle: start() -> connect -> spawn -> modules attach -> (end) -> detach -> reconnect.
 * Leak safety: every bot/instance listener is registered through listen(), every timer through
 * every()/after(); _detach() removes/clears all of them on each disconnect and destroy() on exit.
 *
 * Config used: server, auto_auth, anti_afk, chat_messages, reconnect, modules.*, combat, ai*, proxy
 *
 * v3.1: all pathfinder access goes through this.nav (modules/nav.js) - see that file for why.
 */
const EventEmitter = require("events");
const path = require("path");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const mcDataLoader = require("minecraft-data");
const logger = require("../logger");
const state = require("./state");
const database = require("./database");
const { DATA_DIR } = require("./config");
const { truncateChat, sleep, parseReason } = require("./util");
const { createAntiKick } = require("../modules/anti-kick");
const { Nav, NavCancelled } = require("../modules/nav");

// Who started a task. A lower-ranked source can never replace a higher-ranked one (v3.1).
const SOURCE_RANK = { brain: 1, scheduler: 2, user: 3 };

const noop = () => {};

class BotInstance extends EventEmitter {
  constructor(account, config) {
    super();
    this.setMaxListeners(50);
    this.id = account.id;
    this.account = account;
    this.config = { ...config, server: { ...config.server, host: account.host || config.server.host, port: Number(account.port) || config.server.port, version: account.version || config.server.version }, auto_auth: account.autoAuth ? { enabled: !!account.autoAuth.enabled, password: account.autoAuth.password || account.password, register_command: account.autoAuth.registerCommand || "/register {password} {password}", login_command: account.autoAuth.loginCommand || "/login {password}" } : config.auto_auth };
    this.bot = null;
    this.mcData = null;
    this.movements = null;
    this.stopped = true;
    this.destroyed = false;
    this._spawned = false;
    this._ended = true;
    this._listeners = [];
    this._botTimers = new Set();
    this._lifeTimers = new Set();
    this._reconnectTimer = null;
    this._attempts = 0;
    this._lastKickAt = 0;
    this._lastAuthAt = 0;
    this._recentSent = new Map();
    this._dedupe = new Map();
    this._chatCount = 0;
    this.modules = {};
    this.activities = {};
    this.activeActivity = null;
    this.combatBusy = false;
    this.chatLog = [];
    this.events = [];
    this.flags = { antiAfkMutedUntil: 0, chatMutedUntil: 0, chatMessagesOffUntil: 0, eating: false };
    this.nav = new Nav(this);
    this.paused = false;            // survival "rest": low-priority tasks wait while true
    this.taskDetail = null;         // live progress object of the running task
    this.lastResult = null;         // outcome of the last finished task
    this._activityRank = 0; this._activitySource = null;
    this._runP = null; this._runId = 0; this._sleepers = new Set();
    // Runtime toggles survive reconnects (but not restarts, except brain which is kv-persisted)
    this.runtime = {
      brainEnabled: database.kvGet(`brain:${this.id}`, !!config.ai_brain?.enabled),
      brainReqs: [], brainWarned: false,
      autoJump: database.kvGet(`autojump:${this.id}`, !!config.auto_jump?.enabled),
    };
    this.state = {
      status: "offline", startedAt: null, connectedAt: null, spawnedAt: null, reconnects: 0,
      lastError: null, lastKick: null, task: "idle", health: 20, food: 20, position: null,
      dimension: null, proxy: null, version: null,
    };
    this.antiKick = createAntiKick(this);
    this._viewTick = 0;
  }

  // ---------- helpers ----------
  get services() { return state.services; }
  isOnline() { return !!this.bot && this.state.status === "online" && !!this.bot.entity; }
  canAct() { return this.isOnline() && !this.combatBusy; }
  /** Sleep that stopActivity()/disconnect can wake early, so stopped task loops end promptly. */
  sleep(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this._sleepers.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this._sleepers.add(done);
    });
  }
  _wakeSleepers() { for (const w of [...this._sleepers]) w(); }
  addLog(msg, type = "info") { return logger.addLog(msg, type, this.id); }
  emitSocket(event, data) { try { this.services.socket?.emitTo(this.id, event, data); } catch { /* ignore */ } }
  notify(event, text, opts) { try { this.services.discord?.notify(event, `[${this.id}] ${text}`, opts); } catch { /* ignore */ } }
  pushEvent(text) { this.events.push({ ts: Date.now(), text }); if (this.events.length > 20) this.events.shift(); }
  async waitReady() { while (this.isOnline() && (this.combatBusy || this.paused)) await sleep(400); }

  /** Tracked listener (auto-removed in _detach). */
  listen(emitter, event, fn) {
    const wrapped = (...a) => {
      try {
        const r = fn(...a);
        if (r && typeof r.catch === "function") r.catch((e) => this.addLog(`${event} handler: ${e.message}`, "error"));
      } catch (e) { this.addLog(`${event} handler: ${e.message}`, "error"); }
    };
    emitter.on(event, wrapped);
    this._listeners.push([emitter, event, wrapped]);
    return wrapped;
  }
  /** Remove a timer created with every()/after() before it fires (used when a feature is toggled off). */
  clearTimer(t) { clearTimeout(t); this._botTimers.delete(t); this._lifeTimers.delete(t); }
  /** Tracked interval. scope "bot" is cleared on every disconnect, "life" only on stop(). */
  every(fn, ms, scope = "bot") {
    const t = setInterval(() => { try { const r = fn(); if (r && r.catch) r.catch((e) => this.addLog(`timer: ${e.message}`, "error")); } catch (e) { this.addLog(`timer: ${e.message}`, "error"); } }, ms);
    (scope === "life" ? this._lifeTimers : this._botTimers).add(t);
    return t;
  }
  after(fn, ms, scope = "bot") {
    const set = scope === "life" ? this._lifeTimers : this._botTimers;
    const t = setTimeout(() => { set.delete(t); try { const r = fn(); if (r && r.catch) r.catch((e) => this.addLog(`timeout: ${e.message}`, "error")); } catch (e) { this.addLog(`timeout: ${e.message}`, "error"); } }, ms);
    set.add(t);
    return t;
  }

  // ---------- lifecycle ----------
  async start() {
    if (this.destroyed) return false;
    if (["connecting", "online"].includes(this.state.status)) return false;
    this.stopped = false;
    this._attempts = 0;
    clearTimeout(this._reconnectTimer);
    this._connect();
    return true;
  }

  _setStatus(s) {
    if (this.state.status === s) return;
    this.state.status = s;
    this.emitSocket("status", this.statusPayload());
    this.services.socket?.broadcastInstances();
    state.bus.emit("instance_status", { account: this.id, status: s });
  }

  _connect() {
    const cfg = this.config;
    this._ended = false;
    this._spawned = false;
    this.state.startedAt = Date.now();
    this._setStatus("connecting");
    const opts = {
      host: cfg.server.host, port: Number(cfg.server.port) || 25565,
      username: this.account.username,
      version: cfg.server.version || false,
      auth: this.account.type === "microsoft" ? "microsoft" : "offline",
      hideErrors: false, checkTimeoutInterval: 60000,
      profilesFolder: path.join(DATA_DIR, "auth", this.id),
      onMsaCode: (c) => {
        const msg = `Microsoft login: open ${c.verification_uri} and enter code ${c.user_code}`;
        this.addLog(msg, "warn");
        this.notify("connect", msg, { color: "warn" });
      },
    };
    try {
      const px = this.services.proxy?.pick(this, { afterKick: Date.now() - this._lastKickAt < 15000 });
      if (px) { opts.connect = px.connect(opts.host, opts.port); opts.agent = px.agent; this.state.proxy = px.label; this.addLog(`Using proxy ${px.label}`, "info"); }
      else this.state.proxy = null;
      this.addLog(`Connecting to ${opts.host}:${opts.port} as ${opts.username}`, "control");
      const bot = mineflayer.createBot(opts);
      this.bot = bot;
      bot.loadPlugin(pathfinder);
      this._attachCore(bot);
    } catch (e) {
      this.state.lastError = e.message;
      this.addLog(`Connect failed: ${e.message}`, "error");
      this._onEnd(e.message);
    }
  }

  _attachCore(bot) {
    this.listen(bot, "login", () => { this.state.connectedAt = Date.now(); this.state.version = bot.version; this.addLog("Logged in", "success"); });
    this.listen(bot, "spawn", () => this._onSpawn());
    this.listen(bot, "death", () => {
      this.addLog("Bot died", "warn"); this.pushEvent("died"); this.notify("death", "Bot died; attempting respawn recovery", { color: "error" }); database.logEvent(this.id, "death");
      // Preserve the existing connection/login flow. Ask Mineflayer to respawn only if the
      // same connection is still alive and the server has not already respawned the bot.
      this.after(() => {
        if (this.bot !== bot || !this.isOnline() || bot.health > 0 || typeof bot.respawn !== "function") return;
        try { bot.respawn(); this.addLog("Auto-recovery: respawn requested", "control"); }
        catch (e) { this.addLog(`Auto-recovery respawn failed: ${e.message}`, "warn"); }
      }, 1800);
    });
    this.listen(bot, "health", () => this._onHealth());
    this.listen(bot, "kicked", (reason) => {
      const text = parseReason(reason);
      this.state.lastKick = text; this.state.lastError = text; this._lastKickAt = Date.now();
      this.addLog(`Kicked: ${text}`, "error");
      this.pushEvent(`kicked: ${text.slice(0, 80)}`);
      database.logEvent(this.id, "kick", text);
      this.notify("kick", `Kicked: ${text}`, { color: "error", tts: true });
      this.antiKick.record(text);
    });
    this.listen(bot, "error", (e) => { this.state.lastError = e.message; this.addLog(`Error: ${e.message}`, "error"); });
    this.listen(bot, "end", (reason) => this._onEnd(String(reason || "connection ended")));
    this.listen(bot, "chat", (u, m) => this._handleChat(u, m, "mc"));
    this.listen(bot, "whisper", (u, m) => this._handleChat(u, m, "mc"));
    this.listen(bot, "messagestr", (msg) => this._onMessageStr(msg));
    this.listen(bot, "playerJoined", (p) => { this.emitPlayers(); this.emit("playerJoined", p); });
    this.listen(bot, "playerLeft", (p) => { this.emitPlayers(); this.emit("playerLeft", p); });
  }

  _onSpawn() {
    const bot = this.bot;
    if (!bot || this._spawned) return;
    this._spawned = true;
    this._ended = false;
    try {
      this.mcData = mcDataLoader(bot.version);
      this.movements = new Movements(bot);
      this.movements.canDig = true;
      this.movements.allowSprinting = true;
      // More capable general navigation: doors and small parkour gaps are common
      // reasons bots fail to reach otherwise valid destinations.
      this.movements.canOpenDoors = true;
      this.movements.allowParkour = true;
      this.movements.maxDropDown = 4;
      // Profile for follow/combat/survival/house: never digs or scaffolds, so it cannot wreck builds or burn materials.
      this.safeMovements = new Movements(bot);
      Object.assign(this.safeMovements, { canDig: false, allow1by1towers: false, allowParkour: false, maxDropDown: 3, scafoldingBlocks: [], scaffoldingBlocks: [] });
      this.nav.profile = null;
      bot.pathfinder.setMovements(this.movements);
    } catch (e) { this.addLog(`Pathfinder init failed: ${e.message}`, "error"); }
    this.state.spawnedAt = Date.now();
    this._setStatus("online");
    this.addLog(`Spawned (MC ${bot.version})`, "success");
    this.notify("connect", `Connected to ${this.config.server.host}:${this.config.server.port}`, { color: "success" });
    database.logEvent(this.id, "spawn");
    this.after(() => { this._attempts = 0; }, 60000); // stable for 60s => reset backoff
    this._setupAutoAuth();
    this._setupAntiAfk();
    this._setupChatMessages();
    this.every(() => this._tick(), 1000);
    this._attachModules();
    this.emit("spawned");
  }

  _onHealth() {
    const bot = this.bot; if (!bot) return;
    this.state.health = bot.health; this.state.food = bot.food;
    this.emitSocket("health", { health: bot.health, food: bot.food, saturation: bot.foodSaturation });
    if (bot.health > 0 && bot.health <= 6 && Date.now() - (this._lastLowHp || 0) > 60000) {
      this._lastLowHp = Date.now();
      this.notify("low_health", `Low health: ${bot.health.toFixed(1)}/20`, { color: "warn", tts: true });
    }
  }

  /** Connection ended (kick, network error, server stop, or our own stop()). */
  _onEnd(reason) {
    if (this._ended) return;
    this._ended = true;
    this._detach();
    this.state.lastError = this.state.lastError || reason;
    if (this.stopped) { this._setStatus("stopped"); return; }
    this._setStatus("offline");
    this.addLog(`Disconnected: ${reason}`, "warn");
    database.logEvent(this.id, "disconnect", reason);
    this.notify("disconnect", `Disconnected: ${reason}`, { color: "warn", tts: true });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const r = this.config.reconnect || {};
    if (!r.enabled || this.destroyed) return;
    this._attempts++;
    let delay = (r.delay_sec || 10) * 1000;
    if (r.backoff !== false) delay = Math.min((r.max_delay_sec || 300) * 1000, delay * 2 ** Math.min(this._attempts - 1, 6));
    if (this.antiKick.isMuted()) delay = Math.max(delay, 60000);
    this.state.reconnects++;
    database.logEvent(this.id, "reconnect", `attempt ${this._attempts}`);
    this.addLog(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._attempts})`, "control");
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => { if (!this.stopped && !this.destroyed) this._connect(); }, delay);
  }

  /** Stop all activity & remove every bot-scoped listener/timer. */
  _detach() {
    this.nav.reset();
    this.paused = false; this.flags.eating = false;
    this.activeActivity = null; this._activityRank = 0; this._activitySource = null; this.taskDetail = null;
    this._wakeSleepers();
    for (const m of Object.values(this.modules)) { try { m.stop && m.stop(); } catch { /* ignore */ } }
    this.modules = {}; this.activities = {}; this.activeActivity = null; this.combatBusy = false;
    for (const [em, ev, fn] of this._listeners) { try { em.removeListener(ev, fn); } catch { /* ignore */ } }
    this._listeners = [];
    for (const t of this._botTimers) clearTimeout(t);
    this._botTimers.clear();
    const bot = this.bot;
    if (bot) {
      try { bot.pathfinder && bot.pathfinder.stop(); } catch { /* ignore */ }
      try { bot.clearControlStates(); } catch { /* ignore */ }
      bot.on("error", noop); // late errors after quit must not crash the process
      try { bot._client && bot._client.on("error", noop); } catch { /* ignore */ }
      try { bot.quit(); } catch { /* ignore */ }
      try { bot.end(); } catch { /* ignore */ }
    }
    this.bot = null; this._spawned = false; this.state.task = "idle";
  }

  async stop(reason = "Stopped") {
    this.stopped = true;
    clearTimeout(this._reconnectTimer);
    for (const t of this._lifeTimers) clearTimeout(t);
    this._lifeTimers.clear();
    this._ended = true;
    this._detach();
    this._setStatus("stopped");
    this.addLog(reason, "control");
  }

  async restart() { await this.stop("Restarting"); await sleep(1500); return this.start(); }

  destroy() {
    this.destroyed = true;
    this.stop("Destroyed");
    this.antiKick.destroy();
    this.removeAllListeners();
  }

  // ---------- modules ----------
  _attachModules() {
    const c = this.config, m = c.modules || {};
    const defs = [
      ["survival", "../modules/survival", c.survival?.enabled !== false, false],
      ["combat", "../modules/combat", c.combat?.enabled, false],
      ["tracker", "../modules/tracker", c.tracker?.enabled, false],
      ["backup", "../modules/backup", c.backup?.enabled, false],
      ["aiChat", "../modules/ai-chat", c.ai?.enabled && c.ai_chat?.enabled, false],
      ["brain", "../modules/ai-brain", c.ai?.enabled, false],
      ["move", "../modules/waypoint", true, true],
      ["mine", "../modules/miner", m.auto_mine?.enabled, true],
      ["farm", "../modules/farmer", m.auto_farm?.enabled, true],
      ["fish", "../modules/fisher", m.auto_fish?.enabled, true],
      ["chop", "../modules/chopper", m.auto_chop?.enabled, true],
      ["trade", "../modules/trader", m.auto_trade?.enabled, true],
      ["build", "../modules/builder", m.auto_build?.enabled, true],
      ["follow", "../modules/follow", true, true],
      ["grind", "../modules/grinder", m.auto_grind?.enabled !== false, true],
      ["house", "../modules/housebuilder", m.auto_house?.enabled !== false, true],
      ["autojump", "../modules/autojump", true, false],
      ["invtools", "../modules/invtools", true, false],
      ["coop", "../modules/coop", true, false],
      ["taskQueue", "../modules/task-queue", true, false],
      ["advanced", "../modules/advanced-survival", true, false],
    ];
    for (const [name, file, enabled, isActivity] of defs) {
      if (!enabled) continue;
      try {
        const mod = require(file).create(this);
        this.modules[name] = mod;
        if (isActivity) this.activities[name] = mod;
        mod.init && mod.init();
      } catch (e) { this.addLog(`Module ${name} failed to load: ${e.message}`, "error"); }
    }
    // Advanced activities share the same activity runner and navigation coordinator.
    if (this.modules.advanced) {
      for (const [name, run] of Object.entries(this.modules.advanced.activities || {})) {
        this.activities[name] = { run, halt: () => this.modules.advanced.halt(name) };
      }
    }
    const plugins = this.services.plugins;
    if (plugins) this.modules.plugins = plugins.initFor(this);
  }

  /** Pre-flight (async checks) then run. Throws with a meaningful message if the task cannot start. */
  async startActivity(name, params = {}, opts = {}) {
    if (name === "move" && params.follow) { name = "follow"; params = { player: String(params.follow) }; }
    const act = this.activities[name];
    if (!this.isOnline()) throw new Error("Bot is not online");
    if (!act) throw new Error(`Activity "${name}" is unavailable (disabled in settings or bot offline)`);
    this._checkRank(opts.source);
    const plan = act.prepare ? await act.prepare(params) : null;
    return this.runActivity(name, plan ? { ...params, _plan: plan } : params, opts);
  }

  _checkRank(source = "user") {
    if (this.activeActivity && (SOURCE_RANK[source] || 3) < this._activityRank) {
      throw new Error(`Busy with "${this.activeActivity}" (started by ${this._activitySource}); stop it first`);
    }
  }

  /** Run one activity at a time (mine, farm, fish, chop, trade, build, move, follow, grind, house). */
  runActivity(name, params = {}, opts = {}) {
    if (!this.isOnline()) throw new Error("Bot is not online");
    if (name === "move" && params.follow) { name = "follow"; params = { player: String(params.follow) }; }
    const act = this.activities[name];
    if (!act) throw new Error(`Activity "${name}" is unavailable (disabled in settings or bot offline)`);
    const source = opts.source || "user";
    this._checkRank(source);
    this.stopActivity();
    this.activeActivity = name;
    this._activityRank = SOURCE_RANK[source] || 3; this._activitySource = source;
    this.taskDetail = null;
    this._setTask(name);
    // Serialise: a new run only starts after the previous run loop has actually exited (they can share state).
    const prev = this._runP, id = ++this._runId;
    const p = (async () => {
      if (prev) await Promise.race([prev.catch(() => {}), sleep(10000)]);
      if (this._runId !== id || this.activeActivity !== name || !this.isOnline()) return;
      await act.run(params);
    })();
    this._runP = p;
    p.catch((e) => { if (e && e.cancelled) return; this.finishTask(name, false, e.message); });
    return true;
  }

  /** Stop the current task. With opts.source, a lower-ranked source cannot stop a higher-ranked task. */
  stopActivity(opts = {}) {
    if (opts.source) this._checkRank(opts.source);
    const cur = this.activeActivity;
    this.activeActivity = null; this._activityRank = 0; this._activitySource = null; this._runId++;
    if (cur) {
      try { this.activities[cur]?.halt(); } catch { /* ignore */ }
      this.nav.cancel(cur);          // only this task's navigation is cancelled
    }
    this._wakeSleepers();
    if (!this.nav.isActive()) { try { this.bot?.clearControlStates(); } catch { /* ignore */ } }
    this.taskDetail = null;
    this._setTask("idle");
    return cur;
  }
  /** Used by chat/dashboard "stop moving": stops whatever task is running and releases movement. */
  stopMovement() { return this.stopActivity(); }

  activityDone(name) { if (this.activeActivity === name) { this.activeActivity = null; this._activityRank = 0; this._activitySource = null; this.taskDetail = null; this._setTask("idle"); } }
  /** A task reports its real outcome (never claim success unless the goal was met). */
  finishTask(name, ok, message, extra = {}) {
    this.lastResult = { task: name, ok: !!ok, message, ts: Date.now(), ...extra };
    try { this.modules.advanced?.rememberEvent({ kind: "task-result", task: name, ok: !!ok, message: String(message || "").slice(0, 240) }); } catch { /* memory must never break task completion */ }
    this.notify("task", `${name}: ${message}`, { color: ok ? "success" : "warn" });
    this.addLog(`${name}: ${message}`, ok ? "success" : "warn");
    this.emitSocket("task_result", this.lastResult);
    this.activityDone(name);
  }
  setTaskDetail(detail) { this.taskDetail = detail; }
  _setTask(t) { if (this.state.task !== t) { this.state.task = t; this.emitSocket("task", { task: t }); } }

  setAutoJump(on) {
    this.runtime.autoJump = !!on;
    database.kvSet(`autojump:${this.id}`, !!on);
    this.modules.autojump?.setEnabled(!!on);
    this.addLog(`Auto jump ${on ? "enabled" : "disabled"}`, "control");
    this.emitSocket("status", this.statusPayload());
  }

  /** Navigate via the coordinator. Only valid while a task is running (owner = that task). y == null => XZ goal. */
  async goto(x, y, z, range = 2, timeoutMs = 30000) {
    if (!this.bot) throw new NavCancelled("task", "offline");
    if (!this.activeActivity) throw new NavCancelled("task", "no active task");
    const goal = y == null ? new goals.GoalXZ(x, z) : new goals.GoalNear(x, y, z, range);
    return this.nav.goto(this.activeActivity, goal, { timeoutMs });
  }

  /** Walk over to nearby dropped items so they get picked up. */
  async collectDrops(radius = 8, max = 8) {
    const bot = this.bot; if (!bot) return;
    const items = Object.values(bot.entities)
      .filter((e) => (e.name === "item" || e.objectType === "Item") && e.position && e.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      .slice(0, max);
    const task = this.activeActivity;
    for (const it of items) {
      if (!this.isOnline() || this.activeActivity !== task) return;
      try { await this.goto(it.position.x, it.position.y, it.position.z, 1, 8000); } catch { /* skip */ }
    }
  }

  // ---------- chat ----------
  /** Send chat. Automated callers are blocked while anti-kick has chat muted; force bypasses. */
  chat(msg, { force = false } = {}) {
    if (!this.isOnline()) throw new Error("Bot is not online");
    if (!force && Date.now() < this.flags.chatMutedUntil) { this.addLog("Chat muted by anti-kick; message dropped", "warn"); return false; }
    const text = truncateChat(msg, 256);
    if (!text) return false;
    this.bot.chat(text);
    this._recentSent.set(text, Date.now());
    this.addLog(`> ${text}`, "chat");
    this.pushChat({ username: this.bot.username, message: text, source: "self" });
    return true;
  }
  runCommand(cmd) { const c = String(cmd).trim(); return this.chat(c.startsWith("/") ? c : "/" + c, { force: true }); }

  pushChat(entry) {
    const e = { ts: Date.now(), ...entry };
    this.chatLog.push(e); if (this.chatLog.length > 100) this.chatLog.shift();
    this._chatCount++;
    this.emitSocket("chat", e);
  }

  _handleChat(username, message, source) {
    const bot = this.bot; if (!bot || !message) return;
    const key = `${username}:${message}`;
    const now = Date.now();
    if (now - (this._dedupe.get(key) || 0) < 400) return; // chat + messagestr both fire
    this._dedupe.set(key, now);
    if (this._dedupe.size > 200) for (const [k, t] of this._dedupe) if (now - t > 2000) this._dedupe.delete(k);
    if (username === bot.username) {
      const sent = this._recentSent.get(message);
      if (sent && now - sent < 5000) return; // our own echo
      return;
    }
    this.addLog(`<${username}> ${message}`, "chat");
    this.pushChat({ username, message, source });
    state.bus.emit("mc_chat", { account: this.id, username, message, source });
    this.emit("chat", { username, message, source });
  }

  /** Fallback parser for servers with custom chat formats where "chat" never fires. */
  _onMessageStr(msg) {
    if (!this.bot) return;
    const text = String(msg);
    this._autoAuthCheck(text);
    const m = text.match(/^(?:\[[^\]]*\]\s*)*<?([A-Za-z0-9_]{3,16})>?\s*[:»>]\s*(.+)$/);
    if (m && this.bot.players && this.bot.players[m[1]]) this._handleChat(m[1], m[2], "mc");
  }

  // ---------- auto-auth / anti-afk / periodic chat ----------
  _setupAutoAuth() { /* handled in messagestr via _autoAuthCheck */ }
  _autoAuthCheck(text) {
    const a = this.config.auto_auth;
    if (!a?.enabled || !this.bot) return;
    const pw = a.password || this.account.password;
    if (!pw) return;
    const t = text.toLowerCase();
    if (Date.now() - this._lastAuthAt < 4000) return;
    let cmd = null;
    if (t.includes("/register")) cmd = a.register_command;
    else if (t.includes("/login") || t.includes("/l ")) cmd = a.login_command;
    if (!cmd) return;
    this._lastAuthAt = Date.now();
    this.after(() => { try { this.bot.chat(cmd.replace(/\{password\}/g, pw)); this.addLog("Auto-auth command sent", "control"); } catch { /* ignore */ } }, 1000);
  }

  _setupAntiAfk() {
    const a = this.config.anti_afk;
    if (!a?.enabled) return;
    const actions = a.actions?.length ? a.actions : ["jump", "look"];
    this.every(() => {
      const bot = this.bot;
      if (!this.isOnline() || this.activeActivity || this.combatBusy || this.nav.isActive() || Date.now() < this.flags.antiAfkMutedUntil) return;
      const act = actions[Math.floor(Math.random() * actions.length)];
      if (act === "jump") { bot.setControlState("jump", true); this.after(() => bot.setControlState("jump", false), 250); }
      else if (act === "look") bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
      else if (act === "walk") { bot.setControlState("forward", true); this.after(() => bot.setControlState("forward", false), 700); }
      else if (act === "sneak") { bot.setControlState("sneak", true); this.after(() => bot.setControlState("sneak", false), 500); }
      else if (act === "swing") bot.swingArm();
    }, Math.max(5, a.interval_sec || 25) * 1000);
  }

  _setupChatMessages() {
    const c = this.config.chat_messages;
    if (!c?.enabled || !c.messages?.length) return;
    let i = 0;
    this.every(() => {
      if (!this.isOnline() || Date.now() < this.flags.chatMessagesOffUntil) return;
      this.chat(c.messages[i++ % c.messages.length]);
    }, Math.max(30, c.interval_sec || 600) * 1000);
  }

  // ---------- brain toggle ----------
  setBrain(on) {
    this.runtime.brainEnabled = !!on;
    this.runtime.brainWarned = false;
    database.kvSet(`brain:${this.id}`, !!on);
    this.addLog(`AI brain ${on ? "enabled" : "disabled"}`, "ai");
    this.emitSocket("status", this.statusPayload());
  }

  // ---------- data for dashboard ----------
  getPlayers() {
    if (!this.bot?.players) return [];
    return Object.values(this.bot.players).filter((p) => p.username).map((p) => ({ username: p.username, ping: p.ping ?? null, uuid: p.uuid || null, gamemode: p.gamemode ?? null, self: p.username === this.bot.username }));
  }
  emitPlayers() { this.emitSocket("players", { players: this.getPlayers() }); }

  getInventory() {
    const bot = this.bot;
    if (!bot?.inventory) return { items: [], selected: 0, hotbarStart: 36 };
    const items = [];
    bot.inventory.slots.forEach((it, slot) => { if (it) items.push({ slot, name: it.name, displayName: it.displayName, count: it.count }); });
    return { items, selected: bot.quickBarSlot ?? 0, hotbarStart: 36 };
  }

  getNearby(radius = 24) {
    const bot = this.bot; if (!bot?.entity) return { players: [], mobs: [] };
    const me = bot.entity.position, players = [], mobs = [];
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue;
      const d = e.position.distanceTo(me);
      if (d > radius) continue;
      if (e.type === "player") players.push({ name: e.username || "player", distance: +d.toFixed(1), x: e.position.x, y: e.position.y, z: e.position.z });
      else if (e.type === "hostile" || e.type === "mob" || e.type === "animal") mobs.push({ name: e.name || e.displayName || "mob", type: e.type, distance: +d.toFixed(1), x: e.position.x, y: e.position.y, z: e.position.z });
    }
    players.sort((a, b) => a.distance - b.distance); mobs.sort((a, b) => a.distance - b.distance);
    return { players, mobs };
  }

  positionPayload() {
    const bot = this.bot; if (!bot?.entity) return null;
    const p = bot.entity.position;
    const n = this.getNearby(40);
    const entities = [...n.players.map((e) => ({ kind: "player", ...e })), ...n.mobs.map((e) => ({ kind: e.type === "hostile" ? "hostile" : "mob", ...e }))].slice(0, 80);
    return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: bot.entity.yaw, dimension: bot.game?.dimension || null, entities };
  }

  statusPayload() {
    const s = this.state;
    return {
      status: s.status, uptimeSec: s.spawnedAt && s.status === "online" ? Math.floor((Date.now() - s.spawnedAt) / 1000) : 0,
      reconnects: s.reconnects, lastError: s.lastError, task: s.task, health: s.health, food: s.food,
      version: s.version, proxy: s.proxy, brain: this.runtime.brainEnabled, username: this.account.username,
      server: `${this.config.server.host}:${this.config.server.port}`,
      muted: { antiAfk: Date.now() < this.flags.antiAfkMutedUntil, chat: Date.now() < this.flags.chatMutedUntil },
      autoJump: !!this.runtime.autoJump, detail: this.taskDetail, lastResult: this.lastResult,
      rest: this.paused, nav: this.nav.describe(),
    };
  }

  summary() { return { id: this.id, username: this.account.username, status: this.state.status, task: this.state.task }; }

  snapshot() {
    return {
      status: this.statusPayload(), position: this.positionPayload(), players: this.getPlayers(),
      inventory: this.getInventory(), chat: this.chatLog.slice(-50), logs: logger.getLogs(120, this.id),
    };
  }

  /** 1 Hz heartbeat: status/health/position only when somebody is watching. */
  _tick() {
    if (!this.bot?.entity) return;
    const bot = this.bot;
    this.state.health = bot.health; this.state.food = bot.food;
    this.state.dimension = bot.game?.dimension || null;
    const p = bot.entity.position;
    this.state.position = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) };
    const sock = this.services.socket;
    if (!sock || !sock.hasViewers(this.id)) return;
    this._viewTick++;
    this.emitSocket("status", this.statusPayload());
    this.emitSocket("health", { health: bot.health, food: bot.food, saturation: bot.foodSaturation });
    this.emitSocket("position", this.positionPayload());
    if (this._viewTick % 5 === 0) this.emitSocket("inventory", this.getInventory());
    if (this._viewTick % 10 === 0) this.emitPlayers();
  }

  /** Called by the metrics sampler once per minute. */
  takeChatCount() { const n = this._chatCount; this._chatCount = 0; return n; }
}

module.exports = { BotInstance };
