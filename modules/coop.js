/** Friend/co-op controller. It follows the selected online player whenever no higher-level task owns movement. */
const { goals } = require('mineflayer-pathfinder');
const database = require('../core/database');
function create(inst) {
  let stopped = false, lastState = '', lastMissingLog = 0, autoIndex = 0;
  const key = `friend:${inst.id}`;
  const read = () => ({ username: null, enabled: false, distance: 3, autoTasks: true, ...database.kvGet(key, {}) });
  const write = v => database.kvSet(key, v);
  function setFriend(username, enabled = true, distance = 3) {
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Friend username must be 3-16 letters, numbers, or underscores');
    if (name.toLowerCase() === inst.account.username.toLowerCase()) throw new Error('A bot cannot be its own friend');
    const old = read(); const next = { ...old, username: name, enabled: !!enabled, distance: Math.max(2, Math.min(8, Number(distance) || 3)) };
    write(next); inst.nav.release('coop');
    inst.addLog(`Co-op friend ${name} ${enabled ? 'selected' : 'saved but disabled'}`, 'control');
    inst.emitSocket('friend_status', status()); return next;
  }
  function enable(enabled) { const v = read(); v.enabled = !!enabled; write(v); if (!v.enabled) inst.nav.release('coop'); inst.emitSocket('friend_status', status()); return v; }
  function setAutoTasks(enabled) { const v = read(); v.autoTasks = !!enabled; write(v); return v; }
  function status() {
    const v = read(), player = v.username && inst.bot?.players?.[v.username];
    return { ...v, online: !!player, visible: !!player?.entity, distance: player?.entity && inst.bot?.entity ? +player.entity.position.distanceTo(inst.bot.entity.position).toFixed(1) : null };
  }
  function yieldNavigation() { inst.nav.release('coop'); }
  function tick() {
    if (stopped || !inst.isOnline()) return;
    const v = read();
    if (!v.enabled || !v.username) { inst.nav.release('coop'); setState('disabled'); return; }
    const player = inst.bot.players[v.username];
    if (!player) { inst.nav.release('coop'); setState('waiting', v.username); return; }
    if (!player.entity?.position) {
      inst.nav.release('coop');
      if (Date.now() - lastMissingLog > 30000) { inst.addLog(`Co-op: ${v.username} is online but outside view distance`, 'warn'); lastMissingLog = Date.now(); }
      setState('out_of_range', v.username); return;
    }
    // Do not fight the user's active task or the combat controller for the one pathfinder goal.
    if (inst.activeActivity || inst.combatBusy || inst.paused) { inst.nav.release('coop'); setState('yielding', inst.activeActivity || 'combat/rest'); return; }
    const d = player.entity.position.distanceTo(inst.bot.entity.position);
    if (d > v.distance + 0.6) {
      inst.nav.hold('coop', new goals.GoalFollow(player.entity, v.distance), true);
      setState('following', `${v.username} (${d.toFixed(1)} blocks)`);
      return;
    }
    inst.nav.release('coop');
    if (v.autoTasks) {
      const queue = inst.modules.taskQueue;
      if (queue && queue.list().length === 0) {
        const cfg = inst.config.modules || {};
        const choices = [
          ['mine', cfg.auto_mine?.enabled], ['farm', cfg.auto_farm?.enabled], ['chop', cfg.auto_chop?.enabled],
          ['fish', cfg.auto_fish?.enabled], ['trade', cfg.auto_trade?.enabled], ['grind', cfg.auto_grind?.enabled],
          ['explore', true], ['branchmine', true],
        ].filter(([name, enabled]) => enabled && inst.activities[name]);
        if (choices.length) {
          const [name] = choices[autoIndex++ % choices.length];
          try { queue.enqueue(name, {}, 0, 180); } catch (e) { inst.addLog(`Co-op auto task: ${e.message}`, 'warn'); }
        }
      }
      setState('co_op_tasks', v.username);
    } else setState('near_friend', v.username);
  }
  function setState(s, detail) { if (s === lastState) return; lastState = s; inst.emitSocket('friend_status', { ...status(), state: s, detail }); }
  return {
    setFriend, enable, setAutoTasks, status, yieldNavigation,
    init() { inst.every(tick, 750); },
    stop() { stopped = true; inst.nav.release('coop'); },
  };
}
module.exports = { create };
