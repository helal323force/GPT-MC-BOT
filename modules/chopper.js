/**
 * modules/chopper.js - auto-chop activity.
 * Config (modules.auto_chop): enabled, radius (32), tree_types[] (oak, birch, spruce, ...)
 * Finds the nearest log, flood-fills the whole tree (BFS), digs it bottom-up and collects drops.
 */
const { Vec3 } = require("vec3");

function create(inst) {
  const bot = inst.bot;
  let running = false;

  function collectTree(start, logNames) {
    const seen = new Set([`${start.x},${start.y},${start.z}`]);
    const queue = [start], out = [];
    while (queue.length && out.length < 120) {
      const p = queue.shift();
      out.push(p);
      for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const n = p.offset(dx, dy, dz), k = `${n.x},${n.y},${n.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const b = bot.blockAt(n);
        if (b && logNames.has(b.name)) queue.push(n);
      }
    }
    return out.sort((a, b) => a.y - b.y);
  }

  async function run() {
    if (running) return;
    running = true;
    const cfg = inst.config.modules.auto_chop;
    const logNames = new Set((cfg.tree_types || ["oak"]).map((t) => `${t}_log`));
    const ids = [...logNames].map((n) => inst.mcData.blocksByName[n]?.id).filter((x) => x !== undefined);
    inst.addLog("Auto-chop started", "control");
    try {
      while (running && inst.isOnline()) {
        await inst.waitReady();
        const nearest = bot.findBlocks({ matching: ids, maxDistance: cfg.radius || 32, count: 1 })[0];
        if (!nearest) { inst.addLog("No trees in range, waiting...", "info"); await inst.sleep(10000); continue; }
        const tree = collectTree(new Vec3(nearest.x, nearest.y, nearest.z), logNames);
        inst.addLog(`Chopping tree (${tree.length} logs)`, "info");
        for (const p of tree) {
          if (!running || !inst.isOnline()) break;
          await inst.waitReady();
          const b = bot.blockAt(p);
          if (!b || !logNames.has(b.name)) continue;
          try {
            await inst.goto(p.x, p.y, p.z, 3, 15000);
            const tool = inst.movements?.bestHarvestTool(b);
            if (tool) await bot.equip(tool, "hand").catch(() => {});
            await bot.dig(b, true);
          } catch (e) { inst.addLog(`Chop error: ${e.message}`, "warn"); }
        }
        if (running) await inst.collectDrops(10, 14);
      }
    } catch (e) { if (running) inst.addLog(`Chopper crashed: ${e.message}`, "error"); }
    running = false;
    inst.activityDone("chop");
  }

  return { run, halt() { running = false; }, stop() { running = false; } };
}
module.exports = { create };
