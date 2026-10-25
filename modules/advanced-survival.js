/**
 * Advanced survival activities. These are deliberately conservative client-side
 * helpers: they never issue server commands, never bypass claims/permissions,
 * and report missing world state instead of claiming success.
 */
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const database = require('../core/database');

const MAX_MEMORY = 500;
const HAZARDS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water', 'fire', 'soul_fire', 'cactus', 'magma_block']);
const KEEP_ITEMS = /(?:sword|pickaxe|axe|shovel|hoe|shield|bow|crossbow|trident|food|bread|apple|carrot|potato|beef|porkchop|chicken|mutton|rabbit|cod|salmon|tropical_fish|torch|bucket|elytra|totem|boat|water_bucket|golden_apple)/;
const BOSS_NAMES = new Set(['ender_dragon', 'wither', 'warden', 'elder_guardian', 'ravager', 'evoker', 'piglin_brute']);

function create(inst) {
  const bot = inst.bot;
  let active = new Set();
  const memoryKey = `world_memory:${inst.id}`;
  const memory = () => {
    const v = database.kvGet(memoryKey, { waypoints: [], explored: [], resources: [], events: [] });
    return { waypoints: [], explored: [], resources: [], events: [], ...(v && typeof v === 'object' ? v : {}) };
  };
  function saveMemory(m) {
    m.waypoints = (m.waypoints || []).slice(-MAX_MEMORY);
    m.explored = (m.explored || []).slice(-MAX_MEMORY);
    m.resources = (m.resources || []).slice(-MAX_MEMORY);
    m.events = (m.events || []).slice(-MAX_MEMORY);
    database.kvSet(memoryKey, m);
    return m;
  }
  function remember(kind, data) {
    const m = memory();
    const list = Array.isArray(m[kind]) ? m[kind] : (m[kind] = []);
    list.push({ ...data, ts: Date.now(), dimension: bot.game?.dimension || null });
    saveMemory(m);
  }
  function activeCheck(name) { return active.has(name) && inst.isOnline(); }
  function begin(name) { active.add(name); }
  function end(name) { active.delete(name); }
  function nearestBlock(names, maxDistance = 8) {
    const ids = names.map(n => inst.mcData?.blocksByName?.[n]?.id).filter(Number.isInteger);
    if (!ids.length) return null;
    const p = bot.findBlock({ matching: ids, maxDistance });
    return p ? bot.blockAt(p) : null;
  }
  function inventoryCount(name) { return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0); }

  async function branchMine(params = {}) {
    const name = 'branchmine'; begin(name);
    const length = Math.max(4, Math.min(48, Math.floor(Number(params.length) || 16)));
    const axis = params.axis === 'z' ? 'z' : 'x';
    const sign = Number(params.sign) < 0 ? -1 : 1;
    const base = bot.entity.position.floored();
    const y = Number.isFinite(Number(params.y)) ? Math.floor(Number(params.y)) : base.y;
    let dug = 0;
    inst.addLog(`Branch mining started: ${length} blocks along ${axis.toUpperCase()}`, 'control');
    try {
      for (let i = 1; i <= length && activeCheck(name); i++) {
        await inst.waitReady();
        const x = Math.floor(base.x + (axis === 'x' ? sign * i : 0));
        const z = Math.floor(base.z + (axis === 'z' ? sign * i : 0));
        const floor = bot.blockAt(new Vec3(x, y - 1, z));
        const feet = bot.blockAt(new Vec3(x, y, z));
        const head = bot.blockAt(new Vec3(x, y + 1, z));
        const hazard = [floor, feet, head].find(b => b && HAZARDS.has(b.name));
        if (hazard) { inst.addLog(`Branch mining stopped for safety at ${x},${y},${z}: ${hazard.name}`, 'warn'); break; }
        for (const b of [head, feet]) {
          if (!activeCheck(name)) break;
          if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
          if (b.name === 'bedrock' || b.name === 'barrier' || b.name === 'end_portal_frame') throw new Error(`Branch mining blocked by ${b.name}`);
          if (!b.diggable) throw new Error(`Cannot dig ${b.name}; stopping tunnel`);
          const tool = inst.movements?.bestHarvestTool(b);
          if (tool) await bot.equip(tool, 'hand').catch(() => {});
          await bot.dig(b, true);
          dug++;
        }
        if (i % 4 === 0) inst.setTaskDetail({ phase: 'branchmine', progress: i, total: length, dug });
      }
      remember('explored', { x: base.x, y, z: base.z, kind: 'branchmine', length, dug });
      inst.finishTask(name, true, `Branch mining ended; dug ${dug} block(s)`);
    } finally { end(name); }
  }

  async function loot(params = {}) {
    const name = 'loot'; begin(name);
    const radius = Math.max(2, Math.min(24, Number(params.radius) || 10));
    const max = Math.max(1, Math.min(32, Math.floor(Number(params.max) || 12)));
    try {
      const before = bot.inventory.items().reduce((n, i) => n + i.count, 0);
      await inst.collectDrops(radius, max);
      const after = bot.inventory.items().reduce((n, i) => n + i.count, 0);
      const collected = Math.max(0, after - before);
      remember('events', { kind: 'loot', collected });
      inst.finishTask(name, true, `Loot sweep ended; inventory gained ${collected} item(s) (server pickup confirmation can be delayed)`, { collected });
    } finally { end(name); }
  }

  async function smelt(params = {}) {
    const name = 'smelt'; begin(name);
    const furnace = nearestBlock(['furnace', 'blast_furnace', 'smoker'], Number(params.radius) || 8);
    if (!furnace) { end(name); throw new Error('No furnace, blast furnace, or smoker found nearby'); }
    let window;
    try {
      window = await bot.openFurnace(furnace);
      const rawNames = new Set(params.items || ['raw_iron', 'raw_gold', 'raw_copper', 'iron_ore', 'gold_ore', 'copper_ore', 'sand', 'cobblestone', 'potato', 'beef', 'porkchop', 'chicken']);
      const fuelNames = new Set(params.fuels || ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'oak_planks', 'spruce_planks', 'birch_planks']);
      const items = bot.inventory.items();
      const input = items.find(i => rawNames.has(i.name));
      const fuel = items.find(i => fuelNames.has(i.name));
      if (!input) throw new Error('No configured smeltable item in inventory');
      if (!fuel && !window.fuelItem) throw new Error('No configured furnace fuel in inventory or furnace');
      if (window.putInput) await window.putInput(input.type, input.metadata, Math.min(input.count, 64));
      if (fuel && window.putFuel) await window.putFuel(fuel.type, fuel.metadata, Math.min(fuel.count, 64));
      inst.addLog(`Loaded ${input.name}${fuel ? ` with ${fuel.name} fuel` : ''} into furnace`, 'success');
      const waitMs = Math.max(0, Math.min(60000, Number(params.waitMs ?? 15000)));
      const deadline = Date.now() + waitMs;
      while (activeCheck(name) && Date.now() < deadline && !window.outputItem) await inst.sleep(1000);
      let output = null;
      if (activeCheck(name) && window.outputItem && typeof window.takeOutput === 'function') {
        output = await window.takeOutput();
      }
      remember('events', { kind: 'smelt', item: input.name, output: output?.name || window.outputItem?.name || null, furnace: furnace.position });
      inst.finishTask(name, true, output ? `Smelted output collected: ${output.name}` : `Furnace loaded with ${input.name}; output was not ready within ${Math.round(waitMs / 1000)}s`, { output: output?.name || null });
    } finally {
      try { window?.close(); } catch { /* window may already be closed */ }
      end(name);
    }
  }

  async function store(params = {}) {
    const name = 'store'; begin(name);
    const chest = nearestBlock(['chest', 'trapped_chest', 'barrel'], Number(params.radius) || 8);
    if (!chest) { end(name); throw new Error('No chest or barrel found nearby'); }
    let container;
    let deposited = 0;
    try {
      container = await bot.openContainer(chest);
      const items = bot.inventory.items().filter(i => !KEEP_ITEMS.test(i.name) && !inst.mcData?.foodsByName?.[i.name] && !['diamond', 'emerald', 'netherite_ingot', 'enchanted_golden_apple', 'totem_of_undying'].includes(i.name));
      for (const item of items) {
        if (!activeCheck(name)) break;
        try { await container.deposit(item.type, item.metadata, item.count); deposited += item.count; }
        catch (e) { inst.addLog(`Storage skipped ${item.name}: ${e.message}`, 'warn'); }
      }
      remember('events', { kind: 'storage', deposited, x: chest.position.x, y: chest.position.y, z: chest.position.z });
      inst.finishTask(name, true, `Stored ${deposited} item(s); tools, food and protected valuables were kept`);
    } finally {
      try { container?.close(); } catch { /* ignore */ }
      end(name);
    }
  }

  async function explore(params = {}) {
    const name = 'explore'; begin(name);
    const steps = Math.max(1, Math.min(12, Math.floor(Number(params.steps) || 4)));
    const radius = Math.max(8, Math.min(48, Math.floor(Number(params.radius) || 24)));
    const origin = bot.entity.position.clone();
    let reached = 0;
    try {
      for (let i = 0; i < steps && activeCheck(name); i++) {
        await inst.waitReady();
        let target = null;
        for (let tries = 0; tries < 8 && !target; tries++) {
          const a = Math.random() * Math.PI * 2, r = radius * (0.35 + Math.random() * 0.65);
          const x = Math.round(origin.x + Math.cos(a) * r), z = Math.round(origin.z + Math.sin(a) * r);
          const y = bot.entity.position.y;
          const b = bot.blockAt(new Vec3(x, Math.floor(y), z));
          const above = bot.blockAt(new Vec3(x, Math.floor(y) + 1, z));
          const ground = bot.blockAt(new Vec3(x, Math.floor(y) - 1, z));
          if (b && above && ground && (b.name === 'air' || b.name.endsWith('_air')) && (above.name === 'air' || above.name.endsWith('_air')) && ground.boundingBox === 'block' && !HAZARDS.has(ground.name)) target = { x, y: Math.floor(y), z };
        }
        if (!target) { inst.addLog('Exploration: could not find a safe nearby target', 'warn'); break; }
        await inst.goto(target.x, null, target.z, 2, 45000);
        remember('explored', { ...target, kind: 'exploration' }); reached++;
        inst.setTaskDetail({ phase: 'explore', progress: reached, total: steps, target });
      }
      inst.finishTask(name, reached > 0, reached ? `Exploration reached ${reached} safe waypoint(s)` : 'No safe exploration waypoint reached');
    } finally { end(name); }
  }

  async function base(params = {}) {
    const name = 'base'; begin(name);
    const house = inst.modules.house;
    if (!house || typeof house.run !== 'function' || typeof house.prepare !== 'function') { end(name); throw new Error('House builder module is unavailable'); }
    try {
      const plan = await house.prepare({ size: params.size, material: params.material, x: params.x, y: params.y, z: params.z, allowPartial: false });
      const floorCells = Math.max(0, (plan.size - 2) ** 2);
      const doorName = `${String(plan.material || '').replace(/_planks$/, '')}_door`;
      const have = inventoryCount(plan.material);
      if (have < plan.required + floorCells) throw new Error(`Base setup needs ${plan.required} wall/roof + ${floorCells} floor blocks of ${plan.material}; inventory has ${have}. Add materials before building`);
      const before = inst.lastResult?.ts || 0;
      // Existing house builder validates the site and never digs/removes existing blocks.
      await house.run({ ...params, _plan: plan, allowPartial: false });
      const houseResult = inst.lastResult;
      if (houseResult?.task !== 'house' || houseResult.ts === before || !houseResult.ok) throw new Error(houseResult?.message || 'House builder did not verify a completed house');
      let floorPlaced = 0;
      const cx = plan.corner.x, y0 = plan.corner.y, cz = plan.corner.z;
      const cells = [];
      for (let x = 1; x < plan.size - 1; x++) for (let z = 1; z < plan.size - 1; z++) cells.push({ x: cx + x, z: cz + z });
      cells.sort((a,b) => Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z) - Math.hypot(b.x - bot.entity.position.x, b.z - bot.entity.position.z));
      for (const cell of cells) {
        if (!activeCheck(name)) throw new Error('Base setup stopped before floor completion');
        const target = new Vec3(cell.x, y0, cell.z), existing = bot.blockAt(target);
        if (existing?.name === plan.material) continue;
        if (!existing || !['air','cave_air','void_air','short_grass','grass','fern','dead_bush','snow'].includes(existing.name)) throw new Error(`Floor cell blocked at ${cell.x},${y0},${cell.z}`);
        const ground = bot.blockAt(target.offset(0, -1, 0));
        if (!ground || ground.boundingBox !== 'block') throw new Error(`No solid support under floor at ${cell.x},${y0},${cell.z}`);
        const item = bot.inventory.items().find(i => i.name === plan.material);
        if (!item) throw new Error(`Ran out of ${plan.material} while laying the floor`);
        await inst.goto(cell.x + 1, null, cell.z, 2, 12000).catch(async () => inst.goto(cell.x, null, cell.z + 1, 2, 12000));
        await bot.equip(item, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        await inst.sleep(100);
        if (bot.blockAt(target)?.name !== plan.material) throw new Error(`Floor placement was not verified at ${cell.x},${y0},${cell.z}`);
        floorPlaced++;
      }
      let doorPlaced = false;
      const doorItem = bot.inventory.items().find(i => i.name === doorName);
      if (doorItem) {
        const d = plan.door, target = new Vec3(d.x, d.y, d.z), ground = bot.blockAt(target.offset(0, -1, 0));
        if (ground && ['air','cave_air','void_air'].includes(bot.blockAt(target)?.name)) {
          try {
            await inst.goto(d.x + (d.side === 'west' ? -1 : d.side === 'east' ? 1 : 0), null, d.z + (d.side === 'north' ? -1 : d.side === 'south' ? 1 : 0), 2, 12000);
            await bot.equip(doorItem, 'hand'); await bot.placeBlock(ground, new Vec3(0, 1, 0)); await inst.sleep(150);
            doorPlaced = bot.blockAt(target)?.name === doorName;
          } catch (e) { inst.addLog(`Door placement skipped: ${e.message}`, 'warn'); }
        }
      }
      const center = { x: plan.origin.x, y: plan.origin.y, z: plan.origin.z };
      const m = memory(); m.waypoints.push({ name: String(params.name || 'base').slice(0, 32), ...center, dimension: bot.game?.dimension || null, ts: Date.now() }); saveMemory(m);
      inst.finishTask(name, true, `Base setup verified: house + ${floorPlaced} floor blocks; ${doorPlaced ? 'door placed' : 'door item unavailable or placement failed'}; foundation is existing solid terrain (no destructive digging)`, { floorPlaced, doorPlaced, foundation: 'existing-ground' });
    } finally { end(name); }
  }

  async function boss(params = {}) {
    const name = 'boss'; begin(name);
    const seconds = Math.max(10, Math.min(300, Number(params.durationSec) || 90));
    const until = Date.now() + seconds * 1000;
    let seen = null, warned = false;
    if (!inst.modules.combat?.forceTarget) { end(name); throw new Error('Combat module must be enabled for boss mode'); }
    try {
      while (activeCheck(name) && Date.now() < until) {
        const target = Object.values(bot.entities).filter(e => e && e.isValid && e.position && (BOSS_NAMES.has(e.name) || /dragon|wither|warden|elder_guardian|ravager|evoker|piglin_brute/.test(e.name || '')))
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (!target) { if (!warned) { inst.addLog('Boss mode active; waiting for a supported boss entity nearby', 'info'); warned = true; } await inst.sleep(1200); continue; }
        seen = target.name;
        if (bot.health < (Number(params.retreatHealth) || 7)) { inst.modules.combat?.fleeNow(); await inst.sleep(1800); }
        else inst.modules.combat?.forceTarget(target.name);
        await inst.sleep(500);
      }
      inst.modules.combat?.clearForcedTarget?.();
      inst.finishTask(name, !!seen, seen ? `Boss mode ended after targeting ${seen}` : 'No supported boss found nearby');
    } finally { end(name); }
  }

  async function guard(params = {}) {
    const name = 'guard'; begin(name);
    const p = bot.entity.position;
    const cx = Number.isFinite(Number(params.x)) ? Number(params.x) : p.x;
    const cy = Number.isFinite(Number(params.y)) ? Number(params.y) : p.y;
    const cz = Number.isFinite(Number(params.z)) ? Number(params.z) : p.z;
    const radius = Math.max(4, Math.min(32, Number(params.radius) || 8));
    const duration = Math.max(10, Math.min(1800, Number(params.durationSec) || 300));
    const until = Date.now() + duration * 1000;
    if (!inst.modules.combat?.forceTarget) { end(name); throw new Error('Combat module must be enabled for guard mode'); }
    let patrol = 0;
    try {
      while (activeCheck(name) && Date.now() < until) {
        const threat = Object.values(bot.entities).filter(e => e && e.isValid && e.type === 'hostile' && e.position && e.position.distanceTo(bot.entity.position) < 9)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (threat) { inst.modules.combat?.forceTarget(threat.name); await inst.sleep(1000); continue; }
        const angle = (patrol++ % 8) * Math.PI / 4;
        const tx = Math.round(cx + Math.cos(angle) * radius), tz = Math.round(cz + Math.sin(angle) * radius);
        try { await inst.goto(tx, null, tz, 2, 25000); } catch (e) { if (!e.cancelled) inst.addLog(`Guard patrol path failed: ${e.message}`, 'warn'); }
        remember('events', { kind: 'guard-patrol', x: tx, y: cy, z: tz });
        await inst.sleep(400);
      }
      inst.finishTask(name, true, 'Base guard patrol ended');
    } finally { end(name); }
  }

  let lastToolSwap = 0;
  async function maintainTool() {
    if (!inst.isOnline() || !bot.heldItem || bot.targetDigBlock || inst.flags.eating || inst.combatBusy || Date.now() - lastToolSwap < 4000) return;
    const held = bot.heldItem;
    const family = /^(.*?)(crossbow|pickaxe|sword|shovel|trident|shield|axe|hoe|bow)$/;
    const match = held.name.match(family);
    if (!match) return;
    const max = held.maxDurability || inst.mcData?.itemsByName?.[held.name]?.maxDurability;
    const used = Number(held.durabilityUsed);
    if (!Number.isFinite(max) || !Number.isFinite(used)) return;
    const left = max - used;
    if (left > Math.max(10, max * 0.08)) return;
    const candidates = bot.inventory.items().filter(i => i.name !== held.name && family.test(i.name) && i.name.match(family)?.[2] === match[2])
      .map(i => ({ item: i, max: i.maxDurability || inst.mcData?.itemsByName?.[i.name]?.maxDurability, used: Number(i.durabilityUsed) }))
      .filter(i => Number.isFinite(i.max) && Number.isFinite(i.used) && i.max - i.used > left)
      .sort((a,b) => (b.max - b.used) - (a.max - a.used));
    if (!candidates.length) return;
    lastToolSwap = Date.now();
    try { await bot.equip(candidates[0].item, 'hand'); inst.addLog(`Tool durability manager: switched from ${held.name} (${left} durability left) to ${candidates[0].item.name}`, 'control'); }
    catch (e) { inst.addLog(`Tool swap failed: ${e.message}`, 'warn'); }
  }

  return {
    init() { inst.every(maintainTool, 5000); },
    activities: { branchmine: branchMine, loot, smelt, store, explore, base, boss, guard },
    run: { branchMine, loot, smelt, store, explore, base, boss, guard },
    memory: () => memory(),
    rememberWaypoint(label, pos) {
      if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.z))) throw new Error('Valid x and z coordinates are required');
      const m = memory();
      const waypoint = { name: String(label || 'waypoint').trim().slice(0, 32) || 'waypoint', x: Number(pos.x), y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : null, z: Number(pos.z), dimension: bot.game?.dimension || null, ts: Date.now() };
      m.waypoints = m.waypoints.filter(w => w.name.toLowerCase() !== waypoint.name.toLowerCase()); m.waypoints.push(waypoint); saveMemory(m); return waypoint;
    },
    rememberResource(data) { remember('resources', data); },
    rememberEvent(data) { remember('events', data); },
    clearMemory() { database.kvSet(memoryKey, { waypoints: [], explored: [], resources: [], events: [] }); return memory(); },
    halt(name) { active.delete(name); if (name === 'base') inst.modules.house?.halt?.(); if (name === 'boss' || name === 'guard') inst.modules.combat?.clearForcedTarget?.(); },
    stop() { for (const n of active) active.delete(n); },
  };
}
module.exports = { create, BOSS_NAMES, KEEP_ITEMS };
