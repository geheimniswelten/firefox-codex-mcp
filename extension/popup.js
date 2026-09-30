/* global browser */
"use strict";
let settings = null, updating = false;
let permissionsUpdating = false, permissionGranted = false, permissionRefreshId = 0;
const el = id => document.getElementById(id);
const inventoryPermission = { data_collection: ["technicalAndInteraction"] };
async function refreshPermissions() {
  if (permissionsUpdating) return;
  const requestId = ++permissionRefreshId;
  try {
    const permissions = await browser.permissions.getAll();
    if (permissionsUpdating || requestId !== permissionRefreshId) return;
    permissionGranted = permissions.data_collection?.includes("technicalAndInteraction") === true;
    el("inventoryPermission").checked = permissionGranted;
    el("inventoryPermission").disabled = false;
  } catch (error) {
    if (requestId !== permissionRefreshId || permissionsUpdating) return;
    el("inventoryError").hidden = false;
    el("inventoryError").textContent = String(error.message || error);
  }
}
async function changeInventoryPermission() {
  if (permissionsUpdating) { el("inventoryPermission").checked = permissionGranted; return; }
  const wanted = el("inventoryPermission").checked;
  permissionsUpdating = true; permissionRefreshId += 1;
  el("inventoryPermission").disabled = true;
  el("inventoryError").hidden = true;
  try {
    // Invoke directly in the click handler, before its first await. Firefox
    // requires a user gesture to request optional data-collection consent.
    await (wanted ? browser.permissions.request(inventoryPermission) : browser.permissions.remove(inventoryPermission));
  } catch (error) {
    el("inventoryError").hidden = false;
    el("inventoryError").textContent = String(error.message || error);
  } finally {
    el("inventoryPermission").checked = permissionGranted;
    permissionsUpdating = false;
    await refreshPermissions();
    el("inventoryPermission").disabled = false;
  }
}
function render(state) {
  if (updating) return;
  settings = state.settings;
  el("status").textContent = state.icon.label;
  el("dot").className = `dot ${state.icon.color}`;
  el("detail").textContent = !settings.enabled ? "Der Native Host ist getrennt; Codex hat keinen Zugriff." : state.connected ? "Fenster- und Tabsteuerung ist verfügbar." : state.connecting ? "Verbindung zum Native Host wird aufgebaut …" : "Der lokale Native Host muss installiert sein.";
  el("lastAccess").textContent = state.lastAccessAt ? `Letzter MCP-Zugriff: ${new Date(state.lastAccessAt).toLocaleString("de-DE")}` : "Noch kein MCP-Zugriff.";
  el("toggle").textContent = settings.enabled ? "MCP deaktivieren" : "MCP aktivieren";
  el("reconnect").disabled = !settings.enabled;
  el("contentMode").value = settings.contentMode;
  el("contentScope").value = settings.contentScope;
  el("session").textContent = state.sessionExpiresAt && state.sessionExpiresAt > Date.now() ? `Sitzungsfreigabe bis ${new Date(state.sessionExpiresAt).toLocaleString("de-DE")}.` : settings.contentMode === "ask-session" ? "Noch keine aktive Sitzungsfreigabe." : "";
  el("error").hidden = !state.lastError;
  el("error").textContent = state.lastError || "";
  el("version").textContent = state.version;
}
async function request(message) {
  try { render(await browser.runtime.sendMessage(message)); }
  catch (error) { el("error").hidden = false; el("error").textContent = String(error.message || error); }
}
async function save(change) {
  if (!settings || updating) return;
  updating = true;
  for (const id of ["toggle", "contentMode", "contentScope"]) el(id).disabled = true;
  try {
    const state = await browser.runtime.sendMessage({ type: "bridge_settings", settings: { ...settings, ...change } });
    updating = false; render(state);
  } catch (error) { el("error").hidden = false; el("error").textContent = String(error.message || error); }
  finally { updating = false; for (const id of ["toggle", "contentMode", "contentScope"]) el(id).disabled = false; }
}
el("toggle").addEventListener("click", () => save({ enabled: !settings.enabled }));
el("contentMode").addEventListener("change", event => save({ contentMode: event.target.value }));
el("contentScope").addEventListener("change", event => save({ contentScope: event.target.value }));
el("reconnect").addEventListener("click", () => request({ type: "bridge_reconnect" }));
el("inventoryPermission").addEventListener("click", changeInventoryPermission);
browser.permissions.onAdded.addListener(refreshPermissions);
browser.permissions.onRemoved.addListener(refreshPermissions);
request({ type: "bridge_status" });
refreshPermissions();
const refresh = setInterval(() => { request({ type: "bridge_status" }); refreshPermissions(); }, 1500);
window.addEventListener("unload", () => {
  clearInterval(refresh);
  browser.permissions.onAdded.removeListener(refreshPermissions);
  browser.permissions.onRemoved.removeListener(refreshPermissions);
});
