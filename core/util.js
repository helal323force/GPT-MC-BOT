/**
 * core/util.js - small shared helpers (no external deps).
 *  truncateChat(text, max)  fit text into Minecraft's 256-char chat limit at a sentence/word edge
 *  sleep(ms)                promise delay
 *  parseReason(reason)      flatten a Minecraft chat/JSON kick reason into plain text
 */
function truncateChat(text, max = 256) {
  let t = String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("। "));
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim() + "…";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseReason(reason) {
  const walk = (n) => {
    if (n == null) return "";
    if (typeof n === "string") return n;
    if (Array.isArray(n)) return n.map(walk).join("");
    let s = typeof n.text === "string" ? n.text : "";
    if (n.translate && !s) s = String(n.translate);
    if (n.with) s += " " + walk(n.with);
    if (n.extra) s += walk(n.extra);
    if (n.value) s += walk(n.value);
    return s;
  };
  let r = reason;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { return r; } }
  return walk(r).replace(/§./g, "").trim() || String(reason);
}

/** "ENV:NAME" or "ENV:NAME|default" -> process.env value (deep over arrays/objects). */
function resolveEnv(value) {
  if (typeof value === "string" && value.startsWith("ENV:")) {
    const [name, ...rest] = value.slice(4).split("|");
    const v = process.env[name.trim()];
    return v !== undefined && v !== "" ? v : rest.join("|");
  }
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveEnv(value[k]);
    return out;
  }
  return value;
}

module.exports = { truncateChat, sleep, parseReason, resolveEnv };
