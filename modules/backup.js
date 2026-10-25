/**
 * modules/backup.js - periodic state snapshots + position restore.
 * Config: backup { enabled, interval_min (5), keep (200), try_tp (false) }, restore_position (false)
 * Saves {position, health, food, inventory, xp} to SQLite. On spawn, if restore_position is on and the
 * bot is >20 blocks from the last backup it tries /tp (when backup.try_tp) and otherwise walks back.
 * Inventory cannot be re-created by a client; it is stored for reference/audit only.
 */
const database = require("../core/database");

function create(inst) {
  const bot = inst.bot;

  function save() {
    if (!inst.isOnline()) return null;
    const p = bot.entity.position;
    const inv = bot.inventory.items().map((i) => ({ name: i.name, count: i.count, slot: i.slot }));
    const r = database.run("INSERT INTO backups(account,ts,x,y,z,dimension,health,food,inventory_json,experience) VALUES(?,?,?,?,?,?,?,?,?,?)",
      inst.id, Date.now(), p.x, p.y, p.z, bot.game?.dimension || null, bot.health, bot.food, JSON.stringify(inv), bot.experience?.points ?? 0);
    const keep = inst.config.backup?.keep || 200;
    database.run("DELETE FROM backups WHERE account=? AND id NOT IN (SELECT id FROM backups WHERE account=? ORDER BY ts DESC LIMIT ?)", inst.id, inst.id, keep);
    return r.lastInsertRowid;
  }

  async function restore(row) {
    if (!inst.isOnline()) throw new Error("Bot is not online");
    const d0 = Math.hypot(bot.entity.position.x - row.x, bot.entity.position.y - row.y, bot.entity.position.z - row.z);
    if (d0 <= 5) return { method: "none", distance: d0 };
    if (inst.config.backup?.try_tp) {
      inst.runCommand(`/tp ${bot.username} ${row.x.toFixed(1)} ${row.y.toFixed(1)} ${row.z.toFixed(1)}`);
      await inst.sleep(3000);
      const d1 = Math.hypot(bot.entity.position.x - row.x, bot.entity.position.y - row.y, bot.entity.position.z - row.z);
      if (d1 <= 5) return { method: "tp", distance: d1 };
    }
    if (d0 > 600) throw new Error(`Too far to walk (${Math.round(d0)} blocks); enable backup.try_tp with OP`);
    inst.runActivity("move", { x: row.x, y: row.y, z: row.z });
    return { method: "walk", distance: d0 };
  }

  return {
    save, restore,
    init() {
      const interval = Math.max(1, inst.config.backup?.interval_min || 5) * 60000;
      const last = database.get("SELECT * FROM backups WHERE account=? ORDER BY ts DESC LIMIT 1", inst.id);
      if (last && inst.config.restore_position) {
        inst.after(() => {
          if (!inst.isOnline()) return;
          const d = Math.hypot(bot.entity.position.x - last.x, bot.entity.position.z - last.z);
          if (d > 20 && (!last.dimension || last.dimension === bot.game?.dimension)) {
            inst.addLog(`Restoring position (${Math.round(d)} blocks from last backup)`, "control");
            restore(last).catch((e) => inst.addLog(`Restore failed: ${e.message}`, "warn"));
          }
        }, 6000);
      }
      inst.after(save, 15000);
      inst.every(save, interval);
    },
    stop() {},
  };
}
module.exports = { create };
