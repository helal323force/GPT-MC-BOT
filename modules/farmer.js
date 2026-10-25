/**
 * modules/farmer.js - auto-farm activity.
 * Config (modules.auto_farm): enabled, radius (16), crops[] (wheat, carrots, potatoes, beetroots)
 * Harvests fully grown crops, replants from seeds in inventory, then collects drops.
 */
const { Vec3 } = require("vec3");

const CROPS = {
  wheat: { maxAge: 7, seed: "wheat_seeds" },
  carrots: { maxAge: 7, seed: "carrot" },
  potatoes: { maxAge: 7, seed: "potato" },
  beetroots: { maxAge: 3, seed: "beetroot_seeds" },
};
const alias = { beetroot: "beetroots", carrot: "carrots", potato: "potatoes" };

function create(inst) {
  const bot = inst.bot;
  let running = false, warnedSeed = false;

  const ageOf = (b) => {
    const props = b.getProperties ? b.getProperties() : null;
    return props && props.age !== undefined ? Number(props.age) : -1;
  };

  async function replant(pos, crop) {
    const seed = bot.inventory.items().find((i) => i.name === crop.seed);
    if (!seed) { if (!warnedSeed) { warnedSeed = true; inst.addLog(`No ${crop.seed} to replant`, "warn"); } return; }
    const soil = bot.blockAt(pos.offset(0, -1, 0));
    if (!soil || soil.name !== "farmland") return;
    await bot.equip(seed, "hand");
    await bot.placeBlock(soil, new Vec3(0, 1, 0));
  }

  async function run() {
    if (running) return;
    running = true;
    const cfg = inst.config.modules.auto_farm;
    const names = (cfg.crops || Object.keys(CROPS)).map((n) => alias[n] || n).filter((n) => CROPS[n]);
    const ids = names.map((n) => inst.mcData.blocksByName[n]?.id).filter((x) => x !== undefined);
    inst.addLog("Auto-farm started", "control");
    try {
      while (running && inst.isOnline()) {
        await inst.waitReady();
        const ready = bot.findBlocks({ matching: ids, maxDistance: cfg.radius || 16, count: 64 })
          .map((p) => bot.blockAt(p))
          .filter((b) => b && CROPS[b.name] && ageOf(b) >= CROPS[b.name].maxAge)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
          .slice(0, 12);
        if (!ready.length) { await inst.sleep(15000); continue; }
        for (const b of ready) {
          if (!running || !inst.isOnline()) break;
          await inst.waitReady();
          try {
            await inst.goto(b.position.x, b.position.y, b.position.z, 2, 15000);
            const crop = CROPS[b.name], pos = b.position.clone();
            await bot.dig(bot.blockAt(pos), true);
            await replant(pos, crop);
          } catch (e) { inst.addLog(`Farm error: ${e.message}`, "warn"); }
        }
        if (running) await inst.collectDrops(8, 10);
      }
    } catch (e) { if (running) inst.addLog(`Farmer crashed: ${e.message}`, "error"); }
    running = false;
    inst.activityDone("farm");
  }

  return { run, halt() { running = false; }, stop() { running = false; } };
}
module.exports = { create };
