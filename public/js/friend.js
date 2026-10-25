/* Friend/co-op and priority task queue controls. */
(() => {
  const $ = id => document.getElementById(id);
  if (!$('friendStart') || !window.Bot) return;
  const esc = Bot.esc;
  const api = (url, method='GET', body) => Bot.api(url, method, method === 'GET' ? undefined : { account: Bot.account, ...(body || {}) });
  const query = path => `${path}${path.includes('?') ? '&' : '?'}account=${encodeURIComponent(Bot.account || '')}`;
  const msg = (id, text, kind='info') => { const el=$(id); el.textContent=text; el.className=`xmsg ${kind}`; };
  async function loadPlayers() {
    try {
      const d = await Bot.api(query('/api/players'));
      const list = (d.players || []).filter(p => !p.self);
      const sel = $('friendOnline'), current = sel.value;
      sel.innerHTML = list.length ? list.map(p => `<option value="${esc(p.username)}">${esc(p.username)}</option>`).join('') : '<option value="">No other players online</option>';
      if (list.some(p => p.username === current)) sel.value = current;
    } catch (e) { msg('friendStatus', e.message, 'bad'); }
  }
  async function loadFriend() {
    try {
      const d = await api(query('/api/friend'));
      const f = d.friend || {};
      if (f.username) $('friendName').value = f.username;
      $('friendDistance').value = f.distance || 3;
      $('friendAutoTasks').checked = !!f.autoTasks;
      msg('friendStatus', `Friend: ${f.username || 'not selected'} | mode: ${f.state || (f.enabled ? 'enabled' : 'disabled')} | online: ${f.online ? 'yes' : 'no'}${f.visible === false ? ' | not visible (view distance)' : ''}${f.distance != null && f.username ? ` | ${f.distance} blocks away` : ''}`, f.enabled ? 'ok' : 'info');
    } catch (e) { msg('friendStatus', e.message, 'bad'); }
  }
  async function loadQueue() {
    try {
      const d = await api(query('/api/queue'));
      msg('queueStatus', d.runningId ? `Running queue item ${d.runningId}; started ${new Date(d.startedAt).toLocaleTimeString()}` : `${d.items.length} pending task(s).`, 'info');
      $('queueItems').innerHTML = d.items.length ? d.items.map((x, i) => `<div class="card" style="padding:10px"><div class="flex items-center gap-2"><strong>${i+1}. ${esc(x.name)}</strong><span class="badge">Priority ${x.priority}</span><span class="muted" style="margin-left:auto">max ${x.durationSec}s</span><button class="btn danger sm" data-remove="${esc(x.id)}">Remove</button></div><div class="muted mono" style="font-size:12px;margin-top:5px">${esc(JSON.stringify(x.params || {}))}</div></div>`).join('') : '<p class="muted">Queue is empty.</p>';
      $('queueItems').querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => { try { await api(`/api/queue/${encodeURIComponent(b.dataset.remove)}`, 'DELETE', {}); await loadQueue(); } catch(e) { msg('queueStatus', e.message, 'bad'); } });
    } catch (e) { msg('queueStatus', e.message, 'bad'); $('queueItems').innerHTML=''; }
  }
  $('friendOnline').addEventListener('change', () => { if ($('friendOnline').value) $('friendName').value=$('friendOnline').value; });
  $('friendStart').onclick = async () => {
    try {
      const username = $('friendName').value.trim();
      const distance = Number($('friendDistance').value);
      await api('/api/friend', 'POST', { username, distance, enabled: true });
      await api('/api/friend/auto-tasks', 'POST', { enabled: $('friendAutoTasks').checked });
      await loadFriend(); Bot.toast(`Co-op enabled for ${username}`, 'success');
    } catch(e) { msg('friendStatus', e.message, 'bad'); }
  };
  $('friendStop').onclick = async () => { try { await api('/api/friend/enable','POST',{enabled:false}); await loadFriend(); Bot.toast('Co-op stopped','success'); } catch(e) { msg('friendStatus',e.message,'bad'); } };
  $('friendRefresh').onclick = async () => { await loadPlayers(); await loadFriend(); };
  $('friendAutoTasks').onchange = async () => { try { await api('/api/friend/auto-tasks','POST',{enabled:$('friendAutoTasks').checked}); await loadFriend(); } catch(e) { msg('friendStatus',e.message,'bad'); } };
  $('queueAdd').onclick = async () => {
    try {
      let params; try { params = JSON.parse($('queueParams').value || '{}'); } catch { throw new Error('Activity parameters must be valid JSON'); }
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Activity parameters must be a JSON object');
      await api('/api/queue','POST',{name:$('queueName').value,params,priority:Number($('queuePriority').value),durationSec:Number($('queueDuration').value)});
      await loadQueue(); Bot.toast('Task added to queue','success');
    } catch(e) { msg('queueStatus',e.message,'bad'); }
  };
  $('queueClear').onclick = async () => { if (!confirm('Clear all queued tasks and stop the currently queued task?')) return; try { await api('/api/queue','DELETE',{}); await loadQueue(); } catch(e) { msg('queueStatus',e.message,'bad'); } };
  $('queueRefresh').onclick = loadQueue;
  Bot.on('instances', () => { loadPlayers(); loadFriend(); loadQueue(); });
  Bot.on('players', () => loadPlayers());
  Bot.socket.on('friend_status', d => { if (d.account && d.account !== Bot.account) return; loadFriend(); });
  Bot.socket.on('task_result', () => loadQueue());
  const refresh = () => { loadPlayers(); loadFriend(); loadQueue(); };
  [...document.querySelectorAll('#nav button')].find(b => b.dataset.tab === 'friends')?.addEventListener('click', refresh);
  refresh();
})();
