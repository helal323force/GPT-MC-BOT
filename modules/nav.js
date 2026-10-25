/**
 * modules/nav.js - navigation coordinator (v3.1).
 *
 * WHY: mineflayer-pathfinder has ONE active goal per bot. Before v3.1, combat, waypoint-follow,
 * activities and stopActivity() all called setGoal()/stop() directly, so each of them could cancel
 * another task's in-flight goto() with "Path was stopped before it could be completed!".
 * Now only this class touches the pathfinder goal. Everybody else asks it.
 *
 * Model
 *  - goto(owner, goal)  one-shot navigation (Promise). Resolves when reached.
 *  - hold(owner, goal)  persistent goal (e.g. follow a player, chase a mob). release(owner) ends it.
 *  - Each owner has a priority. A higher-priority owner PREEMPTS a lower one; the lower goto() quietly
 *    waits and RESUMES the same goal afterwards (it does not fail), and lower holds are re-applied
 *    when the higher one releases. A lower owner can never cancel a higher one.
 *  - cancel(owner)  invalidates that owner's pending/future calls (they throw NavCancelled).
 *  - reset()        called on disconnect: cancels everything.
 *
 * Stuck watchdog (independent of the dashboard "Auto Jump" toggle): while any goal is being pursued, a 250 ms timer
 * checks progress. No movement for 1.5 s => jump pulse (the usual cause of a bot sitting in front of a 1-block step).
 * Still stuck at 3.5 s => jump again and re-issue the goal. Still stuck at 7 s => the goto FAILS with a "stuck" error
 * (the task reports it honestly) instead of hanging until its timeout. The timer only exists while a goal is active.
 *
 * No game libraries are imported here on purpose (keeps the logic unit-testable).
 */

// Higher number wins. Anything not listed (mine, farm, chop, grind, trade, fish, house, build, task) = 40.
const PRIORITY = { combat: 100, survival: 90, follow: 60, "rpg-controls": 59, coop: 58, move: 55 };
const DEFAULT_PRIORITY = 40;
// Owners that must never dig through or scaffold with blocks (protects player builds / building materials).
const SAFE_OWNERS = new Set(["combat", "survival", "follow", "house", "build"]);

class NavCancelled extends Error {
  constructor(owner, reason = "cancelled") {
    super(`Navigation cancelled (${reason})`);
    this.name = "NavCancelled";
    this.cancelled = true;
    this.owner = owner;
    this.reason = reason;
  }
}

class Nav {
  constructor(inst) {
    this.inst = inst;
    this.holder = null;          // what currently controls the pathfinder: {owner,pri,type,goal?,abort?,preempted?}
    this.holds = new Map();      // owner -> {owner,pri,goal,dynamic,seq}
    this.gens = new Map();       // owner -> cancel counter
    this.epoch = 0;              // bumped on reset (disconnect)
    this.waiters = new Set();
    this.profile = null;
    this._seq = 0;
    this.stuckCfg = { tickMs: 250, firstMs: 1800, secondMs: 4000, giveUpMs: 10000 };
    this._wd = null; this._lastPos = null; this._lastMove = 0; this._stage = 0; this._jt = null;
  }

  pri(owner) { return PRIORITY[owner] ?? DEFAULT_PRIORITY; }
  token(owner) { return `${this.epoch}:${this.gens.get(owner) || 0}`; }
  isActive() { return !!this.holder; }
  describe() { return this.holder ? { owner: this.holder.owner, type: this.holder.type } : null; }

  // ---------- public API ----------

