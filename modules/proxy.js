/**
 * modules/proxy.js - SOCKS4/5 proxy rotation (round-robin).
 * Config: proxy { enabled, list[], rotate_on_kick (true), rotate_on_reconnect (true) }
 * The game TCP connection is tunnelled with `socks` through minecraft-protocol's `connect` hook;
 * socks-proxy-agent is passed as `agent` for HTTPS (Microsoft auth) requests.
 * Only use proxies you are permitted to use, on servers that allow it.
 */
const { addLog } = require("../logger");

const mask = (u) => String(u).replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");

class ProxyService {
  constructor(cfg) { this.cfg = cfg || {}; this.index = 0; this.used = new Set(); }
  get enabled() { return !!this.cfg.enabled && Array.isArray(this.cfg.list) && this.cfg.list.length > 0; }

  _next() { const url = this.cfg.list[this.index % this.cfg.list.length]; this.index++; return url; }

  /**
   * Choose a proxy for an instance's next connection.
   * First connect or reconnect => next in list (if rotate_on_reconnect), after a kick => next (if rotate_on_kick).
   */
  pick(inst, { afterKick = false } = {}) {
    if (!this.enabled) return null;
    let url = inst._proxyUrl;
    const rotate = !url || (afterKick ? this.cfg.rotate_on_kick !== false : this.cfg.rotate_on_reconnect !== false);
    if (rotate) url = this._next();
    inst._proxyUrl = url;
    try { return this.build(url); }
    catch (e) { addLog(`Bad proxy "${mask(url)}": ${e.message}`, "error"); return null; }
  }

  build(proxyUrl) {
    const { SocksClient } = require("socks");
    const { SocksProxyAgent } = require("socks-proxy-agent");
    const u = new URL(proxyUrl);
    const type = u.protocol.startsWith("socks4") ? 4 : 5;
    const proxy = { host: u.hostname, port: Number(u.port) || 1080, type, userId: decodeURIComponent(u.username || "") || undefined, password: decodeURIComponent(u.password || "") || undefined };
    return {
      label: mask(proxyUrl),
      agent: new SocksProxyAgent(proxyUrl),
      connect: (host, port) => (client) => {
        SocksClient.createConnection({ proxy, command: "connect", destination: { host, port }, timeout: 15000 })
          .then(({ socket }) => { client.setSocket(socket); client.emit("connect"); })
          .catch((err) => client.emit("error", err));
      },
    };
  }
}

module.exports = { ProxyService, mask };
