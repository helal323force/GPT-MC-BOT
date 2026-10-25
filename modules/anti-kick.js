/**
 * modules/anti-kick.js - kick-loop detector (persistent per BotInstance).
 * Config (settings.anti_kick): enabled, threshold (3), window_min (5), mute_min (10), spam_mute_min (15)
 *  - N kicks with the same reason inside the window => anti-AFK + automated chat muted for mute_min.
 *  - Reason contains "spam" => periodic chat messages disabled for spam_mute_min.
 */
function createAntiKick(inst) {
  const kicks = [];
  const cfg = () => inst.config.anti_kick || {};
  const norm = (r) => String(r).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 80);

  return {
    record(reason) {
      const c = cfg(); if (!c.enabled) return;
      const now = Date.now(), win = (c.window_min || 5) * 60000;
      kicks.push({ ts: now, key: norm(reason) });
      while (kicks.length && now - kicks[0].ts > win) kicks.shift();

      if (/spam/i.test(reason)) {
        const mins = c.spam_mute_min || 15;
        inst.flags.chatMessagesOffUntil = now + mins * 60000;
        const msg = `Kick reason mentions spam - periodic chat messages disabled for ${mins} min`;
        inst.addLog(msg, "warn"); inst.notify("anti_kick", msg, { color: "warn" });
      }
      const same = kicks.filter((k) => k.key === norm(reason)).length;
      if (same >= (c.threshold || 3)) {
        const mins = c.mute_min || 10, until = now + mins * 60000;
        inst.flags.antiAfkMutedUntil = until;
        inst.flags.chatMutedUntil = until;
        kicks.length = 0;
        const msg = `Kicked ${same}x in ${c.window_min || 5} min for "${String(reason).slice(0, 100)}" - anti-AFK and chat muted for ${mins} min`;
        inst.addLog(msg, "warn"); inst.notify("anti_kick", msg, { color: "warn" });
        inst.pushEvent("anti-kick mute");
      }
    },
    isMuted() { return Date.now() < Math.max(inst.flags.antiAfkMutedUntil, inst.flags.chatMutedUntil); },
    destroy() { kicks.length = 0; },
  };
}
module.exports = { createAntiKick };
