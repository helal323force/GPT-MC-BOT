'use strict';
/**
 * scripts/test-features.js - integration tests for the v3.1 features using MOCKS (no Minecraft server, no network, no
 * installed game libraries). It loads the real modules/BotInstance with stubbed vec3 / mineflayer / pathfinder / database,
 * a simulated inventory, a simulated block world and simulated entities.
 * Run: node scripts/test-features.js     (passing here proves the logic, NOT live behaviour in Minecraft)
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ---------- stubs ----------
class Vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  offset(a, b, c) { return new Vec3(this.x + a, this.y + b, this.z + c); }
  plus(o) { return this.offset(o.x, o.y, o.z); } minus(o) { return this.offset(-o.x, -o.y, -o.z); }
  scaled(k) { return new Vec3(this.x * k, this.y * k, this.z * k); }
  floored() { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  clone() { return new Vec3(this.x, this.y, this.z); }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
}
class Goal { constructor(name, ...a) { this.name = name; this.args = a; } }
const goals = { GoalNear: class extends Goal { constructor(...a) { super('near', ...a); } }, GoalXZ: class extends Goal { constructor(...a) { super('xz', ...a); } },
  GoalFollow: class extends Goal { constructor(...a) { super('follow', ...a); } }, GoalBlock: class extends Goal { constructor(...a) { super('block', ...a); } } };
class Movements { constructor() { this.id = 'm' + Math.random(); } bestHarvestTool() { return null; } }
const fakeDb = { kvGet: (k, d) => d, kvSet() {}, logEvent() {}, run() { return { lastInsertRowid: 1, changes: 0 }; }, get() { return undefined; }, all() { return []; } };
const STUBS = { vec3: { Vec3 }, 'mineflayer-pathfinder': { goals, Movements, pathfinder() {} }, mineflayer: { createBot() { throw new Error('not used'); } }, 'minecraft-data': () => ({}) };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (STUBS[req]) return STUBS[req];
  if (/core[\\/]database$/.test(req) || (parent && /core[\\/]bot-instance/.test(parent.filename) && req === './database')) return fakeDb;
  if (req === 'express') return { Router: () => { const routes = {}; const mk = (m) => (p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; }; return { routes, get: mk('GET'), post: mk('POST'), patch: mk('PATCH'), delete: mk('DELETE'), use() {} }; } };
  return origLoad.apply(this, arguments);
};
const R = (p) => require(path.join(__dirname, '..', p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { MockPF } = (() => {
  class MockPF extends EventEmitter {
    constructor() { super(); this.pending = []; this.goal = null; this.log = []; this.timer = null; this.moving = false; }
    isMoving() { return this.moving; }
    _arm() { clearTimeout(this.timer); const g = this.goal; if (!g || !g.ms) return; this.moving = true; this.timer = setTimeout(() => { if (this.goal !== g) return; this.moving = false; const l = this.pending.filter((p) => p.goal === g); this.pending = this.pending.filter((p) => p.goal !== g); l.forEach((p) => p.res()); if (!g.dynamic) this.goal = null; }, g.ms); }
    setGoal(g, d) { this.log.push('setGoal:' + (g && (g.name || g.args))); const rej = this.pending.filter((p) => p.goal !== g); this.pending = this.pending.filter((p) => p.goal === g); rej.forEach((p) => p.rej(new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'))); this.goal = g; if (g) g.dynamic = !!d; this.moving = !!g; this._arm(); }
    goto(g) { if (!g.ms && g.ms !== 0) g.ms = 20; return new Promise((res, rej) => { this.pending.push({ goal: g, res, rej }); this.setGoal(g, false); }); }
    stop() { this.log.push('stop'); const a = this.pending; this.pending = []; this.goal = null; this.moving = false; clearTimeout(this.timer); a.forEach((p) => p.rej(new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'))); }
    setMovements(m) { this.movements = m; }
  }
  return { MockPF };
})();

// ---------- mock bot / world ----------
const ITEMS = { coal: { id: 1, name: 'coal' }, oak_planks: { id: 2, name: 'oak_planks' }, bread: { id: 3, name: 'bread' }, rotten_flesh: { id: 4, name: 'rotten_flesh' }, golden_apple: { id: 5, name: 'golden_apple' }, stone_pickaxe: { id: 6, name: 'stone_pickaxe' }, diamond_sword: { id: 7, name: 'diamond_sword' }, dirt: { id: 8, name: 'dirt' }, cooked_beef: { id: 9, name: 'cooked_beef' } };
const BLOCKS = { coal_ore: { id: 100, name: 'coal_ore', boundingBox: 'block', harvestTools: { 6: true } }, deepslate_coal_ore: { id: 101, name: 'deepslate_coal_ore', boundingBox: 'block', harvestTools: { 6: true } }, oak_log: { id: 102, name: 'oak_log', boundingBox: 'block' }, stone: { id: 103, name: 'stone', boundingBox: 'block' } };
const mcData = { itemsByName: ITEMS, items: Object.fromEntries(Object.values(ITEMS).map((i) => [i.id, i])), blocksByName: { ...BLOCKS, air: { id: 0, name: 'air' }, oak_planks: { id: 200, name: 'oak_planks', boundingBox: 'block' }, diamond_block: { id: 201, name: 'diamond_block', boundingBox: 'block' }, dirt: { id: 202, name: 'dirt', boundingBox: 'block' } },
  foodsByName: { bread: { foodPoints: 5 }, rotten_flesh: { foodPoints: 4 }, golden_apple: { foodPoints: 4 }, cooked_beef: { foodPoints: 8 } } };

function mkBot() {
  const bot = new EventEmitter();
  bot.version = '1.20.4'; bot.username = 'Bot'; bot.health = 20; bot.food = 20; bot.pathfinder = new MockPF();
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0, velocity: new Vec3(0, 0, 0) };
  bot.players = {}; bot.entities = {}; bot.controlState = {}; bot.world = new Map(); bot.slots = [];
  const stackSize = 64;
  bot.inventory = {
    items: () => bot.slots.filter(Boolean),
    count: (id) => bot.slots.filter((s) => s && s.type === id).reduce((a, s) => a + s.count, 0),
    emptySlotCount: () => 36 - bot.slots.filter(Boolean).length,
  };
  bot.give = (name, count, extra = {}) => { const it = ITEMS[name]; bot.slots.push({ type: it.id, name, count, stackSize, displayName: name, metadata: null, ...extra }); };
  bot.toss = async (type, md, n) => { bot.tossCalls = (bot.tossCalls || 0) + 1; if (bot.tossBroken) return; let left = n; for (const s of bot.slots.filter((x) => x && x.type === type)) { const t = Math.min(left, s.count); s.count -= t; left -= t; if (left <= 0) break; } bot.slots = bot.slots.filter((s) => s.count > 0); };
  bot.setControlState = (k, v) => { bot.controlState[k] = v; }; bot.clearControlStates = () => { bot.controlState = {}; };
  bot.quit = () => {}; bot.end = () => {}; bot.equip = async () => {}; bot.lookAt = async () => {}; bot.consume = async () => { bot.consumed = (bot.consumed || 0) + 1; };
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z), k = `${x},${y},${z}`; const b = bot.world.has(k) ? bot.world.get(k) : bot.defaultBlock ? bot.defaultBlock(x, y, z) : { name: 'air', boundingBox: 'empty', type: 0 }; return { ...b, position: new Vec3(x, y, z) }; };
  bot.setBlock = (x, y, z, name) => bot.world.set(`${x},${y},${z}`, { name, boundingBox: name === 'air' ? 'empty' : 'block', type: (mcData.blocksByName[name] || {}).id });
  bot.findBlocks = ({ matching, maxDistance, count }) => [...bot.world.entries()].filter(([, b]) => matching.includes(b.type)).map(([k]) => new Vec3(...k.split(',').map(Number))).filter((v) => v.distanceTo(bot.entity.position) <= maxDistance).slice(0, count);
  bot.dig = async (b) => { if (bot.digBroken) throw new Error('cannot dig'); bot.world.delete(`${b.position.x},${b.position.y},${b.position.z}`); bot.slots.length < 36 && bot.give('coal', 1); };
  bot.placeBlock = async (ref, face) => { if (bot.placeBroken) return; const v = ref.position.plus(face); const held = bot.slots.find((s) => s && s.name === bot.holdName) ; if (!held) throw new Error('nothing held'); held.count--; bot.slots = bot.slots.filter((s) => s.count > 0); bot.setBlock(v.x, v.y, v.z, bot.holdName); };
  bot.equip = async (item) => { bot.holdName = item.name; };
  return bot;
}

// Minimal BotInstance harness (real class, fake bot)
function mkInst(extraCfg = {}) {
  const state = R('core/state');
  state.instances.clear(); state.services = {};
  const { BotInstance } = R('core/bot-instance');
  const cfg = { server: { host: 'x', port: 1 }, combat: { enabled: true }, tracker: { enabled: false }, backup: { enabled: false }, ai: { enabled: false }, modules: {}, anti_afk: { enabled: false }, ...extraCfg };
  const inst = new BotInstance({ id: 'main', username: 'Bot', type: 'offline' }, cfg);
  const bot = mkBot();
  inst.bot = bot; inst.mcData = mcData; inst.movements = new Movements(); inst.safeMovements = new Movements(); inst.state.status = 'online';
  inst.addLog = () => {};
  return { inst, bot, state };
}

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e]); } };

(async () => {
  // ================= invtools (F) =================
  await test('drop: validates name / amount / available quantity and never drops more than held', async () => {
    const { inst, bot } = mkInst(); const inv = R('modules/invtools').create(inst);
    bot.give('dirt', 10); bot.give('dirt', 5);
    await assert.rejects(inv.drop({ name: '', count: 1 }), /Choose an item/);
    for (const bad of [0, -3, 1.5, 'abc', NaN]) await assert.rejects(inv.drop({ name: 'dirt', count: bad }), /whole number/);
    await assert.rejects(inv.drop({ name: 'coal', count: 1 }), /not in the bot's inventory/);
    await assert.rejects(inv.drop({ name: 'dirt', count: 16 }), (e) => /Only 15 dirt available/.test(e.message) && e.available === 15);
    assert.strictEqual(bot.tossCalls || 0, 0, 'nothing may be tossed for invalid requests');
  });
  await test('drop: spans stacks, verifies inventory really changed, reports remaining', async () => {
    const { inst, bot } = mkInst(); const inv = R('modules/invtools').create(inst);
    bot.give('dirt', 10); bot.give('dirt', 5);
    const r = await inv.drop({ name: 'dirt', count: 12 });
    assert.deepStrictEqual([r.dropped, r.remaining], [12, 3]);
    assert.strictEqual(bot.inventory.count(ITEMS.dirt.id), 3);
  });
  await test('drop: does NOT report success when the toss silently fails', async () => {
    const { inst, bot } = mkInst(); const inv = R('modules/invtools').create(inst);
    bot.give('dirt', 10); bot.tossBroken = true;
    await assert.rejects(inv.drop({ name: 'dirt', count: 4 }), /Dropped 0 of 4 dirt/);
  });
  await test('drop: protected / enchanted items need explicit confirmation (409 requiresConfirm), can be hard-blocked', async () => {
    const { inst, bot } = mkInst(); const inv = R('modules/invtools').create(inst);
    bot.give('diamond_sword', 1);
    await assert.rejects(inv.drop({ name: 'diamond_sword', count: 1 }), (e) => e.status === 409 && e.requiresConfirm === true);
    assert.strictEqual(bot.tossCalls || 0, 0);
    bot.give('dirt', 3, { enchants: [{ name: 'unbreaking', lvl: 1 }] });
    await assert.rejects(inv.drop({ name: 'dirt', count: 1 }), (e) => e.requiresConfirm && /enchanted/.test(e.reason));
    const r = await inv.drop({ name: 'diamond_sword', count: 1, confirmProtected: true });
    assert.strictEqual(r.dropped, 1);
    inst.config.inventory = { block_protected_drops: true };
    bot.give('diamond_sword', 1);
    await assert.rejects(inv.drop({ name: 'diamond_sword', count: 1, confirmProtected: true }), (e) => e.status === 403);
    inst.config.inventory = { protected_items: ['coal'] }; bot.give('coal', 2);
    await assert.rejects(inv.drop({ name: 'coal', count: 1 }), (e) => e.requiresConfirm);
  });
  await test('drop: only one drop at a time', async () => {
    const { inst, bot } = mkInst(); const inv = R('modules/invtools').create(inst);
    bot.give('dirt', 10);
    const a = inv.drop({ name: 'dirt', count: 2 });
    await assert.rejects(inv.drop({ name: 'dirt', count: 2 }), /in progress/);
    await a;
  });

  // ================= grinder (D) =================
  const grindRig = () => { const x = mkInst(); x.bot.give('stone_pickaxe', 1); for (let i = 0; i < 5; i++) x.bot.setBlock(3 + i, 64, 0, 'coal_ore'); x.inst.sleep = () => sleep(1); x.inst.collectDrops = async () => {}; x.inst.waitReady = async () => {}; x.inst.goto = async () => {}; x.inst.activeActivity = 'grind'; return x; };
  await test('grind prepare: reports unknown resource, bad amount, missing tool, low health, full inventory, nothing nearby', async () => {
    const { inst, bot } = grindRig(); const g = R('modules/grinder').create(inst);
    await assert.rejects(g.prepare({ resource: 'unobtainium', amount: 1 }), /Unknown resource/);
    for (const a of [0, 1.5, 'x', 99999]) await assert.rejects(g.prepare({ resource: 'coal', amount: a }), /Amount must be/);
    bot.slots = bot.slots.filter((s) => s.name !== 'stone_pickaxe');
    await assert.rejects(g.prepare({ resource: 'coal', amount: 3 }), (e) => /Missing tool/.test(e.message) && /stone_pickaxe/.test(e.message));
    bot.give('stone_pickaxe', 1); bot.health = 4;
    await assert.rejects(g.prepare({ resource: 'coal', amount: 3 }), /Health too low/);
    bot.health = 20; bot.world.clear();
    await assert.rejects(g.prepare({ resource: 'coal', amount: 3 }), /No coal_ore\/deepslate_coal_ore within 32 blocks/);
    bot.setBlock(3, 64, 0, 'coal_ore'); for (let i = 0; i < 40; i++) bot.give('dirt', 64);
    await assert.rejects(g.prepare({ resource: 'coal', amount: 3 }), /Inventory is full/);
  });
  await test('grind run: reports SUCCESS only when the real inventory count reaches the goal', async () => {
    const { inst, bot } = grindRig(); const g = R('modules/grinder').create(inst);
    let done = null; inst.finishTask = (n, ok, m) => { done = { n, ok, m }; };
    await g.run({ resource: 'coal', amount: 3 });
    assert.ok(done && done.ok, JSON.stringify(done)); assert.match(done.m, /Collected 3 coal/);
    assert.strictEqual(bot.inventory.count(ITEMS.coal.id), 3);
  });
  await test('grind run: FAILS honestly when the ore runs out before the goal (no false success)', async () => {
    const { inst, bot } = grindRig(); const g = R('modules/grinder').create(inst);
    let done = null; inst.finishTask = (n, ok, m) => { done = { n, ok, m }; };
    await g.run({ resource: 'coal', amount: 50 });
    assert.strictEqual(done.ok, false); assert.match(done.m, /No more reachable .* \(collected 5 of 50 coal\)/);
  });
  await test('grind run: unreachable targets => failure with the real error, not success', async () => {
    const { inst } = grindRig(); const g = R('modules/grinder').create(inst);
    let done = null; inst.finishTask = (n, ok, m) => { done = { n, ok, m }; }; inst.goto = async () => { throw new Error('no path'); };
    for (let i = 0; i < 8; i++) inst.bot.setBlock(10 + i, 64, 0, 'coal_ore');
    await g.run({ resource: 'coal', amount: 5 });
    assert.strictEqual(done.ok, false); assert.match(done.m, /Too many unreachable targets.*no path.*collected 0 of 5/);
  });
  await test('grind run: stopping (halt) mid-way ends the loop and records "stopped by user", not success', async () => {
    const { inst } = grindRig(); const g = R('modules/grinder').create(inst);
    let fin = null; inst.finishTask = (n, ok, m) => { fin = { ok, m }; };
    inst.goto = async () => { await sleep(30); };
    const p = g.run({ resource: 'coal', amount: 5 }); await sleep(10); g.halt(); await p;
    assert.strictEqual(fin, null); assert.strictEqual(inst.lastResult.ok, false); assert.match(inst.lastResult.message, /Stopped by user/);
  });

  // ================= survival (B) =================
  await test('survival: eats appropriate food, never golden apples / rotten flesh unless starving, logs once when none', async () => {
    const { inst, bot } = mkInst(); const logs = []; inst.addLog = (m) => logs.push(m);
    const sv = R('modules/survival').create(inst); sv.init && (inst.every = () => 0);
    bot.food = 10; bot.give('golden_apple', 2); bot.give('rotten_flesh', 3);
    inst.every = (fn) => { sv._tick = fn; }; sv.init();
    sv._tick(); await sleep(20);
    assert.ok(!bot.consumed, 'must not eat golden apple/rotten flesh at food 10');
    assert.ok(logs.some((l) => /no usable food/.test(l)));
    const n = logs.length; sv._tick(); await sleep(20); assert.strictEqual(logs.length, n, 'no-food warning must be throttled');
    bot.give('bread', 2); bot.give('cooked_beef', 2); bot.holdName = null;
    // wait out the eat cooldown
    await sleep(2100); sv._tick(); await sleep(30);
    assert.strictEqual(bot.consumed, 1); assert.strictEqual(bot.holdName, 'cooked_beef', 'beef (8) fits the 10-point gap better than bread (5)');
  });
  await test('survival: critical health + threat => retreats via coordinator (priority survival), combat is vetoed meanwhile', async () => {
    const { inst, bot } = mkInst(); inst.every = (fn) => 0;
    const sv = R('modules/survival').create(inst); let tick; inst.every = (fn) => { tick = fn; }; sv.init();
    bot.health = 5; bot.entities[1] = { type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0), isValid: true };
    const gotoCalls = []; inst.nav.goto = async (owner, goal) => { gotoCalls.push(owner); await sleep(30); };
    tick(); await sleep(10);
    assert.deepStrictEqual(gotoCalls, ['survival']);
    assert.strictEqual(sv.shouldEngage({}, 6), false, 'no chasing while retreating');
    assert.strictEqual(sv.shouldEngage({}, 6) === false && sv.state().retreating, true);
    await sleep(60);
  });
  await test('survival: low health with no threats pauses work (rest) and resumes when healed', async () => {
    const { inst, bot } = mkInst(); let tick; inst.every = (fn) => { tick = fn; };
    const sv = R('modules/survival').create(inst); sv.init();
    bot.health = 4; tick(); assert.strictEqual(inst.paused, true);
    bot.health = 18; tick(); assert.strictEqual(inst.paused, false);
  });
  await test('survival: shouldEngage allows defending at melee range even when hurt', async () => {
    const { inst, bot } = mkInst(); const sv = R('modules/survival').create(inst); bot.health = 3;
    assert.strictEqual(sv.shouldEngage({}, 2), true); assert.strictEqual(sv.shouldEngage({}, 8), false);
  });

  // ================= follow (C) =================
  await test('follow: refuses offline / invisible / self; holds goal via coordinator; stops honestly when player leaves', async () => {
    const { inst, bot } = mkInst(); inst.finishTask = (n, ok, m) => { inst._fin = { ok, m }; };
    const f = R('modules/follow').create(inst);
    await assert.rejects(f.prepare({ player: 'Ghost' }), /not online/);
    await assert.rejects(f.prepare({ player: '' }), /Choose a player/);
    bot.players.Bot = { username: 'Bot', entity: bot.entity }; await assert.rejects(f.prepare({ player: 'Bot' }), /cannot follow itself/);
    bot.players.Far = { username: 'Far', entity: null }; await assert.rejects(f.prepare({ player: 'far' }), /outside the bot's view distance/);
    bot.players.Bob = { username: 'Bob', entity: { position: new Vec3(5, 64, 5) } };
    await f.run({ player: 'bob' });
    assert.ok(inst.nav.holds.has('follow')); assert.strictEqual(bot.pathfinder.goal.name, 'follow');
    delete bot.players.Bob; let t; inst.every = (fn) => { t = fn; };
    f.init(); t();
    assert.strictEqual(inst._fin.ok, false); assert.match(inst._fin.m, /left the game/); assert.strictEqual(inst.nav.holds.size, 0);
  });
  await test('follow: player out of range => searches last position, then gives up with a clear reason', async () => {
    const { inst, bot } = mkInst(); inst.config.follow = { lost_timeout_sec: 0.15 }; inst.finishTask = (n, ok, m) => { inst._fin = { ok, m }; };
    const f = R('modules/follow').create(inst); let tick; inst.every = (fn) => { tick = fn; }; inst.listen = () => {}; f.init();
    bot.players.Bob = { username: 'Bob', entity: { position: new Vec3(5, 64, 5) } }; await f.run({ player: 'Bob' });
    bot.players.Bob.entity = null; tick(); await sleep(200); tick();
    assert.strictEqual(inst._fin.ok, false); assert.match(inst._fin.m, /Lost Bob/);
  });

  // ================= autojump (A) =================
  await test('autojump: ON creates exactly one timer even if toggled twice; OFF removes it and releases jump', async () => {
    const { inst, bot } = mkInst(); const aj = R('modules/autojump').create(inst);
    aj.setEnabled(true); aj.setEnabled(true); assert.strictEqual(inst._botTimers.size, 1);
    bot.setControlState('jump', true); aj.setEnabled(false);
    assert.strictEqual(inst._botTimers.size, 0); assert.strictEqual(bot.controlState.jump, false); assert.strictEqual(aj.isEnabled(), false);
    aj.setEnabled(true); aj.stop(); assert.strictEqual(inst._botTimers.size, 0);
  });
  await test('autojump: jumps at a 1-block step in free walking, not on open ground, not while pathfinder moves', async () => {
    const { inst, bot } = mkInst(); const aj = R('modules/autojump').create(inst);
    let tick; inst.every = (fn) => { tick = fn; return 1; }; aj.setEnabled(true);
    bot.controlState = { forward: true }; bot.entity.yaw = 0;           // yaw 0 => facing -z
    tick(); assert.ok(!bot.controlState.jump, 'open ground: no jump');
    bot.setBlock(0, 64, -1, 'dirt');                                      // 1-block step ahead (feet level)
    tick(); assert.strictEqual(bot.controlState.jump, true);
    await sleep(200); assert.strictEqual(bot.controlState.jump, false);
    bot.setBlock(0, 65, -1, 'dirt');                                      // 2-high wall: jumping is pointless
    tick(); assert.ok(!bot.controlState.jump);
    bot.world.delete('0,65,-1'); bot.pathfinder.moving = true; tick(); assert.ok(!bot.controlState.jump, 'pathfinder owns jumping');
  });

  // ================= house (E) =================
  const flatWorld = (bot) => { bot.defaultBlock = (x, y, z) => (y <= 63 ? { name: 'dirt', boundingBox: 'block', type: 202 } : { name: 'air', boundingBox: 'empty', type: 0 }); };
  const houseRig = (planks = 100) => { const x = mkInst(); flatWorld(x.bot); x.bot.give('oak_planks', planks); x.inst.waitReady = async () => {}; x.inst.sleep = () => sleep(0); x.inst.nav.goto = async (o, g) => { const a = g.args; x.bot.entity.position = new Vec3(a[0] + 0.5, a[1], a[2] + 0.5); }; return x; };
  await test('house plan: 5x5 needs 46 wall + 25 roof = 71 blocks; auto-picks material and a clear spot; read-only', async () => {
    const { inst, bot } = houseRig(); const h = R('modules/housebuilder').create(inst);
    const p = h.plan({});
    assert.ok(p.ok, JSON.stringify(p)); assert.strictEqual(p.required, 71); assert.strictEqual(p.material, 'oak_planks'); assert.strictEqual(p.auto, true);
    assert.strictEqual(bot.world.size, 0, 'planning must not change the world');
  });
  await test('house plan: reports missing materials; allowPartial turns it into a warning', async () => {
    const { inst } = houseRig(30); const h = R('modules/housebuilder').create(inst);
    const p = h.plan({}); assert.strictEqual(p.ok, false); assert.match(p.issues.join(), /need 71 oak_planks, have 30 \(short by 41\)/);
    assert.strictEqual(h.plan({ allowPartial: true }).ok, true);
    await assert.rejects(h.prepare({}), /Missing materials/);
  });
  await test('house plan: refuses to build over existing blocks (never destructive) and over missing ground', async () => {
    const { inst, bot } = houseRig(); const h = R('modules/housebuilder').create(inst);
    bot.setBlock(2, 64, 1, 'dirt');                                       // somebody's block inside the explicit footprint
    const p = h.plan({ x: 2, y: 64, z: 2 }); assert.strictEqual(p.ok, false); assert.match(p.issues.join(), /not clear.*dirt/);
    bot.setBlock(2, 63, 2, 'air'); const q = h.plan({ x: 20, y: 64, z: 20 }); assert.ok(q.ok);
    bot.defaultBlock = (x, y) => (y <= 63 && !(x === 21 && y === 63) ? { name: 'dirt', boundingBox: 'block', type: 202 } : { name: 'air', boundingBox: 'empty', type: 0 });
    const r = h.plan({ x: 20, y: 64, z: 20 }); assert.strictEqual(r.ok, false); assert.match(r.issues.join(), /no solid ground/);
    assert.throws(() => h.plan({ size: 9 }), /between 4 and 7/);
    assert.throws(() => h.plan({ material: 'diamond_block' }), /not allowed/);
  });
  await test('house run: builds, verifies from the world, and reports success only when every cell is present', async () => {
    const { inst, bot } = houseRig(); const h = R('modules/housebuilder').create(inst); let fin = null; inst.finishTask = (n, ok, m, x) => { fin = { ok, m, x }; };
    await h.run({});
    assert.ok(fin && fin.ok, JSON.stringify(fin)); assert.strictEqual(fin.x.placed, 71); assert.strictEqual(bot.inventory.count(ITEMS.oak_planks.id), 29);
    const doorOpen = [...bot.world.keys()].length === 71; assert.ok(doorOpen);
  });
  await test('house run: placement that silently fails is detected and reported, not claimed as built', async () => {
    const { inst, bot } = houseRig(); const h = R('modules/housebuilder').create(inst); let fin = null; inst.finishTask = (n, ok, m) => { fin = { ok, m }; };
    bot.placeBroken = true; await h.run({});
    assert.strictEqual(fin.ok, false); assert.match(fin.m, /71 block\(s\) still missing after placing 0/);
  });
  await test('house run: running out of material mid-build => honest failure; re-run resumes without redoing blocks', async () => {
    const { inst, bot } = houseRig(); const h = R('modules/housebuilder').create(inst); let fin = null; inst.finishTask = (n, ok, m, x) => { fin = { ok, m, x }; };
    const plan = h.plan({}); bot.slots.find((s) => s.name === 'oak_planks').count = 40;       // plan was made with 100, only 40 left
    await h.run({ _plan: plan });
    assert.strictEqual(fin.ok, false); assert.match(fin.m, /Ran out of oak_planks: 31 block\(s\) still missing after placing 40/);
    bot.give('oak_planks', 60); fin = null; await h.run({});
    assert.ok(fin.ok); assert.strictEqual(fin.x.placed, 31, 'only the missing blocks are placed on resume');
  });

  // ================= BotInstance + coordinator integration =================
  await test('BotInstance: only ONE pathfinder writer - after stopActivity a zombie goto cannot navigate; follow survives a brain/scheduler/mine request', async () => {
    const { inst, bot } = mkInst(); inst.activities.follow = { run: async () => {}, halt() {}, prepare: async () => null };
    inst.activities.mine = { run: async () => { try { await inst.goto(5, 64, 5, 2, 500); } catch { /* ignore */ } }, halt() {} };
    inst.runActivity('follow', { player: 'A' });
    assert.throws(() => inst.runActivity('mine', {}, { source: 'brain' }), /Busy with "follow"/);
    assert.throws(() => inst.runActivity('mine', {}, { source: 'scheduler' }), /Busy with "follow"/);
    assert.throws(() => inst.stopActivity({ source: 'brain' }), /Busy/);
    assert.strictEqual(inst.activeActivity, 'follow');
    inst.runActivity('mine', {}, { source: 'user' });                      // the user may replace it deliberately
    assert.strictEqual(inst.activeActivity, 'mine');
    inst.stopActivity(); await assert.rejects(inst.goto(1, 64, 1), (e) => e.cancelled);   // no active task => no navigation
  });
  await test('BotInstance: stop+start of the SAME activity never runs two loops at once (serialised)', async () => {
    const { inst } = mkInst(); let running = 0, maxRunning = 0, runs = 0;
    inst.activities.mine = { async run() { runs++; running++; maxRunning = Math.max(maxRunning, running); try { await inst.sleep(60); } finally { running--; } }, halt() {} };
    inst.runActivity('mine'); inst.stopActivity(); inst.runActivity('mine'); inst.stopActivity(); inst.runActivity('mine');
    await sleep(300);
    assert.strictEqual(maxRunning, 1, 'overlapping loops detected'); assert.ok(runs >= 1);
  });
  await test('BotInstance: combat takes the pathfinder from mining, then mining RESUMES (no "Path was stopped" failure)', async () => {
    const { inst, bot } = mkInst(); bot.pathfinder.goto = (function (orig) { return orig; })(bot.pathfinder.goto.bind(bot.pathfinder));
    let err = null, reached = false;
    inst.activities.mine = { async run() { try { await inst.goto(5, 64, 5, 2, 3000); reached = true; } catch (e) { err = e; } }, halt() {} };
    inst.runActivity('mine'); await sleep(10);
    inst.nav.hold('combat', new goals.GoalFollow({}, 2), true); await sleep(80); assert.strictEqual(err, null);
    inst.nav.release('combat'); await sleep(150);
    assert.strictEqual(reached, true); assert.strictEqual(err, null);
  });
  await test('BotInstance: detach clears every timer/listener/nav state (no leaks after disconnect)', async () => {
    const { inst, bot } = mkInst({ combat: { enabled: true }, survival: { enabled: true } }); inst.state.status = 'online';
    inst._attachModules();
    assert.ok(inst.modules.follow && inst.modules.grind && inst.modules.house && inst.modules.invtools && inst.modules.autojump && inst.modules.survival);
    inst.setAutoJump(true); inst.nav.hold('follow', new goals.GoalFollow({}, 3), true);
    assert.ok(inst._botTimers.size > 0 && inst._listeners.length > 0);
    inst._detach();
    assert.strictEqual(inst._botTimers.size, 0); assert.strictEqual(inst._listeners.length, 0);
    assert.strictEqual(inst.nav.holds.size, 0); assert.strictEqual(inst.nav._wd, null); assert.strictEqual(inst.paused, false);
  });
  await test('BotInstance: startActivity surfaces pre-flight errors (no fake "started" success)', async () => {
    const { inst, bot } = mkInst(); inst._attachModules();
    await assert.rejects(inst.startActivity('grind', { resource: 'coal', amount: 5 }), /Missing tool|No coal/);
    assert.strictEqual(inst.activeActivity, null);
    await assert.rejects(inst.startActivity('follow', { player: 'Nobody' }), /not online/);
    assert.strictEqual(inst.activeActivity, null);
  });

  // ================= chat commands plugin (C) =================
  await test('plugin chat-commands: exports {name,version,init}; .follow / .stopmove work; allow-list + cooldown enforced', async () => {
    const plugin = R('plugins/chat-commands');
    assert.ok(plugin.name && plugin.version && typeof plugin.init === 'function');
    const { inst, bot } = mkInst(); const said = []; const calls = [];
    inst.startActivity = async (n, p) => { calls.push([n, p]); }; inst.stopMovement = () => 'follow';
    const ctx = { instance: inst, addLog() {}, chat: (m) => said.push(m), listen: inst.listen.bind(inst) };
    plugin.init(bot, ctx);
    const say = async (u, m) => { inst.emit('chat', { username: u, message: m }); await sleep(5); };
    await say('Ann', '.follow Bob'); assert.deepStrictEqual(calls[0], ['follow', { player: 'Bob' }]); assert.match(said[0], /^@Ann following Bob/);
    await say('Ann', '.follow Bob'); assert.strictEqual(calls.length, 1, 'cooldown');
    await say('Cid', '.follow'); assert.deepStrictEqual(calls[1], ['follow', { player: 'Cid' }]);
    await say('Dan', '.stopmove'); assert.match(said.pop(), /@Dan stopped follow/);
    await say('Eve', 'hello .follow Bob'); await say('Eve', '.followers'); assert.strictEqual(calls.length, 2, 'only exact commands at the start of a message');
    inst.startActivity = async () => { throw new Error('Player "Zed" is not online'); }; await say('Fay', '.follow Zed'); assert.match(said.pop(), /can't follow: Player "Zed" is not online/);
    inst.config.chat_commands = { allowed_players: ['Gus'] }; await say('Hal', '.stopmove'); const n = said.length; await say('Gus', '.stopmove'); assert.strictEqual(said.length, n + 1);
    inst._detach(); assert.strictEqual(inst._listeners.length, 0);
  });

  // ================= routes + frontend wiring =================
  await test('routes/extras: status codes / formats for bad input, offline bot, protected drop; request bodies reach the modules', async () => {
    const { inst, bot, state } = mkInst(); inst._attachModules(); state.instances.set('main', inst);
    const { extrasRoutes } = R('routes/extras'); const routes = extrasRoutes().routes;
    const call = async (key, body = {}, query = {}) => { let out; const res = { status(c) { out = { status: c }; return this; }, json(b) { out = { status: 200, ...out, body: b }; } }; await routes[key]({ body, query }, res); return out; };
    assert.strictEqual((await call('POST /api/autojump', { enabled: 'yes' })).status, 400);
    assert.deepStrictEqual((await call('POST /api/autojump', { enabled: true })).body, { ok: true, enabled: true });
    assert.strictEqual(inst.modules.autojump.isEnabled(), true);
    assert.strictEqual((await call('POST /api/autojump', { enabled: false })).body.enabled, false); assert.strictEqual(inst.modules.autojump.isEnabled(), false);
    assert.strictEqual((await call('POST /api/follow', { player: 'Ghost' })).status, 400);
    assert.strictEqual((await call('POST /api/autojump', { account: 'nope', enabled: true })).status, 404);
    bot.give('diamond_sword', 1);
    const d1 = await call('POST /api/inventory/drop', { name: 'diamond_sword', count: 1 }); assert.strictEqual(d1.status, 409); assert.strictEqual(d1.body.requiresConfirm, true);
    const d2 = await call('POST /api/inventory/drop', { name: 'diamond_sword', count: 1, confirmProtected: true }); assert.strictEqual(d2.status, 200); assert.strictEqual(d2.body.dropped, 1);
    assert.strictEqual((await call('POST /api/inventory/drop', { name: 'dirt', count: 1 })).status, 404);
    const items = await call('GET /api/inventory/items', {}, {}); assert.ok(Array.isArray(items.body.items));
    const st = await call('POST /api/stopmove', {}); assert.deepStrictEqual(st.body, { ok: true, stopped: null });
    const t = await call('GET /api/task'); assert.ok('task' in t.body && 'detail' in t.body && 'lastResult' in t.body);
    inst.state.status = 'offline'; inst.bot = null; const off = await call('POST /api/grind', { resource: 'coal', amount: 1 }); assert.strictEqual(off.status, 409);
  });
  await test('frontend <-> backend: every endpoint used by public/js/extras.js is registered in routes/extras.js with the right method', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/extras.js'), 'utf8');
    const { extrasRoutes } = R('routes/extras'); const routes = Object.keys(extrasRoutes().routes);
    const used = new Set();
    for (const m of src.matchAll(/call\("(\/api\/[\w/]+)"/g)) used.add('POST ' + m[1]);
    for (const m of src.matchAll(/Bot\.api\("(\/api\/[\w/]+)(?:\?[^"]*)?"\)/g)) used.add('GET ' + m[1]);
    for (const m of src.matchAll(/Bot\.api\(`(\/api\/[\w/]+)(?:\?[^`]*)?`\)/g)) used.add('GET ' + m[1]);
    for (const m of src.matchAll(/fetch\("(\/api\/[\w/]+)",\s*\{\s*method:\s*"POST"/g)) used.add('POST ' + m[1]);
    assert.ok(used.size >= 10, 'expected to detect all frontend calls, found ' + [...used].join(', '));
    for (const u of used) assert.ok(routes.includes(u), `frontend calls ${u} but backend has no such route`);
    const fields = { follow: ['player'], grind: ['resource', 'amount'], drop: ['name', 'count', 'confirmProtected'] };
    for (const f of fields.drop) assert.ok(src.includes(f)); for (const f of fields.grind) assert.ok(src.includes(f));
    const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
    assert.ok(/data-tab="control"/.test(html) && /id="tab-control"/.test(html) && /id="controlMount"/.test(html) && /js\/extras\.js/.test(html));
    for (const id of [...src.matchAll(/\$\("(x\w+)"\)/g)].map((m) => m[1])) assert.ok(new RegExp(`id="${id}"`).test(src), `element #${id} is referenced but never created`);
  });
  await test('index.js mounts extras routes before the /api catch-all and keeps auth ordering', async () => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(s.indexOf('app.use(auth.requireAuth)') < s.indexOf('app.use(extrasRoutes())'));
    assert.ok(s.indexOf('app.use(extrasRoutes())') < s.indexOf('app.use(apiRoutes())'));
  });

  // ---------- report ----------
  let bad = 0;
  for (const [ok, name, e] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) { bad++; console.log('      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); } }
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
