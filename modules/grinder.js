/**
 * modules/grinder.js - resource grinding (activity "grind").
 * Request: { resource: "coal", amount: 16 }  = collect 16 MORE than the bot holds now.
 * Config (optional): grind { radius: 32, max_minutes: 20, min_health: 8 }  (modules.auto_grind.enabled === false turns it off)
 *
 * Before starting (prepare): bot online, health >= min_health, not starving without food, a free slot (or stack space),
 * the right tool for at least one matching block (from the block's harvestTools), and at least one matching block within radius.
 * Progress = the REAL inventory count of the target item (not blocks dug). Success is reported only when it reaches the goal;
 * otherwise the task fails with the reason (no tool, inventory full, nothing reachable, too many failures, timeout).
 * Only digs blocks - never places or breaks anything outside the resource list. Navigation goes through inst.nav (owner "grind").
 */
const { Vec3 } = require("vec3");

// resource -> block names that drop it. (legacy: item name on Minecraft < 1.17 where raw_* items do not exist)
const RESOURCES = {
  oak_log: { blocks: ["oak_log"] }, birch_log: { blocks: ["birch_log"] }, spruce_log: { blocks: ["spruce_log"] },
  jungle_log: { blocks: ["jungle_log"] }, acacia_log: { blocks: ["acacia_log"] }, dark_oak_log: { blocks: ["dark_oak_log"] },
  mangrove_log: { blocks: ["mangrove_log"] }, cherry_log: { blocks: ["cherry_log"] },
  cobblestone: { blocks: ["stone", "cobblestone"] }, cobbled_deepslate: { blocks: ["deepslate"] },
  dirt: { blocks: ["dirt", "grass_block"] }, sand: { blocks: ["sand"] }, gravel: { blocks: ["gravel"] },
  coal: { blocks: ["coal_ore", "deepslate_coal_ore"] },
  raw_iron: { blocks: ["iron_ore", "deepslate_iron_ore"], legacy: "iron_ore" },
  raw_copper: { blocks: ["copper_ore", "deepslate_copper_ore"] },
  raw_gold: { blocks: ["gold_ore", "deepslate_gold_ore"], legacy: "gold_ore" },
  diamond: { blocks: ["diamond_ore", "deepslate_diamond_ore"] }, emerald: { blocks: ["emerald_ore", "deepslate_emerald_ore"] },
  lapis_lazuli: { blocks: ["lapis_ore", "deepslate_lapis_ore"] }, redstone: { blocks: ["redstone_ore", "deepslate_redstone_ore"] },
};

