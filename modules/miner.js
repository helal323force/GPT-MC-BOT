/**
 * modules/miner.js - auto-mine activity.
 * Config (modules.auto_mine): enabled, targets[], radius (32), max_targets_per_cycle (5), require_tool (true)
 * Loop: find ores -> path next to them -> equip best tool -> dig -> pick up drops.
 * Returns to the start position every 5 min; remembers mined coords to skip exhausted veins.
 */
const { Vec3 } = require("vec3");

function create(inst) {
  const bot = inst.bot;
  let running = false;
  const mined = new Set();
  const keyOf = (p) => `${p.x},${p.y},${p.z}`;
  const remember = (k) => { mined.add(k); if (mined.size > 1000) mined.delete(mined.values().next().value); };
  function safeExploreTarget(radius = 24) {
    const me = bot.entity.position;
    for (let tries = 0; tries < 10; tries++) {
      const a = Math.random() * Math.PI * 2, r = radius * (0.45 + Math.random() * 0.55);
      const x = Math.round(me.x + Math.cos(a) * r), z = Math.round(me.z + Math.sin(a) * r), y = Math.floor(me.y);
      const feet = bot.blockAt(new Vec3(x, y, z)), head = bot.blockAt(new Vec3(x, y + 1, z)), ground = bot.blockAt(new Vec3(x, y - 1, z));
      if (feet && head && ground && ['air','cave_air','void_air'].includes(feet.name) && ['air','cave_air','void_air'].includes(head.name) && ground.boundingBox === 'block' && !/lava|water|fire|cactus|magma/.test(ground.name)) return { x, z };
    }
    return null;
  }

  function hasTool(block) {
    if (!block.harvestTools) return true;
    return bot.inventory.items().some((i) => block.harvestTools[i.type]);
  }

  async function mineOne(pos, cfg) {
    const block = bot.blockAt(pos);
    if (!block || !cfg.targets.includes(block.name)) { remember(keyOf(pos)); return; }
    if (cfg.require_tool !== false && !hasTool(block)) { remember(keyOf(pos)); inst.addLog(`Skipping ${block.name}: no suitable tool`, "warn"); return; }
    await inst.goto(pos.x, pos.y, pos.z, 3, 25000);
    const tool = inst.movements?.bestHarvestTool(block);
    if (tool) await bot.equip(tool, "hand").catch(() => {});
    await bot.dig(block, true);
    remember(keyOf(pos));
    try { inst.modules.advanced?.rememberResource({ name: block.name, x: pos.x, y: pos.y, z: pos.z }); } catch { /* memory is best-effort */ }
    inst.addLog(`Mined ${block.name} at ${pos.x},${pos.y},${pos.z}`, "success");
  }

  async function run() {
    if (running) return;
    running = true;
    const cfg = inst.config.modules.auto_mine;
    const ids = cfg.targets.map((n) => inst.mcData.blocksByName[n]?.id).filter((x) => x !== undefined);
    if (!ids.length) { inst.addLog("auto_mine: no valid targets configured", "error"); running = false; inst.activityDone("mine"); return; }
    const home = bot.entity.position.clone();
    let lastHome = Date.now(), emptyScans = 0;
    inst.addLog("Auto-mine started", "control");
    try {
      while (running && inst.isOnline()) {
        await inst.waitReady();
        if (Date.now() - lastHome > 5 * 60000) {
          lastHome = Date.now();
          await inst.goto(home.x, home.y, home.z, 2, 60000).catch(() => {});
        }
        const targets = bot.findBlocks({ matching: ids, maxDistance: cfg.radius || 32, count: 64 })
          .filter((p) => !mined.has(keyOf(p)))
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
          .slice(0, cfg.max_targets_per_cycle || 5);
        if (!targets.length) {
          emptyScans++;
          if (emptyScans <= 4) {
            const target = safeExploreTarget(Math.min(36, Math.max(16, Number(cfg.radius) || 32)));
            if (target) {
              inst.addLog(`No ore in current area; searching nearby at ${target.x},${target.z} (scan ${emptyScans}/4)`, "info");
              try { await inst.goto(target.x, null, target.z, 2, 45000); } catch (e) { if (!e.cancelled) inst.addLog(`Resource search path failed: ${e.message}`, "warn"); }
              await inst.sleep(700);
              continue;
            }
          }
          emptyScans = 0;
          inst.addLog("No ore found after nearby searches; waiting before scanning again", "info");
          await inst.sleep(8000); continue;
        }
        emptyScans = 0;
        for (const p of targets) {
          if (!running || !inst.isOnline()) break;
          await inst.waitReady();
          try { await mineOne(new Vec3(p.x, p.y, p.z), cfg); } catch (e) { remember(keyOf(p)); inst.addLog(`Mine error: ${e.message}`, "warn"); }
        }
        if (running) await inst.collectDrops(8, 8);
      }
    } catch (e) { if (running) inst.addLog(`Miner crashed: ${e.message}`, "error"); }
    running = false;
    inst.activityDone("mine");
  }

  return { run, halt() { running = false; }, stop() { running = false; } };
}
module.exports = { create };
