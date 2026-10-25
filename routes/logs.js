/**
 * routes/logs.js - live terminal page, log history, and the legacy /command endpoint.
 *   GET  /logs               terminal page (xterm.js)
 *   GET  /api/logs?account=&n=
 *   POST /command {command, account?}   (kept for backward compatibility)
 */
const express = require("express");
const path = require("path");
const logger = require("../logger");
const state = require("../core/state");

function logRoutes() {
  const r = express.Router();
  r.get("/logs", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "logs.html")));
  r.get("/api/logs", (req, res) => res.json({ logs: logger.getLogs(req.query.n, req.query.account || state.defaultInstance()?.id || null) }));
  r.post("/command", sendCommand);
  r.post("/api/command", sendCommand);
  return r;
}

function sendCommand(req, res) {
  try {
    const inst = state.getInstance(req.body?.account);
    if (!inst) return res.status(404).json({ error: "Unknown account" });
    const text = String(req.body?.command ?? req.body?.message ?? "").trim();
    if (!text) return res.status(400).json({ error: "command required" });
    logger.addLog(`$ ${text}`, "control", inst.id);
    inst.chat(text, { force: true });
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: e.message }); }
}

module.exports = { logRoutes };
