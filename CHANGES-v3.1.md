# v3.1 update - changed files only

Based on the v3.0 repository (the project with `core/`, `modules/`, `routes/`, `public/`, `plugins/`).
`package.json`, lockfiles, `settings.json`, `render.yaml`, `railway.json`, `Dockerfile`, workflows and `.env` are **not touched**.
No new dependencies. No new required environment variables.

## 1. Root cause of "Path was stopped before it could be completed!"

Several parts of the bot wrote the pathfinder's single goal directly, so each could cancel another task's in-flight `goto()`:

| Where (v3.0) | What it did |
|---|---|
| `modules/combat.js` | `setGoal(GoalFollow)` **every 350 ms** while a threat existed (restarting the path each time and cancelling mining/waypoint gotos); `setGoal(null)` when combat ended (wiping whatever else was running) |
| `core/bot-instance.js` `stopActivity()` | `setGoal(null)` globally; `runActivity()` calls it first, so *starting* any task cancelled the previous one's navigation, including tasks started by the AI brain every 30 s |
| `core/bot-instance.js` `goto()` timeout | `pathfinder.stop()` globally - one task timing out cancelled everybody else |
| `modules/waypoint.js` follow | raw `setGoal` that combat silently overwrote and then cleared while the dashboard still said "following" |
| miner/farmer/chopper | treated the cancellation as a bad ore block and marked it "mined" |

Fix: `modules/nav.js` is now the only code that touches the pathfinder goal (priorities: combat 100 > survival 90 > follow 60 > move 55 > everything else 40). A higher-priority owner pre-empts a lower one, the lower one **waits and resumes the same goal** (it no longer fails), `cancel(owner)` only affects that owner, and everything is reset on disconnect.
Also fixed on the way: a stop-then-start of the same activity could leave the old loop running next to the new one (they shared one `running` flag); tasks started by the AI brain or the scheduler can no longer replace or stop a task you started by hand.

**"Bot can't reach its destination because it won't jump"**: the nav coordinator now has an always-on stuck watchdog (independent of the Auto Jump switch). No progress for 1.5 s -> jump; 3.5 s -> jump again + re-plan; 7 s -> the navigation fails with a clear "stuck" error instead of hanging. The Auto Jump switch controls only the extra free-walking step-up. I could not reproduce the stall without a live server, so see "Not verified" below.

## 2. File list

Paths are relative to the repository root. **R** = replace the existing file, **N** = new file.

| Path | R/N | Feature | Needs |
|---|---|---|---|
| `modules/nav.js` | N | Movement/pathfinding fix, stuck-jump watchdog | used by bot-instance, combat, survival, follow |
| `core/bot-instance.js` | R | Coordinator wiring, task ranks, `startActivity`, task results, Auto Jump state, registers the new modules | `modules/nav.js` + all new modules |
| `modules/combat.js` | R | Pathfinder fix (goal via coordinator, set once per target), survival veto | `modules/nav.js` |
| `modules/waypoint.js` | R | Pathfinder fix (follow moved out), honest task result | `modules/follow.js` |
| `modules/ai-brain.js` | R | Brain can't override user tasks | bot-instance (R) |
| `modules/scheduler.js` | R | Scheduler can't override user tasks | bot-instance (R) |
| `modules/autojump.js` | N | A. Auto Jump | bot-instance (R), `routes/extras.js`, `public/js/extras.js` |
| `modules/survival.js` | N | B. Smart survival | `modules/nav.js`, combat (R) |
| `modules/follow.js` | N | C. Follow a player | `modules/nav.js` |
| `plugins/chat-commands.js` | N | C. `.follow <player>`, `.stopmove` (existing plugin loader) | bot-instance (R) |
| `modules/grinder.js` | N | D. Resource grinding | bot-instance (R) |
| `modules/housebuilder.js` | N | E. House building | bot-instance (R) |
| `modules/invtools.js` | N | F. Inventory list + safe drop | - |
| `routes/extras.js` | N | API for A-F | `index.js` (R) |
| `index.js` | R | Mounts `routes/extras.js` (2 lines) | `routes/extras.js` |
| `public/index.html` | R | "Control" tab shell + script tag | `public/js/extras.js` |
| `public/js/extras.js` | N | Dashboard controls for A, C, D, E, F + live task status | `routes/extras.js` |
| `scripts/test-nav.js` | N | Offline tests (coordinator, stuck watchdog) | - |
| `scripts/test-features.js` | N | Offline integration tests (mocks) | - |
| `CHANGES-v3.1.md` | N | This document | - |

All 7 replaced files must be uploaded **together** with the new ones; they depend on each other. Nothing else is required.

## 3. GitHub upload (web UI)

1. Unzip `minecraft-bot-v3.1-changes.zip` on your computer.
2. In your repo click **Add file -> Upload files** and drag the unzipped folders (`core`, `modules`, `plugins`, `public`, `routes`, `scripts`) plus `index.js` and `CHANGES-v3.1.md`. GitHub keeps the folder paths and overwrites same-named files (that replaces the 7 "R" files; nothing else is deleted).
3. Commit message e.g. "v3.1: navigation coordinator + survival/follow/grind/house/drop". Commit to your deploy branch.
   *(Or with git: copy the files over your clone, `git add -A && git commit && git push`.)*
4. Before uploading, you can check you have the v3.0 base: sha256 prefixes of the originals being replaced:
   `core/bot-instance.js eabca9987cbee10f` · `index.js eb68e0bd180a122b` · `modules/ai-brain.js 342348aa95d44bc2` · `modules/combat.js e39e1e12da54d697` · `modules/scheduler.js 355ac15cc6aae3cc` · `modules/waypoint.js a0c3664c2898aa74` · `public/index.html 1a0d06e8751e744c`
   If yours differ you edited them; tell me and I will merge instead of replacing.

