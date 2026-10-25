/**
 * modules/plugin-loader.js - loads ./plugins/*.js at startup.
 * Plugin shape: module.exports = { name, version, init(bot, context) [, destroy()] }
 * init may also return a cleanup function. Errors are isolated per plugin.
 * Config: plugins { enabled, disabled[] (plugin names) }
 * context: { addLog, config, botState, instance, services, chat, listen, every, after }
 */
const fs = require("fs");
const path = require("path");
const { addLog } = require("../logger");
const state = require("../core/state");

class PluginLoader {
  constructor(cfg) { this.cfg = cfg || {}; this.plugins = []; }

  load() {
    if (this.cfg.enabled === false) return;
    const dir = path.join(__dirname, "..", "plugins");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")); } catch { /* no dir */ }
    for (const f of files) {
      try {
        const mod = require(path.join(dir, f));
        if (!mod || typeof mod.init !== "function" || !mod.name) throw new Error("must export { name, version, init }");
        if ((this.cfg.disabled || []).includes(mod.name)) continue;
        this.plugins.push(mod);
      } catch (e) { addLog(`[Plugins] ${f} failed to load: ${e.message}`, "error"); }
    }
    addLog(`[Plugins] Loaded ${this.plugins.length} plugins${this.plugins.length ? ": " + this.plugins.map((p) => `${p.name} v${p.version || "?"}`).join(", ") : ""}`, "info");
  }

  /** Run every plugin's init for one bot connection; returns a {stop} handle. */
  initFor(inst) {
    const cleanups = [];
    for (const p of this.plugins) {
      try {
        const context = {
          addLog: (m, t = "info") => inst.addLog(`[${p.name}] ${m}`, t),
          config: inst.config, botState: inst.state, instance: inst, services: state.services,
          chat: (m) => inst.chat(m), listen: inst.listen.bind(inst), every: inst.every.bind(inst), after: inst.after.bind(inst),
        };
        const ret = p.init(inst.bot, context);
        if (typeof ret === "function") cleanups.push(ret);
        else if (typeof p.destroy === "function") cleanups.push(() => p.destroy(inst.bot));
      } catch (e) { inst.addLog(`[Plugins] ${p.name} init error: ${e.message}`, "error"); }
    }
    return { stop() { for (const c of cleanups) { try { c(); } catch { /* ignore */ } } cleanups.length = 0; } };
  }
}

module.exports = { PluginLoader };
