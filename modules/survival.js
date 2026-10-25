/**
 * modules/survival.js - smart survival (runs on every connection unless survival.enabled === false).
 * Config (all optional, defaults shown): survival {
 *   enabled: true, eat_below: 14, retreat_health: 8, resume_health: 14, danger_radius: 12, max_threats: 4,
 *   retreat_cooldown_ms: 15000, retreat_distance: 25, max_rest_sec: 180 }
 *
 * - EAT: when food <= eat_below (or hurt and not full). Picks food that fits the hunger gap. Never eats golden apples
 *   (reserved for combat), chorus fruit, pufferfish, poisonous potato, spider eye; rotten flesh / raw chicken only when starving.
 *   No food => logged once per 5 min, bot carries on.
 * - RETREAT: health <= retreat_health with a threat near, or danger weight >= max_threats (creeper counts double).
 *   Goes to a recently-safe spot (remembered while quiet) or directly away from the threats, using the coordinator at
 *   priority "survival" (above everything except combat). If it cannot get away it marks itself "cornered" and lets combat defend.
 * - REST: low health with no threats pauses low-priority tasks (inst.paused) until health recovers or max_rest_sec passes.
 * - shouldEngage(): combat asks before chasing a mob - no chasing while retreating or critically hurt.
 */
const { goals } = require("mineflayer-pathfinder");

const DEFAULTS = { enabled: true, eat_below: 14, retreat_health: 8, resume_health: 14, danger_radius: 12, max_threats: 4, retreat_cooldown_ms: 15000, retreat_distance: 25, max_rest_sec: 180 };
const NEVER_EAT = new Set(["golden_apple", "enchanted_golden_apple", "chorus_fruit", "pufferfish", "poisonous_potato", "spider_eye", "suspicious_stew"]);
const LAST_RESORT = new Set(["rotten_flesh", "chicken"]);

