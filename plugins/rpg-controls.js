/**
 * RPG controls for Minecraft AFK Bot v3.0.0.
 * Commands: .rpg follow <player>, .rpg stop, .rpg grind logs|ores,
 * .rpg stopgrind, .rpg jump on|off, .rpg buildhouse, .rpg drop <item> [amount], .rpg dropall.
 */
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const LOGS = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','crimson_stem','warped_stem'];
const ORES = ['coal_ore','deepslate_coal_ore','iron_ore','deepslate_iron_ore','copper_ore','deepslate_copper_ore'];
const PLANKS = /_planks$/;
module.exports = {
  name: 'rpg-controls', version: '1.0.0',
  init(bot, ctx) {
    const inst = ctx.instance;
    let followName = null, grindMode = null, jumpEnabled = true, stopped = false, busy = false, jumpHeld = false, nextJump = 0;
    // Set RPG_CONTROL_USERS on the host to comma-separated trusted Minecraft usernames.
    const allowedUsers = new Set(String(process.env.RPG_CONTROL_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const log = (m, t='info') => ctx.addLog(m, t);
    const online = () => !stopped && inst.isOnline() && bot.entity && bot.health > 0;
    const items = () => bot.inventory.items();
    const total = (names) => items().filter(i => names.includes(i.name)).reduce((s,i)=>s+i.count,0);
    const say = (m) => { try { ctx.chat(m); } catch {} };
    const stopMove = () => { try { inst.nav.cancel('rpg-controls', 'RPG control stopped'); inst.nav.release('rpg-controls'); bot.setControlState('jump', false); } catch {} };
    const controls = {
      follow(name) { followName = name; grindMode = null; stopMove(); inst.modules.coop?.yieldNavigation(); say(`Following ${name}.`); log(`Dashboard: following ${name}`, 'success'); },
      stop() { followName = null; grindMode = null; stopMove(); say('RPG activity stopped.'); },
      grind(mode) { grindMode = mode; followName = null; inst.modules.coop?.yieldNavigation(); say(`Grinding ${mode}.`); log(`Dashboard: grind ${mode}`, 'success'); },
      stopgrind() { controls.stopgrind(); },
      jump(value) { jumpEnabled = !!value; if (!jumpEnabled) { try { bot.setControlState('jump', false); } catch {} } say(`Auto jump ${jumpEnabled ? 'enabled' : 'disabled'}.`); },
      buildhouse() { void buildHouse(); },
      drop(name, amount) { return dropItem(name, amount); },
      async dropall() { const keep = new Set(['cooked_beef','bread','golden_apple','shield','iron_pickaxe','diamond_pickaxe']); const list = items().filter(i => !keep.has(i.name)).map(i => i.name); for (const name of [...new Set(list)]) await dropItem(name, Infinity); },
      status() { return { status: online() ? 'online' : 'offline', followName, grindMode, jumpEnabled, busy }; },
    };
    ctx.services.rpgControls ||= {};
    ctx.services.rpgControls[inst.id] = controls;

    async function followTick() {
      if (!online() || busy || !followName || inst.activeActivity || inst.combatBusy) return;
      const player = bot.players[followName];
      if (!player?.entity?.position) return;
      const d = bot.entity.position.distanceTo(player.entity.position);
      if (d > 3.5) {
        try { inst.nav.hold('rpg-controls', new goals.GoalFollow(player.entity, 2), true); }
        catch(e) { log(`Follow error: ${e.message}`, 'warn'); }
      } else if (d < 2.2) {
        try { inst.nav.release('rpg-controls'); } catch {}
      }
    }

    async function grindTick() {
      if (!online() || busy || !grindMode || inst.activeActivity || inst.combatBusy || followName) return;
      busy = true;
      try {
        const names = grindMode === 'logs' ? LOGS : ORES;
        if (grindMode === 'logs' && total(LOGS) >= 32) { grindMode = null; say('Grind finished: collected 32 logs.'); return; }
        if (grindMode === 'ores' && total(['coal','raw_iron','raw_copper']) >= 32) { grindMode = null; say('Grind finished: resource target reached.'); return; }
        if (grindMode === 'ores' && !items().some(i => /_pickaxe$/.test(i.name))) { say('Grind stopped: need a pickaxe first.'); grindMode = null; return; }
        const ids = names.map(n => inst.mcData?.blocksByName?.[n]?.id).filter(id => id !== undefined);
        if (!ids.length) return;
        const me = bot.entity.position;
        const positions = bot.findBlocks({matching: ids, maxDistance: 18, count: 30})
          .filter(p => p.y >= Math.floor(me.y)-3 && p.y <= Math.floor(me.y)+8)
          .sort((a,b)=>a.distanceTo(me)-b.distanceTo(me));
        const pos = positions[0];
        if (!pos) return;
        await inst.nav.goto('rpg-grind', new goals.GoalNear(pos.x,pos.y,pos.z,3), { timeoutMs: 15000 });
        if (!online()) return;
        const block = bot.blockAt(pos);
        if (!block || !names.includes(block.name)) return;
        const tool = inst.movements?.bestHarvestTool(block);
        if (tool) await bot.equip(tool,'hand').catch(()=>{});
        await bot.dig(block,true);
        log(`Grind: collected ${block.name}`,'success');
      } catch(e) { log(`Grind error: ${e.message}`,'warn'); }
      finally { inst.nav.release('rpg-grind'); busy = false; }
    }

    async function buildHouse() {
      if (!online() || busy) return say('Bot is busy/offline.');
      const materials = items().filter(i => PLANKS.test(i.name) || i.name === 'cobblestone' || i.name === 'stone_bricks');
      const available = materials.reduce((s,i)=>s+i.count,0);
      if (available < 96) return say(`Need about 96 building blocks for this house; have ${available}. Use .rpg grind logs first (then craft planks manually).`);
      busy = true; followName = null; grindMode = null; stopMove();
      try {
        const origin = bot.entity.position.floored().offset(2,0,2);
        const palette = materials[0].name;
        let placed = 0, skipped = 0;
        const targets = [];
        // 5x5 floor; 3-high walls with a doorway; flat roof.
        for (let x=0;x<5;x++) for(let z=0;z<5;z++) targets.push({x,y:0,z});
        for (let y=1;y<=3;y++) for(let x=0;x<5;x++) for(let z=0;z<5;z++) {
          if (x!==0 && x!==4 && z!==0 && z!==4) continue;
          if (z===0 && x===2 && y<=2) continue;
          targets.push({x,y,z});
        }
        for(let x=0;x<5;x++) for(let z=0;z<5;z++) targets.push({x,y:4,z});
        for (const t of targets) {
          if (!online()) break;
          const target = origin.offset(t.x,t.y,t.z);
          const cur = bot.blockAt(target);
          if (cur && cur.name !== 'air' && !cur.name.endsWith('_air')) { skipped++; continue; }
          const stack = items().find(i => (PLANKS.test(i.name) || i.name==='cobblestone' || i.name==='stone_bricks') && i.count>0);
          if (!stack) { say(`House incomplete: placed ${placed} blocks; materials ran out.`); return; }
          try {
            await inst.goto(target.x,target.y,target.z,2,12000);
            let placedBlock = false;
            for (const d of [new Vec3(0,-1,0),new Vec3(0,1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
              const ref = bot.blockAt(target.plus(d));
              if (ref && ref.boundingBox === 'block') {
                await bot.equip(stack,'hand');
                await bot.placeBlock(ref,d.scaled(-1));
                placed++; placedBlock=true; break;
              }
            }
            if (!placedBlock) skipped++;
          } catch(e) { skipped++; }
        }
        say(`House build finished: ${placed} blocks placed, ${skipped} skipped.`);
        log(`House build finished: ${placed} placed, ${skipped} skipped`, skipped ? 'warn' : 'success');
      } catch(e) { say(`House build error: ${e.message}`); log(`House build error: ${e.message}`,'error'); }
      finally { busy=false; inst.activityDone?.('build'); }
    }

    async function dropItem(name, amount) {
      if (!online()) return say('Bot is offline.');
      const matching = items().filter(i => i.name.toLowerCase() === name.toLowerCase() || (i.displayName||'').toLowerCase() === name.toLowerCase());
      if (!matching.length) return say(`No item found: ${name}`);
      let left = amount === Infinity ? matching.reduce((s,i)=>s+i.count,0) : Math.max(1,Math.floor(amount));
      try {
        for (const stack of matching) {
          if (left <= 0) break;
          const n = Math.min(stack.count,left);
          await bot.toss(stack.type,null,n);
          left -= n;
        }
        say(`Dropped ${amount === Infinity ? 'all matching' : amount-left} ${name}.`);
        log(`Inventory: dropped ${name}`,'success');
      } catch(e) { say(`Drop failed: ${e.message}`); log(`Drop failed: ${e.message}`,'warn'); }
    }

    function command(username, message) {
      if (!message || !message.toLowerCase().startsWith('.rpg ')) return;
      if (username === bot.username) return;
      if (!allowedUsers.has(String(username).toLowerCase())) {
        if (!allowedUsers.size) log('RPG commands locked: set RPG_CONTROL_USERS to trusted player usernames.', 'warn');
        return;
      }
      const args = message.trim().split(/\s+/).slice(1);
      const sub = (args.shift() || '').toLowerCase();
      if (sub === 'follow' && args[0]) {
        controls.follow(args[0]);
      } else if (sub === 'stop') {
        controls.stop();
      } else if (sub === 'grind' && ['logs','ores'].includes((args[0]||'').toLowerCase())) {
        controls.grind(args[0].toLowerCase()); say('Use .rpg stopgrind to stop.');
      } else if (sub === 'stopgrind') { controls.stopgrind(); }
      else if (sub === 'jump' && ['on','off'].includes((args[0]||'').toLowerCase())) { controls.jump(args[0].toLowerCase()==='on'); }
      else if (sub === 'buildhouse') { controls.buildhouse(); }
      else if (sub === 'drop' && args[0]) { const n = args[1] ? Number(args[1]) : Infinity; if (args[1] && (!Number.isFinite(n)||n<1)) return say('Usage: .rpg drop <item_name> [amount]'); void controls.drop(args[0], n); }
      else if (sub === 'dropall') { void controls.dropall(); }
      else if (sub === 'help') say('.rpg follow <player> | stop | grind logs|ores | stopgrind | jump on|off | buildhouse | drop <item_name> [amount] | dropall');
      else say('Unknown RPG command. Use .rpg help');
    }

    ctx.listen(bot, 'chat', command);
    ctx.every(() => {
      if (!online()) return;
      if (jumpEnabled && bot.entity.onGround && Date.now() >= nextJump && !jumpHeld && !busy && ['forward','back','left','right'].some(k=>bot.getControlState?.(k))) {
        nextJump = Date.now()+650; jumpHeld=true;
        try { bot.setControlState('jump',true); } catch {}
        ctx.after(()=>{ try { bot.setControlState('jump',false); } catch {} jumpHeld=false; },120);
      }
      void followTick();
      void grindTick();
    }, 250);
    log('RPG controls loaded: follow, grind, house building, inventory drop, auto-jump', 'success');
    return () => { stopped=true; followName=null; grindMode=null; if (ctx.services.rpgControls?.[inst.id] === controls) delete ctx.services.rpgControls[inst.id]; try { bot.setControlState('jump',false); inst.nav.cancel('rpg-controls', 'plugin stopped'); inst.nav.release('rpg-controls'); inst.nav.release('rpg-grind'); } catch {} };
  }
};
