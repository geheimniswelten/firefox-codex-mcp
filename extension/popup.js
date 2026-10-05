/* global browser */
"use strict";
let settings = null, updating = false;
let permissionsUpdating = false, permissionGranted = false, permissionRefreshId = 0;
let pendingApproval = null, approvalSubmitting = false, statusRequestId = 0;
const el = id => document.getElementById(id);
function setText(id, value) {
  const element = el(id), text = String(value ?? "");
  // Replacing an unchanged text node clears a user's selection on each poll.
  if (element.textContent !== text) element.textContent = text;
}
const inventoryPermission = { data_collection: ["technicalAndInteraction"] };
function renderApproval(approval) {
  const changed = pendingApproval?.id !== approval?.id;
  pendingApproval = approval || null;
  el("approval").hidden = !pendingApproval;
  el("settingsPanel").hidden = !!pendingApproval;
  if (!pendingApproval) {
    el("approvalAllow").disabled = true;
    el("approvalDeny").disabled = true;
    return;
  }
  setText("approvalTitle", approval.title || "Ohne Titel");
  setText("approvalUrl", approval.url);
  const scope = approval.scope === "tab" ? "diesen Tab mit genau der oben angegebenen URL" : approval.scope === "active" ? "jeweils den aktiven Tab im zuletzt aktiven Firefox-Fenster" : "alle Tabs";
  let description = approval.mode === "ask-session"
    ? `Für ${scope} freigeben: bis zu 12 Stunden ab Freigabe, spätestens bis Firefox neu startet. Diese Frist verlängert sich nicht durch Zugriffe.`
    : approval.mode === "ask-five-days"
      ? `Für ${scope} freigeben: für 5 Tage (120 Stunden) ab Zustimmung, auch nach einem Firefox- oder Erweiterungsneustart. Diese Frist verlängert sich nicht durch Zugriffe. Nach Ablauf wird erneut gefragt.`
      : `Nur diese Anfrage für ${scope} freigeben. Bei der nächsten Inhaltsanfrage wird erneut gefragt.`;
  if (approval.scope === "tab") description += " Andere Tabs und andere URLs benötigen eine eigene Freigabe.";
  if (approval.scope === "tab" && approval.mode === "ask-five-days") description += " Die Freigabe bleibt an diesen Firefox-Tab gebunden. Navigation, Neuladen, Entladen oder Schließen widerruft sie.";
  setText("approvalDescription", description);
  const expired = !Number.isFinite(approval.expiresAt) || Date.now() >= approval.expiresAt;
  el("approvalAllow").disabled = approvalSubmitting || expired;
  el("approvalDeny").disabled = approvalSubmitting || expired;
  if (changed) {
    el("approvalError").hidden = true;
    el("approvalDeny").focus();
  }
}
async function answerApproval(allowed) {
  if (!pendingApproval || approvalSubmitting) return;
  if (!Number.isFinite(pendingApproval.expiresAt) || Date.now() >= pendingApproval.expiresAt) { renderApproval(pendingApproval); return; }
  const id = pendingApproval.id;
  approvalSubmitting = true;
  renderApproval(pendingApproval);
  try {
    const result = await browser.runtime.sendMessage({ type: "approval_answer", id, allowed });
    if (!result?.ok) throw new Error("Diese Freigabe ist abgelaufen. Bitte die Inhaltsanfrage erneut stellen.");
  } catch (error) {
    if (pendingApproval?.id === id) {
      el("approvalError").hidden = false;
      setText("approvalError", String(error.message || error));
    }
  } finally {
    approvalSubmitting = false;
    await request({ type: "bridge_status" });
  }
}
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
    setText("inventoryError", String(error.message || error));
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
    setText("inventoryError", String(error.message || error));
  } finally {
    el("inventoryPermission").checked = permissionGranted;
    permissionsUpdating = false;
    await refreshPermissions();
    el("inventoryPermission").disabled = false;
  }
}
function render(state) {
  renderApproval(state.pendingApproval);
  if (updating) return;
  settings = state.settings;
  setText("status", state.icon.label);
  el("dot").className = `dot ${state.icon.color}`;
  setText("detail", !settings.enabled ? "Der Native Host ist getrennt; Codex hat keinen Zugriff." : state.connected && state.setup?.protocolVersion && state.setup.protocolVersion !== state.setup.requiredProtocol ? "Der Native Host ist verbunden, benötigt aber eine passende Protokollversion für den Zugriff." : state.connected ? "Fenster- und Tabsteuerung ist verfügbar." : state.connecting ? "Verbindung zum Native Host wird aufgebaut …" : "Die Verbindung zum lokalen Native Host ist derzeit nicht verfügbar.");
  setText("setupNotice", state.setup?.label || "Einrichtung und Registrierung prüfen.");
  setText("openSetup", state.setup?.actionLabel || "Einrichtung");
  setText("lastAccess", state.lastAccessAt ? `Letzter MCP-Zugriff: ${new Date(state.lastAccessAt).toLocaleString("de-DE")}` : "Noch kein MCP-Zugriff.");
  setText("toggle", settings.enabled ? "MCP deaktivieren" : "MCP aktivieren");
  el("reconnect").disabled = !settings.enabled;
  el("contentMode").value = settings.contentMode;
  el("contentScope").value = settings.contentScope;
  const fiveDays = settings.contentMode === "ask-five-days";
  const expiresAt = fiveDays ? state.fiveDayExpiresAt : state.sessionExpiresAt;
  setText("session", ["ask-session", "ask-five-days"].includes(settings.contentMode)
    ? Number.isFinite(expiresAt) && expiresAt > Date.now()
      ? `${fiveDays ? "5-Tage-Freigabe" : "Sitzungsfreigabe"} bis ${new Date(expiresAt).toLocaleString("de-DE")}.`
      : fiveDays ? "Noch keine aktive 5-Tage-Freigabe. Bei der nächsten Inhaltsanfrage wird gefragt." : "Noch keine aktive Sitzungsfreigabe."
    : "");
  el("error").hidden = !state.lastError;
  setText("error", state.lastError || "");
  setText("version", state.version);
}
async function request(message) {
  const requestId = ++statusRequestId;
  try {
    const state = await browser.runtime.sendMessage(message);
    if (requestId === statusRequestId) render(state);
  } catch (error) {
    if (requestId === statusRequestId) { el("error").hidden = false; setText("error", String(error.message || error)); }
  }
}
async function save(change) {
  if (!settings || updating) return;
  updating = true; statusRequestId += 1;
  for (const id of ["toggle", "contentMode", "contentScope"]) el(id).disabled = true;
  try {
    const state = await browser.runtime.sendMessage({ type: "bridge_settings", settings: { ...settings, ...change } });
    statusRequestId += 1; updating = false; render(state);
  } catch (error) { el("error").hidden = false; setText("error", String(error.message || error)); }
  finally {
    updating = false;
    await request({ type: "bridge_status" });
    for (const id of ["toggle", "contentMode", "contentScope"]) el(id).disabled = false;
  }
}
el("toggle").addEventListener("click", () => save({ enabled: !settings.enabled }));
el("contentMode").addEventListener("change", event => save({ contentMode: event.target.value }));
el("contentScope").addEventListener("change", event => save({ contentScope: event.target.value }));
el("reconnect").addEventListener("click", () => request({ type: "bridge_reconnect" }));
el("openSetup").addEventListener("click", async () => {
  try { await browser.runtime.openOptionsPage(); }
  catch (error) { el("error").hidden = false; setText("error", String(error.message || error)); }
});
el("resetApprovals").addEventListener("click", () => request({ type: "bridge_reset_approvals" }));
el("inventoryPermission").addEventListener("click", changeInventoryPermission);
el("approvalDeny").addEventListener("click", () => answerApproval(false));
el("approvalAllow").addEventListener("click", () => answerApproval(true));
function statusChanged(message) {
  if (message?.type === "bridge_status_changed") request({ type: "bridge_status" });
}
browser.runtime.onMessage.addListener(statusChanged);
browser.permissions.onAdded.addListener(refreshPermissions);
browser.permissions.onRemoved.addListener(refreshPermissions);
request({ type: "bridge_status" });
refreshPermissions();
const refresh = setInterval(() => { request({ type: "bridge_status" }); refreshPermissions(); }, 1500);
window.addEventListener("unload", () => {
  clearInterval(refresh);
  browser.runtime.onMessage.removeListener(statusChanged);
  browser.permissions.onAdded.removeListener(refreshPermissions);
  browser.permissions.onRemoved.removeListener(refreshPermissions);
});
