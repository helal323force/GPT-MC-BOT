# AFK Bot 3.1.0 Upgrade Report

## Changes in this build

- Added authenticated `GET /api/profiles`, `POST /api/profiles`, and `DELETE /api/profiles/:id` endpoints.
- Added the dashboard **Profiles +** control to create, list, and delete dashboard-created accounts. Newly created profiles do not auto-connect; start them explicitly from the dashboard.
- Profiles are stored in the existing SQLite `kv` table and restored at boot. For persistence across redeploys, configure `DATA_DIR` to a persistent volume on your host.
- Added authenticated `GET /api/diagnostics` and a dashboard Diagnostics control to inspect account status, last errors, tasks, reconnect counts, server configuration, enabled modules, and service flags.
- Fixed crop-age fallback in the auto-farmer: if a block does not expose an `age` property, it is no longer incorrectly treated as mature using unrelated block metadata.
- Bumped app/package version to 3.1.0.

## Validation performed

- `node scripts/check.js` — passed (JavaScript syntax + settings checks).
- `node scripts/selftest.js` — passed.
- `node scripts/test-features.js` — 33/33 passed.
- `node scripts/test-nav.js` — 25/25 passed.

These suites use local mocks for some Minecraft behaviors. They do **not** prove that every feature works on a live server. Live connection, Microsoft authentication, Discord/API keys, farming behavior, and actual block placement still need testing in the target server.

## Important notes

- The new profile API is protected by the dashboard's existing authentication middleware.
- Only profiles created through this dashboard can be deleted through the profile API; accounts in `settings.json` are protected.
- The profile type accepts `offline` and `microsoft`. Microsoft authentication uses Mineflayer's device-code flow when started.
- Offline-mode profiles are intended for servers that allow offline usernames. They cannot bypass server authentication or account rules.
- A server may require the shared `auto_auth` configuration for `/login` or `/register` commands.
- SQLite profile persistence depends on `DATA_DIR` being durable on the deployment platform.
- No Minecraft server credentials or API keys were added to this package.
