/**
 * core/auth.js - cookie-session login for the dashboard.
 *
 * Config: settings.dashboard.password (ENV:DASHBOARD_PASSWORD, fallback "admin123" + warning)
 *         settings.dashboard.sessionSecret (ENV:SESSION_SECRET)
 * Sessions are persisted in SQLite so logins survive restarts (Render/Railway redeploys).
 * Automation: send header  x-api-key: <DASHBOARD_PASSWORD>  (or Authorization: Bearer ...).
 */
const crypto = require("crypto");
const session = require("express-session");
const database = require("./database");
const { addLog } = require("../logger");

class SqliteStore extends session.Store {
  constructor() {
    super();
    const t = setInterval(() => { try { database.run("DELETE FROM sessions WHERE expires < ?", Date.now()); } catch { /* ignore */ } }, 10 * 60 * 1000);
    t.unref();
  }
  get(sid, cb) {
    try {
      const row = database.get("SELECT sess, expires FROM sessions WHERE sid = ?", sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      database.run("INSERT INTO sessions(sid,sess,expires) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires", sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { database.run("DELETE FROM sessions WHERE sid = ?", sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function createAuth(dashCfg) {
  let password = dashCfg.password;
  if (!password) {
    password = "admin123";
    addLog("DASHBOARD_PASSWORD not set - using insecure dev password 'admin123'. Set DASHBOARD_PASSWORD!", "warn");
  }
  let secret = dashCfg.sessionSecret;
  if (!secret) {
    secret = crypto.createHash("sha256").update("mc-afk-bot:" + password).digest("hex");
    addLog("SESSION_SECRET not set - deriving one from the password. Set SESSION_SECRET for production.", "warn");
  }

  const sessionMiddleware = session({
    store: new SqliteStore(),
    name: "mcbot.sid",
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 7 * 24 * 3600 * 1000 },
  });

  const apiKeyOk = (req) => {
    const h = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return !!h && safeEqual(h, password);
  };

  /** Gate: lets authenticated sessions (or API-key requests) through, otherwise 401 / redirect. */
  function requireAuth(req, res, next) {
    if (req.session?.auth || apiKeyOk(req)) return next();
    const wantsJson = req.path.startsWith("/api") || req.method !== "GET" || (req.headers.accept || "").includes("application/json");
    if (wantsJson) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/login");
  }

  function login(req, res) {
    const given = String(req.body?.password || "");
    const json = (req.headers["content-type"] || "").includes("json");
    if (given && safeEqual(given, password)) {
      return req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: "Session error" });
        req.session.auth = true;
        req.session.save(() => (json ? res.json({ ok: true }) : res.redirect("/")));
      });
    }
    addLog(`Failed dashboard login from ${req.ip}`, "warn");
    return json ? res.status(401).json({ error: "Invalid password" }) : res.redirect("/login?error=1");
  }

  function logout(req, res) {
    const json = (req.headers["content-type"] || "").includes("json") || (req.headers.accept || "").includes("json");
    req.session.destroy(() => (json ? res.json({ ok: true }) : res.redirect("/login")));
  }

  return { sessionMiddleware, requireAuth, login, logout };
}

module.exports = { createAuth };
