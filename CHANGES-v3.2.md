# AFK Bot v3.2 upgrade notes

## Preserved
- Existing Minecraft connection/login configuration and the existing account authentication flow were not rewritten.
- Existing dashboard login/session/auth middleware and profile API are retained.
- Existing modules for mining, farming, chopping, fishing, trading, combat, survival, house building, schematics, Discord, backups, AI, and scheduler remain in place.

## New or improved
- Navigation coordinator deduplicates equivalent dynamic goals. This addresses a common follow/pathfinding failure mode where a fresh `GoalFollow` object was being applied on every co-op tick and restarting the path repeatedly.
- Navigation watchdog resets its stuck stage for each new one-shot goal, and existing bounded retry/repath behavior is retained.
- Auto-mine now searches a small number of nearby safe locations when no configured ore is visible, rather than waiting forever at the first spot.
- Advanced activity module adds branch mining with basic hazard checks, nearby dropped-item collection, furnace loading/output collection attempts, protected-item-aware chest storage, nearby exploration, base setup using the existing non-destructive house builder plus interior floor and optional door placement, boss targeting, and bounded base patrol/guard.
- Co-op auto-tasks now include nearby exploration and branch mining; selected friends are excluded from PvP retaliation targeting.
- World memory persists waypoints, explored positions, resource coordinates, and task results in the existing SQLite key-value store. Dashboard can save and navigate to named waypoints and clear memory.
- AI Brain and scheduled/queued tasks can use the new advanced activities.
- Death handler requests respawn recovery only when the same connection is still online and has not already respawned.
- Tool durability manager attempts to switch to a more durable equivalent tool when safe and available.
- Raw `settings.json` backups are created at startup and every six hours, with a manual Dashboard action and a ten-file retention limit. Backups preserve raw `ENV:` placeholders rather than serializing resolved process environment secrets.
- Task completion can emit Discord notifications when the `task` event is enabled.

## Important limitations
- No live Minecraft server was available for this run. Mock/offline tests do not prove all interactions work on a particular server, anti-cheat, protected region, dimension, or plugin setup.
- Branch mining is a bounded horizontal tunnel and stops on recognized hazards/undiggable blocks; it is not a full cave/lava simulator.
- Smelting loads a nearby furnace and makes a bounded attempt to collect output; furnace type, server timing, and Mineflayer protocol behavior may vary.
- Chest storage deposits eligible surplus into the nearest chest/barrel; category-specific multi-chest sorting is not implemented yet.
- Base setup uses the existing validated house builder, then attempts an interior floor and door if a matching door item is available. It deliberately does not excavate or replace terrain to create a separate foundation.
- Boss targeting uses entity-name heuristics and the existing combat module; it is not a scripted strategy for every boss phase.
- Exploration chooses nearby safe-looking targets at roughly the bot's current Y; it cannot guarantee a route through unloaded chunks, cliffs, claims, or server-specific restrictions.
- Profile creation, Microsoft account authentication, login, and server join still depend on valid credentials/configuration and persistent hosting storage.
