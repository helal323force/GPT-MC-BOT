/**
 * modules/invtools.js - inventory listing + safe item dropping (used by routes/extras.js).
 * Config (optional): inventory { protected_items: ["name", "prefix*", "*suffix"], block_protected_drops: false }
 * Built-in protected list: netherite/diamond gear and blocks, elytra, totems, enchanted golden apples, nether stars, beacons,
 * dragon eggs, shulker boxes, ender chests, tridents, ... plus ANY enchanted or custom-named item.
 * drop({name, count, confirmProtected}):
 *   - validates name + whole-number count against the real inventory (never more than the bot holds)
 *   - protected items need confirmProtected: true (HTTP 409 {requiresConfirm:true} otherwise), or are refused outright when
 *     block_protected_drops is true (HTTP 403)
 *   - success is reported only if the inventory count really dropped by the requested amount; otherwise an error says how many
 *     were dropped. Only main inventory/hotbar slots are touched (never armor or the off-hand). One drop at a time.
 * Note: dropped items can be picked up again if the bot stays next to them.
 */
const DEFAULT_PROTECTED = ["netherite_*", "diamond*", "emerald_block", "elytra", "totem_of_undying", "enchanted_golden_apple", "nether_star", "beacon", "dragon_egg", "*shulker_box", "ender_chest", "trident", "heart_of_the_sea", "mace", "written_book"];

const globRe = (g) => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

function create(inst) {
  const bot = inst.bot;
  let dropping = false;
  const err = (msg, status, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
  const patterns = () => [...DEFAULT_PROTECTED, ...(inst.config.inventory?.protected_items || [])].map(globRe);

  function protection(item) {
    if (patterns().some((re) => re.test(item.name))) return "protected item";
    let ench = 0; try { ench = (item.enchants || []).length; } catch { /* no nbt */ }
    if (ench) return "enchanted";
    try { if (item.customName || item.nbt?.value?.display?.value?.Name) return "custom-named"; } catch { /* ignore */ }
    return null;
  }

  function list() {
    if (!inst.isOnline()) throw err("Bot is not online", 409);
    const map = new Map();
    for (const i of bot.inventory.items()) {
      const g = map.get(i.name) || { name: i.name, displayName: i.displayName, count: 0, protected: false, reason: null };
      g.count += i.count;
      const r = protection(i); if (r && !g.protected) { g.protected = true; g.reason = r; }
      map.set(i.name, g);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function drop({ name, count, confirmProtected = false } = {}) {
    if (!inst.isOnline()) throw err("Bot is not online", 409);
    name = String(name || "").trim();
    if (!name) throw err("Choose an item to drop", 400);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) throw err("Amount must be a whole number of at least 1", 400);
    if (dropping) throw err("Another drop is still in progress", 409);
    const stacksNow = () => bot.inventory.items().filter((i) => i.name === name);
    let stacks = stacksNow();
    if (!stacks.length) throw err(`"${name}" is not in the bot's inventory`, 404);
    const total = stacks.reduce((s, i) => s + i.count, 0);
    if (n > total) throw err(`Only ${total} ${name} available - cannot drop ${n}`, 400, { available: total });
    const why = stacks.map(protection).find(Boolean);
    if (why) {
      if (inst.config.inventory?.block_protected_drops) throw err(`${name} is ${why} and dropping protected items is disabled in settings`, 403);
      if (!confirmProtected) throw err(`${name} is ${why}. Confirm to drop it`, 409, { requiresConfirm: true, reason: why });
    }
    dropping = true;
    try {
      let remaining = n;
      while (remaining > 0) {
        stacks = stacksNow().sort((a, b) => a.count - b.count);          // re-read: the inventory may have changed
        if (!stacks.length) break;
        const st = stacks[0], take = Math.min(remaining, st.count);
        await bot.toss(st.type, st.metadata ?? null, take);
        remaining -= take;
      }
      await inst.sleep(400);                                              // let the server confirm the inventory change
      const after = stacksNow().reduce((s, i) => s + i.count, 0), dropped = total - after;
      if (dropped !== n) throw err(`Dropped ${dropped} of ${n} ${name} - the inventory changed while dropping`, 409, { dropped, remaining: after });
      inst.addLog(`Dropped ${dropped} ${name} (${after} left)`, "control");
      return { dropped, remaining: after, note: "Dropped items can be picked up again if the bot stays nearby." };
    } finally { dropping = false; }
  }

  return { list, drop, protection, stop() { dropping = false; } };
}
module.exports = { create, DEFAULT_PROTECTED, globRe };