function create(inst) {
  const bot = inst.bot;
  const cfg = () => ({ radius: 32, max_minutes: 20, min_health: 8, ...(inst.config.grind || {}) });
  let running = false;

  const reg = () => inst.mcData;
  const itemOf = (def, key) => { const d = reg(); return d.itemsByName[key] || (def.legacy && d.itemsByName[def.legacy]) || null; };
  const count = (item) => bot.inventory.count(item.id);
  const toolNames = (blockDef) => Object.keys(blockDef.harvestTools || {}).map((id) => reg().items[id]?.name).filter(Boolean);
  const harvestable = (blockDef) => !blockDef.harvestTools || bot.inventory.items().some((i) => blockDef.harvestTools[i.type]);
  const hasRoom = (item) => bot.inventory.emptySlotCount() > 0 || bot.inventory.items().some((i) => i.type === item.id && i.count < i.stackSize);

  /** Validate everything and return a plan, or throw an Error that says exactly what is wrong. */
  async function prepare(p) {
    if (!inst.isOnline()) throw new Error("Bot is not online");
    const c = cfg(), key = String(p.resource || "").trim().toLowerCase().replace(/\s+/g, "_");
    const def = RESOURCES[key];
    if (!def) throw new Error(`Unknown resource "${key}". Supported: ${Object.keys(RESOURCES).join(", ")}`);
    const amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 2304) throw new Error("Amount must be a whole number between 1 and 2304");
    const item = itemOf(def, key);
    if (!item) throw new Error(`${key} does not exist in Minecraft ${bot.version}`);
    const blockDefs = def.blocks.map((n) => reg().blocksByName[n]).filter(Boolean);
    if (!blockDefs.length) throw new Error(`No block that drops ${key} exists in Minecraft ${bot.version}`);

    if (bot.health < c.min_health) throw new Error(`Health too low to grind (${bot.health.toFixed(1)}/20, need ${c.min_health}). Let the bot recover first`);
    const foods = reg().foodsByName || {};
    if (bot.food <= 4 && !bot.inventory.items().some((i) => foods[i.name])) throw new Error(`Bot is starving (food ${bot.food}/20) and has no food`);
    if (!hasRoom(item)) throw new Error("Inventory is full - free a slot before grinding");

    const usable = blockDefs.filter(harvestable);
    if (!usable.length) {
      const need = [...new Set(blockDefs.flatMap(toolNames))];
      throw new Error(`Missing tool: cannot mine ${def.blocks.join("/")} without one of: ${need.join(", ") || "a suitable tool"}`);
    }
    const ids = usable.map((b) => b.id);
    const near = bot.findBlocks({ matching: ids, maxDistance: c.radius, count: 32 });
    if (!near.length) throw new Error(`No ${usable.map((b) => b.name).join("/")} within ${c.radius} blocks of the bot. Move the bot to a place that has it`);
    const notes = blockDefs.length > usable.length ? [`Skipping ${blockDefs.filter((b) => !harvestable(b)).map((b) => b.name).join(", ")} (tool not good enough)`] : [];
    const baseline = count(item);
    return { resource: key, item: item.name, itemId: item.id, amount, baseline, goal: baseline + amount, blocks: usable.map((b) => b.name), radius: c.radius, nearby: near.length, notes };
  }

  async function run(params) {
    if (running) return;
    const plan = params._plan || (await prepare(params));
    running = true;
    const c = cfg(), item = reg().items[plan.itemId], deadline = Date.now() + c.max_minutes * 60000;
    const bad = new Set(), key = (v) => `${v.x},${v.y},${v.z}`;
    let failures = 0, emptyScans = 0, dug = 0, last = "";
    inst.addLog(`Grinding ${plan.amount} ${plan.item} (have ${plan.baseline}, goal ${plan.goal}) from ${plan.blocks.join("/")}`, "control");
    const have = () => count(item), got = () => Math.max(0, have() - plan.baseline);
    const detail = (state) => inst.setTaskDetail({ kind: "grind", resource: plan.item, collected: got(), target: plan.amount, state });
    const fail = (msg) => inst.finishTask("grind", false, `${msg} (collected ${got()} of ${plan.amount} ${plan.item})`, { collected: got(), target: plan.amount });
    try {
      while (running && inst.isOnline()) {
        await inst.waitReady();
        if (!running) break;
        if (have() >= plan.goal) { inst.finishTask("grind", true, `Collected ${got()} ${plan.item} (inventory now ${have()})`, { collected: got(), target: plan.amount }); return; }
        if (Date.now() > deadline) return fail(`Timed out after ${c.max_minutes} min`);
        if (!hasRoom(item)) return fail("Inventory is full");
        const defs = plan.blocks.map((n) => reg().blocksByName[n]).filter(harvestable);
        if (!defs.length) return fail("No suitable tool left (broken or dropped)");
        const ids = defs.map((b) => b.id);
        detail("searching");
        const targets = bot.findBlocks({ matching: ids, maxDistance: plan.radius, count: 24 })
          .filter((v) => !bad.has(key(v)))
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, 6);
        if (!targets.length) {
          if (++emptyScans >= 3) return fail(`No more reachable ${plan.blocks.join("/")} within ${plan.radius} blocks`);
          await inst.sleep(4000); continue;
        }
        emptyScans = 0;
        for (const t of targets) {
          if (!running || !inst.isOnline() || have() >= plan.goal) break;
          await inst.waitReady();
          try {
            const pos = new Vec3(t.x, t.y, t.z), block = bot.blockAt(pos);
            if (!block || !ids.includes(block.type)) continue;
            detail("mining");
            await inst.goto(pos.x, pos.y, pos.z, 3, 25000);
            const tool = inst.movements?.bestHarvestTool(block);
            if (tool) await bot.equip(tool, "hand").catch(() => {});
            await bot.dig(block, true);
            dug++; failures = 0;
          } catch (e) {
            if (e.cancelled) return;                       // stopped by user / disconnected: not a failure
            bad.add(key(t)); failures++; last = e.message;
            inst.addLog(`Grind: skipping unreachable ${plan.blocks[0]} at ${t.x},${t.y},${t.z} (${e.message})`, "warn");
            if (failures >= 6) return fail(`Too many unreachable targets in a row (last error: ${last})`);
          }
        }
        if (running) { detail("collecting"); await inst.collectDrops(8, 10); await inst.sleep(300); }
      }
    } catch (e) { if (running && !e.cancelled) fail(`Grinder error: ${e.message}`); }
    running = false;
  }

  return {
    prepare, run,
    halt() {
      if (!running) return;
      running = false;
      inst.lastResult = { task: "grind", ok: false, message: `Stopped by user before the goal was reached (collected ${inst.taskDetail?.collected ?? 0} of ${inst.taskDetail?.target ?? "?"})`, ts: Date.now() };
    },
    stop() { running = false; },
  };
}
module.exports = { create, RESOURCES };
