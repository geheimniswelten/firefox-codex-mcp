/* global browser, FirefoxBridgeCore, FirefoxBridgePolicy */
(() => {
  "use strict";
  const { createService, errorData, validate, VERSION } = FirefoxBridgeCore;
  const { ContentAccess, normalizeSettings, iconStatus } = FirefoxBridgePolicy;
  const policy = new ContentAccess(browser, { requestApproval });
  const service = createService(browser, { contentAccess: policy });
  const state = { connected: false, connecting: false, lastError: null, lastAccessAt: null, version: VERSION };
  let port = null, reconnectTimer = null, retryDelay = 1000, pendingCount = 0, prompt = null;
  let queue = Promise.resolve();
  function publicState() {
    if (prompt && Date.now() >= prompt.expiresAt) finishPrompt(false, prompt);
    return { ...state, settings: { ...policy.settings }, sessionExpiresAt: policy.expiresAt, icon: iconStatus({ ...state, enabled: policy.settings.enabled }), pendingApproval: prompt ? { ...prompt.request, id: prompt.id, expiresAt: prompt.expiresAt } : null };
  }
  function badge() {
    const status = iconStatus({ ...state, enabled: policy.settings.enabled });
    browser.browserAction.setBadgeText({ text: prompt ? "?" : "" }).catch(() => {});
    browser.browserAction.setIcon({ path: `icon-${status.color}.svg` }).catch(() => {});
    browser.browserAction.setTitle({ title: `Firefox ↔ Codex · ${prompt ? "Inhaltsfreigabe erforderlich · Erweiterung anklicken" : status.label}` }).catch(() => {});
  }
  function notifyPopup() {
    try { browser.runtime.sendMessage({ type: "bridge_status_changed" }).catch(() => {}); }
    catch { /* No popup receiver is required; reopening also loads the state. */ }
  }
  function finishPrompt(allowed, current = prompt) {
    if (!current || prompt !== current) return false;
    prompt = null;
    clearTimeout(current.timer);
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
  async function requestApproval(request) {
    if (prompt || !policy.settings.enabled) return false;
    return new Promise(resolve => {
      const id = crypto.randomUUID();
      const current = { id, request: { ...request }, resolve, expiresAt: Date.now() + 120000 };
      prompt = current;
      current.timer = setTimeout(() => finishPrompt(false, current), 120000);
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
    service.clearExports?.();
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
      state.connected = true; state.connecting = false; state.lastError = null; retryDelay = 1000; badge(); return;
    }
    if (typeof message.id !== "string" || message.id.length > 128 || typeof message.method !== "string" || message.method.length > 64) return;
    try { validate(message.method, message.params ?? {}); }
    catch (error) { send(target, { id: message.id, error: errorData(error) }); return; }
    if (pendingCount >= 32) { send(target, { id: message.id, error: { code: "BUSY", message: "Zu viele ausstehende Firefox-Anfragen." } }); return; }
    state.lastAccessAt = Date.now(); badge(); pendingCount += 1;
    const execute = async () => {
      if (!policy.settings.enabled || port !== target) return;
      const assertLive = () => {
        if (!policy.settings.enabled || port !== target) throw Object.assign(new Error("Die MCP-Verbindung wurde beendet."), { code: "MCP_DISABLED" });
        if (Number.isFinite(message.expiresAt) && Date.now() >= message.expiresAt) throw Object.assign(new Error("Die Anfrage ist abgelaufen und wurde nicht ausgeführt."), { code: "REQUEST_EXPIRED" });
      };
      try {
        assertLive();
        send(target, { id: message.id, result: await service.handle(message.method, message.params ?? {}, { assertLive }) });
      } catch (error) { send(target, { id: message.id, error: errorData(error) }); }
    };
    // Permission prompts do not hold status or tab-control requests in the queue.
    if (["read_content", "save_png", "save_html", "save_pdf"].includes(message.method)) execute().finally(() => { pendingCount -= 1; });
    else queue = queue.then(execute).catch(() => {}).finally(() => { pendingCount -= 1; });
  }
  function connect() {
    if (!policy.settings.enabled || port) return;
    state.connecting = true; state.lastError = null; badge();
    try {
      const current = browser.runtime.connectNative("de.codex.firefox_bridge"); port = current;
      current.onMessage.addListener(message => receive(current, message));
      current.onDisconnect.addListener(() => {
        if (port !== current) return;
        port = null; service.clearExports?.(); finishPrompt(false); state.connected = false; state.connecting = false;
        state.lastError = String(current.error?.message || "Native Host getrennt. Installation und Firefox-Profil prüfen.").slice(0, 1000);
        badge(); scheduleReconnect();
      });
      current.postMessage({ type: "ready", version: VERSION });
    } catch (error) { port = null; state.connecting = false; state.lastError = String(error.message || error).slice(0, 1000); badge(); scheduleReconnect(); }
  }
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return undefined;
    if (sender.url !== browser.runtime.getURL("popup.html")) return undefined;
    if (message.type === "approval_answer") {
      const current = prompt;
      if (!current || !promptIsCurrent(current) || message.id !== current.id || typeof message.allowed !== "boolean") return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: finishPrompt(message.allowed, current) });
    }
    if (message.type === "bridge_status") return startup.then(publicState);
    if (message.type === "bridge_reset_approvals") return startup.then(() => {
      policy.resetApprovals(); service.clearExports?.(); finishPrompt(false); badge(); notifyPopup(); return publicState();
    });
    if (message.type === "bridge_reconnect") return startup.then(() => { disconnect(); retryDelay = 1000; connect(); return publicState(); });
    if (message.type === "bridge_settings" && message.settings && typeof message.settings === "object") return startup.then(async () => {
      const before = JSON.stringify(policy.settings);
      const settings = policy.setSettings(normalizeSettings(message.settings));
      if (JSON.stringify(settings) !== before) { service.clearExports?.(); finishPrompt(false); }
      await browser.storage.local.set({ bridgeSettings: settings });
      if (!settings.enabled) disconnect(); else connect();
      badge(); return publicState();
    });
    return undefined;
  });
  const startup = (async () => {
    const saved = await browser.storage.local.get("bridgeSettings");
    policy.setSettings(saved.bridgeSettings || {});
    await service.ready;
    connect(); badge();
  })().catch(error => { state.lastError = String(error.message || error).slice(0, 1000); badge(); });
  setInterval(badge, 15000);
})();
