/* Dashboard controls for advanced survival activities and persistent world memory. */
(() => {
  const $ = id => document.getElementById(id);
  if (!$('automationStatus') || !window.Bot) return;
  const esc = Bot.esc;
  const query = path => `${path}${path.includes('?') ? '&' : '?'}account=${encodeURIComponent(Bot.account || '')}`;
  const api = (url, method='GET', body) => Bot.api(url, method, method === 'GET' ? undefined : { account: Bot.account, ...(body || {}) });
  const status = (text, kind='info') => { $('automationStatus').textContent = text; $('automationStatus').className = `xmsg ${kind}`; };
  const num = (id, fallback, min, max) => Math.max(min, Math.min(max, Number($(id).value) || fallback));
  function params(name) {
    if (name === 'branchmine') return { length: num('branchLength',16,4,48), axis: $('branchAxis').value };
    if (name === 'explore') return { steps: num('exploreSteps',4,1,12), radius: num('exploreRadius',24,8,48) };
    if (name === 'guard') return { radius: num('guardRadius',8,4,32), durationSec: num('guardDuration',300,10,1800) };
    if (name === 'base') return { size: num('baseSize',5,4,7) };
    if (name === 'boss') return { durationSec: 90, retreatHealth: 7 };
    return {};
  }
  document.querySelectorAll('[data-automation]').forEach(btn => btn.addEventListener('click', async () => {
    const name = btn.dataset.automation;
    const friendly = { branchmine:'Branch mining', loot:'Loot collection', smelt:'Smelting', store:'Chest storage', explore:'Exploration', base:'Base building', boss:'Boss mode', guard:'Base guard' }[name] || name;
    if (['branchmine','smelt','store','base','boss','guard'].includes(name) && !confirm(`Start ${friendly}? The bot may change blocks or move items in the current world.`)) return;
    try {
      await api('/api/automation/run','POST',{ name, params: params(name) });
      status(`${friendly} started. Watch the task status and logs for the real result.`, 'ok');
    } catch (e) { status(e.message || 'Could not start task', 'bad'); }
  }));
  $('automationStop').onclick = async () => { try { const r=await api('/api/automation/stop','POST',{}); status(r.stopped ? `Stopped ${r.stopped}.` : 'No activity was running.'); } catch(e) { status(e.message,'bad'); } };
  async function loadMemory() {
    try {
      const r = await Bot.api(query('/api/automation/memory'));
      const m = r.memory || {};
      const rows = [];
      for (const w of (m.waypoints || []).slice().reverse()) rows.push(`WAYPOINT ${w.name}: ${w.x}, ${w.y ?? '~'}, ${w.z} | ${w.dimension || 'unknown dimension'}`);
      for (const r of (m.resources || []).slice(-12).reverse()) rows.push(`RESOURCE ${r.name}: ${r.x}, ${r.y}, ${r.z}`);
      for (const e of (m.explored || []).slice(-12).reverse()) rows.push(`EXPLORED ${e.kind || 'area'}: ${e.x}, ${e.y ?? '~'}, ${e.z}`);
      for (const e of (m.events || []).slice(-12).reverse()) rows.push(`EVENT ${e.kind || 'event'}: ${e.deposited ?? e.item ?? ''}`);
      $('memoryView').textContent = rows.length ? rows.join('\n') : 'No waypoints or exploration history saved yet.';
      const old = $('waypointGoList'); if (old) old.remove();
      const list = document.createElement('div'); list.id = 'waypointGoList'; list.className = 'flex flex-wrap gap-2';
      for (const w of (m.waypoints || []).slice().reverse()) {
        const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = `Go: ${w.name}`;
        b.addEventListener('click', async () => { try { await api('/api/automation/waypoint/go','POST',{name:w.name}); status(`Navigating to waypoint “${w.name}”.`, 'ok'); } catch(e) { status(e.message,'bad'); } });
        list.appendChild(b);
      }
      $('memoryView').after(list);
    } catch(e) { $('memoryView').textContent = e.message || 'Could not load world memory'; }
  }
  $('waypointSave').onclick = async () => {
    const name = $('waypointName').value.trim();
    const x = Number($('waypointX').value), z = Number($('waypointZ').value);
    const y = $('waypointY').value.trim() === '' ? null : Number($('waypointY').value);
    if (!name || !Number.isFinite(x) || !Number.isFinite(z) || (y !== null && !Number.isFinite(y))) return status('Enter a waypoint name, X and Z; Y is optional.', 'bad');
    try { await api('/api/automation/waypoint','POST',{name,x,y,z}); status(`Waypoint “${name}” saved.`, 'ok'); await loadMemory(); }
    catch(e) { status(e.message,'bad'); }
  };
  $('memoryRefresh').onclick = loadMemory;
  async function loadBackups() {
    try {
      const r = await Bot.api(query('/api/config-backups'));
      $('configBackupList').textContent = (r.backups || []).length ? r.backups.map(b => `${b.name} | ${Math.ceil(b.size/1024)} KB`).join('\n') : 'No configuration backups yet.';
    } catch(e) { $('configBackupList').textContent = e.message || 'Could not load backups'; }
  }
  $('configBackupNow').onclick = async () => {
    try { const r = await api('/api/config-backups','POST',{}); status(`Settings backup created: ${r.backup.name}`, 'ok'); await loadBackups(); }
    catch(e) { status(e.message,'bad'); }
  };
  $('configBackupRefresh').onclick = loadBackups;
  $('memoryClear').onclick = async () => {
    if (!confirm('Clear saved waypoints and exploration memory for this bot profile?')) return;
    try { await api('/api/automation/memory','DELETE',{}); status('World memory cleared.', 'ok'); await loadMemory(); }
    catch(e) { status(e.message,'bad'); }
  };
  Bot.on('instances', () => { loadMemory(); loadBackups(); });
  [...document.querySelectorAll('#nav button')].find(b => b.dataset.tab === 'automation')?.addEventListener('click', loadMemory);
  loadMemory(); loadBackups();
})();
