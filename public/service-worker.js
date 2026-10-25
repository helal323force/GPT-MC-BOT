/* Offline shell cache. API, Socket.IO and HTML pages are always network-first so data is never stale. */
const CACHE = "mcbot-shell-v3";
const SHELL = ["/css/app.css", "/js/socket.js", "/js/app.js", "/js/charts.js", "/js/terminal.js", "/icon.svg", "/manifest.json"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api") || u.pathname.startsWith("/socket.io")) return;
  if (SHELL.includes(u.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => { const net = fetch(e.request).then((r) => { caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; }).catch(() => hit); return hit || net; }));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || new Response("Offline - the bot dashboard needs a connection.", { status: 503, headers: { "Content-Type": "text/plain" } }))));
});