  /** One-shot navigation. Throws NavCancelled if cancelled, Error("navigation timeout"/pathfinder error) on real failure. */
  async goto(owner, goal, { timeoutMs = 30000 } = {}) {
    const inst = this.inst, tok = this.token(owner), pri = this.pri(owner), deadline = Date.now() + timeoutMs;
    let recoveryAttempts = 0;
    for (;;) {
      this._alive(owner, tok);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("navigation timeout");
      if (this._blocked(owner, pri)) { await this._waitTurn(Math.min(left, 1000)); continue; }

      const bot = inst.bot;
      const h = { owner, pri, type: "goto", goal, preempted: false, abort: null };
      let timer;
      const aborted = new Promise((_, rej) => { h.abort = rej; });
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("navigation timeout")), left); });
      aborted.catch(() => {}); timeout.catch(() => {});

      this._takeForGoto(h);
      this._sync();
      try {
        this._applyProfile(owner);
        // pathfinder.goto's own promise is raced, so a spurious late rejection/resolution can never leak out.
        await Promise.race([bot.pathfinder.goto(goal), aborted, timeout]);
        return;
      } catch (e) {
        this._alive(owner, tok);                       // cancelled / disconnected => NavCancelled
        if (h.preempted) continue;                     // a higher-priority owner took over: wait, then resume
        const remaining = deadline - Date.now();
        const message = String(e?.message || e);
        const recoverable = remaining > 700 && recoveryAttempts < 2 && !/navigation cancelled|offline/i.test(message);
        if (recoverable) {
          recoveryAttempts++;
          const log = this.inst.addLog;
          if (log) log(`Navigation retry ${recoveryAttempts}/2 for ${owner}: ${message.slice(0, 140)}`, "warn");
          // Clear stale path state, reapply the owner's safe movement profile, then retry the same goal.
          // A fresh goto call is important: the previous pathfinder Promise may already be rejected.
          this._stopPf();
          this.profile = null;
          this._applyProfile(owner);
          await new Promise(resolve => setTimeout(resolve, Math.min(350, Math.max(50, remaining - 100))));
          continue;
        }
        throw e;                                       // exhausted bounded recovery attempts
      } finally {
        clearTimeout(timer);
        this._drop(h);
      }
    }
  }

  /** Persistent goal. Re-applied automatically after a higher-priority owner releases.
   * Dynamic follow callers often create a new GoalFollow object every tick. Treat equivalent
   * goals as the same goal so that the pathfinder is not restarted 1-2 times per second.
   */
  hold(owner, goal, dynamic = false) {
    const old = this.holds.get(owner);
    if (old && old.dynamic === !!dynamic && this._sameGoal(old.goal, goal)) return;
    this.holds.set(owner, { owner, pri: this.pri(owner), goal, dynamic, seq: ++this._seq });
    this._reapply();
    this._sync();
  }

  _sameGoal(a, b) {
    if (a === b) return true;
    if (!a || !b || a.constructor !== b.constructor) return false;
    if (a.entity || b.entity) return a.entity === b.entity && a.range === b.range;
    if (Number.isFinite(a.x) && Number.isFinite(b.x) && Number.isFinite(a.z) && Number.isFinite(b.z)) {
      if (a.x !== b.x || a.z !== b.z) return false;
      if (a.y !== undefined || b.y !== undefined) return a.y === b.y && a.range === b.range;
      return true;
    }
    return false;
  }
  hold_has(owner) { return this.holds.has(owner); }
  release(owner) {
    if (!this.holds.delete(owner)) return;
    this._reapply();
    this._sync();
    this._wake();
  }

  /** Cancel everything an owner has pending (its gotos throw NavCancelled, its hold is dropped). */
  cancel(owner, reason = "cancelled") {
    this.gens.set(owner, (this.gens.get(owner) || 0) + 1);
    this.holds.delete(owner);
    const h = this.holder;
    if (h && h.owner === owner) {
      this.holder = null;
      if (h.abort) h.abort(new NavCancelled(owner, reason));
      this._stopPf();
    }
    this._reapply();
    this._sync();
    this._wake();
  }

  /** Bot disconnected: invalidate everything. Does not touch the (dead) pathfinder. */
  reset() {
    this.epoch++;
    this.holds.clear();
    const h = this.holder;
    this.holder = null;
    if (h && h.abort) h.abort(new NavCancelled(h.owner, "reset"));
    this.profile = null;
    this._sync();
    this._wake();
  }

  // ---------- internals ----------

  _alive(owner, tok) {
    if (this.token(owner) !== tok) throw new NavCancelled(owner, "cancelled");
    if (!this.inst.bot) throw new NavCancelled(owner, "offline");
  }

  _topHold() {
    let top = null;
    for (const h of this.holds.values()) if (!top || h.pri > top.pri || (h.pri === top.pri && h.seq > top.seq)) top = h;
    return top;
  }

  _blocked(owner, pri) {
    if (this.inst.paused && pri < PRIORITY.survival) return true; // survival rest: low priority work waits
    const h = this.holder;
    if (h && h.owner !== owner && h.pri > pri) return true;
    const t = this._topHold();
    return !!(t && t.owner !== owner && t.pri > pri);
  }

  _takeForGoto(h) {
    // A previous goal may have reached the watchdog's final stage. Reset progress for this new goal
    // even when the watchdog interval itself remains alive across adjacent navigation requests.
    this._lastPos = null; this._lastMove = Date.now(); this._stage = 0; this._releaseJump();
    const cur = this.holder;
    if (cur) {
      if (cur.type === "goto") this._preempt(cur, cur.owner === h.owner);
      // a current "hold" stays registered in this.holds and resumes via _reapply() later
    }
    this.holder = h;
  }

  _preempt(cur, superseded = false) {
    if (!superseded) cur.preempted = true;
    this.holder = null;
    if (cur.abort) cur.abort(new Error(superseded ? "superseded by a newer navigation" : "preempted"));
    this._stopPf();
  }

  _drop(h) {
    if (this.holder === h) { this.holder = null; this._stopPf(); }
    this._reapply();
    this._sync();
    this._wake();
  }

  /** Make the pathfinder reflect the highest-priority hold, unless a goto currently outranks it. */
  _reapply() {
    const bot = this.inst.bot;
    if (!bot || !bot.pathfinder) return;
    const top = this._topHold(), cur = this.holder;
    if (cur && cur.type === "goto") {
      if (!top || top.pri <= cur.pri) return;
      this._preempt(cur);
    }
    const now = this.holder;
    if (top) {
      if (now && now.type === "hold" && now.owner === top.owner && now.goal === top.goal) return;
      this._applyProfile(top.owner);
      this.holder = { owner: top.owner, pri: top.pri, type: "hold", goal: top.goal };
      try { bot.pathfinder.setGoal(top.goal, top.dynamic); } catch { /* bot ending */ }
    } else if (now && now.type === "hold") {
      this.holder = null;
      try { bot.pathfinder.setGoal(null); } catch { /* bot ending */ }
    }
  }

  // ---------- stuck watchdog ----------
  _sync() { if (this.holder && this.inst.bot) this._watchStart(); else this._watchStop(); }
  _watchStart() {
    if (this._wd) return;
    this._lastPos = null; this._lastMove = Date.now(); this._stage = 0;
    this._wd = setInterval(() => { try { this._watch(); } catch { /* never break navigation */ } }, this.stuckCfg.tickMs);
  }
  _watchStop() {
    if (this._wd) { clearInterval(this._wd); this._wd = null; }
    this._releaseJump();
  }
  _releaseJump() {
    if (this._jt) { clearTimeout(this._jt); this._jt = null; }
    try { this.inst.bot?.setControlState("jump", false); } catch { /* bot ended */ }
  }
  _jump() {
    const bot = this.inst.bot; if (!bot || this._jt) return;
    bot.setControlState("jump", true);
    this._jt = setTimeout(() => { this._jt = null; try { bot.setControlState("jump", false); } catch { /* ended */ } }, 200);
  }
  _watch() {
    const bot = this.inst.bot, h = this.holder, c = this.stuckCfg;
    if (!bot || !bot.entity || !h) return;
    const pf = bot.pathfinder;
    if (!pf || typeof pf.isMoving !== "function" || (!pf.goal && !this.holds.has(h.owner))) { this._lastMove = Date.now(); this._stage = 0; return; }
    const e = bot.entity, p = e.position, now = Date.now();
    if (!this._lastPos || this._lastPos.distanceTo(p) > 0.1 || e.onGround === false) { this._lastPos = p.clone(); this._lastMove = now; this._stage = 0; return; }
    const idle = now - this._lastMove, log = (m) => this.inst.addLog && this.inst.addLog(m, "warn");
    if (idle > c.firstMs && this._stage === 0) { this._stage = 1; log("Navigation: no progress - jumping to get past an obstacle"); this._jump(); }
    else if (idle > c.secondMs && this._stage === 1) {
      this._stage = 2; log("Navigation: still stuck - jumping again and re-planning"); this._jump();
      // Force a fresh path calculation for both one-shot and persistent goals. This is
      // important when a temporary obstruction or newly-loaded chunk invalidates the path.
      try {
        if (h.type === "hold") pf.setGoal(h.goal, !!(this.holds.get(h.owner) || {}).dynamic);
        else if (h.type === "goto" && h.goal) pf.setGoal(h.goal);
      } catch (e) { log(`Navigation re-plan failed: ${e.message}`); }
    } else if (idle > c.giveUpMs && this._stage === 2) {
      this._stage = 3; log(`Navigation: stuck for ${Math.round(idle / 1000)}s`);
      if (h.type === "goto" && h.abort) h.abort(new Error("bot is stuck - no movement for " + Math.round(idle / 1000) + "s (blocked path?)"));
    }
  }

  _stopPf() { try { this.inst.bot?.pathfinder?.stop(); } catch { /* bot ending */ } }

  _applyProfile(owner) {
    const inst = this.inst, bot = inst.bot;
    const m = SAFE_OWNERS.has(owner) ? (inst.safeMovements || inst.movements) : inst.movements;
    if (!bot || !m || this.profile === m) return;
    try { bot.pathfinder.setMovements(m); this.profile = m; } catch { /* ignore */ }
  }

  _waitTurn(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  _wake() { for (const w of [...this.waiters]) w(); }
}

module.exports = { Nav, NavCancelled, PRIORITY };
