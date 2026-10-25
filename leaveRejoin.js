/**
 * leaveRejoin.js - scheduled leave/rejoin cycle (your original file was not in the uploaded zip,
 * so this is a compatible re-implementation).
 * Config: leave_rejoin { enabled, stay_min (120), away_sec (60) }
 * After a bot has been online for stay_min it is stopped for away_sec and started again.
 */
const state = require("./core/state");
const { addLog } = require("./logger");

function start(config) {
  const c = config.leave_rejoin || {};
  if (!c.enabled) return { stop() {} };
  const timers = new Set();
  const cycle = (inst) => {
    const t = setTimeout(async () => {
      timers.delete(t);
      if (inst.destroyed) return;
      if (inst.isOnline()) {
        addLog(`[LeaveRejoin] ${inst.id} leaving for ${c.away_sec || 60}s`, "control");
        await inst.stop("Scheduled leave");
        const back = setTimeout(async () => { timers.delete(back); if (!inst.destroyed) { await inst.start(); cycle(inst); } }, (c.away_sec || 60) * 1000);
        timers.add(back);
      } else cycle(inst);
    }, (c.stay_min || 120) * 60000);
    timers.add(t);
  };
  for (const inst of state.instances.values()) cycle(inst);
  addLog(`[LeaveRejoin] enabled: stay ${c.stay_min || 120} min, away ${c.away_sec || 60}s`, "info");
  return { stop() { for (const t of timers) clearTimeout(t); timers.clear(); } };
}

module.exports = { start };