## 4. Render

Render auto-deploys on push (`autoDeploy: true` in your render.yaml). If it does not: **Manual Deploy -> Deploy latest commit**. No new env vars, no build-command change, no `npm install` changes (no new packages). Hard-refresh the dashboard (Ctrl+Shift+R) once so the browser loads the new `index.html`/`extras.js`; the PWA service worker serves cached JS otherwise.

## 5. Using it

* Dashboard -> **Control** tab: current task + live progress, Auto jump switch, follow (player list), resource grinding (Check / Start), house (Check area / Build), drop item.
* In game: `.follow <player>` (or `.follow` for yourself), `.stopmove`.
* Optional `settings.json` keys (all have defaults; nothing to add unless you want to change them):
  `survival {eat_below, retreat_health, resume_health, max_threats, ...}` · `follow {distance, lost_timeout_sec}` · `grind {radius, max_minutes, min_health}` · `inventory {protected_items:[...], block_protected_drops}` · `chat_commands {enabled, allowed_players:[...]}` · `auto_jump {enabled}` · `modules.auto_grind.enabled` / `modules.auto_house.enabled` (set `false` to turn off) · `survival.enabled:false`.
* **Security note:** by default **any player** can use `.follow` / `.stopmove` (like `.ai`). Set `chat_commands.allowed_players` to restrict. There is deliberately **no** chat command for dropping items.

## 6. Behaviour changes to be aware of

* Follow, combat and survival navigate with a "safe" movement profile (no digging, no scaffolding, no parkour, max 3-block drops) so they cannot break builds or burn building blocks. Mining/farming/chopping/grinding keep the old profile.
* Starting a task from the AI brain or scheduler while you have a task running now logs "Busy with ..." instead of replacing it.
* `inst.goto()` now only works while a task is running (it used to run orphaned after a stop).
* `inst.sleep()` is woken early when a task is stopped, so stopped loops end immediately.

## 7. Testing

Run `node scripts/check.js && node scripts/selftest.js && node scripts/test-nav.js && node scripts/test-features.js`.

**Passed (in the build sandbox):** `node --check` on every file; the existing `selftest.js`; 25 coordinator tests (priority pre-emption + resume, cancel isolation, timeouts, reset, same-owner supersede, safe/work movement profile, stuck watchdog jump / re-plan / honest failure / no leaked timer) against a mock pathfinder in both a strict and a lenient variant; 33 integration tests that load the real modules and `BotInstance` with stubbed libraries (drop validation/confirmation/verification, grind pre-flight and honest success/failure, survival eating/retreat/rest/veto, follow offline/out-of-range/leave, Auto Jump single timer + cleanup, house plan/build/verify/partial/resume/no-destruction, task ranks, run-loop serialisation, combat-then-resume, detach leak check, plugin exports + command parsing + allow-list + cooldown, API status codes/bodies, frontend-to-backend endpoint and element-id matching, route mount order). The last-step check also ran the whole suite after unpacking the ZIP onto a clean copy of v3.0.

**Not run / not verified:** anything against a real Minecraft server or the real `mineflayer` / `mineflayer-pathfinder` / `vec3` / `prismarine` libraries (not installable in the sandbox); the dashboard in a real browser; real Render deployment. Specifically unverified: that a jump pulse is honoured while the real pathfinder is driving (it normally plans its own jumps; the watchdog is a safety net); the real pathfinder's rejection behaviour on `setGoal`/`stop` (the coordinator is written to be correct whether it rejects or not, and was tested both ways); block placement geometry, reach and standing positions in the house builder; item drop via `bot.toss` on your server version; trader/builder/fisher modules (unchanged). Treat the first live run as a test: try Control -> Check buttons first, use a small amount, watch the log.

## 8. Known limitations

* Dropped items can be picked up again if the bot stays near them.
* House: 4-7 blocks wide, 3 high, flat roof, open doorway (no door item), no floor/foundation building; needs flat solid ground and a clear area; materials limited to planks, cobblestone, stone, bricks, sandstone, deepslate bricks/cobbled deepslate, dirt (or an explicit non-valuable block).
* Grinding: blocks that drop an item directly (logs, stone->cobblestone, ores, sand, gravel, dirt); no mob drops, smelting or crafting. Needs the resource within the radius; it does not wander to find more.
* Other plugins you write that call `bot.pathfinder.setGoal()` directly bypass the coordinator and can still cancel tasks. Use `ctx.instance.nav.hold()/goto()`.


## AFK Bot reliability patch (2026-10-25)

- Added the missing authenticated `/api/profiles` GET/POST and `/api/profiles/:id` DELETE routes that the existing dashboard profile manager already called. Profiles are validated, persisted in the existing SQLite key-value store, and created as non-autostart BotInstance objects. Only dashboard-created profiles can be deleted.
- Improved default pathfinding movement settings to support door opening and parkour over small gaps. Safe movement profile remains conservative for follow/combat/house actions.
- Stored the active goal in navigation state and force a pathfinder re-plan after a prolonged stuck condition for both one-shot navigation and persistent holds. Increased the final stuck threshold to allow one extra recovery window before reporting failure.
- Added regression guards for the missing profile API and pathfinding recovery behavior.
- Validation: `npm test` passes (syntax/config checks and offline self-tests). Live Minecraft navigation still requires testing on the target server; no software can pathfind through unloaded chunks, protected regions, impossible vertical gaps, or server-specific anti-cheat restrictions.
