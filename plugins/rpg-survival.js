/**
 * RPG Survival plugin for Minecraft AFK Bot v3.0.0.
 * Deterministic survival loop: eats food, retreats at low health, collects drops,
 * harvests mature nearby crops, gathers surface logs, crafts basic tools when possible,
 * and mines safe nearby ores. Does not require the AI provider/API to work.
 *
 * Loaded automatically by modules/plugin-loader.js. Disable in settings.json with:
 * plugins.disabled: ["rpg-survival"]
 */
const { Vec3 } = require("vec3");
const { goals } = require("mineflayer-pathfinder");

const FOOD = [
  "golden_carrot", "cooked_beef", "cooked_porkchop", "cooked_mutton",
  "cooked_chicken", "cooked_salmon", "cooked_cod", "baked_potato",
  "bread", "cooked_rabbit", "pumpkin_pie", "apple", "sweet_berries",
  "carrot", "potato", "melon_slice", "dried_kelp", "rotten_flesh"
];
const LOGS = ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "crimson_stem", "warped_stem"];
const CROPS = {
  wheat: { age: 7, seed: "wheat_seeds" }, carrots: { age: 7, seed: "carrot" },
  potatoes: { age: 7, seed: "potato" }, beetroots: { age: 3, seed: "beetroot_seeds" }
};
const ORES = ["coal_ore", "deepslate_coal_ore", "iron_ore", "deepslate_iron_ore", "copper_ore", "deepslate_copper_ore"];
const PICKAXES = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "golden_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];

