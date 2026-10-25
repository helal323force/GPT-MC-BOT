# Minecraft AFK Bot v3.0

AI chat + autonomous brain, Discord bot and chat bridge, real-time Socket.IO dashboard, mining/farming/fishing/chopping/trading/building, multi-account, scheduler, backups, plugins. Runs on **Railway**, **Render** and **GitHub Actions** (or any Docker/VPS host).

> Use bots only on servers you own or where AFK bots are allowed. Proxy rotation and anti-kick handling exist to cope with flaky networks, not to evade bans.

## Quick start (local)

```bash
cp .env.example .env        # fill in at least DASHBOARD_PASSWORD, SESSION_SECRET, MC_HOST
npm install
npm start                   # http://localhost:3000
```

Everything is configured in `settings.json`. Any value written `"ENV:NAME"` (or `"ENV:NAME|default"`) is read from the environment at boot, so the file is safe to commit. `SETTINGS_OVERRIDE='{"ai_brain":{"enabled":true}}'` deep-merges JSON over the file, which is handy on hosts where you only set env vars.

## Deploying

| | Railway | Render | GitHub Actions |
|---|---|---|---|
| Config file | `railway.json` + `Dockerfile` | `render.yaml` + `Dockerfile` | `.github/workflows/run-bot.yml` |
| Dashboard | yes | yes | no (`HEADLESS=true`), control via Discord |
| Health check | `/health` | `/health` | none |
| Persistent data | add a Volume at `/app/data` | paid plan: add a disk (see `render.yaml`) | `actions/cache` restores `data/` between runs |
| Sleeps when idle | no | free plan yes - keep-alive pings `/ping` | n/a |

**Railway:** New Project -> Deploy from GitHub repo. Add the variables from `.env.example` (Railway injects `PORT`). Optionally add a Volume mounted at `/app/data`. `RAILWAY_PUBLIC_DOMAIN` is used automatically for keep-alive.

**Render:** New -> Blueprint -> pick the repo. Fill the `sync: false` variables when prompted. Set `RENDER_EXTERNAL_URL` to your service URL so the keep-alive pinger works. The free plan has no disk, so SQLite data (sessions, history, tasks added in the UI) resets on redeploy; tasks in `settings.json` are re-seeded every boot.

