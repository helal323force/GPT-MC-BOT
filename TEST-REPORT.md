# AFK Bot v3.2 automated test report

## Test commands
- `npm test` — PASS
- `node --check` on all JavaScript files — PASS (part of `npm test`)
- `node scripts/selftest.js` — PASS
- `node scripts/test-nav.js` — 26/26 PASS
- `node scripts/test-features.js` — 33/33 PASS
- Settings JSON and static integration guards — PASS

## Regression fixes covered
- Profile API routes remain present.
- Pathfinding recovery still retries and reports genuine stuck failures honestly.
- Equivalent dynamic follow goals are not re-applied on every tick.
- New advanced activity routes, task queue names, AI actions, world memory, config backup, and co-op automation are wired in source.
- Dashboard automation endpoints are registered before the API catch-all.

## Not verified
- No live Minecraft server was connected for this test. Actual server join/login, block placement, furnace timing, chest deposits, boss combat, auto-respawn, anti-cheat, claim protection, and full friend co-op require testing in the target server.
- Tests use mocks for navigation and feature logic. They are not proof that every feature works perfectly in every world.

## Deployment
1. Keep a copy of the previous ZIP and your `settings.json` / environment variables.
2. Use persistent `DATA_DIR` storage for profiles, task queues, world memory, and config backups.
3. Deploy the ZIP and check Dashboard > Automation, Profile Manager, and the bot logs.
4. First test with a disposable world or safe area. Verify navigation, friend selection, branch mining, furnace loading, chest storage, and base setup separately before enabling long-running automation.
