/**
 * core/state.js - process-wide shared state (singletons).
 *   instances : Map<accountId, BotInstance>
 *   services  : discord, bridge, ai, aiChat, scheduler, proxy, plugins, socket, ...
 *   bus       : EventEmitter for cross-module events (mc_chat, ai_reply, instance_status...)
 */
const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(100);

const state = {
  version: "3.2.0",
  startedAt: Date.now(),
  instances: new Map(),
  services: {},
  bus,
  /** First configured instance (default target when no account is given). */
  defaultInstance() { return this.instances.values().next().value || null; },
  /** Resolve an instance by id (falls back to default when id is empty). */
  getInstance(id) {
    if (!id) return this.defaultInstance();
    return this.instances.get(String(id)) || null;
  },
};

module.exports = state;
