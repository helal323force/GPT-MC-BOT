'use strict';
/**
 * scripts/test-nav.js - offline tests for the v3.1 navigation coordinator and feature logic.
 * Run: node scripts/test-nav.js
 * Uses a MOCK pathfinder/bot (no Minecraft, no network). It proves the coordination logic, not live
 * pathfinding. The mock exists in two flavours because the real library's exact rejection behaviour
 * could not be inspected: "strict" rejects pending goto() on setGoal()/stop(); "lenient" does not and
 * also resolves ALL pending goto()s when any goal is reached (worst case).
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const { Nav, NavCancelled } = require('../modules/nav');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MSG = 'Path was stopped before it could be completed! Thus, the desired goal was not reached.';

class MockPF extends EventEmitter {
  constructor(strict) { super(); this.strict = strict; this.pending = []; this.goal = null; this.log = []; this.timer = null; }
  _arm() {
    clearTimeout(this.timer);
    if (!this.goal || !this.goal.ms) return;
    const g = this.goal;
    this.timer = setTimeout(() => {
      if (this.goal !== g) return;
      this.log.push('reached:' + g.name);
      const list = this.strict ? this.pending.filter((p) => p.goal === g) : this.pending.slice();
      this.pending = this.pending.filter((p) => !list.includes(p));
      list.forEach((p) => p.res());
      if (!g.dynamic) this.goal = null;
    }, g.ms);
  }
  setGoal(goal, dynamic) {
    this.log.push('setGoal:' + (goal ? goal.name : 'null'));
    if (this.strict) { const rej = this.pending.filter((p) => p.goal !== goal); this.pending = this.pending.filter((p) => p.goal === goal); rej.forEach((p) => p.rej(new Error(MSG))); }
    this.goal = goal; if (goal) goal.dynamic = !!dynamic; this._arm();
  }
  goto(goal) { return new Promise((res, rej) => { this.pending.push({ goal, res, rej }); this.setGoal(goal, false); }); }
  stop() { this.log.push('stop'); const all = this.pending; this.pending = []; this.goal = null; clearTimeout(this.timer); if (this.strict) all.forEach((p) => p.rej(new Error(MSG))); }
  setMovements(m) { this.log.push('movements'); this.movements = m; }
}
const goal = (name, ms) => ({ name, ms });
function rig(strict) {
  const pf = new MockPF(strict);
  const inst = { bot: { pathfinder: pf }, movements: { id: 'work' }, safeMovements: { id: 'safe' }, paused: false };
  return { pf, inst, nav: new Nav(inst) };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e]); }
}

(async () => {
  for (const strict of [true, false]) {
    const tag = strict ? '[strict]' : '[lenient]';

    await test(`${tag} low-priority goto survives a combat hold and RESUMES (no "Path was stopped")`, async () => {
      const { pf, nav } = rig(strict);
      const mine = nav.goto('mine', goal('ore', 200), { timeoutMs: 3000 });
      let err = null; mine.catch((e) => { err = e; });
      await sleep(50);
      nav.hold('combat', goal('zombie', 0), true);          // preempts mining
      await sleep(80);
      assert.strictEqual(pf.goal.name, 'zombie');
      assert.strictEqual(err, null, 'mining goto must not reject when preempted');
      nav.release('combat');
      await mine;                                           // resumes the SAME goal and completes
      assert.ok(pf.log.includes('reached:ore'));
      assert.strictEqual(err, null);
    });

    await test(`${tag} follow hold is re-applied after a survival goto finishes`, async () => {
      const { pf, nav } = rig(strict);
      nav.hold('follow', goal('player', 0), true);
      assert.strictEqual(pf.goal.name, 'player');
      await nav.goto('survival', goal('safe', 60), { timeoutMs: 2000 });
      assert.strictEqual(pf.goal.name, 'player', 'follow must resume after retreat');
    });

    await test(`${tag} a lower-priority owner can neither cancel nor displace follow`, async () => {
      const { pf, nav } = rig(strict);
      nav.hold('follow', goal('player', 0), true);
      const p = nav.goto('mine', goal('ore', 30), { timeoutMs: 300 });
      nav.cancel('mine');                                   // like stopActivity() of another task
      await assert.rejects(p, (e) => e instanceof NavCancelled);
      assert.strictEqual(pf.goal.name, 'player');
      assert.ok(!pf.log.includes('setGoal:ore'), 'mining must never have taken the pathfinder');
    });

    await test(`${tag} goto timeout fails honestly and does NOT stop another owner's goal`, async () => {
      const { pf, nav } = rig(strict);
      nav.hold('follow', goal('player', 0), true);
      await assert.rejects(nav.goto('mine', goal('ore', 0), { timeoutMs: 120 }), /navigation timeout/);
      assert.strictEqual(pf.goal.name, 'player');
      assert.ok(!pf.log.includes('stop'));
    });

    await test(`${tag} a real timeout (own goal never reached) stops pathfinding`, async () => {
      const { pf, nav } = rig(strict);
      await assert.rejects(nav.goto('mine', goal('far', 0), { timeoutMs: 100 }), /navigation timeout/);
      assert.strictEqual(pf.goal, null);
      assert.strictEqual(nav.isActive(), false);
    });

    await test(`${tag} cancel(owner) rejects its pending goto and frees the pathfinder`, async () => {
      const { pf, nav } = rig(strict);
      const p = nav.goto('mine', goal('ore', 1000), { timeoutMs: 3000 });
      await sleep(30);
      nav.cancel('mine');
      await assert.rejects(p, (e) => e.cancelled === true);
      assert.strictEqual(pf.goal, null);
      assert.strictEqual(nav.isActive(), false);
    });

    await test(`${tag} reset() (disconnect) cancels everything and clears holds`, async () => {
      const { nav } = rig(strict);
      nav.hold('follow', goal('player', 0), true);
      const p = nav.goto('survival', goal('safe', 1000), { timeoutMs: 3000 });
      await sleep(20);
      nav.reset();
      await assert.rejects(p, (e) => e.cancelled === true);
      assert.strictEqual(nav.holds.size, 0);
      assert.strictEqual(nav.isActive(), false);
    });

    await test(`${tag} second goto from the SAME owner supersedes the first (no ping-pong)`, async () => {
      const { nav } = rig(strict);
      const a = nav.goto('move', goal('a', 500), { timeoutMs: 2000 });
      a.catch(() => {});
      await sleep(20);
      await nav.goto('move', goal('b', 40), { timeoutMs: 2000 });
      await assert.rejects(a, /superseded/);
    });

    await test(`${tag} survival rest (inst.paused) blocks work but not survival`, async () => {
      const { pf, nav, inst } = rig(strict);
      inst.paused = true;
      const work = nav.goto('mine', goal('ore', 20), { timeoutMs: 400 });
      work.catch(() => {});
      await nav.goto('survival', goal('safe', 20), { timeoutMs: 400 });
      assert.ok(pf.log.includes('reached:safe'));
      await assert.rejects(work, /navigation timeout/);
      assert.ok(!pf.log.includes('setGoal:ore'));
    });

    await test(`${tag} combat hold is applied once, not re-set every tick`, async () => {
      const { pf, nav } = rig(strict);
      const g = goal('zombie', 0);
      nav.hold('combat', g, true);
      for (let i = 0; i < 10; i++) { if (!nav.hold_has('combat')) nav.hold('combat', g, true); }
      nav.hold('combat', g, true);                           // same goal object: must be a no-op for pathfinder
      assert.strictEqual(pf.log.filter((l) => l === 'setGoal:zombie').length, 1);
    });
  }

  await test('dynamic follow goal updates do not restart the pathfinder every tick', async () => {
    const { pf, nav } = rig(true);
    class GoalFollow { constructor(entity, range) { this.entity = entity; this.range = range; } }
    const entity = { id: 7 };
    nav.hold('follow', new GoalFollow(entity, 3), true);
    for (let i = 0; i < 20; i++) nav.hold('follow', new GoalFollow(entity, 3), true);
    assert.strictEqual(pf.log.filter((l) => l === 'setGoal:undefined').length, 1, 'equivalent follow goal should only be applied once');
  });

  await test('movement profile: follow/combat/house use safe movements, mining uses the work profile', async () => {
    const { pf, nav } = rig(true);
    nav.hold('follow', goal('p', 0), true);
    assert.strictEqual(pf.movements.id, 'safe');
    nav.release('follow');
    await nav.goto('mine', goal('ore', 10), { timeoutMs: 500 });
    assert.strictEqual(pf.movements.id, 'work');
  });

  // ---- stuck watchdog (the "bot cannot get past a 1-block step" fix) ----
  const vec = (x, y, z) => ({ x, y, z, clone() { return vec(x, y, z); }, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); } });
  function stuckRig(moving) {
    const r = rig(true);
    const jumps = [];
    r.pf.isMoving = () => true;
    r.inst.bot.entity = { position: vec(0, 64, 0), onGround: true };
    r.inst.bot.setControlState = (k, v) => { if (k === 'jump') jumps.push(v); };
    r.inst.addLog = () => {};
    r.nav.stuckCfg = { tickMs: 20, firstMs: 100, secondMs: 400, giveUpMs: 700 };
    r.jumps = jumps;
    if (moving) { let x = 0; r.timer = setInterval(() => { x += 1; r.inst.bot.entity.position = vec(x, 64, 0); }, 10); }
    return r;
  }

  await test('stuck watchdog: no progress => jump pulse, then honest "stuck" failure (not a silent hang)', async () => {
    const r = stuckRig(false);
    await assert.rejects(r.nav.goto('move', goal('far', 0), { timeoutMs: 5000 }), /stuck/);
    assert.ok(r.jumps.filter((v) => v === true).length >= 2, 'expected at least 2 jump pulses, got ' + r.jumps.join());
    assert.strictEqual(r.jumps[r.jumps.length - 1], false, 'jump key must be released');
    assert.strictEqual(r.nav._wd, null, 'watchdog timer must be gone after the goto ended');
  });

  await test('stuck watchdog: works for held goals too (re-plans, never throws)', async () => {
    const r = stuckRig(false);
    r.nav.hold('follow', goal('player', 0), true);
    await sleep(600);
    assert.ok(r.jumps.includes(true));
    assert.ok(r.pf.log.filter((l) => l === 'setGoal:player').length >= 2, 'goal should be re-issued once');
    r.nav.release('follow');
    await sleep(40);
    assert.strictEqual(r.nav._wd, null);
  });

  await test('stuck watchdog: a bot that IS making progress is never jumped or aborted', async () => {
    const r = stuckRig(true);
    await r.nav.goto('move', goal('near', 450), { timeoutMs: 3000 });
    clearInterval(r.timer);
    assert.strictEqual(r.jumps.filter((v) => v === true).length, 0);
  });

  await test('stuck watchdog: no timer left running after cancel / reset', async () => {
    const r = stuckRig(false);
    const p = r.nav.goto('mine', goal('x', 0), { timeoutMs: 3000 }); p.catch(() => {});
    await sleep(40);
    assert.ok(r.nav._wd, 'watchdog should run while navigating');
    r.nav.cancel('mine');
    await assert.rejects(p, (e) => e.cancelled);
    assert.strictEqual(r.nav._wd, null);
    r.nav.hold('follow', goal('p', 0), true); r.nav.reset();
    assert.strictEqual(r.nav._wd, null);
  });

  global.__navResults = results;
  if (require.main === module) {
    let bad = 0;
    for (const [ok, name, e] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) { bad++; console.log('      ', e && e.message); } }
    console.log(`\n${results.length - bad}/${results.length} passed`);
    process.exit(bad ? 1 : 0);
  }
})();
