/**
 * modules/housebuilder.js - small survival house (activity "house").
 * Request: { size?: 4..7 (default 5), material?: "oak_planks", x?, y?, z?, allowPartial?: false }
 *   x,y,z = centre of the footprint at FLOOR level (the first air layer above the ground). Omit them to let the bot pick the
 *   nearest flat, clear spot within 14 blocks.
 * Shape: size x size footprint, 3-high walls, flat roof, 1x2 doorway left open (no door item needed). Floor = existing ground.
 *
 * Safety: NEVER digs or breaks anything. If any cell the house needs (walls, roof, interior, doorway) holds a block that is not
 * air / replaceable plants, the plan fails and lists them - so existing player builds are not touched. Ground under the whole
 * footprint must be solid. Blocks are placed from inventory only; every placement is verified with blockAt(), failures are retried
 * then reported. Interrupted builds can be resumed: cells that already hold the material are skipped.
 * plan() is read-only (dashboard "Check area"); prepare()/run() build.
 */
const { Vec3 } = require("vec3");
const { goals } = require("mineflayer-pathfinder");

const HEIGHT = 3;
const REPLACEABLE = new Set(["air", "cave_air", "void_air", "short_grass", "grass", "tall_grass", "fern", "large_fern", "dead_bush", "snow"]);
const AUTO_OK = /^(?:[a-z_]+_planks|cobblestone|stone|stone_bricks|bricks|sandstone|cobbled_deepslate|deepslate_bricks|smooth_stone|dirt)$/;
const DENY = /(diamond|emerald|netherite|gold|iron|lapis|redstone|beacon|tnt|spawner|command|barrier|bedrock|chest|shulker|obsidian|sand$|gravel|powder|anvil)/;

const ringCells = (off, m) => {            // cells of a square ring in walking order (m x m at offset off)
  if (m <= 0) return [];
  if (m === 1) return [[off, off]];
  const out = [], hi = off + m - 1;
  for (let x = off; x <= hi; x++) out.push([x, off]);
  for (let z = off + 1; z <= hi; z++) out.push([hi, z]);
  for (let x = hi - 1; x >= off; x--) out.push([x, hi]);
  for (let z = hi - 1; z > off; z--) out.push([off, z]);
  return out;
};

