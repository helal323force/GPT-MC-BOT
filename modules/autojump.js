/**
 * modules/autojump.js - Auto Jump toggle (dashboard switch / POST /api/autojump).
 *
 * What it does while ON (checked every 100 ms by ONE timer that exists only while enabled):
 *  1. Free movement (control states such as the anti-AFK "walk", no pathfinder): if there is a solid 1-block step directly in
 *     the walking direction with room above, it presses jump once (150 ms pulse).
 *  2. While the pathfinder is moving we do nothing: it plans its own jumps, and modules/nav.js has an always-on stuck
 *     watchdog (independent of this toggle) that jumps when the bot stops making progress.
 * Turning it OFF clears the timer, releases the jump key and leaves no pending pulse. Enabling twice never creates a second timer.
 * Persisted per account (kv "autojump:<id>"); settings default: auto_jump.enabled (optional).
 */
function create(inst) {
  const bot = inst.bot;
  let timer = null, pulse = null;

  const solid = (b) => !!b && b.boundingBox === "block";
  const stepBlocker = (b) => !!b && /fence|wall$|_wall|gate/.test(b.name); // taller than 1 block: jumping won't help

  function jump() {
    if (pulse) return;                                   // one pulse at a time
    bot.setControlState("jump", true);
    pulse = inst.after(() => { pulse = null; try { bot.setControlState("jump", false); } catch { /* ended */ } }, 150);
  }

  function tick() {
    if (!inst.isOnline() || !bot.entity) return;
    const e = bot.entity;
    if (!e.onGround || e.isInWater || e.isInLava) return;
    const pos = e.position;
    if (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) return; // pathing: the pathfinder + nav stuck-watchdog own jumping

    const cs = bot.controlState || {};
    if (!cs.forward && !cs.back) return;                 // not walking by itself
    const yaw = e.yaw, f = cs.forward ? 1 : -1;
    const dx = -Math.sin(yaw) * f, dz = -Math.cos(yaw) * f;
    const at = (h) => bot.blockAt(pos.offset(dx * 0.8, h, dz * 0.8));
    const feet = at(0.2), above1 = at(1.2), above2 = at(2.2), headroom = bot.blockAt(pos.offset(0, 2.2, 0));
    if (solid(feet) && !stepBlocker(feet) && !solid(above1) && !solid(above2) && !solid(headroom)) jump();
  }

  function setEnabled(on) {
    if (on) {
      if (timer) return;                                 // never a second timer
      timer = inst.every(tick, 100);
    } else {
      if (timer) { inst.clearTimer(timer); timer = null; }
      if (pulse) { inst.clearTimer(pulse); pulse = null; }
      try { bot.setControlState("jump", false); } catch { /* ended */ }
    }
  }

  return {
    init() { if (inst.runtime.autoJump) setEnabled(true); },
    setEnabled,
    isEnabled() { return !!timer; },
    stop() { setEnabled(false); },
  };
}
module.exports = { create };
