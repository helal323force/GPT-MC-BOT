/**
 * modules/discord-bot.js - full Discord bot (discord.js v14) + legacy webhook notifications.
 * Config: discord { enabled, botToken, guildId, allowedChannels[], adminRoles[], prefix, webhook_url,
 *   notify_channelId, notify_events[], tts_alerts{enabled,events[]}, chat_bridge{...} }
 * Commands (slash + prefix): start stop status pos say cmd ai brain logs players
 *   Optional account: slash option "account"; prefix `!start alt1`; for text commands use `@alt1 message`.
 * Permissions: member must have a role id/name in adminRoles (empty list => Administrator permission).
 * Needs the "Message Content" privileged intent for prefix commands and the chat bridge.
 */
const axios = require("axios");
const state = require("../core/state");
const logger = require("../logger");
const { addLog } = require("../logger");

const COLORS = { success: 0x2ecc71, error: 0xe74c3c, info: 0x3498db, warn: 0xf39c12, ai: 0x9b59b6 };
const ACC = { name: "account", type: 3, description: "Bot account id (default: first)", required: false };
const COMMANDS = [
  { name: "start", description: "Start a bot (or 'all')", options: [ACC] },
  { name: "stop", description: "Stop a bot (or 'all')", options: [ACC] },
  { name: "status", description: "Health, uptime, position, players", options: [ACC] },
  { name: "pos", description: "Bot coordinates", options: [ACC] },
  { name: "say", description: "Send in-game chat", options: [{ name: "message", type: 3, description: "Message", required: true }, ACC] },
  { name: "cmd", description: "Run a Minecraft command", options: [{ name: "command", type: 3, description: "e.g. /home", required: true }, ACC] },
  { name: "ai", description: "Ask the AI", options: [{ name: "question", type: 3, description: "Question", required: true }, ACC] },
  { name: "brain", description: "Toggle the AI brain", options: [{ name: "mode", type: 3, description: "on or off", required: true, choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }] }, ACC] },
  { name: "logs", description: "Last N log lines", options: [{ name: "n", type: 4, description: "Lines (default 15)", required: false }, ACC] },
  { name: "players", description: "Players online", options: [ACC] },
];

const fmtUp = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
const embed = (title, description, color = "info", fields) => ({ title, description: String(description || "").slice(0, 4000), color: COLORS[color] ?? color, fields, timestamp: new Date().toISOString() });

class DiscordService {
  constructor(config) { this.config = config; this.cfg = config.discord || {}; this.client = null; this.ready = false; }

