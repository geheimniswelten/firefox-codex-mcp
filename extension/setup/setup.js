/* global browser */
"use strict";
const el = id => document.getElementById(id);
function setText(id, value) {
  const element = el(id), text = String(value ?? "");
  // An unchanged text node keeps the user's selection across status refreshes.
  if (element.textContent !== text) element.textContent = text;
}
let selectedPlatform = false, statusRequestId = 0, copyRequestId = 0, checking = false, downloading = false, currentState = null;
const dateText = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("de-DE") : "Noch nicht bestätigt";
function renderDownloads() {
  const platform = el("platform").value;
  const supported = ["win", "linux", "mac"].includes(platform);
  for (const id of ["registerDownload", "unregisterDownload"]) {
    const button = el(id);
    button.disabled = !supported || downloading;
    button.setAttribute("aria-disabled", String(button.disabled));
  }
  setText("registerDownload", currentState?.setup?.status === "update_required" ? "Aktualisierungsskript speichern" : "Registrierungsskript speichern");
  el("commandInstructions").hidden = !supported;
  setText("commandIntro", platform === "win"
    ? "Öffne PowerShell im Ordner der gespeicherten Skripte."
    : "Öffne ein Terminal im Ordner der gespeicherten Skripte.");
  for (const [id, script] of [["registerCommand", "register"], ["unregisterCommand", "unregister"]]) {
    const command = !supported ? "" : platform === "win"
      ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\" + script + ".ps1"
      : "sh " + script + ".sh";
    // Keep an existing selection intact during the regular status refresh.
    if (el(id).value !== command) {
      el(id).value = command;
      copyRequestId++;
      setText("copyStatus", "");
    }
  }
  el("windowsInstructions").hidden = platform !== "win";
  setText("platformNote", platform === "win"
    ? "Windows: PowerShell-Skript ausführen. Fehlendes Node.js kann das Registrierungsskript automatisch beziehen."
    : supported ? `${platform === "mac" ? "macOS" : "Linux"}: Node.js 22 oder neuer und npm müssen verfügbar sein. Führe das gespeicherte Skript im Terminal mit sh register.sh aus.`
      : "Wähle das Betriebssystem, auf dem Firefox und der lokale Server laufen.");
}
async function downloadScript(script) {
  const platform = el("platform").value;
  if (downloading || !["win", "linux", "mac"].includes(platform)) return;
  const filename = `${script}.${platform === "win" ? "ps1" : "sh"}`;
  const status = el("downloadStatus");
  downloading = true;
  renderDownloads();
  status.className = "note";
  setText("downloadStatus", `Speicherdialog für ${filename} wird geöffnet …`);
  try {
    // Firefox does not reliably honor an anchor's download attribute for
    // moz-extension URLs. Use its download API for packaged, offline scripts.
    await browser.downloads.download({ url: browser.runtime.getURL(`setup/${filename}`), filename, saveAs: true });
    setText("downloadStatus", `Download für ${filename} gestartet. Prüfe den Download in Firefox.`);
  } catch (error) {
    status.className = "error";
    setText("downloadStatus", `${filename} konnte nicht gespeichert werden: ${String(error.message || error)}`);
  } finally {
    downloading = false;
    renderDownloads();
  }
}
async function copyCommand(id, label) {
  const field = el(id), command = field.value;
  if (!command) return;
  const requestId = ++copyRequestId;
  try {
    await navigator.clipboard.writeText(command);
    if (requestId === copyRequestId) setText("copyStatus", label + " kopiert.");
  } catch {
    if (requestId !== copyRequestId) return;
    field.focus();
    field.select();
    setText("copyStatus", "Automatisches Kopieren ist nicht verfügbar. Der Befehl ist markiert: mit Strg+C (macOS: ⌘C) kopieren.");
  }
}
function render(state) {
  currentState = state;
  const setup = state.setup || {}, registration = setup.registration;
  setText("statusTitle", setup.label || "Registrierung noch nicht bestätigt");
  setText("statusDescription", setup.description || "Verbinde die Erweiterung erneut, um die Einrichtung zu prüfen.");
  setText("connection", !state.settings?.enabled ? "MCP ist deaktiviert. Aktiviere es über das Erweiterungsmenü in der Symbolleiste." : state.connected ? "Native-Messaging-Verbindung hergestellt." : state.connecting ? "Native-Messaging-Verbindung wird aufgebaut …" : "Native-Messaging-Verbindung derzeit nicht verfügbar.");
  setText("addonVersion", state.version);
  setText("hostVersion", setup.hostVersion || "Noch nicht bestätigt");
  setText("requiredRevision", String(setup.requiredRevision ?? 1));
  setText("currentRevision", registration ? String(registration.registrationRevision) : "Noch nicht bestätigt");
  setText("installerVersion", registration?.installerVersion || "Noch nicht bestätigt");
  setText("registeredAt", registration ? dateText(registration.registeredAt) : "Noch nicht bestätigt");
  const previous = setup.lastConfirmation;
  setText("lastConfirmed", previous ? `${dateText(previous.verifiedAt)} · Revision ${previous.registration.registrationRevision} · Skript ${previous.registration.installerVersion} · Server ${previous.hostVersion}` : "Noch keine bestätigte Prüfung");
  setText("manifestPath", registration?.manifestPath || "Noch nicht bestätigt");
  el("checkSetup").disabled = checking || !state.settings?.enabled;
  el("error").hidden = !state.lastError;
  setText("error", state.lastError || "");
  if (!selectedPlatform && ["win", "linux", "mac"].includes(setup.platform)) el("platform").value = setup.platform;
  renderDownloads();
}
async function request(type = "bridge_status") {
  const id = ++statusRequestId;
  try {
    const state = await browser.runtime.sendMessage({ type });
    if (id === statusRequestId) render(state);
  } catch (error) {
    if (id === statusRequestId) { el("error").hidden = false; setText("error", String(error.message || error)); }
  }
}
el("platform").addEventListener("change", () => { selectedPlatform = true; renderDownloads(); });
el("registerDownload").addEventListener("click", () => downloadScript("register"));
el("unregisterDownload").addEventListener("click", () => downloadScript("unregister"));
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
