/* Dashboard UI: tabs, overview, chat, inventory, map, tasks, AI, analytics. Updates patch the DOM (no flicker). */
(() => {
  const $ = (id) => document.getElementById(id);
  const setHTML = (el, html) => { if (el._h !== html) { el.innerHTML = html; el._h = html; } };
  const setText = (el, t) => { if (el.textContent !== String(t)) el.textContent = t; };
  Bot.initHeader();

  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll("#nav button")];
  function showTab(name) {
    tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    history.replaceState(null, "", "#" + name);
    if (name === "inventory") drawInventory(lastInv);
    if (name === "rpg") refreshRpgStatus();
    if (name === "map") drawMap();
    if (name === "tasks") loadTasks();
    if (name === "ai") loadAi();
    if (name === "analytics") { Charts.mount($("analyticsMount")); Charts.refresh(); }
    if (name === "chat") $("chatFeed").scrollTop = 1e9;
  }
  tabs.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- connection badge ----------
  const conn = $("connBadge");
  Bot.on("connected", () => { setText(conn, "live"); conn.style.color = "var(--ok)"; });
  Bot.on("disconnected", () => { setText(conn, "reconnecting…"); conn.style.color = "var(--warn)"; });

  // ---------- overview ----------
  const seg = (el, value, max = 20) => {
    const full = Math.floor(value / 2), half = value % 2 >= 1 ? 1 : 0;
    let h = "";
    for (let i = 0; i < 10; i++) h += `<i class="${i < full ? "on" : i === full && half ? "half" : ""}"></i>`;
    setHTML(el, h);
  };
  function drawStatus(s) {
    if (!s) return;
    setText($("sServer"), s.server || "-"); setText($("sVersion"), s.version || "-"); setText($("sTask"), s.task || "idle");
    setText($("sReconnects"), s.reconnects ?? 0); setText($("sProxy"), s.proxy || "none"); setText($("sError"), s.lastError || "-");
    const brain = `AI brain: ${s.brain ? "on" : "off"}`;
    setText($("btnBrain"), brain); setText($("aiBrain"), s.brain ? "on" : "off");
    $("btnStart").disabled = ["online", "connecting"].includes(s.status);
    $("btnStop").disabled = s.status === "stopped";
    drawVitals(s);
  }
  function drawVitals(h) {
    if (h.health == null) return;
    seg($("hpSeg"), Math.max(0, h.health)); seg($("foodSeg"), Math.max(0, h.food ?? 0));
    setText($("hpNum"), `${(+h.health).toFixed(1)}/20`); setText($("foodNum"), `${h.food ?? 0}/20`);
  }
  Bot.on("status", drawStatus);
  Bot.on("health", drawVitals);

  let pos = null;
  Bot.on("position", (p) => { pos = p; if (!p) return; setText($("coords"), `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`); setText($("dimension"), String(p.dimension || "").replace("minecraft:", "")); if ($("tab-map").classList.contains("active")) scheduleMap(); });
  Bot.on("task", (t) => setText($("sTask"), t.task));

  function drawPlayers(list) {
    setText($("pCount"), list.length ? `(${list.length})` : "");
    setHTML($("plist"), list.length ? list.map((p) => `<li><img src="https://mc-heads.net/avatar/${encodeURIComponent(p.username)}/20" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span style="color:${Bot.hue(p.username)}">${Bot.esc(p.username)}</span>${p.self ? '<span class="tag">bot</span>' : ""}<span class="muted mono" style="margin-left:auto;font-size:12px">${p.ping ?? ""}${p.ping != null ? " ms" : ""}</span></li>`).join("") : '<li class="muted">Nobody yet.</li>');
  }
  Bot.on("players", (d) => drawPlayers(d.players));
  Bot.on("player_event", (d) => Bot.toast(`${d.username} ${d.type === "join" ? "joined" : "left"}${d.op ? " (OP)" : ""}`, d.watched || d.op ? "warn" : "info"));

  const mini = $("miniLog");
  const LOGC = { info: "var(--text)", warn: "var(--warn)", error: "var(--bad)", chat: "#5fc4d9", success: "var(--ok)", control: "var(--ai)", ai: "#c3a6ff" };
  const logRow = (e) => `<div class="row" style="color:${LOGC[e.type] || LOGC.info}"><span class="t">${Bot.time(e.ts)}</span>${Bot.esc(e.msg)}</div>`;
  Bot.on("log", (e) => { const stick = mini.scrollTop + mini.clientHeight >= mini.scrollHeight - 20; mini.insertAdjacentHTML("beforeend", logRow(e)); while (mini.children.length > 120) mini.firstChild.remove(); if (stick) mini.scrollTop = 1e9; });

  const act = (url, body, msg) => Bot.act(url, "POST", body, msg).catch(() => {});
  $("btnStart").onclick = () => act("/api/start", {}, "Starting…");
  $("btnStop").onclick = () => act("/api/stop", {}, "Stopped");
  $("btnRestart").onclick = () => act("/api/restart", {}, "Restarting…");
  $("btnIdle").onclick = () => act("/api/activity", { name: "idle" }, "Activity stopped");
  $("btnBrain").onclick = () => act("/api/brain", { enabled: !Bot.status?.brain });
  $("aiBrainBtn").onclick = $("btnBrain").onclick;
  $("btnStartAll").onclick = () => act("/api/start", { account: "all" }, "Starting all bots");
  $("btnStopAll").onclick = () => act("/api/stop", { account: "all" }, "Stopping all bots");
  $("btnNotify").onclick = async () => {
    if (!("Notification" in window)) return Bot.toast("Notifications are not supported here", "warn");
    const r = await Notification.requestPermission(); Bot.toast(r === "granted" ? "Alerts enabled" : "Alerts blocked", r === "granted" ? "success" : "warn");
  };

  Bot.api("/api/config").then((c) => {
    Bot.config = c;
    const names = { mine: "Mine", farm: "Farm", fish: "Fish", chop: "Chop", trade: "Trade" };
    setHTML($("activityBtns"), Object.keys(names).filter((k) => c.modules[k]).map((k) => `<button class="btn sm" data-act="${k}">${names[k]}</button>`).join(""));
    $("activityBtns").querySelectorAll("button").forEach((b) => (b.onclick = () => act("/api/activity", { name: b.dataset.act }, `${b.textContent} started`)));
    if (c.warnDefaultPassword) Bot.toast("Dashboard is using the default password. Set DASHBOARD_PASSWORD.", "warn");
    if (!c.ai.enabled) $("aiAsk").disabled = true;
  }).catch(() => {});

  // ---------- chat ----------
  const feed = $("chatFeed");
  function chatRow(m) {
    const col = m.source === "self" ? "var(--accent)" : Bot.hue(m.username);
    const tag = m.source === "discord" ? '<span class="tag discord">discord</span>' : m.source === "self" ? '<span class="tag self">bot</span>' : "";
    return `<div class="row"><span class="t">${Bot.time(m.ts)}</span>${tag}<b style="color:${col}">${Bot.esc(m.username)}</b> ${Bot.esc(m.message)}</div>`;
  }
  Bot.on("chat", (m) => { const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30; feed.insertAdjacentHTML("beforeend", chatRow(m)); while (feed.children.length > 300) feed.firstChild.remove(); if (stick) feed.scrollTop = 1e9; });
  const sendChat = async () => { const v = $("chatInput").value.trim(); if (!v) return; $("chatInput").value = ""; Bot.act("/api/chat", "POST", { message: v }).catch(() => {}); };
  $("chatSend").onclick = sendChat; $("chatInput").addEventListener("keydown", (e) => e.key === "Enter" && sendChat());

  // ---------- inventory ----------
  let lastInv = { items: [], selected: 0 };
  const iconUrl = (n) => `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.20.2/items/${n}.png`;
  const slotHtml = (it, sel) => it
    ? `<div class="slot${sel ? " sel" : ""}" title="${Bot.esc(it.displayName || it.name)}"><img src="${iconUrl(it.name)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=fallback style=color:${Bot.hue(it.name)}>${Bot.esc(it.name.slice(0, 3))}</span>'"><span class="n">${it.count > 1 ? it.count : ""}</span></div>`
    : `<div class="slot${sel ? " sel" : ""}"></div>`;
  function drawInventory(inv) {
    lastInv = inv || lastInv; if (!$("tab-inventory").classList.contains("active")) return;
    const by = new Map(lastInv.items.map((i) => [i.slot, i]));
    let main = "", hot = "";
    for (let s = 9; s < 36; s++) main += slotHtml(by.get(s));
    for (let i = 0; i < 9; i++) hot += slotHtml(by.get(36 + i), i === lastInv.selected);
    setHTML($("invMain"), main); setHTML($("invHot"), hot);
  }
  Bot.on("inventory", drawInventory);

  // ---------- map ----------
  const cv = $("mapCanvas"), ctx = cv.getContext("2d"); let mapQueued = false, target = null;
  const scheduleMap = () => { if (!mapQueued) { mapQueued = true; requestAnimationFrame(() => { mapQueued = false; drawMap(); }); } };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function drawMap() {
    const W = cv.width, H = cv.height, z = +$("zoom").value, cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = css("--panel2"); ctx.fillRect(0, 0, W, H);
    if (!pos) { ctx.fillStyle = css("--muted"); ctx.font = "16px IBM Plex Sans, sans-serif"; ctx.textAlign = "center"; ctx.fillText("Waiting for the bot to spawn…", cx, cy); return; }
    ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath();
    const step = 8 * z, ox = ((cx - (pos.x % 8) * z) % step + step) % step, oy = ((cy - (pos.z % 8) * z) % step + step) % step;
    for (let x = ox; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    const toPx = (wx, wz) => [cx + (wx - pos.x) * z, cy + (wz - pos.z) * z];
    for (const e of pos.entities || []) {
      const [px, py] = toPx(e.x, e.z); if (px < 0 || py < 0 || px > W || py > H) continue;
      ctx.fillStyle = e.kind === "player" ? css("--ok") : e.kind === "hostile" ? css("--bad") : css("--warn");
      ctx.beginPath(); ctx.arc(px, py, e.kind === "player" ? 5 : 4, 0, 7); ctx.fill();
      if (e.kind === "player") { ctx.fillStyle = css("--text"); ctx.font = "12px IBM Plex Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(e.name, px, py - 9); }
    }
    if (target) { const [tx, ty] = toPx(target.x, target.z); ctx.strokeStyle = css("--accent"); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(tx, ty, 6, 0, 7); ctx.stroke(); }
    const dx = -Math.sin(pos.yaw || 0), dz = -Math.cos(pos.yaw || 0), a = Math.atan2(dz, dx);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.fillStyle = css("--accent"); ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, 7); ctx.lineTo(-4, 0); ctx.lineTo(-7, -7); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  $("zoom").addEventListener("input", scheduleMap);
  cv.addEventListener("click", (ev) => {
    if (!pos) return;
    const r = cv.getBoundingClientRect(), k = cv.width / r.width, z = +$("zoom").value;
    const x = Math.round(pos.x + ((ev.clientX - r.left) * k - cv.width / 2) / z), zc = Math.round(pos.z + ((ev.clientY - r.top) * k - cv.height / 2) / z);
    target = { x, z: zc }; scheduleMap();
    Bot.act("/api/move", "POST", { x, z: zc }, `Heading to ${x}, ${zc}`).catch(() => { target = null; });
  });
  Bot.on("move_status", (m) => { setText($("moveStatus"), m.state + (m.error ? ` (${m.error})` : "")); if (m.state === "arrived" || m.state === "failed") { target = null; scheduleMap(); } if (m.state === "failed") Bot.toast(`Navigation failed: ${m.error}`, "warn"); });
  Bot.on("theme", scheduleMap);

  // ---------- tasks ----------
  const fmtWhen = (t) => (t.cron ? `<span class="mono">${Bot.esc(t.cron)}</span>` : `every ${t.delay_sec}s${t.repeat ? "" : " (once)"}`);
  async function loadTasks() {
    try {
      const { tasks } = await Bot.api("/api/tasks");
      setHTML($("taskRows"), tasks.length ? tasks.map((t) => `<tr><td><input type="checkbox" data-id="${t.id}" ${t.enabled ? "checked" : ""} style="width:auto" aria-label="Enable ${Bot.esc(t.label)}"></td><td>${Bot.esc(t.label)}<div class="muted" style="font-size:12px">${Bot.esc(t.account || "all accounts")}</div></td><td>${fmtWhen(t)}</td><td><span class="mono">${Bot.esc(t.action)}</span> <span class="muted mono" style="font-size:12px">${Bot.esc(JSON.stringify(t.params))}</span></td><td class="muted">${t.last_run ? new Date(t.last_run).toLocaleString() : "never"}</td><td style="white-space:nowrap"><button class="btn sm" data-run="${t.id}">Run now</button> <button class="btn sm danger" data-del="${t.id}">Delete</button></td></tr>`).join("") : '<tr><td colspan="6" class="muted">No tasks yet. Add one on the right.</td></tr>');
    } catch (e) { Bot.toast(e.message, "error"); }
  }
  $("taskRows").addEventListener("click", async (e) => {
    const del = e.target.dataset.del, run = e.target.dataset.run;
    try {
      if (del) { await Bot.api(`/api/tasks/${del}`, "DELETE"); Bot.toast("Task deleted", "success"); loadTasks(); }
      if (run) { await Bot.api(`/api/tasks/${run}/run`, "POST", {}); Bot.toast("Task triggered", "success"); }
    } catch (err) { Bot.toast(err.message, "error"); }
  });
  $("taskRows").addEventListener("change", async (e) => { if (e.target.dataset.id) { try { await Bot.api(`/api/tasks/${e.target.dataset.id}`, "PATCH", { enabled: e.target.checked }); } catch (err) { Bot.toast(err.message, "error"); loadTasks(); } } });
  $("tKind").onchange = () => { const c = $("tKind").value === "cron"; setText($("tWhenLabel"), c ? "Cron expression" : "Seconds"); $("tWhen").placeholder = c ? "0 0 * * *" : "3600"; };
  const defaults = { cmd: '{"command":"/home"}', say: '{"message":"hello"}', walk_to: '{"x":100,"y":64,"z":200}' };
  $("tAction").onchange = () => { $("tParams").value = defaults[$("tAction").value] || "{}"; };
  Bot.on("instances", (d) => { setHTML($("tAcct"), '<option value="">All accounts</option>' + d.instances.map((i) => `<option value="${Bot.esc(i.id)}">${Bot.esc(i.id)}</option>`).join("")); });
  $("taskForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const body = { label: $("tLabel").value.trim(), action: $("tAction").value, account: $("tAcct").value || null, params: JSON.parse($("tParams").value || "{}") };
      if ($("tKind").value === "cron") body.cron = $("tWhen").value.trim(); else { body.delay_sec = Number($("tWhen").value); body.repeat = true; }
      await Bot.api("/api/tasks", "POST", body); Bot.toast("Task added", "success"); $("tLabel").value = ""; loadTasks();
    } catch (err) { Bot.toast(err.message, "error"); }
  });

  // ---------- RPG Survival controls ----------
  const rpgAct = (action, params = {}, msg = "RPG command sent") => Bot.act("/api/rpg", "POST", { action, ...params }, msg).catch(() => {});
  const refreshRpgStatus = async () => {
    try {
      const r = await Bot.api(`/api/rpg?account=${encodeURIComponent(Bot.account || "")}`);
      setText($("rpgStatus"), r.status || "Ready");
      setText($("rpgJumpBtn"), `Auto Jump: ${r.jumpEnabled ? "ON" : "OFF"}`);
      setText($("rpgSurvivalBtn"), `Survival: ${r.survivalEnabled ? "ON" : "OFF"}`);
    } catch (e) { setText($("rpgStatus"), e.message || "Plugin unavailable"); }
  };
  $("rpgFollowBtn").onclick = () => {
    const player = $("rpgFollowName").value.trim();
    if (!player) return Bot.toast("Enter a player username", "warn");
    rpgAct("follow", { player }, `Following ${player}`);
  };
  $("rpgFollowName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("rpgFollowBtn").click(); });
  $("rpgStopBtn").onclick = () => rpgAct("stop", {}, "Follow/grind stopped");
  $("rpgSurvivalBtn").onclick = async () => {
    try { const r = await Bot.api("/api/rpg", "POST", { account: Bot.account, action: "survival_toggle" }); Bot.toast(`Survival ${r.survivalEnabled ? "ON" : "OFF"}`, "success"); refreshRpgStatus(); }
    catch (e) { Bot.toast(e.message, "error"); }
  };
  $("rpgGrindBtn").onclick = () => rpgAct("grind", { mode: $("rpgGrindType").value }, "Grind started");
  $("rpgStopGrindBtn").onclick = () => rpgAct("stopgrind", {}, "Grind stopped");
  $("rpgJumpBtn").onclick = async () => {
    try { const r = await Bot.api("/api/rpg", "POST", { account: Bot.account, action: "jump_toggle" }); Bot.toast(`Auto Jump ${r.jumpEnabled ? "ON" : "OFF"}`, "success"); refreshRpgStatus(); }
    catch (e) { Bot.toast(e.message, "error"); }
  };
  $("rpgHouseBtn").onclick = () => { if (confirm("Try to build a house using the bot's current inventory?")) rpgAct("buildhouse", {}, "House building started"); };
  $("rpgDropBtn").onclick = () => {
    const item = $("rpgDropItem").value.trim(); const amount = Number($("rpgDropAmount").value);
    if (!item) return Bot.toast("Enter an item ID", "warn");
    if (!Number.isInteger(amount) || amount < 1) return Bot.toast("Amount must be at least 1", "warn");
    if (confirm(`Drop ${amount} × ${item}?`)) rpgAct("drop", { item, amount }, "Drop command sent");
  };
  $("rpgDropAllBtn").onclick = () => { if (confirm("WARNING: This drops almost all items except a small protected list. Continue?")) rpgAct("dropall", {}, "Drop-all command sent"); };
  Bot.on("snapshot", () => { if ($("tab-rpg").classList.contains("active")) refreshRpgStatus(); });

  // ---------- AI ----------
  let presetsLoaded = false;
  async function loadAi() {
    try {
      const [st, lg] = await Promise.all([Bot.api("/api/ai/stats"), Bot.api("/api/ai/logs?limit=50")]);
      setText($("aiProv"), st.enabled ? st.providers.join(" > ") : "disabled (no API key)");
      setText($("aiReq"), `${st.lastHour?.n ?? 0} / ${st.last24h?.n ?? 0}`); setText($("aiTok"), `${st.lastHour?.t ?? 0} / ${st.last24h?.t ?? 0}`);
      if (st.personality && document.activeElement !== $("persona")) $("persona").value = st.personality;
      if (!presetsLoaded && st.presets) { presetsLoaded = true; $("preset").innerHTML = '<option value="">Custom</option>' + Object.keys(st.presets).map((k) => `<option value="${k}">${k}</option>`).join(""); $("preset").onchange = () => { if ($("preset").value) $("persona").value = st.presets[$("preset").value]; }; }
      setHTML($("aiLog"), lg.logs.length ? lg.logs.map((l) => `<div class="aiitem"><div><span class="q">${Bot.esc(l.player || l.source)}:</span> ${Bot.esc(l.question)}</div><div>${l.ok ? Bot.esc(l.response) : '<span style="color:var(--bad)">' + Bot.esc(l.error || "failed") + "</span>"}</div><div class="m">${Bot.esc(l.source)} · ${Bot.esc(l.provider)} · ${l.tokens} tok · ${l.latency_ms} ms · ${new Date(l.ts).toLocaleTimeString()}</div></div>`).join("") : '<div class="muted">No AI requests yet. Try “.ai hello” in game.</div>');
    } catch (e) { Bot.toast(e.message, "error"); }
  }
  $("personaSave").onclick = () => Bot.api("/api/ai/personality", "POST", { personality: $("persona").value }).then(() => Bot.toast("Personality saved", "success")).catch((e) => Bot.toast(e.message, "error"));
  const ask = async () => {
    const q = $("aiQ").value.trim(); if (!q) return; setText($("aiAnswer"), "Thinking…");
    try { const r = await Bot.api("/api/ai/ask", "POST", { question: q, account: Bot.account }); setText($("aiAnswer"), r.answer); $("aiAnswer").style.color = "var(--text)"; loadAi(); }
    catch (e) { setText($("aiAnswer"), e.message); $("aiAnswer").style.color = "var(--bad)"; }
  };
  $("aiAsk").onclick = ask; $("aiQ").addEventListener("keydown", (e) => e.key === "Enter" && ask());
  Bot.on("brain", (d) => Bot.toast(`Brain: ${d.decision.action}${d.decision.say ? " - " + d.decision.say : ""}`, "info"));

  // ---------- snapshot (initial + account switch) ----------
  function applySnapshot(d) {
    drawStatus(d.status); if (d.status) drawVitals(d.status);
    pos = d.position; if (pos) { setText($("coords"), `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`); }
    drawPlayers(d.players || []);
    feed.innerHTML = (d.chat || []).map(chatRow).join(""); feed.scrollTop = 1e9;
    mini.innerHTML = (d.logs || []).slice(-100).map(logRow).join(""); mini.scrollTop = 1e9;
    lastInv = d.inventory || lastInv; drawInventory(lastInv); target = null; scheduleMap();
  }
  Bot.on("snapshot", applySnapshot);
  if (Bot.lastSnapshot) applySnapshot(Bot.lastSnapshot);
  if (Bot.socket.connected) Bot._emit("connected");

  const initial = location.hash.slice(1);
  if (tabs.some((b) => b.dataset.tab === initial)) showTab(initial);
})();
