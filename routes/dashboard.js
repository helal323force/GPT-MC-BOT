/**
 * routes/dashboard.js - page routes + login/logout.
 *   publicRoutes(auth): /health, /ping, /login, /auth, /logout, PWA files (no login needed)
 *   pageRoutes(): authenticated pages  /  /analytics  /setup
 */
const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const state = require("../core/state");

const PUB = path.join(__dirname, "..", "public");

function publicRoutes(auth) {
  const r = express.Router();
  r.get("/health", (_req, res) => res.json({ ok: true, version: state.version, uptimeSeconds: Math.floor(process.uptime()), bots: [...state.instances.values()].map((i) => i.summary()) }));
  r.get("/ping", (_req, res) => res.type("text").send("pong"));
  r.get("/login", (_req, res) => res.sendFile(path.join(PUB, "login.html")));
  r.post("/auth", rateLimit({ windowMs: 15 * 60000, limit: 15, standardHeaders: true, legacyHeaders: false }), auth.login);
  r.post("/logout", auth.logout);
  for (const f of ["manifest.json", "service-worker.js", "icon.svg"]) r.get("/" + f, (_req, res) => res.sendFile(path.join(PUB, f)));
  r.get("/css/app.css", (_req, res) => res.sendFile(path.join(PUB, "css", "app.css")));
  return r;
}

function pageRoutes() {
  const r = express.Router();
  const page = (file) => (_req, res) => res.sendFile(path.join(PUB, file));
  r.get("/", page("index.html"));
  r.get("/analytics", page("analytics.html"));
  r.get("/setup", page("setup.html"));
  return r;
}

module.exports = { publicRoutes, pageRoutes };
