/**
 * modules/waypoint.js - "move" activity: go to x/y/z or wander randomly.
 * run({x,y?,z}) | run({random:true})
 * v3.1: {follow:"Name"} is no longer handled here - inst.runActivity() redirects it to the follow module
 * (modules/follow.js), which holds the goal through the navigation coordinator.
 * Emits Socket.IO "move_status" {state: navigating|arrived|failed|following, target, error}.
 */
function create(inst) {
  const bot = inst.bot;
  let token = 0;

  const status = (state, extra = {}) => inst.emitSocket("move_status", { state, ...extra });

  async function run(p = {}) {
    const my = ++token;
    let x = Number(p.x), y = p.y == null || p.y === "" ? null : Number(p.y), z = Number(p.z);
    if (p.random) {
      const me = bot.entity.position;
      x = me.x + (Math.random() - 0.5) * 24; z = me.z + (Math.random() - 0.5) * 24; y = null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z) || (y !== null && !Number.isFinite(y))) { status("failed", { error: "invalid coordinates" }); inst.activityDone("move"); return; }
    const target = { x: Math.round(x), y: y === null ? null : Math.round(y), z: Math.round(z) };
    status("navigating", { target });
    inst.addLog(`Navigating to ${target.x}, ${target.y ?? "~"}, ${target.z}`, "control");
    try {
      await inst.goto(x, y, z, 2, 120000);
      if (my !== token) return;
      status("arrived", { target });
      inst.finishTask("move", true, `Arrived at ${target.x}, ${target.y ?? "~"}, ${target.z}`);
    } catch (e) {
      if (my !== token || e.cancelled) return;     // stopped by the user / replaced: not a failure
      status("failed", { target, error: e.message });
      inst.finishTask("move", false, `Navigation failed: ${e.message}`);
    }
  }

  return { run, halt() { token++; }, stop() { token++; } };
}
module.exports = { create };
