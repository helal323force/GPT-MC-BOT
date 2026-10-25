/* xterm.js live terminal for logs.html. Server log types are mapped to ANSI colours. */
(() => {
  const ANSI = { info: "\x1b[37m", warn: "\x1b[33m", error: "\x1b[31m", chat: "\x1b[36m", success: "\x1b[32m", control: "\x1b[35m", ai: "\x1b[95m" }, RESET = "\x1b[0m";
  const term = new Terminal({ convertEol: true, disableStdin: true, scrollback: 4000, fontSize: 13, fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace', cursorBlink: false, theme: { background: "#0f1217", foreground: "#dde2ea" } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  const refit = () => { try { fit.fit(); } catch { /* hidden */ } };
  refit(); window.addEventListener("resize", refit);

  const write = (e) => term.writeln(`${ANSI[e.type] || ANSI.info}${new Date(e.ts).toISOString().substring(11, 19)} ${e.msg}${RESET}`);
  const draw = (d) => { term.clear(); (d.logs || []).forEach(write); };
  Bot.on("snapshot", draw);
  if (Bot.lastSnapshot) draw(Bot.lastSnapshot); // snapshot may have arrived while xterm was loading
  Bot.on("log", write);

  const input = document.getElementById("cmd"), hist = []; let hi = 0;
  const send = async () => {
    const v = input.value.trim(); if (!v) return;
    hist.push(v); hi = hist.length; input.value = "";
    if (v === "clear") return term.clear();
    try { await Bot.api("/command", "POST", { command: v, account: Bot.account }); }
    catch (e) { term.writeln(`${ANSI.error}${e.message}${RESET}`); }
  };
  document.getElementById("sendBtn").addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
    else if (e.key === "ArrowUp" && hist.length) { hi = Math.max(0, hi - 1); input.value = hist[hi]; e.preventDefault(); }
    else if (e.key === "ArrowDown") { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ""; e.preventDefault(); }
  });
})();
