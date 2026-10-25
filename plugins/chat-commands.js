/**
 * plugins/chat-commands.js - in-game commands (loaded automatically by modules/plugin-loader.js).
 *   .follow <player>   follow that player (".follow" alone follows whoever typed it)
 *   .stopmove          stop the current task / movement safely
 * Same style as ".ai": a "." prefix; replies are "@player ..." in chat.
 * Config (optional, settings.json):
 *   chat_commands: { enabled: true, allowed_players: [] }   <- empty/missing list = anyone can use the commands
 * Disable entirely with plugins.disabled: ["chat-commands"].
 */
const RE = /^\.(follow|stopmove)(?:\s+@?(\S+))?\s*$/i;

module.exports = {
  name: "chat-commands",
  version: "1.0.0",
  init(bot, ctx) {
    const inst = ctx.instance, last = new Map();
    const cfg = () => inst.config.chat_commands || {};
    if (cfg().enabled === false) return;

    const say = (user, text) => { try { ctx.chat(`@${user} ${text}`); } catch (e) { ctx.addLog(`reply failed: ${e.message}`, "warn"); } };

    ctx.listen(inst, "chat", async ({ username, message }) => {
      const m = RE.exec(String(message).trim());
      if (!m || username === bot.username) return;
      const allowed = cfg().allowed_players || [];
      if (allowed.length && !allowed.map((a) => a.toLowerCase()).includes(username.toLowerCase())) return;
      const now = Date.now();
      if (now - (last.get(username) || 0) < 2000) return;          // anti-spam
      last.set(username, now);
      if (last.size > 200) for (const [k, t] of last) if (now - t > 60000) last.delete(k);

      if (m[1].toLowerCase() === "stopmove") {
        const was = inst.stopMovement();
        ctx.addLog(`${username} used .stopmove${was ? ` (stopped ${was})` : ""}`, "control");
        return say(username, was ? `stopped ${was}.` : "nothing to stop.");
      }
      const target = m[2] || username;
      try {
        await inst.startActivity("follow", { player: target });
        ctx.addLog(`${username} used .follow ${target}`, "control");
        say(username, `following ${target}. Say .stopmove to stop.`);
      } catch (e) { say(username, `can't follow: ${e.message}`.slice(0, 200)); }
    });
  },
};
