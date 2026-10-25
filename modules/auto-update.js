/**
 * modules/auto-update.js - GitHub auto-update via git.
 * Config: auto_update { enabled, repo:"user/repo", branch:"main", check_interval_min:30, auto_apply:true }
 * git fetch + compare HEAD with origin/<branch>. New commit => (auto_apply) git pull + npm install, then
 * pm2 restart (if under pm2); otherwise it only logs "restart required".
 * Skips (with a warning) when there is no .git folder, e.g. Docker builds on Render/Railway;
 * those platforms redeploy automatically on every git push instead.
 */
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { addLog } = require("../logger");

const ROOT = path.join(__dirname, "..");
const sh = (cmd) => new Promise((res, rej) => exec(cmd, { cwd: ROOT, timeout: 180000 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out.trim()))));

class AutoUpdate {
  constructor(cfg, notify) { this.cfg = cfg; this.notify = notify; this.timer = null; this.busy = false; }

  async init() {
    if (!this.cfg.enabled) return;
    if (!fs.existsSync(path.join(ROOT, ".git"))) { addLog("[AutoUpdate] no .git directory (container/Render/Railway?) - disabled. Those platforms redeploy on git push.", "warn"); return; }
    try { await sh("git --version"); } catch { addLog("[AutoUpdate] git not installed - disabled", "warn"); return; }
    try {
      const remote = await sh("git remote get-url origin");
      if (this.cfg.repo && !remote.includes(this.cfg.repo)) addLog(`[AutoUpdate] origin (${remote.replace(/\/\/[^@]*@/, "//")}) does not match settings repo "${this.cfg.repo}"`, "warn");
    } catch { /* ignore */ }
    const every = Math.max(5, this.cfg.check_interval_min || 30) * 60000;
    this.timer = setInterval(() => this.check(), every);
    this.timer.unref();
    setTimeout(() => this.check(), 15000).unref();
    addLog(`[AutoUpdate] watching ${this.cfg.repo || "origin"}@${this.cfg.branch || "main"} every ${every / 60000} min`, "info");
  }
  stop() { clearInterval(this.timer); }

  async check() {
    if (this.busy) return;
    this.busy = true;
    const branch = this.cfg.branch || "main";
    try {
      await sh(`git fetch origin ${branch}`);
      const local = await sh("git rev-parse HEAD"), remote = await sh(`git rev-parse origin/${branch}`);
      if (local === remote) return;
      const msg = `New commit ${remote.slice(0, 7)} on ${branch} (running ${local.slice(0, 7)})`;
      addLog(`[AutoUpdate] ${msg}`, "control");
      if (!this.cfg.auto_apply) { this.notify("update", `${msg} - pull manually`, { color: "info" }); return; }
      await sh(`git pull --ff-only origin ${branch}`);
      await sh("npm install --omit=dev");
      this.notify("update", `Updated to ${remote.slice(0, 7)}`, { color: "success" });
      if (process.env.pm_id !== undefined) { addLog("[AutoUpdate] restarting via pm2", "control"); exec("pm2 restart all"); }
      else addLog("[AutoUpdate] updated - restart required (no pm2 detected)", "warn");
    } catch (e) { addLog(`[AutoUpdate] ${e.message}`, "error"); }
    finally { this.busy = false; }
  }
}

module.exports = { AutoUpdate };
