/**
 * modules/fisher.js - auto-fish activity.
 * Config (modules.auto_fish): enabled
 * Uses mineflayer's bot.fish() (it watches the bobber and reels in on bite), then recasts.
 * Needs a fishing_rod in the inventory and water within 16 blocks.
 */
function create(inst) {
  const bot = inst.bot;
  let running = false, caught = 0;

  const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error("fishing timeout")), ms); })]).finally(() => clearTimeout(t)); };

  async function run() {
    if (running) return;
    running = true;
    inst.addLog("Auto-fish started", "control");
    try {
      const rod = () => bot.inventory.items().find((i) => i.name === "fishing_rod");
      if (!rod()) throw new Error("no fishing_rod in inventory");
      const water = bot.findBlock({ matching: inst.mcData.blocksByName.water.id, maxDistance: 16, useExtraInfo: (b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === "air" });
      if (!water) throw new Error("no water within 16 blocks");
      await inst.goto(water.position.x, water.position.y, water.position.z, 4, 20000).catch(() => {});
      while (running && inst.isOnline()) {
        await inst.waitReady();
        await bot.equip(rod(), "hand");
        await bot.lookAt(water.position.offset(0.5, 0.9, 0.5), true);
        try {
          await withTimeout(bot.fish(), 70000);
          caught++;
          inst.addLog(`Caught something (#${caught})`, "success");
        } catch (e) {
          inst.addLog(`Fishing: ${e.message}`, "warn");
          try { bot.activateItem(); } catch { /* reel in */ }
          await inst.sleep(2000);
        }
        await inst.sleep(700);
      }
    } catch (e) { if (running) inst.addLog(`Fisher stopped: ${e.message}`, "error"); }
    running = false;
    inst.activityDone("fish");
  }

  return { run, halt() { running = false; try { bot.activateItem(); } catch { /* ignore */ } }, stop() { running = false; } };
}
module.exports = { create };
