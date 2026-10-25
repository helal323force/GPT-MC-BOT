/**
 * modules/builder.js - build from a schematic (.schem / .schematic / .nbt) via prismarine-schematic.
 * Config (modules.auto_build): enabled, schematic_path
 * run({ data: <base64>|path, x, y, z }) - origin defaults to the bot's position.
 * Places blocks bottom-up using the inventory (no creative/WorldEdit). Missing materials are skipped
 * and reported. Test with a tiny schematic first.
 */
const fs = require("fs");
const { Vec3 } = require("vec3");

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

function create(inst) {
  const bot = inst.bot;
  let running = false;

  async function load(p) {
    const { Schematic } = require("prismarine-schematic");
    let buf;
    if (p.data && /^[A-Za-z0-9+/=\r\n]+$/.test(String(p.data)) && String(p.data).length > 255) buf = Buffer.from(String(p.data), "base64");
    else {
      const file = p.data || p.path || inst.config.modules.auto_build.schematic_path;
      if (!file) throw new Error("No schematic provided (data or modules.auto_build.schematic_path)");
      buf = fs.readFileSync(file);
    }
    return Schematic.read(buf, bot.version);
  }

  async function placeAt(target, itemName) {
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return "missing";
    await inst.goto(target.x, target.y, target.z, 4, 15000);
    await bot.equip(item, "hand");
    for (const f of FACES) {
      const ref = bot.blockAt(target.plus(f));
      if (ref && ref.boundingBox === "block") {
        await bot.placeBlock(ref, f.scaled(-1));
        return "placed";
      }
    }
    return "noref";
  }

  async function run(p = {}) {
    if (running) return;
    running = true;
    try {
      const sch = await load(p);
      const o = bot.entity.position.floored();
      const origin = new Vec3(Number.isFinite(+p.x) && p.x !== undefined ? +p.x : o.x, Number.isFinite(+p.y) && p.y !== undefined ? +p.y : o.y, Number.isFinite(+p.z) && p.z !== undefined ? +p.z : o.z);
      const start = sch.start(), end = sch.end();
      inst.addLog(`Building ${end.x - start.x}x${end.y - start.y}x${end.z - start.z} at ${origin.x},${origin.y},${origin.z}`, "control");
      const missing = new Map();
      let placed = 0;
      for (let y = start.y; y < end.y && running; y++)
        for (let z = start.z; z < end.z && running; z++)
          for (let x = start.x; x < end.x && running; x++) {
            if (!inst.isOnline()) throw new Error("bot went offline");
            await inst.waitReady();
            const sb = sch.getBlock(new Vec3(x, y, z));
            if (!sb || sb.name === "air" || sb.name.endsWith("_air")) continue;
            const target = origin.offset(x - start.x, y - start.y, z - start.z);
            const cur = bot.blockAt(target);
            if (cur && cur.name === sb.name) continue;
            try {
              const r = await placeAt(target, sb.name);
              if (r === "placed") placed++; else if (r === "missing") missing.set(sb.name, (missing.get(sb.name) || 0) + 1);
            } catch (e) { inst.addLog(`Build: ${e.message}`, "warn"); }
          }
      inst.addLog(`Build finished: ${placed} placed${missing.size ? ", missing " + [...missing].map(([k, v]) => `${k}x${v}`).join(", ") : ""}`, missing.size ? "warn" : "success");
    } catch (e) { inst.addLog(`Builder: ${e.message}`, "error"); }
    running = false;
    inst.activityDone("build");
  }

  return { run, halt() { running = false; }, stop() { running = false; } };
}
module.exports = { create };
