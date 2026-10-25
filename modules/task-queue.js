/** Persistent per-account priority task queue. Activities still use the existing activity runner. */
const crypto = require('crypto');
const database = require('../core/database');
const ALLOWED = new Set(['mine','farm','fish','chop','trade','grind','house','build','move','follow','branchmine','loot','smelt','store','explore','base','boss','guard']);
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || min));
function create(inst) {
  const key = `task_queue:${inst.id}`;
  let runningId = null, startedAt = 0, baselineResultTs = 0, runningName = null, durationTimer = null, stopped = false;
  const load = () => { const q = database.kvGet(key, []); return Array.isArray(q) ? q : []; };
  const save = q => database.kvSet(key, q.slice(0, 100));
  function list() { return load().sort((a,b) => (b.priority||0)-(a.priority||0) || a.createdAt-b.createdAt); }
  function enqueue(name, params = {}, priority = 0, durationSec = 300) {
    if (!ALLOWED.has(name)) throw new Error(`Unsupported queue activity: ${name}`);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object');
    const q = load(); if (q.length >= 100) throw new Error('Queue is full (100 tasks maximum)');
    const item = { id: crypto.randomUUID(), name, params, priority: clamp(priority, -100, 100), durationSec: clamp(durationSec, 10, 3600), createdAt: Date.now(), status: 'pending' };
    q.push(item); save(q); inst.addLog(`Queued ${name} (priority ${item.priority}, max ${item.durationSec}s)`, 'control'); return item;
  }
  function remove(id) { const q = load(), next = q.filter(x => x.id !== id); save(next); if (runningId === id) { clearTimeout(durationTimer); durationTimer = null; inst.stopActivity(); runningId = null; } return next.length !== q.length; }
  function clear() { clearTimeout(durationTimer); durationTimer = null; if (runningId) inst.stopActivity(); runningId = null; save([]); }
  async function tick() {
    if (stopped || !inst.isOnline()) return;
    let q = list();
    if (runningId) {
      if (inst.activeActivity) return;
      const idx = q.findIndex(x => x.id === runningId);
      if (idx >= 0) {
        const [done] = q.splice(idx, 1); save(q);
        const result = inst.lastResult;
        if (result && result.ts > baselineResultTs && result.task === runningName) {
          inst.addLog(`Queue task ${result.ok ? 'completed' : 'failed'}: ${done.name} — ${result.message || 'no detail'}`, result.ok ? 'success' : 'warn');
        } else inst.addLog(`Queue task ${done.name} ended without a verified result (stopped or time-limited)`, 'warn');
      }
      runningId = null; runningName = null; baselineResultTs = 0; clearTimeout(durationTimer); durationTimer = null;
    }
    if (inst.activeActivity || inst.combatBusy || inst.paused || !q.length) return;
    const item = q[0];
    try {
      inst.modules.coop?.yieldNavigation();
      const priorResultTs = inst.lastResult?.ts || 0;
      await inst.startActivity(item.name, item.params, { source: 'scheduler' });
      runningId = item.id; runningName = item.name; startedAt = Date.now(); baselineResultTs = priorResultTs;
      durationTimer = setTimeout(() => {
        if (runningId === item.id && inst.activeActivity === item.name) {
          inst.addLog(`Queue time limit reached for ${item.name}; moving to next queued task`, 'warn');
          inst.stopActivity();
        }
      }, item.durationSec * 1000);
      if (durationTimer.unref) durationTimer.unref();
    } catch (e) {
      q = load().filter(x => x.id !== item.id); save(q);
      inst.addLog(`Queue task ${item.name} failed to start: ${e.message}`, 'error');
    }
  }
  return {
    list, enqueue, remove, clear,
    status() { return { runningId, startedAt, items: list() }; },
    init() { inst.every(tick, 1000); },
    stop() { stopped = true; clearTimeout(durationTimer); durationTimer = null; runningId = null; runningName = null; baselineResultTs = 0; },
  };
}
module.exports = { create, ALLOWED };
