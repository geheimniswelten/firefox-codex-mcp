/* global browser, FirefoxBridgeCore, FirefoxBridgePolicy */
(() => {
  "use strict";
  const { createService, errorData, validate, VERSION } = FirefoxBridgeCore;
  const { ContentAccess, normalizeSettings, iconStatus } = FirefoxBridgePolicy;
  const policy = new ContentAccess(browser, { requestApproval });
  const service = createService(browser, { contentAccess: policy });
  const REQUIRED_REGISTRATION_REVISION = { win: 1, linux: 1, mac: 1 }, REQUIRED_PROTOCOL_VERSION = 1;
  const CONFIRMATION_KEY = "bridgeSetupLastConfirmation";
  const state = { connected: false, connecting: false, lastError: null, lastAccessAt: null, version: VERSION };
  let port = null, reconnectTimer = null, handshakeTimer = null, retryDelay = 1000, pendingCount = 0, prompt = null;
  let platform = null, setupMetadata = null, metadataError = null, lastConfirmation = null;
  let confirmationWrites = Promise.resolve();
  let queue = Promise.resolve();
  const waits = new Map();
  const cancellation = (code, message) => Object.assign(new Error(message), { code });
  function abortWaits() {
    for (const controller of waits.values()) controller.abort(cancellation("MCP_DISABLED", "Die MCP-Verbindung wurde beendet."));
    waits.clear();
  }
  const smallText = (value, limit = 80) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/u.test(value);
  const isoTime = value => smallText(value, 64) && /T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
  function parseSetupMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !smallText(value.hostVersion) || !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) return null;
    const registration = value.registration;
    if (registration !== null && (!registration || typeof registration !== "object" || Array.isArray(registration) || !Number.isSafeInteger(registration.registrationRevision) || registration.registrationRevision < 0 || !smallText(registration.installerVersion) || !isoTime(registration.registeredAt) || !["win", "linux", "mac"].includes(registration.platform) || !smallText(registration.manifestPath, 4096))) return null;
    return {
      hostVersion: value.hostVersion, protocolVersion: value.protocolVersion,
      registration: registration === null ? null : {
        registrationRevision: registration.registrationRevision, installerVersion: registration.installerVersion,
        registeredAt: registration.registeredAt, platform: registration.platform, manifestPath: registration.manifestPath,
      },
    };
  }
  function rememberConfirmation(metadata) {
    if (!metadata.registration) return;
    lastConfirmation = { ...metadata, registration: { ...metadata.registration }, verifiedAt: new Date().toISOString() };
    const saved = lastConfirmation;
    // Keep successive reconnect confirmations in order; storage is history only.
    confirmationWrites = confirmationWrites.then(() => browser.storage.local.set({ [CONFIRMATION_KEY]: saved })).catch(() => {});
  }
  function setupState() {
    const registration = setupMetadata?.registration;
    const requiredRevision = REQUIRED_REGISTRATION_REVISION[platform || registration?.platform] ?? 1;
    let status, label, description;
    if (!policy.settings.enabled) {
      status = "disabled"; label = "MCP deaktiviert"; description = "Aktiviere MCP im Erweiterungsmenü, um den Native Host und die Registrierung zu prüfen.";
    } else if (state.connecting) {
      status = "pending"; label = "Einrichtung wird geprüft …"; description = "Die Erweiterung wartet auf die Rückmeldung des lokalen Native Hosts.";
    } else if (state.lastError || metadataError) {
      status = /^No such native application de\.codex\.firefox_bridge\.?$/u.test(state.lastError) ? "host_missing" : "connection_error";
      label = status === "host_missing" ? "Native Host nicht gefunden" : "Verbindung zum Native Host gestört";
      description = status === "host_missing" ? "Firefox findet den Native Host nicht. Registrierung und Manifestpfad müssen geprüft werden." : "Die Registrierung kann derzeit nicht abschließend geprüft werden. Prüfe die Fehlermeldung und versuche die Verbindung erneut.";
    } else if (setupMetadata && (setupMetadata.protocolVersion !== REQUIRED_PROTOCOL_VERSION || registration && (registration.registrationRevision < requiredRevision || platform && registration.platform !== platform))) {
      status = "update_required"; label = "Aktualisierung erforderlich";
      description = setupMetadata.protocolVersion !== REQUIRED_PROTOCOL_VERSION ? "Erweiterung und Native Host verwenden unterschiedliche Protokollversionen. Aktualisiere die zusammengehörigen Komponenten." : "Die bestätigte Registrierung passt noch nicht zu dieser Erweiterung. Speichere das aktuelle Registrierungsskript und führe es aus.";
    } else if (state.connected && registration) {
      status = "ready"; label = "Registrierung bestätigt"; description = "Der Native Host ist verbunden und bestätigt eine passende Registrierungsrevision.";
    } else {
      status = "unverified"; label = "Registrierung noch nicht bestätigt";
      description = state.connected ? "Der Native Host ist verbunden, liefert aber keinen Registrierungsnachweis. Speichere das aktuelle Registrierungsskript, führe es aus und prüfe erneut." : "Ein Download bestätigt noch keine Installation. Führe das Registrierungsskript selbst aus und prüfe anschließend erneut.";
    }
    return {
      status, label, description, requiredRevision, requiredProtocol: REQUIRED_PROTOCOL_VERSION,
      actionLabel: status === "update_required" ? "Registrierung aktualisieren" : ["host_missing", "unverified"].includes(status) ? "Einrichten / registrieren" : "Einrichtung",
      platform, hostVersion: setupMetadata?.hostVersion ?? null, protocolVersion: setupMetadata?.protocolVersion ?? null,
      registration: registration ? { ...registration } : null,
      lastConfirmation: lastConfirmation ? { ...lastConfirmation, registration: { ...lastConfirmation.registration } } : null,
    };
  }
  function clearHandshakeTimer() { if (handshakeTimer) clearTimeout(handshakeTimer); handshakeTimer = null; }
  function publicState() {
    if (prompt && Date.now() >= prompt.expiresAt) finishPrompt(false, prompt);
    return { ...state, lastError: state.lastError || metadataError, setup: setupState(), settings: { ...policy.settings }, sessionExpiresAt: policy.settings.contentMode === "ask-session" ? policy.expiresAt : null, fiveDayExpiresAt: policy.settings.contentMode === "ask-five-days" ? policy.expiresAt : null, icon: iconStatus({ ...state, enabled: policy.settings.enabled }), pendingApproval: prompt ? { ...prompt.request, id: prompt.id, expiresAt: prompt.expiresAt } : null };
  }
  function badge() {
    const status = iconStatus({ ...state, enabled: policy.settings.enabled });
    const setup = setupState();
    const setupBadge = setup.status === "update_required" ? "↑" : ["host_missing", "unverified", "connection_error"].includes(setup.status) ? "!" : "";
    browser.browserAction.setBadgeText({ text: prompt ? "?" : setupBadge }).catch(() => {});
    browser.browserAction.setIcon({ path: `icon-${status.color}.svg` }).catch(() => {});
    browser.browserAction.setTitle({ title: `Firefox ↔ Codex · ${prompt ? "Inhaltsfreigabe erforderlich · Erweiterung anklicken" : setupBadge ? setup.label : status.label}` }).catch(() => {});
  }
  function notifyPopup() {
    try { browser.runtime.sendMessage({ type: "bridge_status_changed" }).catch(() => {}); }
    catch { /* No popup receiver is required; reopening also loads the state. */ }
  }
  function finishPrompt(allowed, current = prompt) {
    if (!current || prompt !== current) return false;
    prompt = null;
    clearTimeout(current.timer);
    current.signal?.removeEventListener("abort", current.onAbort);
    badge(); notifyPopup(); current.resolve(allowed);
    return true;
  }
  function promptIsCurrent(current) {
    if (prompt !== current) return false;
    if (Date.now() >= current.expiresAt) { finishPrompt(false, current); return false; }
    return true;
  }
  async function openApprovalPopup(current) {
    let window;
    try { window = await policy.getCurrentWindow(); }
    catch { return; }
    if (!promptIsCurrent(current) || window?.type !== "normal" || !Number.isInteger(window.id)) return;
    try { await browser.windows.update(window.id, { focused: true, ...(window.state === "minimized" ? { state: "normal" } : {}) }); }
    catch { /* Keep the request available through the toolbar. */ }
    if (!promptIsCurrent(current)) return;
    try { await browser.browserAction.openPopup({ windowId: window.id }); }
    catch { /* Older Firefox versions may require the user's toolbar click. */ }
  }
  async function requestApproval(request, { signal } = {}) {
    if (prompt || !policy.settings.enabled || signal?.aborted) return false;
    return new Promise(resolve => {
      const id = crypto.randomUUID();
      const current = { id, request: { ...request }, resolve, expiresAt: Date.now() + 120000, signal };
      prompt = current;
      current.timer = setTimeout(() => finishPrompt(false, current), 120000);
      current.onAbort = () => finishPrompt(false, current);
      signal?.addEventListener("abort", current.onAbort, { once: true });
      badge(); notifyPopup();
      void openApprovalPopup(current);
    });
  }
  function scheduleReconnect() {
    if (!policy.settings.enabled || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  function disconnect() {
    clearHandshakeTimer(); setupMetadata = null; metadataError = null;
    abortWaits();
    service.clearExports?.();
    service.clearHistorySnapshots?.();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null; finishPrompt(false);
    const oldPort = port; port = null;
    if (oldPort) oldPort.disconnect();
    state.connected = false; state.connecting = false; badge();
  }
  function send(target, message) {
    if (port !== target || !policy.settings.enabled) return;
    try { target.postMessage(message); } catch { /* A completed operation is never replayed. */ }
  }
  function receive(target, message) {
    if (target !== port || !policy.settings.enabled || !message || typeof message !== "object") return;
    if (message.type === "connected") {
      clearHandshakeTimer(); state.connected = true; state.connecting = false; state.lastError = null; retryDelay = 1000; badge(); return;
    }
    if (message.type === "setup_status") {
      const metadata = parseSetupMetadata(message);
      if (!metadata) { setupMetadata = null; metadataError = "Der Native Host lieferte einen ungültigen Registrierungsnachweis."; state.connecting = false; badge(); return; }
      metadataError = null; setupMetadata = metadata; rememberConfirmation(metadata); badge(); return;
    }
    if (message.type === "cancel" && typeof message.id === "string") {
      waits.get(message.id)?.abort(cancellation("CANCELLED", "Die Anfrage wurde abgebrochen."));
      return;
    }
    if (typeof message.id !== "string" || message.id.length > 128 || typeof message.method !== "string" || message.method.length > 64) return;
    if (metadataError) { send(target, { id: message.id, error: { code: "HOST_STATUS_INVALID", message: metadataError } }); return; }
    if (setupMetadata && setupMetadata.protocolVersion !== REQUIRED_PROTOCOL_VERSION) {
      send(target, { id: message.id, error: { code: "PROTOCOL_MISMATCH", message: "Erweiterung und Native Host verwenden unterschiedliche Protokollversionen." } }); return;
    }
    try { validate(message.method, message.params ?? {}); }
    catch (error) { send(target, { id: message.id, error: errorData(error) }); return; }
    if (pendingCount >= 32) { send(target, { id: message.id, error: { code: "BUSY", message: "Zu viele ausstehende Firefox-Anfragen." } }); return; }
    if (waits.has(message.id)) { send(target, { id: message.id, error: { code: "BUSY", message: "Diese Warteanfrage läuft bereits." } }); return; }
    const controller = ["wait_for", "search_history"].includes(message.method) ? new AbortController() : null;
    if (controller) waits.set(message.id, controller);
    state.lastAccessAt = Date.now(); badge(); pendingCount += 1;
    const execute = async () => {
      if (!policy.settings.enabled || port !== target) return;
      const assertLive = () => {
        if (controller?.signal.aborted) throw controller.signal.reason;
        if (!policy.settings.enabled || port !== target) throw Object.assign(new Error("Die MCP-Verbindung wurde beendet."), { code: "MCP_DISABLED" });
        if (Number.isFinite(message.expiresAt) && Date.now() >= message.expiresAt) throw Object.assign(new Error("Die Anfrage ist abgelaufen und wurde nicht ausgeführt."), { code: "REQUEST_EXPIRED" });
      };
      try {
        assertLive();
        send(target, { id: message.id, result: await service.handle(message.method, message.params ?? {}, { assertLive, signal: controller?.signal }) });
      } catch (error) { send(target, { id: message.id, error: errorData(error) }); }
    };
    // Permission prompts and history scans do not hold tab-control requests in the queue.
    if (["read_content", "save_png", "save_html", "save_pdf", "wait_for", "search_history"].includes(message.method)) execute().finally(() => { pendingCount -= 1; if (controller) waits.delete(message.id); });
    else queue = queue.then(execute).catch(() => {}).finally(() => { pendingCount -= 1; });
  }
  function connect() {
    if (!policy.settings.enabled || port) return;
    setupMetadata = null; metadataError = null; state.connecting = true; state.lastError = null; badge();
    try {
      const current = browser.runtime.connectNative("de.codex.firefox_bridge"); port = current;
      current.onMessage.addListener(message => receive(current, message));
      current.onDisconnect.addListener(() => {
        if (port !== current) return;
        port = null; clearHandshakeTimer(); setupMetadata = null; metadataError = null; abortWaits(); service.clearExports?.(); service.clearHistorySnapshots?.(); finishPrompt(false); state.connected = false; state.connecting = false;
        state.lastError = String(current.error?.message || "Native Host getrennt. Installation und Firefox-Profil prüfen.").slice(0, 1000);
        badge(); scheduleReconnect();
      });
      handshakeTimer = setTimeout(() => {
        if (port !== current || state.connected) return;
        disconnect(); state.lastError = "Der Native Host hat den Verbindungsaufbau nicht rechtzeitig bestätigt."; badge(); scheduleReconnect();
      }, 10000);
      current.postMessage({ type: "ready", version: VERSION });
    } catch (error) {
      const failedPort = port; port = null; clearHandshakeTimer();
      try { failedPort?.disconnect(); } catch { /* Startup already failed. */ }
      state.connecting = false; state.lastError = String(error.message || error).slice(0, 1000); badge(); scheduleReconnect();
    }
  }
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return undefined;
    const fromPopup = sender.url === browser.runtime.getURL("popup.html");
    const fromSetup = sender.url === browser.runtime.getURL("setup/setup.html");
    if (!fromPopup && !fromSetup) return undefined;
    if (fromSetup && !["bridge_status", "bridge_reconnect"].includes(message.type)) return undefined;
    if (message.type === "approval_answer") {
      const current = prompt;
      if (!current || !promptIsCurrent(current) || message.id !== current.id || typeof message.allowed !== "boolean") return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: finishPrompt(message.allowed, current) });
    }
    if (message.type === "bridge_status") return startup.then(publicState);
    if (message.type === "bridge_reset_approvals") return startup.then(async () => {
      policy.resetApprovals(); service.clearExports?.(); finishPrompt(false); badge(); notifyPopup();
      await policy.flushApprovals(); return publicState();
    });
    if (message.type === "bridge_reconnect") return startup.then(() => { disconnect(); retryDelay = 1000; connect(); return publicState(); });
    if (message.type === "bridge_settings" && message.settings && typeof message.settings === "object") return startup.then(async () => {
      const before = JSON.stringify(policy.settings);
      const settings = policy.setSettings(normalizeSettings(message.settings));
      if (JSON.stringify(settings) !== before) { service.clearExports?.(); finishPrompt(false); }
      await policy.flushApprovals();
      await browser.storage.local.set({ bridgeSettings: settings });
      if (!settings.enabled) disconnect(); else connect();
      badge(); return publicState();
    });
    return undefined;
  });
  const startup = (async () => {
    const [saved, platformInfo] = await Promise.all([
      browser.storage.local.get(["bridgeSettings", CONFIRMATION_KEY]),
      Promise.resolve().then(() => browser.runtime.getPlatformInfo?.()).catch(() => null),
    ]);
    platform = ["win", "linux", "mac"].includes(platformInfo?.os) ? platformInfo.os : null;
    const previous = saved[CONFIRMATION_KEY];
    const previousMetadata = parseSetupMetadata(previous);
    if (previousMetadata?.registration && isoTime(previous.verifiedAt)) lastConfirmation = { ...previousMetadata, verifiedAt: previous.verifiedAt };
    policy.setSettings(saved.bridgeSettings || {}, { persist: false });
    await policy.restoreApprovals();
    await service.ready;
    connect(); badge();
  })().catch(error => { state.lastError = String(error.message || error).slice(0, 1000); badge(); });
  setInterval(badge, 15000);
})();
