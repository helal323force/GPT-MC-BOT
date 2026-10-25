/* Lightweight account profile manager; all changes go through authenticated API routes. */
(() => {
  const btn = document.getElementById("profileBtn");
  const diagBtn = document.getElementById("diagnosticsBtn");
  if ((!btn && !diagBtn) || !window.Bot) return;
  const Bot = window.Bot;
  diagBtn?.addEventListener("click", async () => {
    try {
      const d = await Bot.api("/api/diagnostics");
      const lines = [`Server: ${d.server.host}:${d.server.port} (MC ${d.server.version})`, `Enabled modules: ${d.enabledModules.join(", ") || "none detected"}`, `AI: ${d.services.ai ? "enabled" : "disabled"}`, "", ...d.instances.map(i => `${i.id} (${i.username}): ${i.status}; task=${i.task}; reconnects=${i.reconnects}${i.lastError ? "\n  Last error: " + i.lastError : ""}`)];
      alert(lines.join("\n"));
    } catch (e) { Bot.toast(e.message || "Diagnostics failed", "error"); }
  });
  btn?.addEventListener("click", async () => {
    const action = prompt("Profiles: CREATE, LIST, EDIT, or DELETE a dashboard-created profile.", "CREATE");
    if (!action) return;
    try {
      if (action.trim().toUpperCase() === "CREATE") {
        const username = prompt("Minecraft username (3-16 characters):"); if (!username) return;
        const type = (prompt("Account type: OFFLINE or MICROSOFT", "OFFLINE") || "offline").trim().toLowerCase();
        const result = await Bot.api("/api/profiles", "POST", { username, type });
        Bot.toast(`Profile ${result.profile.id} created. Start it when ready.`, "success");
        Bot._emit("instances", await Bot.api("/api/instances"));
      } else if (action.trim().toUpperCase() === "LIST") {
        const data = await Bot.api("/api/profiles"); alert(data.profiles.length ? data.profiles.map(p => `${p.id} — ${p.username} (${p.type})`).join("\n") : "No dashboard-created profiles yet.");
      } else if (action.trim().toUpperCase() === "EDIT") {
        const data = await Bot.api("/api/profiles");
        if (!data.profiles.length) return alert("No dashboard-created profiles yet.");
        const id = prompt("Profile ID to edit:\n" + data.profiles.map(p => `${p.id} — ${p.username} (${p.type}, autoStart=${p.autoStart})`).join("\n")); if (!id) return;
        const profile = data.profiles.find(p => p.id === id.trim()); if (!profile) return Bot.toast("Profile ID not found.", "error");
        const type = (prompt("Account type: OFFLINE or MICROSOFT", profile.type || "offline") || profile.type).trim().toLowerCase();
        const autoStart = (prompt("Auto-start at server boot? YES or NO", profile.autoStart ? "YES" : "NO") || (profile.autoStart ? "YES" : "NO")).trim().toLowerCase() === "yes";
        await Bot.api(`/api/profiles/${encodeURIComponent(id.trim())}`, "PUT", { type, autoStart });
        Bot.toast(`Profile ${id} updated.`, "success");
      } else if (action.trim().toUpperCase() === "DELETE") {
        const id = prompt("Enter the profile ID to delete (only profiles created here can be deleted):"); if (!id) return;
        if (!confirm(`Delete profile ${id}? This cannot be undone.`)) return;
        await Bot.api(`/api/profiles/${encodeURIComponent(id)}`, "DELETE");
        if (Bot.account === id) Bot.account = null;
        Bot._emit("instances", await Bot.api("/api/instances")); Bot.toast(`Profile ${id} deleted.`, "success");
      } else Bot.toast("Choose CREATE, LIST, or DELETE.", "error");
    } catch (e) { Bot.toast(e.message || "Profile operation failed", "error"); }
  });
})();
