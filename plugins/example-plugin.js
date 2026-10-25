/** Example plugin: replies "pong" to "!ping" in game chat. Disable via plugins.disabled: ["example"]. */
module.exports = {
  name: "example",
  version: "1.0.0",
  init(bot, ctx) {
    ctx.addLog("Example plugin active - say !ping in chat");
    ctx.listen(bot, "chat", (username, message) => {
      if (username !== bot.username && message.trim() === "!ping") ctx.chat(`@${username} pong`);
    });
  },
};
