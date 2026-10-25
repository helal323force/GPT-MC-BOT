/**
 * index.js - Minecraft AFK Bot v3 entry point (slim: wires everything together).
 *
 * Env: PORT, HEADLESS=true (no web server - GitHub Actions), RUN_FOR_MINUTES (graceful exit after N min),
 *      DATA_DIR, TRUST_PROXY, plus everything in .env.example.
 * Boot order: config -> database -> services (AI, proxy, plugins, scheduler, Discord, auto-update)
 *             -> web server + Socket.IO -> bot instances -> monitors.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const axios = require("axios");

const { config } = require("./core/config");
const database = require("./core/database");
const state = require("./core/state");
const logger = require("./logger");
const { addLog } = logger;

const HEADLESS = process.env.HEADLESS === "true" || config.dashboard?.headless === true || config.dashboard?.enabled === false;
let shuttingDown = false;
const timers = [];

async function main() {
  addLog(`Minecraft AFK Bot v${state.version} starting (${HEADLESS ? "headless" : "dashboard"} mode)`, "success");
  database.init();
  const configBackup = require("./modules/config-backup").create();
  state.services.configBackup = configBackup;
  try { const saved = configBackup.backup(); addLog(`Settings backup created: ${saved.name}`, "info"); }
  catch (e) { addLog(`Settings backup skipped: ${e.message}`, "warn"); }
  timers.push(setInterval(() => { try { const saved = configBackup.backup(); addLog(`Settings backup created: ${saved.name}`, "info"); } catch (e) { addLog(`Settings backup failed: ${e.message}`, "warn"); } }, 6 * 60 * 60 * 1000));
  // Dashboard-created profiles survive redeploys when DATA_DIR is persistent.
  const savedProfiles = database.kvGet("dynamic_profiles", []);
  if (Array.isArray(savedProfiles)) {
    const configured = new Set(config.accounts.map((a) => a.id));
    for (const profile of savedProfiles) {
      if (profile && profile.id && profile.username && !configured.has(profile.id)) {
        config.accounts.push({ type: "offline", autoStart: false, enabled: true, ...profile });
        configured.add(profile.id);
      }
    }
  }

  // ---- services ----
  const { AiService } = require("./modules/ai-providers");
  const { AiChatService } = require("./modules/ai-chat");
  const { ProxyService } = require("./modules/proxy");
  const { PluginLoader } = require("./modules/plugin-loader");
  const { Scheduler } = require("./modules/scheduler");
  const { DiscordService } = require("./modules/discord-bot");
  const { DiscordBridge } = require("./modules/discord-bridge");
  const { AutoUpdate } = require("./modules/auto-update");
  const S = state.services;

  S.ai = new AiService(config.ai || {});
  if (S.ai.enabled) addLog(`[AI] providers: ${S.ai.providers().join(" -> ")}`, "ai");
  else addLog("[AI] disabled (no API key set) - .ai chat and brain are inactive", "info");
  S.aiChat = new AiChatService(config, S.ai);
  S.proxy = new ProxyService(config.proxy);
  S.plugins = new PluginLoader(config.plugins); S.plugins.load();
  S.discord = new DiscordService(config);
  S.bridge = new DiscordBridge(config, S.discord);
  S.scheduler = new Scheduler(config);
  S.autoUpdate = new AutoUpdate(config.auto_update || {}, (e, t, o) => S.discord.notify(e, t, o));

  // ---- web server ----
  let server = null;
  if (!HEADLESS) {
    const { createAuth } = require("./core/auth");
    const { createSocket } = require("./core/socket");
    const { publicRoutes, pageRoutes } = require("./routes/dashboard");
    const { logRoutes } = require("./routes/logs");
    const { apiRoutes } = require("./routes/api");
    const { extrasRoutes } = require("./routes/extras");

    const app = express();
    app.set("trust proxy", 1); // Render / Railway terminate TLS in front of us
    app.disable("x-powered-by");
    const auth = createAuth(config.dashboard || {});
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    const json = express.json({ limit: "200kb" });
    app.use((req, res, next) => (req.path === "/api/build" ? next() : json(req, res, next)));
    app.use(express.urlencoded({ extended: false, limit: "16kb" }));
    app.use(auth.sessionMiddleware);
    app.use(publicRoutes(auth));              // /health /ping /login /auth /logout + PWA files
    app.use(auth.requireAuth);                // everything below needs a login
    app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "5m" }));
    app.use(pageRoutes());
    app.use(logRoutes());
    app.use(extrasRoutes());                  // v3.1 features; must come before apiRoutes() (its /api 404 catch-all)
    app.use(apiRoutes());
    app.use((err, _req, res, _next) => { addLog(`HTTP error: ${err.message}`, "error"); res.status(500).json({ error: "Internal server error" }); });

    server = http.createServer(app);
    S.socket = createSocket(server, auth.sessionMiddleware);
    const port = Number(process.env.PORT || config.dashboard?.port || 3000);
    await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
    addLog(`Dashboard listening on port ${port}`, "success");
  }

  // ---- bot instances ----
  const { BotInstance } = require("./core/bot-instance");
  if (!config.accounts.length) addLog("No enabled accounts in settings.json", "warn");
  for (const acc of config.accounts) state.instances.set(acc.id, new BotInstance(acc, config));

  S.scheduler.init();
  await S.discord.init(S.bridge);
  S.bridge.init();
  S.autoUpdate.init().catch(() => {});
  const lr = require("./leaveRejoin").start(config);

  let delay = 0;
  for (const inst of state.instances.values()) {
    if (inst.account.autoStart === false) continue;
    setTimeout(() => { if (!shuttingDown) inst.start().catch((e) => addLog(`start failed: ${e.message}`, "error")); }, delay).unref();
    delay += 3000; // stagger logins to avoid connection throttling
  }

  startMonitors();
  process.once("SIGINT", () => shutdown("SIGINT", server, lr));
  process.once("SIGTERM", () => shutdown("SIGTERM", server, lr));
  const runFor = Number(process.env.RUN_FOR_MINUTES);
  if (runFor > 0) { setTimeout(() => shutdown(`RUN_FOR_MINUTES=${runFor} reached`, server, lr), runFor * 60000).unref(); addLog(`Will exit gracefully after ${runFor} min`, "info"); }
}

function startMonitors() {
  const S = state.services;
  // metrics sampler (analytics)
  timers.push(setInterval(() => {
    const m = process.memoryUsage(), rss = +(m.rss / 1048576).toFixed(1), heap = +(m.heapUsed / 1048576).toFixed(1);
    for (const i of state.instances.values()) {
      try { database.run("INSERT INTO metrics(ts,account,online,rss_mb,heap_mb,chat_count) VALUES(?,?,?,?,?,?)", Date.now(), i.id, i.isOnline() ? 1 : 0, rss, heap, i.takeChatCount()); } catch { /* ignore */ }
    }
  }, 60000));
  timers.push(setInterval(() => { try { database.run("DELETE FROM metrics WHERE ts<?", Date.now() - 8 * 86400000); database.run("DELETE FROM events WHERE ts<?", Date.now() - 30 * 86400000); database.run("DELETE FROM ai_logs WHERE ts<?", Date.now() - 30 * 86400000); } catch { /* ignore */ } }, 3600000));

  // memory monitor
  const mm = config.memory_monitor || {};
  if (mm.enabled) {
    let warned = false;
    timers.push(setInterval(() => {
      const m = process.memoryUsage(), rss = m.rss / 1048576;
      addLog(`[Memory] rss ${rss.toFixed(0)} MB, heap ${(m.heapUsed / 1048576).toFixed(0)} MB`, "info");
      if (rss > (mm.limit_mb || 480)) {
        addLog(`[Memory] limit ${mm.limit_mb} MB exceeded - action: ${mm.action}`, "error");
        if (mm.action === "exit") return shutdown("memory limit", null, null, 1);
        if (mm.action === "restart_bots") for (const i of state.instances.values()) if (!i.stopped) i.restart().catch(() => {});
        if (global.gc) global.gc();
      } else if (rss > (mm.warn_mb || 400) && !warned) { warned = true; addLog("[Memory] above warning threshold", "warn"); }
      else if (rss < (mm.warn_mb || 400) * 0.9) warned = false;
    }, (mm.interval_sec || 60) * 1000));
  }

  // keep-alive for hosts that sleep idle web services (Render free tier)
  const ka = config.keepalive || {};
  const base = ka.url || process.env.RENDER_EXTERNAL_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (ka.enabled && base && !HEADLESS) {
    timers.push(setInterval(() => axios.get(`${base.replace(/\/$/, "")}/ping`, { timeout: 10000 }).catch(() => {}), Math.max(1, ka.interval_min || 10) * 60000));
    addLog(`[Keepalive] pinging ${base}/ping every ${ka.interval_min || 10} min`, "info");
  }
  timers.forEach((t) => t.unref && t.unref());
}