**GitHub Actions:** Repo -> Settings -> Secrets and variables. Secrets: `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `MC_HOST` (or variable), `BOT_PASSWORD`, `BOT_AUTH_PASSWORD`, AI keys, `DISCORD_BOT_TOKEN`. Variables: `MC_PORT`, `MC_VERSION`, `BOT_USERNAME`, `DISCORD_GUILD_ID`, `DISCORD_BRIDGE_CHANNEL_ID`. Run **Actions -> Run Bot -> Run workflow**. A job lives at most 6 h, so the bot exits cleanly after 345 min and the last step re-dispatches the workflow (`concurrency` prevents overlap). Untick "chain" to stop the loop.
Caveats: GitHub's terms limit Actions to project-related work, and long-running bots may violate them. Private repos burn the free minutes quota (~33 h/month). The safe option is a self-hosted runner: set repo variable `RUNNER_LABEL`. You can't reach the dashboard from outside, so use Discord (`!status`, `!say`, ...).

`.github/workflows/ci.yml` runs syntax checks + offline self-tests on every push. `.github/workflows/deploy.yml` is an optional extra that triggers a Render deploy hook (`RENDER_DEPLOY_HOOK_URL` secret) and/or `railway up` (`RAILWAY_TOKEN` secret); each job skips itself when its secret is missing. Both platforms also auto-deploy from GitHub without it, so delete it if you don't need it.

## Features and their config keys

Every module can be turned off in `settings.json`.

| Feature | Key | Notes |
|---|---|---|
| Dashboard + Socket.IO | `dashboard.*` | Events: `status chat log players inventory health position task move_status player_event`. Per-account rooms. `/health` and `/ping` stay public. |
| Login | `dashboard.password`, `sessionSecret` | Falls back to `admin123` with a warning. Sessions stored in SQLite. Scripts can send `x-api-key: <password>`. |
| AI chat | `ai`, `ai_chat` | `.ai` anywhere (`\.ai\b`). 1 reply/player/10 s, 20/min global. Memory 10 messages/player, cleared when the player leaves. |
| Providers | `ai.primary`, `ai.fallbacks` | Gemini -> Groq -> OpenAI. 10 s timeout, one retry with backoff on 429/5xx, 60 s response cache, failure cool-down up to 5 min. |
| AI brain | `ai_brain` | JSON decisions every `tick_interval` s. When `max_requests_per_hour` is hit the brain **switches itself off** and warns. Toggle in the AI tab, `!brain on|off`, or `POST /api/brain`. |
| Discord bot | `discord` | Slash + prefix commands. Needs the **Message Content** intent. `adminRoles`: role ids or names (empty = Administrator permission). `allowedChannels`: empty = anywhere. |
| Chat bridge | `discord.chat_bridge` | MC -> Discord embeds with head icons; Discord -> MC as `<Name>: text`. Bot's own messages are never forwarded. `.ai` lines are forwarded as "asked AI". |
| TTS alerts | `discord.tts_alerts` | Uses Discord's `tts: true` flag (the listener needs "Allow text-to-speech" enabled in Discord). |
| Mining | `modules.auto_mine` | Needs the right pickaxe when `require_tool`. Returns home every 5 min. |
| Farming | `modules.auto_farm` | Replants from inventory seeds. |
| Fishing | `modules.auto_fish` | Needs a rod and water within 16 blocks. Uses mineflayer's bobber handling. |
| Chopping | `modules.auto_chop` | Flood-fills the tree and digs it bottom-up. |
| Trading | `modules.auto_trade` | `item_wanted` = what you receive, `item_give` = what you pay. |
| Building | `modules.auto_build` | `POST /api/build {schematic: base64, x,y,z}`. Survival placement from inventory. **Test with a tiny schematic first.** |
| Combat | `combat` | Weapon table, golden apples, flee, PvP retaliation only, ignore lists. |
| Tracker | `tracker` | Sessions in SQLite; `GET /api/players/history?username=`. OP status is not visible to clients, so list ops in `tracker.ops`. |
| Scheduler | `tasks` | Cron + delay tasks; add/toggle/delete in the Tasks tab or `/api/tasks`. Delay tasks repeat unless `"repeat": false`. |
| Waypoints | `/api/move` | Also click the Map tab. |
| Anti-kick | `anti_kick` | 3 identical kicks in 5 min -> anti-AFK + automated chat muted 10 min. "spam" in the reason -> periodic chat off 15 min. |
| Backups | `backup`, `restore_position` | Every 5 min. Restore walks back (or `/tp` if `backup.try_tp` and the bot is OP). Inventory is recorded, not re-created. |
| Plugins | `plugins`, `plugins/*.js` | See `plugins/README.md`. |
| Proxy | `proxy` | `socks4://` / `socks5://user:pass@host:port`, round-robin per reconnect. |
| Auto-update | `auto_update` | Needs a `.git` checkout (not Docker builds). Uses pm2 restart if available, otherwise logs "restart required". |
| Multi-account | `accounts[]` + `launcher_accounts.json` | One `BotInstance` per account; staggered 3 s logins. |
| Memory / crash | `memory_monitor`, `crash_recovery` | Crash loops (6 in a minute) exit so the platform restarts the process. |

Discord commands: `start stop status pos say cmd ai brain logs players`. Prefix form: `!start alt1`, `!say @alt1 hello`, `!logs 20 alt1`. Slash commands have an `account` option.

## Assumptions (you asked me not to ask)

- Your zip had a different layout (`src/server.js`, multi-user login, Bedrock adapter) from the file list in the brief, and no `settings.json`, `logger.js` or `leaveRejoin.js`. v3 follows the brief's structure; `logger.js` and `leaveRejoin.js` are new compatible implementations, and the old multi-user login and Bedrock adapter are not carried over.
- Dashboard auth is a single shared password, as specified.
- AI providers are called over REST with `axios` instead of the three vendor SDKs (fewer dependencies, hard timeouts). `socket.io-client` is not needed (served by the server).
- Default Gemini model is `gemini-2.5-flash`, because 1.5 models are retired. Check the model names in `settings.json` against your provider's current list.
- `logger.addLog(msg, type = "info", account = "system")`: the 300-line buffer is per account.
- Tailwind, Chart.js, xterm.js and fonts load from CDNs. Item icons come from the PrismarineJS `minecraft-assets` repo and fall back to a text tile.
- Push notifications use the browser Notification API via the service worker when the bot goes down while a tab is open (no web-push server).

## Dependencies

```
npm install axios better-sqlite3 discord.js dotenv express express-rate-limit express-session helmet \
  minecraft-data mineflayer mineflayer-pathfinder node-cron prismarine-schematic socket.io socks \
  socks-proxy-agent vec3
```
Added beyond your list: `mineflayer`, `mineflayer-pathfinder`, `minecraft-data`, `vec3`, `socks`, `helmet`, `express-rate-limit`. Removed: `@google/generative-ai`, `groq-sdk`, `openai`, `socket.io-client`. Node 20+.

## Testing checklist

- [ ] `npm install` finishes (better-sqlite3 uses a prebuilt binary on Node 20/22; the Dockerfile has build tools as a fallback)
- [ ] `npm test` (syntax of every file + offline logic tests)
- [ ] Bot connects and spawns
- [ ] Dashboard loads at `/` after login; browser console shows `socket connected`
- [ ] Start/Stop works from the dashboard
- [ ] Live chat appears on the Chat tab
- [ ] In game `.ai hello` gets a reply
- [ ] `test .ai what is your name` gets a reply
- [ ] Discord slash commands respond
- [ ] Bridge forwards MC chat to Discord and back
- [ ] Auto-mine works (if enabled, with a pickaxe in inventory)
- [ ] A cron task fires (add `* * * * *` + `say`)
- [ ] Join/leave rows appear (`GET /api/players/history?username=X`)
- [ ] Analytics charts render
- [ ] Stop then Start leaves no ghost intervals (the `[Memory]` line stays flat)
- [ ] 30 minutes with no memory growth
- [ ] Every non-public route redirects to `/login` when signed out

## Status of this build

Every file passes `node --check`, all relative requires resolve, and the pure logic (`.ai` parsing, chat truncation, kick-reason parsing, brain JSON parsing, env resolution, proxy masking) is covered by `scripts/selftest.js`. The sandbox this was built in had no network, so **dependencies were never installed and the bot was never run against a real Minecraft server, Discord or an AI API.** Expect to fix small integration issues on first boot, most likely in the activity modules (builder, trader, fisher) which depend on live game state.
