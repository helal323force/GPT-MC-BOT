/**
 * modules/ai-brain.js - autonomous decision loop.
 * Config: ai_brain { enabled, tick_interval (30 s), max_requests_per_hour (100) }  + runtime toggle (dashboard/Discord)
 * Every tick the AI gets a situation snapshot and returns JSON:
 *   { "action": flee|attack|follow|walk_random|mine|farm|fish|idle|reply_chat, "params": {}, "say": "optional" }
 * Cost guard: when max_requests_per_hour is reached the brain switches itself off and logs a warning.
 */
const state = require("../core/state");
const { truncateChat } = require("../core/util");

const ACTIONS = new Set(["flee", "attack", "follow", "walk_random", "mine", "farm", "fish", "branchmine", "loot", "explore", "store", "smelt", "idle", "reply_chat"]);

function parseDecision(text) {
  const clean = String(text).replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON in AI reply");
  const d = JSON.parse(clean.slice(start, end + 1));
  if (!ACTIONS.has(d.action)) throw new Error(`unknown action "${d.action}"`);
  return { action: d.action, params: d.params && typeof d.params === "object" ? d.params : {}, say: typeof d.say === "string" ? d.say : "" };
}

function create(inst) {
  const bot = inst.bot;
  let busy = false;

  function snapshot() {
    const n = inst.getNearby(24), p = bot.entity.position;
    return {
      health: bot.health, food: bot.food,
      position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      nearbyMobs: n.mobs.slice(0, 8).map((m) => ({ name: m.name, distance: m.distance })),
      nearbyPlayers: n.players.slice(0, 8).map((m) => ({ name: m.name, distance: m.distance })),
      currentTask: inst.state.task,
      availableActivities: Object.keys(inst.activities).filter((a) => ["mine", "farm", "fish", "chop", "branchmine", "loot", "explore", "store", "smelt"].includes(a)),
      lastChat: inst.chatLog.slice(-5).map((c) => `${c.username}: ${c.message}`),
      recentEvents: inst.events.slice(-5).map((e) => e.text),
    };
  }

  function brainRun(name, params) {
    try { inst.runActivity(name, params, { source: "brain" }); }
    catch (e) { inst.addLog(`Brain: ${e.message}`, "ai"); }
  }

  function execute(d) {
    const combat = inst.modules.combat;
    switch (d.action) {
      case "flee": if (combat) combat.fleeNow(); break;
      case "attack": if (combat) combat.forceTarget(d.params.target); break;
      // v3.1: the brain has the LOWEST rank - it can never replace or stop a task started by the user or the scheduler.
      case "follow": if (d.params.player && bot.players[d.params.player]?.entity) brainRun("follow", { player: String(d.params.player) }); break;
      case "walk_random": brainRun("move", { random: true }); break;
      case "mine": case "farm": case "fish": case "branchmine": case "loot": case "explore": case "store": case "smelt":
        if (inst.activities[d.action]) { if (inst.activeActivity !== d.action) brainRun(d.action, d.params || {}); }
        else inst.addLog(`Brain wanted ${d.action} but the module is disabled`, "ai");
        break;
      case "idle": try { inst.stopActivity({ source: "brain" }); } catch (e) { inst.addLog(`Brain: ${e.message}`, "ai"); } break;
      default: break;
    }
    const say = d.say || (d.action === "reply_chat" ? d.params.text : "");
    if (say) inst.chat(truncateChat(String(say), 200));
  }

  async function tick() {
    const ai = state.services.ai, rt = inst.runtime, max = inst.config.ai_brain.max_requests_per_hour || 100;
    if (!rt.brainEnabled || busy || !ai?.enabled || !inst.isOnline()) return;
    const now = Date.now();
    rt.brainReqs = rt.brainReqs.filter((t) => now - t < 3600000);
    if (rt.brainReqs.length >= max) {
      const msg = `AI brain hit its cost guard (${max} requests/hour) and was switched off`;
      inst.addLog(msg, "warn"); inst.notify("brain", msg, { color: "warn" });
      inst.setBrain(false);
      return;
    }
    busy = true; rt.brainReqs.push(now);
    try {
      const system = inst.services.ai.systemPrompt(bot.username,
        'You control the bot. Reply ONLY with JSON: {"action":"flee|attack|follow|walk_random|mine|farm|fish|branchmine|loot|explore|store|smelt|idle|reply_chat","params":{},"say":""}. ' +
        'params: attack{target}, follow{player}, branchmine{length,axis}, loot{radius,max}, explore{steps,radius}, reply_chat{text}. Only choose activities listed as available. Avoid branch mining near hazards, use storage only when a chest is nearby, and smelt only when a furnace and fuel are available. Flee when health is low or dangerous mobs are close. Prefer idle when nothing needs doing. "say" is optional chat text under 200 chars.');
      const res = await ai.ask({ system, prompt: JSON.stringify(snapshot()), json: true, maxTokens: 220, temperature: 0.6, cache: false, meta: { source: "brain", account: inst.id } });
      const d = parseDecision(res.text);
      inst.addLog(`Brain: ${d.action}${d.say ? ` "${d.say}"` : ""}`, "ai");
      inst.emitSocket("brain", { decision: d });
      execute(d);
    } catch (e) { inst.addLog(`Brain tick failed: ${e.message}`, "warn"); }
    finally { busy = false; }
  }

  return {
    init() { inst.every(tick, Math.max(5, inst.config.ai_brain.tick_interval || 30) * 1000); },
    stop() {},
  };
}

module.exports = { create, parseDecision };
