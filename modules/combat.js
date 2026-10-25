/**
 * modules/combat.js - advanced combat (rewrite).
 * Config (settings.combat): enabled, auto_attack_mobs, pvp_mode, ignore_players[], ignore_mobs[],
 *   eat_golden_apple_below (6), flee_below (4), flee_distance (20), attack_range (3.2)
 * - Equips the best weapon (damage table - mineflayer items carry no attackDamage field).
 * - Eats golden apples when hurt; flees when low and no apples.
 * - PvP mode: only retaliates against players who hit the bot first (30 s memory).
 * Sets inst.combatBusy so activities (mine/farm/...) pause while fighting.
 *
 * v3.1: goals are requested through inst.nav (priority "combat") instead of bot.pathfinder.setGoal():
 *  - the chase goal is set ONCE per target (it used to be re-set every 350 ms, which restarted the path
 *    and cancelled any other task's goto with "Path was stopped before it could be completed!")
 *  - ending combat releases only combat's own goal, so follow/other tasks resume instead of being wiped
 *  - eating shares inst.flags.eating with the survival module; survival can veto a fight (shouldEngage)
 */
const { goals } = require("mineflayer-pathfinder");

const WEAPONS = {
  netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4,
  netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7, trident: 9,
};
const APPLES = ["enchanted_golden_apple", "golden_apple"];

function create(inst) {
  const bot = inst.bot;
  const cfg = () => inst.config.combat || {};
  const aggressors = new Map(); // player -> expiry
  let lastAttack = 0, lastEat = 0, lastEquip = 0, fleeUntil = 0, forced = null, forcedUntil = 0, chasing = null, fleeing = false;

  const apple = () => bot.inventory.items().find((i) => APPLES.includes(i.name));
  const selectedFriend = () => { try { return inst.modules.coop?.status()?.username?.toLowerCase() || null; } catch { return null; } };

  function onHurt(entity) {
    if (entity !== bot.entity) return;
    const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 6 && (e.type === "player" || e.type === "hostile"))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!near) return;
    inst.pushEvent(`hurt by ${near.username || near.name}`);
    if (near.type === "player" && near.username && near.username.toLowerCase() !== selectedFriend() && !(cfg().ignore_players || []).includes(near.username)) aggressors.set(near.username, Date.now() + 30000);
  }

  function findThreat() {
    const c = cfg(), now = Date.now(), me = bot.entity.position;
    if (forced && now < forcedUntil && forced.isValid) return forced;
    forced = null;
    let best = null, bd = 9;
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position || !e.isValid) continue;
      const d = e.position.distanceTo(me);
      if (d > bd) continue;
      let ok = false;
      if (e.type === "player") {
        const exp = aggressors.get(e.username);
        ok = e.username?.toLowerCase() !== selectedFriend() && c.pvp_mode && exp && exp > now && !(c.ignore_players || []).includes(e.username);
      } else if (e.type === "hostile" && c.auto_attack_mobs !== false) {
        ok = !(c.ignore_mobs || []).includes(e.name);
      }
      if (ok) { best = e; bd = d; }
    }
    return best;
  }

  function equipBest() {
    if (Date.now() - lastEquip < 2000) return;
    lastEquip = Date.now();
    let best = null, score = 0;
    for (const it of bot.inventory.items()) { const s = WEAPONS[it.name] || 0; if (s > score) { best = it; score = s; } }
    if (best && bot.heldItem?.name !== best.name) bot.equip(best, "hand").catch(() => {});
  }

  async function eat(item) {
    if (inst.flags.eating) return; inst.flags.eating = true; lastEat = Date.now();
    try { await bot.equip(item, "hand"); await bot.consume(); inst.addLog(`Ate ${item.name}`, "control"); }
    catch (e) { inst.addLog(`Eat failed: ${e.message}`, "warn"); }
    finally { inst.flags.eating = false; }
  }

  function flee(threat, dist) {
    const me = bot.entity.position;
    let dx = me.x - (threat ? threat.position.x : me.x + Math.random() - 0.5);
    let dz = me.z - (threat ? threat.position.z : me.z + Math.random() - 0.5);
    const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    const d = dist || cfg().flee_distance || 20;
    inst.combatBusy = true;
    fleeing = true; chasing = null;
    fleeUntil = Date.now() + 9000;
    inst.addLog(`Fleeing ${d} blocks`, "warn");
    inst.pushEvent("fled");
    inst.nav.hold("combat", new goals.GoalXZ(me.x + dx * d, me.z + dz * d), false);
  }

  function endCombat() {
    if (!inst.combatBusy) return;
    inst.combatBusy = false; fleeing = false; chasing = null;
    inst.nav.release("combat"); // releases ONLY combat's goal; other tasks resume
  }

  function tick() {
    if (!inst.isOnline() || inst.flags.eating) return;
    const c = cfg(), now = Date.now();
    if (bot.health < (c.eat_golden_apple_below ?? 6) && now - lastEat > 3000) {
      const a = apple(); if (a) { eat(a); return; }
    }
    if (now < fleeUntil) return;
    if (fleeing && now >= fleeUntil) { fleeUntil = 0; endCombat(); }

    const creeper = Object.values(bot.entities).find((e) => e.name === "creeper" && e.position && e.position.distanceTo(bot.entity.position) < 4);
    if (creeper && c.auto_attack_mobs !== false) return flee(creeper, 8);

    const threat = findThreat();
    if (!threat) return endCombat();
    if (bot.health < (c.flee_below ?? 4) && !apple()) return flee(threat);
    const d = threat.position.distanceTo(bot.entity.position);
    // Survival may veto a fight (retreating, critically low health, outnumbered). Defending at melee range is still allowed.
    const sv = inst.modules.survival;
    if (sv && !sv.shouldEngage(threat, d)) return endCombat();

    inst.combatBusy = true;
    equipBest();
    if (chasing !== threat.id) { // set the chase goal once per target, not every tick
      chasing = threat.id;
      inst.nav.hold("combat", new goals.GoalFollow(threat, 2), true);
    }
    if (d <= (c.attack_range || 3.2) && now - lastAttack > 550) {
      lastAttack = now;
      bot.lookAt(threat.position.offset(0, (threat.height || 1.6) * 0.85, 0), true).catch(() => {});
      try { bot.attack(threat); } catch { /* ignore */ }
    }
  }

  return {
    init() {
      inst.listen(bot, "entityHurt", onHurt);
      inst.listen(bot, "death", () => { inst.combatBusy = false; aggressors.clear(); });
      inst.every(tick, 350);
    },
    stop() { inst.combatBusy = false; inst.nav.release("combat"); },
    /** Used by the AI brain. */
    fleeNow() { const t = findThreat(); flee(t, cfg().flee_distance || 20); },
    forceTarget(name) {
      const e = Object.values(bot.entities).filter((x) => x !== bot.entity && x.position && ((x.username || x.name) === name || (!name && x.type === "hostile")))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!e) return false;
      forced = e; forcedUntil = Date.now() + 15000; return true;
    },
    clearForcedTarget() { forced = null; forcedUntil = 0; endCombat(); },
  };
}
module.exports = { create, WEAPONS };
