'use strict';
// Syntax-checks every .js file (node --check), validates settings.json and the ENV: resolver.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'data']);
let failed = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
      catch (err) { failed++; console.error('FAIL', path.relative(root, p), '\n', String(err.stderr || err)); }
    }
  }
}
walk(root);
// Regression guards for bugs that were present in the delivered ZIP.
try {
  const api = fs.readFileSync(path.join(root, 'routes/api.js'), 'utf8');
  const nav = fs.readFileSync(path.join(root, 'modules/nav.js'), 'utf8');
  const bot = fs.readFileSync(path.join(root, 'core/bot-instance.js'), 'utf8');
  if (!api.includes('r.post("/api/profiles"') || !api.includes('r.get("/api/profiles"') || !api.includes('r.delete("/api/profiles/:id"')) throw new Error('dashboard profile API routes are missing');
  if (!nav.includes('else if (h.type === "goto" && h.goal) pf.setGoal(h.goal)')) throw new Error('stuck-navigation re-plan regression');
  if (!bot.includes('this.movements.allowParkour = true') || !bot.includes('this.movements.canOpenDoors = true')) throw new Error('extended pathfinding movement options missing');
  const advanced = fs.readFileSync(path.join(root, 'modules/advanced-survival.js'), 'utf8');
  const extras = fs.readFileSync(path.join(root, 'routes/extras.js'), 'utf8');
  const queue = fs.readFileSync(path.join(root, 'modules/task-queue.js'), 'utf8');
  const coop = fs.readFileSync(path.join(root, 'modules/coop.js'), 'utf8');
  if (!bot.includes('"advanced", "../modules/advanced-survival"')) throw new Error('advanced survival module not registered');
  for (const route of ['/api/automation/run', '/api/automation/memory', '/api/automation/waypoint/go']) if (!extras.includes(route)) throw new Error(`missing route ${route}`);
  for (const task of ['branchmine', 'loot', 'smelt', 'store', 'explore', 'base', 'boss', 'guard']) if (!queue.includes(`'${task}'`) || !advanced.includes(`${task}`)) throw new Error(`advanced task ${task} is not wired`);
  if (!coop.includes("['explore', true]") || !coop.includes("['branchmine', true]")) throw new Error('co-op auto survival tasks are missing');
  const cfgBackup = fs.readFileSync(path.join(root, 'modules/config-backup.js'), 'utf8');
  if (!cfgBackup.includes('config-backups') || !extras.includes('/api/config-backups')) throw new Error('configuration backup is not wired');
  if (!bot.includes('Auto-recovery: respawn requested') || !bot.includes('rememberEvent({ kind: "task-result"')) throw new Error('death recovery or world task memory missing');
  const brain = fs.readFileSync(path.join(root, 'modules/ai-brain.js'), 'utf8');
  if (!brain.includes('branchmine') || !brain.includes('explore')) throw new Error('AI brain advanced actions missing');
  const front = fs.readFileSync(path.join(root, 'public/js/automation.js'), 'utf8');
  for (const route of ['/api/automation/run', '/api/automation/memory', '/api/config-backups']) if (!front.includes(route)) throw new Error(`automation dashboard route missing: ${route}`);
} catch (e) { failed++; console.error('regression check failed:', e.message); }
try {
  const s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  const { resolveEnv } = require('../core/util');
  process.env.__T = 'ok';
  if (resolveEnv('ENV:__T') !== 'ok' || resolveEnv('ENV:__MISSING|dflt') !== 'dflt') throw new Error('ENV resolver broken');
  if (!Array.isArray(s.accounts)) throw new Error('settings.accounts must be an array');
} catch (e) { failed++; console.error('settings.json check failed:', e.message); }
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('All checks passed');
