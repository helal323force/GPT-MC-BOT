/* v3.1 "Control" tab: Auto Jump, Follow/Stop, Resource grinding, House building, Inventory drop, live task status.
 * Loaded after app.js. Uses window.Bot from socket.js. Every control below calls a real endpoint in routes/extras.js:
 *   POST /api/autojump  /api/follow  /api/stopmove  /api/grind/check  /api/grind  /api/house/plan  /api/house  /api/inventory/drop
 *   GET  /api/grind/resources  /api/inventory/items          (account is added automatically from the header selector)
 */
(() => {
  const mount = document.getElementById("controlMount");
  if (!mount || !window.Bot) return;
  const $ = (id) => document.getElementById(id);
  const esc = Bot.esc;

  const css = document.createElement("style");
  css.textContent = `.spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}} .xbar{height:8px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;overflow:hidden}.xbar i{display:block;height:100%;background:var(--accent);transition:width .3s}
  .xrow{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:8px}.xrow>div{flex:1;min-width:110px}.xmsg{margin-top:10px;font-size:14px;white-space:pre-wrap;word-break:break-word}
  .xmsg.ok{color:var(--ok)}.xmsg.bad{color:var(--bad)}.xmsg.info{color:var(--muted)}`;
  document.head.appendChild(css);

  mount.innerHTML = `
  <div class="card" style="grid-column:1/-1">
    <h2>Current task</h2>
    <div class="flex items-center gap-3 flex-wrap"><span class="badge mono" id="xTask">idle</span><span id="xDetail" class="muted"></span><span style="flex:1"></span><button class="btn danger sm" id="xStop">Stop task</button></div>
    <div class="xbar" id="xBarWrap" style="margin-top:10px;display:none"><i id="xBar" style="width:0"></i></div>
    <div class="xmsg info" id="xResult">No task has finished yet.</div>
  </div>

  <div class="card">
    <h2>Movement</h2>
    <div class="flex items-center gap-3"><button class="btn" id="xJump" aria-pressed="false">Auto jump: off</button><span class="muted" style="font-size:13px">Steps over 1-block obstacles during free walking. Pathfinding always jumps when stuck.</span></div>
    <div class="xrow"><div><label for="xPlayer">Follow player</label><select id="xPlayer"><option value="">No players visible</option></select></div>
      <button class="btn primary" id="xFollow">Follow</button><button class="btn" id="xUnfollow">Stop following</button></div>
    <div class="xmsg info" id="xFollowMsg"></div>
  </div>

  <div class="card">
    <h2>Resource grinding</h2>
    <div class="xrow"><div style="flex:2"><label for="xRes">Resource</label><select id="xRes"><option value="">Loading…</option></select></div>
      <div><label for="xAmt">Amount to collect</label><input id="xAmt" type="number" min="1" max="2304" step="1" value="16"></div></div>
    <div class="xrow"><button class="btn" id="xGrindCheck">Check</button><button class="btn primary" id="xGrind">Start grinding</button></div>
    <div class="xmsg info" id="xGrindMsg">“Check” verifies health, tools, inventory space and nearby blocks without starting.</div>
  </div>

  <div class="card">
    <h2>Build a small house</h2>
    <div class="xrow"><div><label for="xSize">Size</label><select id="xSize"><option>4</option><option selected>5</option><option>6</option><option>7</option></select></div>
      <div><label for="xMat">Material (blank = auto)</label><input id="xMat" placeholder="e.g. oak_planks"></div></div>
    <div class="xrow"><div><label for="xHx">X (centre)</label><input id="xHx" type="number" step="1" placeholder="auto"></div><div><label for="xHy">Y (floor)</label><input id="xHy" type="number" step="1" placeholder="auto"></div><div><label for="xHz">Z (centre)</label><input id="xHz" type="number" step="1" placeholder="auto"></div></div>
    <label style="margin-top:8px"><input type="checkbox" id="xPartial" style="width:auto"> Build as far as materials allow</label>
    <div class="xrow"><button class="btn" id="xHouseCheck">Check area</button><button class="btn primary" id="xHouse">Build house</button></div>
    <div class="xmsg info" id="xHouseMsg">Leave X/Y/Z empty to let the bot pick flat, clear ground nearby. It never digs or removes blocks.</div>
  </div>

  <div class="card">
    <h2>Drop an item</h2>
    <div class="xrow"><div style="flex:2"><label for="xItem">Item</label><select id="xItem"><option value="">Loading…</option></select></div>
      <div><label for="xDropAmt">Amount</label><input id="xDropAmt" type="number" min="1" step="1" value="1"></div></div>
    <div class="xrow"><button class="btn danger" id="xDrop">Drop</button><button class="btn sm" id="xAllBtn">All</button><button class="btn sm" id="xRefresh">Refresh</button></div>
    <div class="xmsg info" id="xDropMsg"></div>
  </div>`;

  // ---------- helpers ----------
  const msg = (id, text, kind = "info") => { const el = $(id); el.textContent = text; el.className = `xmsg ${kind}`; };
  async function busy(btn, fn) {
    const label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label}`;
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }
  const call = (url, body) => Bot.api(url, "POST", { account: Bot.account, ...(body || {}) });
  const setOptions = (sel, html) => { if (sel._h !== html) { const v = sel.value; sel.innerHTML = html; sel._h = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; } };

  // ---------- live task status ----------
  function describe(s) {
    const d = s.detail;
    if (!d) return s.rest ? "Resting to recover health - tasks paused" : "";
    if (d.kind === "follow") return d.state === "following" ? `Following ${d.player} (${d.distance} blocks away)` : `Looking for ${d.player} - out of range for ${d.lostForSec}s`;
    if (d.kind === "grind") return `${d.resource}: ${d.collected} / ${d.target} collected (${d.state})`;
    if (d.kind === "house") return `Placed ${d.placed}, ${d.remaining} of ${d.total} blocks left (${d.state})`;
    return "";
  }
  function drawStatus(s) {
    if (!s) return;
    $("xTask").textContent = s.task || "idle";
    $("xDetail").textContent = describe(s);
    const d = s.detail, bar = $("xBarWrap");
    let pct = null;
    if (d?.kind === "grind" && d.target) pct = (d.collected / d.target) * 100;
    if (d?.kind === "house" && d.total) pct = ((d.total - d.remaining) / d.total) * 100;
    bar.style.display = pct === null ? "none" : "block";
    if (pct !== null) $("xBar").style.width = Math.max(0, Math.min(100, pct)) + "%";
    const on = !!s.autoJump, b = $("xJump");
    b.textContent = `Auto jump: ${on ? "on" : "off"}`; b.setAttribute("aria-pressed", on); b.classList.toggle("primary", on);
    if (s.lastResult) { const r = s.lastResult; msg("xResult", `${r.task}: ${r.message}`, r.ok ? "ok" : "bad"); }
  }
  Bot.on("status", drawStatus);
  Bot.on("snapshot", (d) => { drawStatus(d.status); drawPlayers(d.players || []); });
  Bot.socket.on("task_result", (r) => { if (r.account && r.account !== Bot.account) return; Bot.toast(`${r.task}: ${r.message}`, r.ok ? "success" : "error"); });
  if (Bot.status) drawStatus(Bot.status);

  $("xStop").onclick = (e) => busy(e.currentTarget, async () => { try { const r = await call("/api/stopmove"); Bot.toast(r.stopped ? `Stopped ${r.stopped}` : "Nothing was running", "success"); } catch (err) { Bot.toast(err.message, "error"); } });

  // ---------- auto jump ----------
  $("xJump").onclick = (e) => busy(e.currentTarget, async () => {
    try { const r = await call("/api/autojump", { enabled: !Bot.status?.autoJump }); if (Bot.status) Bot.status.autoJump = r.enabled; drawStatus(Bot.status); Bot.toast(`Auto jump ${r.enabled ? "enabled" : "disabled"}`, "success"); }
    catch (err) { Bot.toast(err.message, "error"); }
  });

  // ---------- follow ----------
  function drawPlayers(list) {
    const others = list.filter((p) => !p.self);
    setOptions($("xPlayer"), others.length ? others.map((p) => `<option value="${esc(p.username)}">${esc(p.username)}</option>`).join("") : '<option value="">No players online</option>');
  }
  Bot.on("players", (d) => drawPlayers(d.players));
  $("xFollow").onclick = (e) => busy(e.currentTarget, async () => {
    const p = $("xPlayer").value; if (!p) return msg("xFollowMsg", "Choose a player first.", "bad");
    try { await call("/api/follow", { player: p }); msg("xFollowMsg", `Now following ${p}.`, "ok"); }
    catch (err) { msg("xFollowMsg", err.message, "bad"); }
  });
  $("xUnfollow").onclick = (e) => busy(e.currentTarget, async () => {
    try { const r = await call("/api/stopmove"); msg("xFollowMsg", r.stopped ? `Stopped ${r.stopped}.` : "Nothing was running.", "ok"); }
    catch (err) { msg("xFollowMsg", err.message, "bad"); }
  });

  // ---------- grinding ----------
  async function loadResources() {
    try { const { resources } = await Bot.api("/api/grind/resources"); setOptions($("xRes"), resources.map((r) => `<option value="${esc(r.key)}">${esc(r.key)}</option>`).join("")); }
    catch (err) { msg("xGrindMsg", err.message, "bad"); }
  }
  const grindBody = () => ({ resource: $("xRes").value, amount: Number($("xAmt").value) });
  $("xGrindCheck").onclick = (e) => busy(e.currentTarget, async () => {
    try { const { plan: p } = await call("/api/grind/check", grindBody()); msg("xGrindMsg", `Ready: collect ${p.amount} ${p.item} (have ${p.baseline}). ${p.nearby}+ ${p.blocks.join("/")} within ${p.radius} blocks.${p.notes.length ? "\n" + p.notes.join("\n") : ""}`, "ok"); }
    catch (err) { msg("xGrindMsg", err.message, "bad"); }
  });
  $("xGrind").onclick = (e) => busy(e.currentTarget, async () => {
    try { await call("/api/grind", grindBody()); msg("xGrindMsg", "Grinding started - watch “Current task” above for real progress.", "ok"); }
    catch (err) { msg("xGrindMsg", err.message, "bad"); }
  });

  // ---------- house ----------
  const houseBody = () => {
    const b = { size: Number($("xSize").value), allowPartial: $("xPartial").checked };
    if ($("xMat").value.trim()) b.material = $("xMat").value.trim();
    for (const [k, id] of [["x", "xHx"], ["y", "xHy"], ["z", "xHz"]]) if ($(id).value !== "") b[k] = Number($(id).value);
    return b;
  };
  const planText = (p) => `${p.ok ? "Site OK" : "Cannot build here"} - ${p.size}x${p.size}${p.material ? " of " + p.material : ""}${p.origin ? ` at ${p.origin.x},${p.origin.y},${p.origin.z}${p.auto ? " (auto-selected)" : ""}` : ""}\n`
    + (p.required !== undefined ? `Needs ${p.required} blocks, has ${p.available}${p.missing ? `, missing ${p.missing}` : ""}. Doorway: ${p.door ? p.door.side : "?"}.\n` : "") + (p.issues || []).map((i) => "• " + i).join("\n");
  $("xHouseCheck").onclick = (e) => busy(e.currentTarget, async () => {
    try { const { plan: p } = await call("/api/house/plan", houseBody()); msg("xHouseMsg", planText(p), p.ok ? "ok" : "bad"); }
    catch (err) { msg("xHouseMsg", err.message, "bad"); }
  });
  $("xHouse").onclick = (e) => busy(e.currentTarget, async () => {
    try { await call("/api/house", houseBody()); msg("xHouseMsg", "Building started - watch “Current task” above. Only a verified, complete house is reported as finished.", "ok"); }
    catch (err) { msg("xHouseMsg", err.message, "bad"); }
  });

  // ---------- inventory drop ----------
  let items = [];
  async function loadItems() {
    try {
      ({ items } = await Bot.api(`/api/inventory/items?account=${encodeURIComponent(Bot.account || "")}`));
      setOptions($("xItem"), items.length ? items.map((i) => `<option value="${esc(i.name)}">${esc(i.displayName || i.name)} x${i.count}${i.protected ? " - protected" : ""}</option>`).join("") : '<option value="">Inventory is empty</option>');
    } catch (err) { setOptions($("xItem"), '<option value="">Unavailable</option>'); msg("xDropMsg", err.message, "bad"); }
  }
  $("xRefresh").onclick = (e) => busy(e.currentTarget, loadItems);
  $("xAllBtn").onclick = () => { const it = items.find((i) => i.name === $("xItem").value); if (it) $("xDropAmt").value = it.count; };
  $("xDrop").onclick = (e) => busy(e.currentTarget, async () => {
    const name = $("xItem").value, count = Number($("xDropAmt").value), it = items.find((i) => i.name === name);
    if (!name) return msg("xDropMsg", "Choose an item first.", "bad");
    if (!Number.isInteger(count) || count < 1) return msg("xDropMsg", "Amount must be a whole number of at least 1.", "bad");
    if (it && count > it.count) return msg("xDropMsg", `The bot only has ${it.count} ${name}.`, "bad");
    const send = async (confirmProtected) => {
      const res = await fetch("/api/inventory/drop", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: Bot.account, name, count, confirmProtected }) });
      if (res.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
      return { res, data: await res.json().catch(() => ({})) };
    };
    try {
      let { res, data } = await send(false);
      if (res.status === 409 && data.requiresConfirm) {
        if (!window.confirm(`${name} is ${data.reason}.\n\nReally drop ${count}? Dropped items can be lost or picked up by others.`)) return msg("xDropMsg", "Cancelled - nothing was dropped.", "info");
        ({ res, data } = await send(true));
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      msg("xDropMsg", `Dropped ${data.dropped} ${name}; ${data.remaining} left. ${data.note || ""}`, "ok");
      Bot.toast(`Dropped ${data.dropped} ${name}`, "success");
    } catch (err) { msg("xDropMsg", err.message, "bad"); }
    loadItems();
  });

  // ---------- refresh when the tab is opened / inventory changes ----------
  const active = () => $("tab-control").classList.contains("active");
  let t = null;
  Bot.on("inventory", () => { if (!active()) return; clearTimeout(t); t = setTimeout(loadItems, 800); });
  document.getElementById("nav").addEventListener("click", (e) => { if (e.target.dataset?.tab === "control") { loadResources(); loadItems(); } });
  Bot.on("snapshot", () => { if (active()) loadItems(); });
  if (location.hash === "#control") { loadResources(); loadItems(); }
})();
