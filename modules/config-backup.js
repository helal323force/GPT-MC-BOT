/** Back up the raw settings file (ENV placeholders remain placeholders; resolved secrets are not serialized). */
const fs = require('fs');
const path = require('path');
const { SETTINGS_PATH, DATA_DIR } = require('../core/config');

function create() {
  const dir = path.join(DATA_DIR, 'config-backups');
  const keep = 10;
  function list() {
    fs.mkdirSync(dir, { recursive: true });
    return fs.readdirSync(dir).filter(n => /^settings-\d{8}T\d{6}Z(?:-\d{1,3})?\.json$/.test(n)).sort().reverse().map(name => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtimeMs };
    });
  }
  function backup() {
    if (!fs.existsSync(SETTINGS_PATH)) throw new Error(`Settings file not found: ${SETTINGS_PATH}`);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    let name = `settings-${stamp}.json`;
    if (fs.existsSync(path.join(dir, name))) name = `settings-${stamp}-${Date.now() % 1000}.json`;
    const dest = path.join(dir, name);
    fs.copyFileSync(SETTINGS_PATH, dest, fs.constants.COPYFILE_EXCL);
    // Verify JSON before reporting the backup as usable.
    JSON.parse(fs.readFileSync(dest, 'utf8'));
    for (const old of list().slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
    return { name, size: fs.statSync(dest).size, createdAt: fs.statSync(dest).mtimeMs };
  }
  return { backup, list };
}
module.exports = { create };