module.exports = {
  name: "rpg-survival",
  version: "1.0.0",
  init(bot, ctx) {
    const inst = ctx.instance;
    let busy = false;
    let lastFlee = 0;
    let lastNoTaskLog = 0;
    let stopped = false;
    let enabled = true;

    const log = (msg, type = "info") => ctx.addLog(msg, type);
    const online = () => !stopped && inst.isOnline() && bot.entity && bot.health > 0;
    const count = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
    const totalLogs = () => bot.inventory.items().filter((i) => LOGS.includes(i.name)).reduce((n, i) => n + i.count, 0);
    const hasPickaxe = () => bot.inventory.items().some((i) => PICKAXES.includes(i.name));
    const dist = (p) => p.distanceTo(bot.entity.position);
    const isAir = (b) => !b || b.name === "air" || b.name === "cave_air" || b.name === "void_air";

    async function eatIfNeeded() {
      if (bot.food >= 15 || bot.foodSaturation > 3) return false;
      const items = bot.inventory.items();
      const food = FOOD.map((name) => items.find((i) => i.name === name)).find(Boolean);
      if (!food) return false;
      try {
        await bot.equip(food, "hand");
        if (!online()) return true;
        await bot.consume();
        log(`Survival: ate ${food.name} (food ${bot.food}/20)`, "success");
      } catch (e) { log(`Could not eat ${food.name}: ${e.message}`, "warn"); }
      return true;
    }

    function nearbyHostile(max = 8) {
      return Object.values(bot.entities).filter((e) => e && e !== bot.entity && e.isValid && e.position && e.type === "hostile" && dist(e.position) <= max)
        .sort((a, b) => dist(a.position) - dist(b.position))[0];
    }

    async function retreatIfDangerous() {
      const threat = nearbyHostile(10);
      if (!threat || bot.health > 8 || Date.now() - lastFlee < 12000) return false;
      lastFlee = Date.now();
      const combat = inst.modules.combat;
      if (combat?.fleeNow) combat.fleeNow();
      else {
        const me = bot.entity.position;
        const dx = me.x - threat.position.x, dz = me.z - threat.position.z;
        const len = Math.hypot(dx, dz) || 1;
        await inst.nav.goto("survival", new goals.GoalXZ(Math.round(me.x + dx / len * 12), Math.round(me.z + dz / len * 12)), { timeoutMs: 10000 }).catch(() => {});
      }
      log(`Survival: retreating from ${threat.name || "hostile mob"} (health ${bot.health}/20)`, "warn");
      return true;
    }

    async function collectNearbyDrops() {
      const items = Object.values(bot.entities).filter((e) => e && (e.name === "item" || e.objectType === "Item") && e.position && dist(e.position) <= 5);
      if (!items.length) return false;
      await inst.collectDrops(5, 3);
      return true;
    }

    async function harvestCrop() {
      const cropNames = Object.keys(CROPS);
      const ids = cropNames.map((n) => inst.mcData?.blocksByName?.[n]?.id).filter((id) => id !== undefined);
      if (!ids.length) return false;
      const positions = bot.findBlocks({ matching: ids, maxDistance: 10, count: 20 });
      const ripe = positions.map((p) => bot.blockAt(p)).filter((b) => {
        if (!b || !CROPS[b.name]) return false;
        const props = b.getProperties?.() || {};
        return Number(props.age ?? -1) >= CROPS[b.name].age;
      }).sort((a, b) => dist(a.position) - dist(b.position));
      const block = ripe[0];
      if (!block) return false;
      const pos = block.position.clone(), crop = CROPS[block.name];
      await inst.goto(pos.x, pos.y, pos.z, 2, 12000);
      if (!online()) return true;
      const current = bot.blockAt(pos);
      if (!current || current.name !== block.name) return true;
      await bot.dig(current, true);
      const seed = bot.inventory.items().find((i) => i.name === crop.seed);
      const soil = bot.blockAt(pos.offset(0, -1, 0));
      if (seed && soil?.name === "farmland" && online()) {
        try { await bot.equip(seed, "hand"); await bot.placeBlock(soil, new Vec3(0, 1, 0)); } catch { /* crop may be blocked */ }
      }
      log(`Survival: harvested ${block.name}`, "success");
      return true;
    }

    async function gatherLog() {
      if (totalLogs() >= 8) return false;
      const ids = LOGS.map((n) => inst.mcData?.blocksByName?.[n]?.id).filter((id) => id !== undefined);
      if (!ids.length) return false;
      const me = bot.entity.position;
      const positions = bot.findBlocks({ matching: ids, maxDistance: 12, count: 24 })
        .filter((p) => p.y >= Math.floor(me.y) - 1 && p.y <= Math.floor(me.y) + 5)
        .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
      const pos = positions[0];
      if (!pos) return false;
      await inst.goto(pos.x, pos.y, pos.z, 3, 12000);
      if (!online()) return true;
      const block = bot.blockAt(pos);
      if (!block || !LOGS.includes(block.name)) return true;
      const tool = inst.movements?.bestHarvestTool(block);
      if (tool) await bot.equip(tool, "hand").catch(() => {});
      await bot.dig(block, true);
      log(`Survival: gathered ${block.name}`, "success");
      return true;
    }

    async function craftOnce(name, table = null) {
      const item = inst.mcData?.itemsByName?.[name];
      if (!item) return false;
      try {
        const recipes = bot.recipesFor(item.id, null, 1, table);
        if (!recipes?.length) return false;
        await bot.craft(recipes[0], 1, table);
        log(`Survival: crafted ${name}`, "success");
        return true;
      } catch (e) {
        log(`Craft ${name} skipped: ${e.message}`, "info");
        return false;
      }
    }

    async function craftBasicTools() {
      const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
      let tableBlock = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 6 });
      const hasPlanks = bot.inventory.items().some((i) => /_planks$/.test(i.name));
      const logs = bot.inventory.items().find((i) => LOGS.includes(i.name));

      if (!hasPlanks && logs) {
        const plankName = `${logs.name.replace(/_(log|stem)$/, "")}_planks`;
        if (await craftOnce(plankName)) return true;
        // Crimson/warped stems have planks with corresponding names as well.
      }
      if (!tableBlock && !tableItem && bot.inventory.items().filter((i) => /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0) >= 4) {
        if (await craftOnce("crafting_table")) return true;
        return false;
      }
      if (!tableBlock && tableItem) {
        const me = bot.entity.position;
        const supports = bot.findBlocks({ matching: (b) => b && b.boundingBox === "block" && b.name !== "crafting_table", maxDistance: 4, count: 30 });
        for (const p of supports) {
          if (p.y < Math.floor(me.y) - 1 || p.y > Math.floor(me.y) + 1) continue;
          const support = bot.blockAt(p), above = bot.blockAt(p.offset(0, 1, 0));
          if (!support || isAir(support) || !isAir(above)) continue;
          try {
            await inst.goto(p.x, p.y, p.z, 2, 8000);
            await bot.equip(tableItem, "hand");
            await bot.placeBlock(support, new Vec3(0, 1, 0));
            tableBlock = bot.blockAt(p.offset(0, 1, 0));
            if (tableBlock?.name === "crafting_table") { log("Survival: placed crafting table", "success"); return true; }
          } catch { /* try another support next tick */ }
        }
        return false;
      }
      if (tableBlock && !hasPickaxe()) {
        if (count("stick") < 2) {
          if (bot.inventory.items().some((i) => /_planks$/.test(i.name))) return await craftOnce("stick");
          return false;
        }
        for (const name of ["stone_pickaxe", "wooden_pickaxe"]) {
          if (await craftOnce(name, tableBlock)) return true;
        }
      }
      return false;
    }

    async function mineSafeSurfaceOre() {
      if (!hasPickaxe() || bot.health < 12) return false;
      const ids = ORES.map((n) => inst.mcData?.blocksByName?.[n]?.id).filter((id) => id !== undefined);
      if (!ids.length) return false;
      const me = bot.entity.position;
      const candidates = bot.findBlocks({ matching: ids, maxDistance: 10, count: 30 })
        .filter((p) => p.y >= Math.floor(me.y) - 1 && p.y <= Math.floor(me.y) + 2)
        .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
      const pos = candidates[0];
      if (!pos) return false;
      const block = bot.blockAt(pos);
      if (!block) return false;
      const tool = inst.movements?.bestHarvestTool(block);
      if (tool) await bot.equip(tool, "hand").catch(() => {});
      if (block.harvestTools && !bot.inventory.items().some((i) => block.harvestTools[i.type])) return false;
      await inst.goto(pos.x, pos.y, pos.z, 3, 12000);
      if (!online()) return true;
      const fresh = bot.blockAt(pos);
      if (!fresh || !ORES.includes(fresh.name)) return true;
      await bot.dig(fresh, true);
      log(`Survival: mined nearby ${fresh.name}`, "success");
      return true;
    }

    async function tick() {
      if (!enabled || !online() || busy) return;
      // The plugin never interrupts a user-started activity. Combat remains managed by the existing combat module.
      if (inst.activeActivity) return;
      busy = true;
      try {
        if (await eatIfNeeded()) return;
        if (await retreatIfDangerous()) return;
        if (inst.combatBusy) return;
        if (await collectNearbyDrops()) return;
        if (bot.food <= 12 && await harvestCrop()) return;
        if (await craftBasicTools()) return;
        if (await gatherLog()) return;
        if (await mineSafeSurfaceOre()) return;
        if (Date.now() - lastNoTaskLog > 120000) {
          lastNoTaskLog = Date.now();
          log(`Survival active: HP ${bot.health}/20, food ${bot.food}/20; no safe nearby task found`, "info");
        }
      } catch (e) { log(`Survival action failed: ${e.message}`, "warn"); }
      finally { busy = false; }
    }

    const service = {
      toggle() { enabled = !enabled; log(`RPG Survival ${enabled ? "enabled" : "paused"} from dashboard`, enabled ? "success" : "warn"); return enabled; },
      status() { return { enabled, busy }; },
    };
    ctx.services.rpgSurvival ||= {};
    ctx.services.rpgSurvival[inst.id] = service;
    ctx.addLog("RPG Survival enabled (AI-independent survival loop)", "success");
    ctx.every(tick, Math.max(3, Number(ctx.config.rpg_survival?.tick_interval_sec) || 5) * 1000);
    return () => { stopped = true; if (ctx.services.rpgSurvival?.[inst.id] === service) delete ctx.services.rpgSurvival[inst.id]; try { bot.clearControlStates(); } catch { /* disconnected */ } };
  }
};
