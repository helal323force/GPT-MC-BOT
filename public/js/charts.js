/* Chart.js analytics: uptime (24h), reconnects (7d), memory, chat frequency. Charts.mount(el) then Charts.refresh(). */
window.Charts = (() => {
  let root = null, charts = {}, timer = null;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const CARDS = [["uptime", "Uptime, last 24 hours (% online)"], ["reconnects", "Reconnects, last 7 days"], ["memory", "Memory (MB), last 24 hours"], ["chat", "Chat messages per hour"]];

  function mount(el) {
    if (root === el && el.childElementCount) return;
    root = el;
    el.innerHTML = '<div class="grid2">' + CARDS.map(([k, t]) => `<div class="card"><h2>${t}</h2><div class="chartbox"><canvas id="ch-${k}"></canvas></div></div>`).join("") + "</div>";
    charts = {};
    if (!timer) timer = setInterval(() => { if (root && document.body.contains(root) && root.offsetParent !== null) refresh(); }, 60000);
    if (window.Bot) Bot.on("theme", () => { charts = {}; if (root) { const r = root; root = null; mount(r); refresh(); } });
  }

  function make(key, type, labels, datasets, opts = {}) {
    const text = css("--muted"), grid = css("--line");
    if (charts[key]) { charts[key].data.labels = labels; charts[key].data.datasets.forEach((d, i) => Object.assign(d, datasets[i])); charts[key].update("none"); return; }
    const canvas = document.getElementById("ch-" + key); if (!canvas) return;
    charts[key] = new Chart(canvas, {
      type, data: { labels, datasets },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: text, maxTicksLimit: 8 }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: text, precision: 0 }, grid: { color: grid }, ...(opts.y || {}) } } },
    });
  }

  async function refresh() {
    if (!root) return;
    try {
      const acct = window.Bot?.account ? `?account=${encodeURIComponent(Bot.account)}` : "";
      const d = await Bot.api("/api/analytics" + acct);
      const accent = css("--accent"), ok = css("--ok"), warn = css("--warn"), bad = css("--bad");
      const hh = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      make("uptime", "line", d.uptime.map((x) => hh(x.ts)), [{ data: d.uptime.map((x) => x.pct), borderColor: ok, backgroundColor: ok + "33", fill: true, tension: 0.25, spanGaps: true, pointRadius: 2 }], { y: { max: 100 } });
      make("reconnects", "bar", d.reconnects.map((x) => new Date(x.ts).toLocaleDateString([], { weekday: "short" })), [{ data: d.reconnects.map((x) => x.n), backgroundColor: bad }]);
      make("memory", "line", d.memory.map((x) => hh(x.ts)), [{ label: "RSS", data: d.memory.map((x) => x.rss_mb), borderColor: accent, pointRadius: 0, tension: 0.2 }, { label: "Heap", data: d.memory.map((x) => x.heap_mb), borderColor: warn, pointRadius: 0, tension: 0.2 }]);
      make("chat", "bar", d.chat.map((x) => hh(x.ts)), [{ data: d.chat.map((x) => x.n), backgroundColor: accent }]);
      if (charts.memory) charts.memory.options.plugins.legend.display = true;
    } catch (e) { if (window.Bot) Bot.toast(e.message, "error"); }
  }
  return { mount, refresh };
})();
