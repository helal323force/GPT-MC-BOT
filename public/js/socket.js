/* Shared client core: Socket.IO connection, REST helper, toasts, header wiring. Exposes window.Bot. */
(() => {
  const root = document.documentElement;
  const Bot = (window.Bot = { account: localStorage.getItem("account"), accounts: [], status: null, config: null, _h: {} });
  Bot.on = (ev, fn) => { (Bot._h[ev] ||= []).push(fn); return fn; };
  Bot._emit = (ev, d) => (Bot._h[ev] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error(ev, e); } });
  Bot.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  Bot.fmtUp = (s) => { s = Math.max(0, s | 0); const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0; return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };
  Bot.hue = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 65% ${root.dataset.theme === "light" ? 38 : 68}%)`; };
  Bot.time = (ts) => new Date(ts || Date.now()).toLocaleTimeString([], { hour12: false });

  Bot.toast = (msg, kind = "info") => {
    let box = document.getElementById("toasts");
    if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = `toast ${kind}`; t.textContent = msg; box.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  };

  Bot.api = async (url, method = "GET", body) => {
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    if (res.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  /** Fire an API call and toast the outcome. */
  Bot.act = async (url, method, body, okMsg) => {
    try { const r = await Bot.api(url, method, { account: Bot.account, ...(body || {}) }); if (okMsg) Bot.toast(okMsg, "success"); return r; }
    catch (e) { Bot.toast(e.message, "error"); throw e; }
  };

  Bot.select = (id) => { Bot.account = id; localStorage.setItem("account", id); Bot.socket.emit("select", id); };

  // ---- socket ----
  const socket = (Bot.socket = io({ transports: ["websocket", "polling"] }));
  socket.on("connect", () => { console.log("socket connected"); if (Bot.account) socket.emit("select", Bot.account); Bot._emit("connected"); });
  socket.on("disconnect", () => Bot._emit("disconnected"));
  socket.on("connect_error", (e) => { if (/unauthorized/i.test(e.message)) location.href = "/login"; });
  socket.on("instances", (d) => {
    Bot.accounts = d.instances;
    if (!Bot.account || !d.instances.some((i) => i.id === Bot.account)) Bot.account = d.instances[0]?.id || null;
    Bot._emit("instances", d);
  });
  socket.on("snapshot", (d) => { Bot.lastSnapshot = d; Bot.account = d.account; Bot.status = d.status; Bot._emit("snapshot", d); Bot._emit("status", d.status); });
  for (const ev of ["status", "chat", "players", "inventory", "health", "position", "task", "move_status", "player_event", "brain", "log"]) {
    socket.on(ev, (d) => {
      if (d.account && d.account !== "system" && Bot.account && d.account !== Bot.account) return;
      if (ev === "status") {
        const prev = Bot.status?.status; Bot.status = d;
        if (prev === "online" && ["offline", "stopped"].includes(d.status)) Bot.alertDown(d);
      }
      Bot._emit(ev, d);
    });
  }

  Bot.alertDown = (d) => {
    Bot.toast(`Bot went ${d.status}${d.lastError ? ": " + d.lastError : ""}`, "error");
    if ("Notification" in window && Notification.permission === "granted" && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then((r) => r.showNotification("Minecraft bot is down", { body: d.lastError || d.status, icon: "/icon.svg", tag: "bot-down" })).catch(() => {});
    }
  };

  // ---- header ----
  Bot.initHeader = () => {
    const sel = document.getElementById("acctSel"), badge = document.getElementById("statusBadge"), txt = document.getElementById("statusText"), up = document.getElementById("uptimeBadge");
    const drawStatus = (s) => { if (!s) return; badge.querySelector(".dot").className = `dot ${s.status}`; txt.textContent = s.status; up.textContent = s.status === "online" ? Bot.fmtUp(s.uptimeSec) : "-"; };
    Bot.on("status", drawStatus);
    Bot.on("instances", (d) => {
      const html = d.instances.map((i) => `<option value="${Bot.esc(i.id)}">${Bot.esc(i.id)} (${Bot.esc(i.username)})</option>`).join("");
      if (sel._h !== html) { sel.innerHTML = html; sel._h = html; }
      sel.value = Bot.account;
    });
    sel.addEventListener("change", () => Bot.select(sel.value));
    Bot.on("snapshot", () => { sel.value = Bot.account; });
    document.getElementById("themeBtn").addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      root.dataset.theme = next; localStorage.setItem("theme", next);
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#eceff4" : "#15191f");
      Bot._emit("theme", next);
    });
    document.getElementById("logoutBtn").addEventListener("click", async () => { await fetch("/logout", { method: "POST", headers: { Accept: "application/json" } }); location.href = "/login"; });
  };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
})();