function create(inst) {
  const bot = inst.bot;
  let running = false, lastSite = null;   // lastSite: unfinished build on this connection, reused when no coordinates are given
  const reg = () => inst.mcData;
  const nameAt = (v) => (bot.blockAt(v) || { name: "unknown" }).name;
  const count = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
  const solidGround = (v) => { const b = bot.blockAt(v); return !!b && b.boundingBox === "block" && !/leaves|ice|cactus|magma|campfire|fire|lava|water/.test(b.name); };

  function pickMaterial(requested, required) {
    if (requested) {
      const m = String(requested).toLowerCase(), b = reg().blocksByName[m];
      if (!b) throw new Error(`Unknown block "${requested}"`);
      if (b.boundingBox !== "block" || DENY.test(m)) throw new Error(`"${m}" is not allowed as a house material (valuable, gravity-affected or non-solid)`);
      return m;
    }
    const tally = {};
    for (const i of bot.inventory.items()) if (AUTO_OK.test(i.name)) tally[i.name] = (tally[i.name] || 0) + i.count;
    const names = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
    if (!names.length) return null;
    return names.find((n) => tally[n] >= required) || names[0];
  }

  /** Cells (relative x,z in 0..s-1) and absolute y for walls+roof, plus door cells. */
  function layout(s, y0, door) {
    const wall = [];
    for (let dy = 0; dy < HEIGHT; dy++) for (const [x, z] of ringCells(0, s)) {
      if (x === door.x && z === door.z && dy < 2) continue;                    // doorway: 1 wide, 2 high
      wall.push({ x, z, y: y0 + dy });
    }
    const roof = [];
    for (let k = 0; k <= Math.floor((s - 1) / 2); k++) for (const [x, z] of ringCells(k, s - 2 * k)) roof.push({ x, z, y: y0 + HEIGHT });
    return { wall, roof };
  }

  const DOORS = (s) => { const c = Math.floor(s / 2); return [{ x: c, z: 0, out: [0, -1], side: "north" }, { x: s - 1, z: c, out: [1, 0], side: "east" }, { x: c, z: s - 1, out: [0, 1], side: "south" }, { x: 0, z: c, out: [-1, 0], side: "west" }]; };

  /** Examine one candidate site. Returns { conflicts[], unsupported, door, cells, todo, already }. */
  function analyze(corner, y0, s, material) {
    const conflicts = [];
    let unsupported = 0;
    for (let x = 0; x < s; x++) for (let z = 0; z < s; z++) if (!solidGround(new Vec3(corner.x + x, y0 - 1, corner.z + z))) unsupported++;
    // choose the doorway side whose outside cell is walkable
    let door = null;
    for (const d of DOORS(s)) {
      const ox = corner.x + d.x + d.out[0], oz = corner.z + d.z + d.out[1];
      if (REPLACEABLE.has(nameAt(new Vec3(ox, y0, oz))) && REPLACEABLE.has(nameAt(new Vec3(ox, y0 + 1, oz))) && solidGround(new Vec3(ox, y0 - 1, oz))) { door = d; break; }
    }
    if (!door) door = DOORS(s)[0];
    const { wall, roof } = layout(s, y0, door);
    const cells = [...wall, ...roof], todo = [];
    let already = 0;
    for (const c of cells) {
      const v = new Vec3(corner.x + c.x, c.y, corner.z + c.z), n = nameAt(v);
      if (n === material) already++;
      else if (REPLACEABLE.has(n)) todo.push({ ...c, v });
      else conflicts.push(`${n} at ${v.x},${v.y},${v.z}`);
    }
    // interior + doorway must also be free (we do not want to wall in somebody's furniture or builds)
    for (let x = 1; x < s - 1; x++) for (let z = 1; z < s - 1; z++) for (let dy = 0; dy < HEIGHT; dy++) {
      const v = new Vec3(corner.x + x, y0 + dy, corner.z + z), n = nameAt(v);
      if (!REPLACEABLE.has(n)) conflicts.push(`${n} inside at ${v.x},${v.y},${v.z}`);
    }
    for (let dy = 0; dy < 2; dy++) { const v = new Vec3(corner.x + door.x, y0 + dy, corner.z + door.z), n = nameAt(v); if (!REPLACEABLE.has(n)) conflicts.push(`${n} in doorway at ${v.x},${v.y},${v.z}`); }
    return { conflicts, unsupported, door, cells, todo, already, wall, roof };
  }

  const groundY = (x, z) => {                       // floor level (first air above a solid block) near the bot's height
    const by = Math.floor(bot.entity.position.y);
    for (let y = by + 3; y >= by - 4; y--) {
      if (solidGround(new Vec3(x, y - 1, z)) && REPLACEABLE.has(nameAt(new Vec3(x, y, z)))) return y;
    }
    return null;
  };

  /** Read-only planning. Never throws for "problems with the site" - they come back in issues[] with ok:false. */
  function plan(p = {}) {
    if (!inst.isOnline()) throw new Error("Bot is not online");
    const s = Math.round(Number(p.size) || 5);
    if (s < 4 || s > 7) throw new Error("size must be between 4 and 7");
    const issues = [], half = Math.floor(s / 2);
    let corner = null, y0 = null, auto = false;
    const me = bot.entity.position.floored();

    const material0 = p.material ? pickMaterial(p.material, 0) : null;
    if (p.x !== undefined && p.x !== "" && p.z !== undefined && p.z !== "") {
      const cx = Math.floor(Number(p.x)), cz = Math.floor(Number(p.z));
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) throw new Error("x and z must be numbers");
      y0 = p.y !== undefined && p.y !== "" ? Math.floor(Number(p.y)) : groundY(cx, cz);
      if (y0 === null || !Number.isFinite(y0)) { return { ok: false, issues: [`Cannot find ground at ${cx},${cz} (area not loaded or too far from the bot's height). Give y explicitly or move the bot closer`], size: s }; }
      corner = new Vec3(cx - half, y0, cz - half);
    } else {
      auto = true;
      if (lastSite && lastSite.size === s) {                          // resume an interrupted build at the same site
        const m = material0 || lastSite.material, a = analyze(lastSite.corner, lastSite.corner.y, s, m);
        if (!a.conflicts.length && !a.unsupported) { corner = lastSite.corner.clone(); y0 = corner.y; }
      }
      const cands = [];
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) cands.push([dx, dz, dx * dx + dz * dz]);
      cands.sort((a, b) => a[2] - b[2]);
      for (const [dx, dz] of corner ? [] : cands) {
        const cx = me.x + dx, cz = me.z + dz, gy = groundY(cx, cz);
        if (gy === null) continue;
        const c = new Vec3(cx - half, gy, cz - half);
        const a = analyze(c, gy, s, material0 || "__none__");
        if (!a.conflicts.length && !a.unsupported) { corner = c; y0 = gy; break; }
      }
      if (!corner) return { ok: false, issues: ["No flat, clear, solid 5x5-style area found within 14 blocks. Move the bot to open flat ground or specify x/y/z"], size: s };
    }

    // first pass (to know how many blocks are needed), then pick material
    const a0 = analyze(corner, y0, s, material0 || "__none__");
    const material = material0 || pickMaterial(null, a0.todo.length);
    if (!material) issues.push("No usable building blocks in inventory (planks, cobblestone, stone, bricks, dirt...)");
    const a = material ? analyze(corner, y0, s, material) : a0;
    if (a.unsupported) issues.push(`${a.unsupported} footprint tile(s) have no solid ground below - the bot does not build floors or foundations`);
    if (a.conflicts.length) issues.push(`Area is not clear: ${a.conflicts.length} cell(s) already contain blocks, e.g. ${a.conflicts.slice(0, 3).join("; ")}. The bot will not remove them`);
    const required = a.todo.length, available = material ? count(material) : 0, missing = Math.max(0, required - available);
    const partial = !!p.allowPartial;
    if (material && missing > 0) issues.push(`Missing materials: need ${required} ${material}, have ${available} (short by ${missing})${partial ? " - building as far as possible (allowPartial)" : ""}`);
    const hard = issues.filter((i) => !(partial && i.startsWith("Missing materials")));
    return {
      ok: hard.length === 0, issues, size: s, height: HEIGHT, auto, material, required, available, missing, alreadyBuilt: a.already,
      origin: { x: corner.x + half, y: y0, z: corner.z + half }, corner: { x: corner.x, y: y0, z: corner.z },
      door: { side: a.door.side, x: corner.x + a.door.x, y: y0, z: corner.z + a.door.z }, partial,
    };
  }

  async function prepare(p) {
    const pl = plan(p);
    if (!pl.ok) throw new Error(pl.issues.join(" | "));
    if (bot.health < 8) throw new Error(`Health too low to build (${bot.health.toFixed(1)}/20)`);
    return pl;
  }

  // ---------- building ----------
  const eyeDist = (stand, cell) => Math.hypot(stand.x + 0.5 - (cell.x + 0.5), stand.y + 1.62 - (cell.y + 0.5), stand.z + 0.5 - (cell.z + 0.5));

  function standSpot(cell, an, corner, y0, s) {
    const blocked = new Set(an.wall.filter((c) => c.y <= y0 + 1).map((c) => `${corner.x + c.x},${corner.z + c.z}`));
    let best = null, bd = Infinity;
    for (let x = corner.x - 2; x <= corner.x + s + 1; x++) for (let z = corner.z - 2; z <= corner.z + s + 1; z++) {
      if (blocked.has(`${x},${z}`)) continue;
      if (cell.y <= y0 + 1 && x === cell.x && z === cell.z) continue;
      const st = new Vec3(x, y0, z);
      if (!(solidGround(st.offset(0, -1, 0)) && REPLACEABLE.has(nameAt(st)) && REPLACEABLE.has(nameAt(st.offset(0, 1, 0))))) continue;
      if (eyeDist(st, cell) > 4.2) continue;
      const d = st.distanceTo(bot.entity.position);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  async function placeCell(cell, item, an, corner, y0, s) {
    const stand = standSpot(cell, an, corner, y0, s);
    if (!stand) return "no reachable standing position";
    const here = bot.entity.position;
    if (Math.abs(here.x - (stand.x + 0.5)) > 0.8 || Math.abs(here.z - (stand.z + 0.5)) > 0.8 || Math.abs(here.y - stand.y) > 1) {
      await inst.nav.goto("house", new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000 });
    }
    const v = cell.v;
    const order = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (nameAt(v) === item.name) return null;
      let ref = null, face = null;
      for (const o of order) { const r = bot.blockAt(v.offset(o[0], o[1], o[2])); if (r && r.boundingBox === "block") { ref = r; face = new Vec3(-o[0], -o[1], -o[2]); break; } }
      if (!ref) return "no adjacent solid block to place against";
      try {
        await bot.equip(item, "hand");
        await bot.lookAt(v.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(ref, face);
      } catch (e) { if (attempt === 2) return `placement failed: ${e.message}`; }
      await inst.sleep(150);
      if (nameAt(v) === item.name) return null;
    }
    return `block did not appear (found ${nameAt(v)})`;
  }

  async function run(params) {
    if (running) return;
    const pl = params._plan || (await prepare(params));
    running = true;
    const s = pl.size, corner = new Vec3(pl.corner.x, pl.corner.y, pl.corner.z), y0 = pl.corner.y, deadline = Date.now() + 15 * 60000;
    let placed = 0, outOfMaterial = false;
    const failed = [];
    try {
      const an = analyze(corner, y0, s, pl.material);
      if (an.conflicts.length) throw new Error(`Area changed since planning: ${an.conflicts.slice(0, 3).join("; ")}`);
      const queue = [...an.wall.map((c) => ({ ...c, v: new Vec3(corner.x + c.x, c.y, corner.z + c.z) })), ...an.roof.map((c) => ({ ...c, v: new Vec3(corner.x + c.x, c.y, corner.z + c.z) }))];
      const total = queue.length;
      lastSite = { corner: corner.clone(), size: s, material: pl.material };
      inst.addLog(`Building ${s}x${s} house of ${pl.material} at ${pl.origin.x},${pl.origin.y},${pl.origin.z} (${pl.required} blocks to place)`, "control");
      for (let pass = 0; pass < 2 && running; pass++) {
        const retry = [];
        for (const cell of queue) {
          if (!running || !inst.isOnline()) break;
          if (Date.now() > deadline) { running = false; failed.push({ cell: cell.v, why: "timeout" }); break; }
          await inst.waitReady();
          const n = nameAt(cell.v);
          if (n === pl.material) continue;
          if (!REPLACEABLE.has(n)) { failed.push({ cell: cell.v, why: `blocked by ${n}` }); continue; }
          const item = bot.inventory.items().find((i) => i.name === pl.material);
          if (!item) { outOfMaterial = true; running = false; break; }
          inst.setTaskDetail({ kind: "house", material: pl.material, placed, remaining: queue.filter((c) => nameAt(c.v) !== pl.material).length, total, state: "building" });
          let why;
          try { why = await placeCell(cell, item, an, corner, y0, s); }
          catch (e) { if (e.cancelled) return; why = e.message; }
          if (why) { if (pass === 0 && /adjacent solid/.test(why)) retry.push(cell); else failed.push({ cell: cell.v, why }); }
          else placed++;
        }
        if (!retry.length) break;
        queue.length = 0; queue.push(...retry);
      }
      // Final verification straight from the world - the only thing that counts as "finished"
      const finalAn = analyze(corner, y0, s, pl.material);
      const stillMissing = finalAn.todo.length;
      const reasons = [...new Set(failed.map((f) => f.why))].slice(0, 3).join("; ");
      if (!stillMissing && !failed.length) lastSite = null;
      if (!stillMissing && !failed.length) return inst.finishTask("house", true, `House finished: ${placed} block(s) placed, doorway open on the ${pl.door.side} side at ${pl.door.x},${pl.door.y},${pl.door.z}`, { placed });
      const head = outOfMaterial ? `Ran out of ${pl.material}` : !running ? "Interrupted" : "Build incomplete";
      return inst.finishTask("house", false, `${head}: ${stillMissing} block(s) still missing after placing ${placed}${reasons ? ` (${reasons})` : ""}. Run again to continue at the same site (centre ${pl.origin.x},${pl.origin.y},${pl.origin.z}) - finished blocks are kept`, { placed, missing: stillMissing });
    } catch (e) { if (!e.cancelled) inst.finishTask("house", false, `House build failed: ${e.message}`); }
    finally { running = false; }
  }

  return {
    plan, prepare, run,
    halt() { if (running) { running = false; inst.lastResult = { task: "house", ok: false, message: `Stopped by user (${inst.taskDetail?.remaining ?? "?"} block(s) still to place). Run again to continue at the same site`, ts: Date.now() }; } },
    stop() { running = false; },
  };
}
module.exports = { create, ringCells };
