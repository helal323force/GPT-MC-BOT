/**
 * modules/discord-bridge.js - Minecraft <-> Discord chat bridge.
 * Config: discord.chat_bridge { enabled, channelId, account, forward_ai }
 *  MC -> Discord: embed with the player's head (mc-heads.net). Bot's own messages are never forwarded (loop guard);
 *                 ".ai" messages are forwarded as "asked AI: ..." and the AI reply is posted when forward_ai is on.
 *  Discord -> MC: "<DiscordName>: message" (256 chars). Bot authors and command messages are ignored.
 */
const state = require("../core/state");
const { addLog } = require("../logger");
const { truncateChat } = require("../core/util");

const AI_RE = /\.ai\b/i;

class DiscordBridge {
  constructor(config, discord) {
    this.cfg = config.discord?.chat_bridge || {};
    this.discord = discord;
    this.handlers = [];
  }
  get enabled() { return !!this.cfg.enabled && !!this.cfg.channelId; }

  init() {
    if (!this.enabled) return;
    const on = (ev, fn) => { state.bus.on(ev, fn); this.handlers.push([ev, fn]); };
    on("mc_chat", ({ account, username, message }) => {
      if (account !== this.account().id) return;
      const inst = state.getInstance(account);
      if (!inst || username === inst.bot?.username) return;
      if (AI_RE.test(message)) { if (this.cfg.forward_ai !== false) this.post({ title: null, description: `🤖 **${username}** asked AI: ${message.replace(AI_RE, "").trim() || "(help)"}`, username, color: 0x9b59b6 }); return; }
      this.post({ description: message, username, color: 0x2ecc71 });
    });
    on("ai_reply", ({ account, username, reply }) => {
      if (this.cfg.forward_ai === false || account !== this.account().id) return;
      this.post({ description: `🤖 → **${username}**: ${reply}`, username: "AI", color: 0x9b59b6, noAvatar: true });
    });
    addLog(`[Bridge] enabled on channel ${this.cfg.channelId}`, "info");
  }

  stop() { for (const [ev, fn] of this.handlers) state.bus.off(ev, fn); this.handlers = []; }

  account() { return state.getInstance(this.cfg.account) || state.defaultInstance() || { id: null }; }

  post({ description, username, color = 0x2ecc71, noAvatar = false }) {
    const embed = { description: String(description).slice(0, 2000), color, author: { name: username, icon_url: noAvatar ? undefined : `https://mc-heads.net/avatar/${encodeURIComponent(username)}/64` } };
    this.discord.sendEmbed(this.cfg.channelId, embed);
  }

  /** Called by discord-bot for every non-command message in the bridge channel. */
  fromDiscord(msg) {
    if (!this.enabled || msg.author.bot || msg.channelId !== this.cfg.channelId) return false;
    const inst = this.account();
    if (!inst.isOnline || !inst.isOnline()) return false;
    const name = (msg.member?.displayName || msg.author.username).replace(/[^\w .-]/g, "").slice(0, 24) || "discord";
    const text = String(msg.cleanContent || msg.content || "").replace(/[\r\n]+/g, " ").trim();
    if (!text) return false;
    try {
      inst.chat(truncateChat(`<${name}>: ${text}`, 256), { force: true });
      inst.pushChat({ username: name, message: text, source: "discord" });
    } catch (e) { addLog(`[Bridge] ${e.message}`, "warn"); }
    return true;
  }
}

module.exports = { DiscordBridge };
