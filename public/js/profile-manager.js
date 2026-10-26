/* Profile manager for dashboard-created Minecraft bots.
 * Uses existing authenticated /api/profiles endpoints.
 * Java connection settings are supported by the current Mineflayer engine.
 * Bedrock is intentionally not offered here until a Bedrock protocol adapter is installed.
 */
(() => {
  const btn = document.getElementById("profileBtn");
  const diagBtn = document.getElementById("diagnosticsBtn");
  if ((!btn && !diagBtn) || !window.Bot) return;
  const Bot = window.Bot;

  const ask = (label, value = "") => {
    const v = prompt(label, value);
    return v === null ? null : v.trim();
  };
  const yes = (v) => ["yes", "y", "true", "1"].includes(String(v).toLowerCase());
  const getProfiles = async () => (await Bot.api("/api/profiles")).profiles || [];
  const describe = (p) =>
    `${p.id} — ${p.username} — ${p.host || "(server not set)"}:${p.port || 25565} — ${p.type}`;

  function readProfile(p = {}) {
    const username = ask("Minecraft username (3–16 letters/numbers/_):", p.username || "");
    if (username === null || !username) return null;

    const host = ask("Java server IP/host:", p.host || "");
    if (host === null || !host) return null;

    const portText = ask("Server port:", String(p.port || 25565));
    if (portText === null) return null;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be between 1 and 65535.");
    }

    const type = (ask("Authentication: OFFLINE or MICROSOFT", p.type || "offline") || p.type || "offline").toLowerCase();
    if (!["offline", "microsoft"].includes(type)) {
      throw new Error("Choose OFFLINE or MICROSOFT.");
    }

    const version = ask("Java Minecraft version (blank = auto-detect):", p.version || "");
    if (version === null) return null;

    const autoStart = yes(ask("Auto-start when service starts? YES/NO", p.autoStart ? "YES" : "NO") || "no");
    const oldAutoAuth = p.autoAuth || {};
    const autoAuthEnabled = yes(ask("Enable server /register and /login auto-auth? YES/NO", oldAutoAuth.enabled ? "YES" : "NO") || "no");

    let autoAuthPassword = "";
    let registerCommand = oldAutoAuth.registerCommand || oldAutoAuth.register_command || "/register {password} {password}";
    let loginCommand = oldAutoAuth.loginCommand || oldAutoAuth.login_command || "/login {password}";

    if (autoAuthEnabled) {
      autoAuthPassword = ask("Server auth password (leave blank to keep existing password):", "");
      if (autoAuthPassword === null) return null;
      registerCommand = ask("Register command template (use {password}):", registerCommand);
      if (registerCommand === null) return null;
      loginCommand = ask("Login command template (use {password}):", loginCommand);
      if (loginCommand === null) return null;
      if (!autoAuthPassword && !oldAutoAuth.password && !p.password) {
        throw new Error("Auto-auth needs a password.");
      }
    }

    return {
      username, host, port, type, version, autoStart,
      autoAuthEnabled,
      autoAuthPassword,
      registerCommand,
      loginCommand
    };
  }

  async function syncInstances() {
    Bot._emit("instances", await Bot.api("/api/instances"));
  }

  diagBtn?.addEventListener("click", async () => {
    try {
      const d = await Bot.api("/api/diagnostics");
      const lines = [
        `Default server: ${d.server.host}:${d.server.port} (MC ${d.server.version})`,
        `Enabled modules: ${d.enabledModules.join(", ") || "none detected"}`,
        `AI: ${d.services.ai ? "enabled" : "disabled"}`,
        "",
        ...d.instances.map(i =>
          `${i.id} (${i.username}): ${i.status}; task=${i.task}; reconnects=${i.reconnects}${i.lastError ? "\n  Last error: " + i.lastError : ""}`
        )
      ];
      alert(lines.join("\n"));
    } catch (e) {
      Bot.toast(e.message || "Diagnostics failed", "error");
    }
  });

  btn?.addEventListener("click", async () => {
    const action = ask("Profile manager: CREATE, LIST, EDIT, DELETE, START, or STOP", "CREATE");
    if (!action) return;

    try {
      const mode = action.toUpperCase();

      if (mode === "CREATE") {
        const p = readProfile();
        if (!p) return;
        const result = await Bot.api("/api/profiles", "POST", p);
        Bot.toast(`Profile ${result.profile.id} created. Use START to connect.`, "success");
        await syncInstances();
        return;
      }

      const profiles = await getProfiles();
      if (mode === "LIST") {
        alert(profiles.length ? profiles.map(describe).join("\n") : "No dashboard-created profiles yet.");
        return;
      }

      if (!["EDIT", "DELETE", "START", "STOP"].includes(mode)) {
        throw new Error("Choose CREATE, LIST, EDIT, DELETE, START, or STOP.");
      }
      if (!profiles.length) {
        alert("No dashboard-created profiles yet.");
        return;
      }

      const id = ask("Enter exact profile ID:\n" + profiles.map(describe).join("\n"));
      if (!id) return;
      const profile = profiles.find(p => p.id === id);
      if (!profile) throw new Error("Profile ID not found.");

      if (mode === "EDIT") {
        const next = readProfile(profile);
        if (!next) return;
        await Bot.api(`/api/profiles/${encodeURIComponent(id)}`, "PUT", next);
        Bot.toast(`Profile ${id} updated.`, "success");
        await syncInstances();
      } else if (mode === "DELETE") {
        if (!confirm(`Delete profile ${id}? Its bot will be stopped. This cannot be undone.`)) return;
        await Bot.api(`/api/profiles/${encodeURIComponent(id)}`, "DELETE");
        if (Bot.account === id) Bot.account = null;
        await syncInstances();
        Bot.toast(`Profile ${id} deleted.`, "success");
      } else {
        await Bot.api(mode === "START" ? "/api/start" : "/api/stop", "POST", { account: id });
        Bot.toast(`Profile ${id}: ${mode.toLowerCase()} requested.`, "success");
      }
    } catch (e) {
      Bot.toast(e.message || "Profile operation failed", "error");
    }
  });
})();