function create(inst) {
  const bot = inst.bot;
  const cfg = () => ({ ...DEFAULTS, ...(inst.config.survival || {}) });
  let retreating = false, cornered = false, tok = 0, lastRetreat = 0, lastEat = 0, noFoodLogged = 0;
  let restSince = 0, lastSpotAt = 0;
  const safeSpots = [];

  function threats() {
    const c = cfg(), ignore = inst.config.combat?.ignore_mobs || [], me = bot.entity.position, out = [];
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || e.type !== "hostile" || !e.position || ignore.includes(e.name)) continue;
      const d = e.position.distanceTo(me);
      if (d <= c.danger_radius) out.push({ e, d, w: e.name === "creeper" ? 2 : 1 });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // ---------- eating ----------
  function pickFood() {
    const foods = inst.mcData?.foodsByName || {};
    const desperate = bot.food <= 4;
    const usable = bot.inventory.items().filter((i) => foods[i.name] && !NEVER_EAT.has(i.name) && (!LAST_RESORT.has(i.name) || desperate));
    if (!usable.length) return null;
    const gap = 20 - bot.food;
    const fits = usable.filter((i) => foods[i.name].foodPoints >= gap).sort((a, b) => foods[a.name].foodPoints - foods[b.name].foodPoints);
    return fits[0] || usable.sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
  }

  async function maybeEat() {
    const c = cfg(), now = Date.now();
    if (inst.flags.eating || now - lastEat < 2000 || bot.food >= 20) return;
    if (!(bot.food <= c.eat_below || (bot.health < 15 && bot.food < 20))) return;
    const food = pickFood();
    if (!food) {
      if (now - noFoodLogged > 300000) { noFoodLogged = now; inst.addLog(`Hungry (${bot.food}/20) but no usable food in inventory`, "warn"); inst.pushEvent("no food"); }
      return;
    }
    inst.flags.eating = true; lastEat = now;
    try { await bot.equip(food, "hand"); await bot.consume(); inst.addLog(`Ate ${food.name} (food ${bot.food}/20)`, "control"); }
    catch (e) { inst.addLog(`Could not eat ${food.name}: ${e.message}`, "warn"); }
    finally { inst.flags.eating = false; }
  }

  // ---------- retreat ----------
  function recordSafeSpot() {
    const now = Date.now(), p = bot.entity.position;
    if (now - lastSpotAt < 20000 || !bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) return;
    const last = safeSpots[safeSpots.length - 1];
    if (last && last.distanceTo(p) < 8) return;
    lastSpotAt = now; safeSpots.push(p.clone()); if (safeSpots.length > 8) safeSpots.shift();
  }

  function pickGoal(ts) {
    const c = cfg(), me = bot.entity.position;
    for (let i = safeSpots.length - 1; i >= 0; i--) {
      const s = safeSpots[i], dm = s.distanceTo(me);
      if (dm >= 8 && dm <= 80 && ts.every((t) => t.e.position.distanceTo(s) > 14)) return new goals.GoalNear(s.x, s.y, s.z, 2);
    }
    let dx = 0, dz = 0;
    for (const t of ts) { dx += me.x - t.e.position.x; dz += me.z - t.e.position.z; }
    const len = Math.hypot(dx, dz) || 1;
    return new goals.GoalXZ(me.x + (dx / len) * c.retreat_distance, me.z + (dz / len) * c.retreat_distance);
  }

  async function retreat(ts) {
    const my = ++tok;
    retreating = true; cornered = false; lastRetreat = Date.now();
    inst.addLog(`Retreating: health ${bot.health.toFixed(1)}/20, ${ts.length} threat(s) nearby`, "warn");
    inst.pushEvent("retreat");
    try {
      await inst.nav.goto("survival", pickGoal(ts), { timeoutMs: 20000 });
    } catch (e) {
      if (my !== tok || e.cancelled) { retreating = false; return; }
      cornered = true;
      inst.addLog(`Retreat failed (${e.message}) - will defend if attacked`, "warn");
    }
    // Stay in "retreat" until the area has been quiet for 4 s (max 30 s). Threats still on top of us => cornered.
    const until = Date.now() + 30000; let quiet = 0;
    while (my === tok && inst.isOnline() && Date.now() < until) {
      const now = threats();
      if (now.some((t) => t.d < 4)) cornered = true;
      if (!now.length) { quiet = quiet || Date.now(); if (Date.now() - quiet > 4000) break; } else quiet = 0;
      await inst.sleep(500);
    }
    if (my === tok) { retreating = false; cornered = false; }
  }

  // ---------- main tick ----------
  function tick() {
    if (!inst.isOnline() || cfg().enabled === false) return;
    const c = cfg(), now = Date.now(), ts = threats(), hp = bot.health;
    if (!ts.length && hp >= c.resume_health) recordSafeSpot();

    maybeEat().catch(() => {});

    const danger = ts.reduce((s, t) => s + t.w, 0);
    const critical = hp <= c.retreat_health;
    if (!retreating && now - lastRetreat > c.retreat_cooldown_ms && ((critical && ts.length) || danger >= c.max_threats)) retreat(ts).catch((e) => inst.addLog(`Retreat error: ${e.message}`, "warn"));

    // Rest: no threats but badly hurt => pause low-priority tasks until healed (or give up waiting, e.g. no food to regenerate)
    if (!ts.length && critical && !inst.paused && !retreating) { inst.paused = true; restSince = now; inst.addLog(`Resting at ${hp.toFixed(1)}/20 health - tasks paused`, "info"); }
    if (inst.paused && (hp >= c.resume_health || now - restSince > c.max_rest_sec * 1000)) {
      if (hp < c.resume_health) inst.addLog("Health is not recovering (no food?) - resuming tasks anyway", "warn");
      else inst.addLog("Recovered - resuming tasks", "info");
      inst.paused = false;
    }
  }

  return {
    init() { inst.every(tick, 750); },
    stop() { tok++; retreating = false; cornered = false; inst.paused = false; },
    /** Combat asks before chasing. Defending at melee range is always allowed. */
    shouldEngage(threat, d) {
      const c = cfg();
      if (c.enabled === false) return true;
      if (cornered) return true;
      if (retreating) return false;
      if (bot.health <= c.retreat_health && d > 3.5) return false;
      return true;
    },
    state() { return { retreating, cornered, safeSpots: safeSpots.length }; },
  };
}
module.exports = { create, DEFAULTS };
