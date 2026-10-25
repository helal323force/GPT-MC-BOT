/**
 * modules/trader.js - auto-trade with the nearest villager.
 * Config (modules.auto_trade): enabled, item_wanted ("emerald" = what we receive), item_give ("wheat" = what we pay)
 * Picks the cheapest enabled trade that outputs item_wanted (and takes item_give, if set) and repeats it
 * until stock or inventory runs out.
 */
function create(inst) {
  const bot = inst.bot;
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    const cfg = inst.config.modules.auto_trade;
    inst.addLog("Auto-trade started", "control");
    try {
      while (running && inst.isOnline()) {
        await inst.waitReady();
        const villager = bot.nearestEntity((e) => e.name === "villager");
        if (!villager) { inst.addLog("No villager nearby", "info"); await inst.sleep(15000); continue; }
        if (villager.position.distanceTo(bot.entity.position) > 3) await inst.goto(villager.position.x, villager.position.y, villager.position.z, 2, 20000).catch(() => {});
        const win = await bot.openVillager(villager);
        try {
          let best = -1, bestCost = Infinity;
          win.trades.forEach((t, i) => {
            if (t.tradeDisabled || t.disabled) return;
            if (t.outputItem?.name !== cfg.item_wanted) return;
            if (cfg.item_give && t.inputItem1?.name !== cfg.item_give && t.inputItem2?.name !== cfg.item_give) return;
            const cost = (t.inputItem1?.count || 1) / Math.max(1, t.outputItem.count);
            if (cost < bestCost) { best = i; bestCost = cost; }
          });
          if (best < 0) inst.addLog(`No trade giving ${cfg.item_wanted}${cfg.item_give ? " for " + cfg.item_give : ""}`, "info");
          else {
            let done = 0;
            for (let n = 0; n < 64 && running; n++) {
              try { await bot.trade(win, best, 1); done++; } catch { break; }
            }
            if (done) inst.addLog(`Traded ${done}x for ${cfg.item_wanted}`, "success");
          }
        } finally { try { win.close(); } catch { /* ignore */ } }
        await inst.sleep(20000);
      }
    } catch (e) { if (running) inst.addLog(`Trader error: ${e.message}`, "error"); }
    running = false;
    inst.activityDone("trade");
  }

  return { run, halt() { running = false; }, stop() { running = false; } };
}
module.exports = { create };
