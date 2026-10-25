/**
 * core/socket.js - Socket.IO server.
 *
 * Events (server -> client), each payload is an object that includes { account }:
 *   status, chat, log, players, inventory, health, position, task,
 *   move_status, player_event, instances (global), snapshot (on connect / select)
 * Per-account events go to room "acct:<id>". Clients call socket.emit("select", id) to switch.
 * Auth: reuses the express-session cookie; unauthenticated sockets are rejected.
 */
const { Server } = require("socket.io");
const logger = require("../logger");
const state = require("./state");

function createSocket(httpServer, sessionMiddleware) {
  const io = new Server(httpServer, { serveClient: true, pingInterval: 20000, pingTimeout: 25000 });
  io.engine.use(sessionMiddleware);
  io.use((socket, next) => (socket.request.session?.auth ? next() : next(new Error("unauthorized"))));

  const room = (id) => `acct:${id}`;

  function listInstances() {
    return [...state.instances.values()].map((i) => i.summary());
  }

  function join(socket, id) {
    for (const r of socket.rooms) if (r.startsWith("acct:")) socket.leave(r);
    socket.join(room(id));
    socket.data.account = id;
    const inst = state.getInstance(id);
    socket.emit("snapshot", { account: id, ...(inst ? inst.snapshot() : { status: { status: "offline" } }) });
  }

  io.on("connection", (socket) => {
    const first = state.defaultInstance();
    socket.emit("instances", { instances: listInstances() });
    if (first) join(socket, first.id);
    socket.on("select", (id) => { if (state.instances.has(String(id))) join(socket, String(id)); });
  });

  // Stream logs: per-account lines go to that account's room, system lines to everyone.
  logger.events.on("log", (e) => {
    const payload = { account: e.account, ts: e.ts, type: e.type, msg: e.msg };
    if (e.account === "system") io.emit("log", payload);
    else io.to(room(e.account)).emit("log", payload);
  });

  const api = {
    io,
    /** Emit to every client watching this account. */
    emitTo(account, event, data = {}) { io.to(room(account)).emit(event, { account, ts: Date.now(), ...data }); },
    /** True when somebody is watching - lets instances skip work when idle. */
    hasViewers(account) { return (io.sockets.adapter.rooms.get(room(account))?.size || 0) > 0; },
    broadcastInstances() { io.emit("instances", { instances: listInstances() }); },
    broadcast(event, data) { io.emit(event, data); },
  };
  return api;
}

module.exports = { createSocket };
