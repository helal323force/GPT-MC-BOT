/**
 * modules/follow.js - follow one specific player (activity "follow").
 * Started by: dashboard (POST /api/follow), chat command ".follow <player>" (plugins/chat-commands.js).
 * Stopped by: ".stopmove", dashboard Stop, or automatically when the player leaves / is lost for too long.
 * Config (optional): follow { distance: 3, lost_timeout_sec: 60 }
 *
 * The goal is held through inst.nav at priority "follow": combat/survival may temporarily take over (and the
 * follow goal is re-applied afterwards); mining/brain/scheduler can never cancel it.
 * Single 500 ms timer per connection (created in init, never per follow request).
 */
const { goals } = require("mineflayer-pathfinder");

function create(inst) {
  const bot = inst.bot;
  const cfg = () => ({ distance: 3, lost_timeout_sec: 60, ...(inst.config.follow || {}) });
  let running = false, target = null, dist = 3, heldEntity = null, lastPos = null, lostSince = 0, searching = false, searchBusy = false;

  const find = (name) => {
    const n = String(name || "").replace(/^@/, "").toLowerCase();
    return Object.keys(bot.players).find((k) => k.toLowerCase() === n) || null;
  };

  async function prepare(p) {
    if (!inst.isOnline()) throw new Error("Bot is not online");
    if (!p.player) throw new Error("Choose a player to follow");
    const name = find(p.player);
    if (!name) throw new Error(`Player "${p.player}" is not online`);
    if (name === bot.username) throw new Error("The bot cannot follow itself");
    if (!bot.players[name].entity) throw new Error(`${name} is online but outside the bot's view distance, so the bot cannot see them to follow`);
    return { name, distance: Math.min(10, Math.max(2, Number(p.distance) || cfg().distance)) };
  }

  function end(ok, msg) {
    running = false; heldEntity = null; searching = false; target = null;
    inst.nav.cancel("follow");
    inst.finishTask("follow", ok, msg);
  }

  async function run(params) {
    const plan = params._plan || (await prepare(params));
    running = true; target = plan.name; dist = plan.distance;
    heldEntity = null; lastPos = null; lostSince = 0; searching = false; searchBusy = false;
    inst.addLog(`Following ${target} (keeping ~${dist} blocks)`, "control");
    inst.emitSocket("move_status", { state: "following", target });
    tick();
  }

  function tick() {
    if (!running || !inst.isOnline()) return;
    const now = Date.now(), p = bot.players[target];
    if (!p) return end(false, `${target} left the game - stopped following`);
    const e = p.entity;
    if (e && e.position) {
      lastPos = e.position.clone(); lostSince = 0;
      if (searching) { searching = false; inst.addLog(`${target} is back in range`, "info"); }
      if (heldEntity !== e) { heldEntity = e; inst.nav.hold("follow", new goals.GoalFollow(e, dist), true); }
      inst.setTaskDetail({ kind: "follow", player: target, state: "following", distance: +e.position.distanceTo(bot.entity.position).toFixed(1) });
      return;
    }
    // Player is online but not loaded around the bot: go to where they were last seen, then wait.
    if (heldEntity) { heldEntity = null; inst.nav.release("follow"); }
    if (!lostSince) lostSince = now;
    const lostFor = now - lostSince, limit = cfg().lost_timeout_sec * 1000;
    if (lostFor > limit) return end(false, `Lost ${target}: out of range for ${Math.round(lostFor / 1000)}s - stopped following`);
    if (!searching) { searching = true; inst.addLog(`${target} is out of range - heading to their last known position`, "warn"); }
    inst.setTaskDetail({ kind: "follow", player: target, state: "searching", lostForSec: Math.round(lostFor / 1000) });
    if (lastPos && !searchBusy) {
      searchBusy = true;
      const lp = lastPos;
      inst.nav.goto("follow", new goals.GoalNear(lp.x, lp.y, lp.z, 3), { timeoutMs: 20000 })
        .catch(() => {}).finally(() => { searchBusy = false; });
    }
  }

  return {
    prepare, run,
    init() {
      inst.every(tick, 500);   // one timer for the connection; cheap no-op unless following
      inst.listen(bot, "playerLeft", (p) => { if (running && p?.username === target) end(false, `${target} left the game - stopped following`); });
    },
    halt() { if (running) { running = false; heldEntity = null; searching = false; target = null; inst.nav.cancel("follow"); } },
    stop() { running = false; heldEntity = null; },
  };
}
module.exports = { create };