  // ---------- notifications (webhook + channel) ----------
  async notify(event, text, { color = "info", tts = false } = {}) {
    const c = this.cfg;
    if (!c.enabled) return;
    const events = c.notify_events || [];
    const ttsOn = c.tts_alerts?.enabled && (c.tts_alerts.events || []).includes(event);
    if (!events.includes(event) && !events.includes("*") && !ttsOn) return;
    const e = embed(event.replace(/_/g, " "), text, color);
    const useTts = !!(tts && ttsOn);
    const content = useTts ? `Minecraft bot alert: ${event.replace(/_/g, " ")}. ${String(text).replace(/[*_`]/g, "")}`.slice(0, 1900) : undefined;
    const chan = c.notify_channelId || (c.chat_bridge?.enabled ? c.chat_bridge.channelId : "");
    try {
      if (this.ready && chan) await this.sendEmbed(chan, e, { content, tts: useTts });
      else if (c.webhook_url) await axios.post(c.webhook_url, { embeds: [e], content, tts: useTts }, { timeout: 8000 });
    } catch (err) { addLog(`[Discord] notify failed: ${err.message}`, "warn"); }
  }

  async sendEmbed(channelId, e, extra = {}) {
    try {
      if (this.ready) {
        const ch = await this.client.channels.fetch(channelId);
        if (ch?.isTextBased()) return await ch.send({ embeds: [e], content: extra.content, tts: !!extra.tts, allowedMentions: { parse: [] } });
      } else if (this.cfg.webhook_url) {
        await axios.post(this.cfg.webhook_url, { embeds: [e], username: e.author?.name, avatar_url: e.author?.icon_url, content: extra.content, tts: !!extra.tts, allowed_mentions: { parse: [] } }, { timeout: 8000 });
      }
    } catch (err) { addLog(`[Discord] send failed: ${err.message}`, "warn"); }
  }

  // ---------- lifecycle ----------
  async init(bridge) {
    this.bridge = bridge;
    const c = this.cfg;
    if (!c.enabled) return;
    if (!c.botToken) { addLog("[Discord] no DISCORD_BOT_TOKEN - bot disabled (webhook notifications still work)", "info"); return; }
    try {
      const { Client, GatewayIntentBits, Partials } = require("discord.js");
      this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
      this.client.on("error", (e) => addLog(`[Discord] ${e.message}`, "error"));
      this.client.once("clientReady", () => this._onReady());
      this.client.once("ready", () => this._onReady());
      this.client.on("interactionCreate", (i) => this._onInteraction(i).catch((e) => addLog(`[Discord] interaction: ${e.message}`, "error")));
      this.client.on("messageCreate", (m) => this._onMessage(m).catch((e) => addLog(`[Discord] message: ${e.message}`, "error")));
      await this.client.login(c.botToken);
    } catch (e) { addLog(`[Discord] login failed: ${e.message}`, "error"); this.client = null; }
  }

  async _onReady() {
    if (this.ready) return;
    this.ready = true;
    addLog(`[Discord] logged in as ${this.client.user.tag}`, "success");
    try {
      const guild = this.cfg.guildId && (await this.client.guilds.fetch(this.cfg.guildId).catch(() => null));
      if (guild) await guild.commands.set(COMMANDS);
      else await this.client.application.commands.set(COMMANDS);
      addLog(`[Discord] ${COMMANDS.length} slash commands registered${guild ? " in guild" : " globally (may take ~1h)"}`, "info");
    } catch (e) { addLog(`[Discord] slash registration failed: ${e.message}`, "warn"); }
  }

  async stop() { this.ready = false; try { await this.client?.destroy(); } catch { /* ignore */ } this.client = null; }

  // ---------- permissions ----------
  _allowedChannel(id) { const a = this.cfg.allowedChannels || []; return !a.length || a.includes(id); }
  _isAdmin(member) {
    if (!member) return false;
    const roles = this.cfg.adminRoles || [];
    if (!roles.length) return member.permissions?.has("Administrator");
    return member.roles?.cache?.some((r) => roles.includes(r.id) || roles.includes(r.name));
  }

  // ---------- command execution ----------
  _resolve(accountArg) {
    if (accountArg) { const i = state.getInstance(accountArg); if (!i) throw new Error(`Unknown account "${accountArg}". Known: ${[...state.instances.keys()].join(", ")}`); return i; }
    const i = state.defaultInstance(); if (!i) throw new Error("No bot accounts configured"); return i;
  }

  async execute(name, a) {
    const targets = () => (a.account === "all" ? [...state.instances.values()] : [this._resolve(a.account)]);
    switch (name) {
      case "start": { const t = targets(); for (const i of t) await i.start(); return embed("Start", `Starting ${t.map((i) => i.id).join(", ")}`, "success"); }
      case "stop": { const t = targets(); for (const i of t) await i.stop("Stopped from Discord"); return embed("Stop", `Stopped ${t.map((i) => i.id).join(", ")}`, "warn"); }
      case "status": {
        const i = this._resolve(a.account), s = i.statusPayload(), p = i.state.position;
        return embed(`Status: ${i.id}`, `**${s.status}** on ${s.server}`, s.status === "online" ? "success" : "warn", [
          { name: "Uptime", value: fmtUp(s.uptimeSec), inline: true }, { name: "Health / Food", value: `${(s.health ?? 0).toFixed?.(1) ?? s.health} / ${s.food}`, inline: true },
          { name: "Position", value: p ? `${p.x}, ${p.y}, ${p.z}` : "n/a", inline: true }, { name: "Players", value: String(i.getPlayers().length), inline: true },
          { name: "Task", value: s.task, inline: true }, { name: "AI brain", value: s.brain ? "on" : "off", inline: true }, { name: "Reconnects", value: String(s.reconnects), inline: true },
        ]);
      }
      case "pos": { const i = this._resolve(a.account), p = i.state.position; return p ? embed("Position", `**${p.x}, ${p.y}, ${p.z}**  (${i.state.dimension || "?"})`, "info") : embed("Position", "Bot is offline", "warn"); }
      case "say": { const i = this._resolve(a.account); i.chat(a.text, { force: true }); return embed("Sent", a.text, "success"); }
      case "cmd": { const i = this._resolve(a.account); i.runCommand(a.text); return embed("Command", `\`${a.text}\``, "success"); }
      case "ai": {
        const i = this._resolve(a.account), svc = state.services.aiChat;
        if (!svc || !state.services.ai?.enabled) throw new Error("AI is not configured");
        const text = await svc.ask({ account: i.id, botName: i.account.username, player: a.user || "discord", question: a.text, source: "discord" });
        return embed("AI", text, "ai", [{ name: "Question", value: a.text.slice(0, 1000) }]);
      }
      case "brain": { const i = this._resolve(a.account); i.setBrain(a.mode === "on"); return embed("AI brain", `Brain is now **${a.mode}** for ${i.id}`, a.mode === "on" ? "ai" : "warn"); }
      case "logs": {
        const i = this._resolve(a.account), n = Math.max(1, Math.min(40, a.n || 15));
        const lines = logger.getLogs(n, i.id).map((e) => `${new Date(e.ts).toISOString().substring(11, 19)} ${e.msg}`).join("\n");
        return embed(`Last ${n} logs`, "```\n" + (lines || "(empty)").slice(-3800) + "\n```", "info");
      }
      case "players": { const i = this._resolve(a.account), p = i.getPlayers(); return embed(`Players (${p.length})`, p.map((x) => `• ${x.username}${x.self ? " (bot)" : ""}`).join("\n") || "none", "info"); }
      default: throw new Error("Unknown command");
    }
  }

  async _onInteraction(i) {
    if (!i.isChatInputCommand()) return;
    if (!this._allowedChannel(i.channelId)) return i.reply({ embeds: [embed("Not allowed", "Commands are not allowed in this channel.", "error")], ephemeral: true });
    if (!this._isAdmin(i.member)) return i.reply({ embeds: [embed("No permission", "You need an admin role to control the bot.", "error")], ephemeral: true });
    await i.deferReply();
    const o = i.options;
    const args = { account: o.getString("account") || undefined, user: i.user.username };
    const text = o.getString("message") || o.getString("command") || o.getString("question");
    if (text) args.text = text;
    if (i.commandName === "brain") args.mode = o.getString("mode");
    if (i.commandName === "logs") args.n = o.getInteger("n") || undefined;
    try { await i.editReply({ embeds: [await this.execute(i.commandName, args)] }); }
    catch (e) { await i.editReply({ embeds: [embed("Error", e.message, "error")] }); }
  }

  async _onMessage(m) {
    if (m.author.bot || !m.guild) return;
    if (this.cfg.guildId && m.guildId !== this.cfg.guildId) return;
    const prefix = this.cfg.prefix || "!";
    if (!m.content.startsWith(prefix)) { this.bridge?.fromDiscord(m); return; }
    const [rawName, ...rest] = m.content.slice(prefix.length).trim().split(/\s+/);
    const name = (rawName || "").toLowerCase();
    if (!COMMANDS.some((c) => c.name === name)) { this.bridge?.fromDiscord(m); return; }
    if (!this._allowedChannel(m.channelId) || !this._isAdmin(m.member)) { return void m.reply({ embeds: [embed("No permission", "Not allowed here or you lack an admin role.", "error")], allowedMentions: { repliedUser: false } }); }

    const args = { user: m.author.username };
    const isAcct = (t) => t && (t === "all" || state.instances.has(t));
    if (["say", "cmd", "ai"].includes(name)) {
      if (rest[0]?.startsWith("@") && isAcct(rest[0].slice(1))) args.account = rest.shift().slice(1);
      args.text = rest.join(" ");
      if (!args.text) return void m.reply({ embeds: [embed("Usage", `${prefix}${name} [@account] <text>`, "warn")], allowedMentions: { repliedUser: false } });
    } else if (name === "brain") {
      args.mode = (rest.shift() || "").toLowerCase();
      if (!["on", "off"].includes(args.mode)) return void m.reply({ embeds: [embed("Usage", `${prefix}brain on|off [account]`, "warn")], allowedMentions: { repliedUser: false } });
      args.account = rest[0];
    } else if (name === "logs") {
      if (/^\d+$/.test(rest[0] || "")) args.n = Number(rest.shift());
      args.account = rest[0];
    } else args.account = rest[0];
    try { await m.reply({ embeds: [await this.execute(name, args)], allowedMentions: { repliedUser: false } }); }
    catch (e) { await m.reply({ embeds: [embed("Error", e.message, "error")], allowedMentions: { repliedUser: false } }); }
  }
}

module.exports = { DiscordService, COMMANDS };
