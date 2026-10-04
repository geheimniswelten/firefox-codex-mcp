/* global browser */
"use strict";
const el = id => document.getElementById(id);
let selectedPlatform = false, statusRequestId = 0, copyRequestId = 0, checking = false, currentState = null;
const dateText = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("de-DE") : "Noch nicht bestätigt";
function renderDownloads() {
  const platform = el("platform").value;
  const supported = ["win", "linux", "mac"].includes(platform);
  const extension = platform === "win" ? "ps1" : "sh";
  for (const [id, script] of [["registerDownload", "register"], ["unregisterDownload", "unregister"]]) {
    const link = el(id);
    link.setAttribute("aria-disabled", supported ? "false" : "true");
    if (supported) {
      link.href = browser.runtime.getURL(`setup/${script}.${extension}`);
      link.download = `${script}.${extension}`;
    } else { link.removeAttribute("href"); link.removeAttribute("download"); }
  }
  el("registerDownload").textContent = currentState?.setup?.status === "update_required" ? "Aktualisierungsskript speichern" : "Registrierungsskript speichern";
  el("commandInstructions").hidden = !supported;
  el("commandIntro").textContent = platform === "win"
    ? "Öffne PowerShell im Ordner der gespeicherten Skripte."
    : "Öffne ein Terminal im Ordner der gespeicherten Skripte.";
  for (const [id, script] of [["registerCommand", "register"], ["unregisterCommand", "unregister"]]) {
    const command = !supported ? "" : platform === "win"
      ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\" + script + ".ps1"
      : "sh " + script + ".sh";
    // Keep an existing selection intact during the regular status refresh.
    if (el(id).value !== command) {
      el(id).value = command;
      copyRequestId++;
      el("copyStatus").textContent = "";
    }
  }
  el("windowsInstructions").hidden = platform !== "win";
  el("platformNote").textContent = platform === "win"
    ? "Windows: PowerShell-Skript ausführen. Fehlendes Node.js kann das Registrierungsskript automatisch beziehen."
    : supported ? `${platform === "mac" ? "macOS" : "Linux"}: Node.js 22 oder neuer und npm müssen verfügbar sein. Führe das gespeicherte Skript im Terminal mit sh register.sh aus.`
      : "Wähle das Betriebssystem, auf dem Firefox und der lokale Server laufen.";
}
async function copyCommand(id, label) {
  const field = el(id), command = field.value;
  if (!command) return;
  const requestId = ++copyRequestId;
  try {
    await navigator.clipboard.writeText(command);
    if (requestId === copyRequestId) el("copyStatus").textContent = label + " kopiert.";
  } catch {
    if (requestId !== copyRequestId) return;
    field.focus();
    field.select();
    el("copyStatus").textContent = "Automatisches Kopieren ist nicht verfügbar. Der Befehl ist markiert: mit Strg+C (macOS: ⌘C) kopieren.";
  }
}
function render(state) {
  currentState = state;
  const setup = state.setup || {}, registration = setup.registration;
  el("statusTitle").textContent = setup.label || "Registrierung noch nicht bestätigt";
  el("statusDescription").textContent = setup.description || "Verbinde die Erweiterung erneut, um die Einrichtung zu prüfen.";
  el("connection").textContent = !state.settings?.enabled ? "MCP ist deaktiviert. Aktiviere es über das Erweiterungsmenü in der Symbolleiste." : state.connected ? "Native-Messaging-Verbindung hergestellt." : state.connecting ? "Native-Messaging-Verbindung wird aufgebaut …" : "Native-Messaging-Verbindung derzeit nicht verfügbar.";
  el("addonVersion").textContent = state.version;
  el("hostVersion").textContent = setup.hostVersion || "Noch nicht bestätigt";
  el("requiredRevision").textContent = String(setup.requiredRevision ?? 1);
  el("currentRevision").textContent = registration ? String(registration.registrationRevision) : "Noch nicht bestätigt";
  el("installerVersion").textContent = registration?.installerVersion || "Noch nicht bestätigt";
  el("registeredAt").textContent = registration ? dateText(registration.registeredAt) : "Noch nicht bestätigt";
  const previous = setup.lastConfirmation;
  el("lastConfirmed").textContent = previous ? `${dateText(previous.verifiedAt)} · Revision ${previous.registration.registrationRevision} · Skript ${previous.registration.installerVersion} · Server ${previous.hostVersion}` : "Noch keine bestätigte Prüfung";
  el("manifestPath").textContent = registration?.manifestPath || "Noch nicht bestätigt";
  el("checkSetup").disabled = checking || !state.settings?.enabled;
  el("error").hidden = !state.lastError;
  el("error").textContent = state.lastError || "";
  if (!selectedPlatform && ["win", "linux", "mac"].includes(setup.platform)) el("platform").value = setup.platform;
  renderDownloads();
}
async function request(type = "bridge_status") {
  const id = ++statusRequestId;
  try {
    const state = await browser.runtime.sendMessage({ type });
    if (id === statusRequestId) render(state);
  } catch (error) {
    if (id === statusRequestId) { el("error").hidden = false; el("error").textContent = String(error.message || error); }
  }
}
el("platform").addEventListener("change", () => { selectedPlatform = true; renderDownloads(); });
el("copyRegisterCommand").addEventListener("click", () => copyCommand("registerCommand", "Registrierungsbefehl"));
el("copyUnregisterCommand").addEventListener("click", () => copyCommand("unregisterCommand", "Deregistrierungsbefehl"));
el("checkSetup").addEventListener("click", async () => {
  if (checking) return;
  checking = true; el("checkSetup").disabled = true;
  try { await request("bridge_reconnect"); }
  finally { checking = false; await request(); }
});
function statusChanged(message) { if (message?.type === "bridge_status_changed") request(); }
browser.runtime.onMessage.addListener(statusChanged);
request(); renderDownloads();
const refresh = setInterval(() => request(), 1500);
window.addEventListener("unload", () => { clearInterval(refresh); browser.runtime.onMessage.removeListener(statusChanged); });
