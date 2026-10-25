# Plugins

Drop a `.js` file in this folder; it is loaded at startup (`[Plugins] Loaded N plugins: ...` in the log).

```js
module.exports = {
  name: "my-plugin",
  version: "1.0.0",
  // Called once per bot connection (after spawn). Return a cleanup function if you need one.
  init(bot, ctx) {
    ctx.addLog("hello from my plugin", "success");
    ctx.listen(bot, "chat", (user, msg) => { if (msg === "!ping") ctx.chat("pong"); });
    ctx.every(() => ctx.addLog("tick"), 60000);
  },
};
```

`ctx` provides `addLog(msg, type)`, `config`, `botState`, `instance`, `services`, `chat(msg)`,
and tracked helpers `listen(emitter, event, fn)`, `every(fn, ms)`, `after(fn, ms)`.
Use those helpers (not raw `bot.on` / `setInterval`) so everything is cleaned up on disconnect.
A plugin that throws is logged and skipped; it never crashes the bot.
Disable one with `plugins.disabled: ["my-plugin"]` in settings.json.