async function shutdown(reason, server, lr, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  addLog(`Shutting down: ${reason}`, "warn");
  const S = state.services;
  try { timers.forEach(clearInterval); lr?.stop(); S.scheduler?.stop(); S.bridge?.stop(); S.autoUpdate?.stop(); S.aiChat?.stop(); } catch { /* ignore */ }
  for (const i of state.instances.values()) { try { await i.stop("Process shutdown"); i.destroy(); } catch { /* ignore */ } }
  try { await S.discord?.stop(); } catch { /* ignore */ }
  try { S.socket?.io.close(); server?.close(); } catch { /* ignore */ }
  database.close();
  setTimeout(() => process.exit(code), 300).unref();
}

// ---- crash recovery: log, alert, keep running (restart the process only on a crash loop) ----
const crashes = [];
function onCrash(kind, err) {
  const msg = `${kind}: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`;
  addLog(msg, "error");
  if (config.crash_recovery?.enabled === false) process.exit(1);
  const now = Date.now();
  crashes.push(now); while (crashes.length && now - crashes[0] > 60000) crashes.shift();
  try { state.services.discord?.notify("crash", msg.slice(0, 500), { color: "error", tts: true }); } catch { /* ignore */ }
  if (crashes.length >= 6) { addLog("Crash loop detected - exiting so the platform restarts the process", "error"); shutdown("crash loop", null, null, 1); }
}
process.on("uncaughtException", (e) => onCrash("uncaughtException", e));
process.on("unhandledRejection", (e) => onCrash("unhandledRejection", e));

main().catch((e) => { console.error("Fatal boot error:", e); process.exit(1); });
