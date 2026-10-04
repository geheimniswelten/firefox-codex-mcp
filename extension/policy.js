(() => {
  "use strict";
  const SESSION_MS = 12 * 60 * 60 * 1000;
  const DEFAULTS = Object.freeze({ enabled: true, contentMode: "ask-session", contentScope: "active" });
  const accessError = (code, message) => Object.assign(new Error(message), { code });
  function normalizeSettings(value = {}) {
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
      contentMode: ["allow", "deny", "ask-every-time", "ask-session"].includes(value.contentMode) ? value.contentMode : DEFAULTS.contentMode,
      contentScope: ["all", "active"].includes(value.contentScope) ? value.contentScope : DEFAULTS.contentScope
    };
  }
  function iconStatus({ enabled, connected, lastAccessAt }, now = Date.now()) {
    if (!enabled) return { color: "gray", label: "MCP deaktiviert" };
    if (!connected) return { color: "gray", label: "MCP nicht verbunden" };
    if (lastAccessAt !== null && lastAccessAt !== undefined && now - lastAccessAt <= 60000) return { color: "blue", label: "MCP verbunden · Zugriff innerhalb der letzten Minute" };
    if (lastAccessAt !== null && lastAccessAt !== undefined && now - lastAccessAt <= 1800000) return { color: "amber", label: "MCP verbunden · Zugriff innerhalb der letzten 30 Minuten" };
    return { color: "green", label: "MCP verbunden · Kein Zugriff in den letzten 30 Minuten" };
  }
  // Firefox ignores getLastFocused({windowTypes}), so remember normal-window
  // focus explicitly. Extension permission popups must never become the target.
  class NormalWindowTracker {
    constructor(browser) {
      this.browser = browser; this.lastNormalId = null; this.queue = Promise.resolve();
      this.listener = id => {
        if (id < 0) return;
        this.queue = this.queue.then(async () => {
          const window = await browser.windows.get(id, { populate: false });
          if (window.type === "normal") this.lastNormalId = id;
        }).catch(() => {});
      };
      browser.windows.onFocusChanged.addListener(this.listener);
      this.ready = browser.windows.getLastFocused({ populate: false }).then(window => {
        if (window.type === "normal" && this.lastNormalId === null) this.lastNormalId = window.id;
      }).catch(() => {});
    }
    async getCurrent() {
      await this.ready; await this.queue;
      let current;
      try { current = await this.browser.windows.getLastFocused({ populate: true }); } catch { /* No current window. */ }
      if (current?.type === "normal") { this.lastNormalId = current.id; return current; }
      if (this.lastNormalId !== null) {
        try { const window = await this.browser.windows.get(this.lastNormalId, { populate: true }); if (window.type === "normal") return window; }
        catch { this.lastNormalId = null; }
      }
      const windows = (await this.browser.windows.getAll({ populate: true })).filter(window => window.type === "normal");
      const selected = windows.find(window => window.focused) || (windows.length === 1 ? windows[0] : null);
      if (selected) { this.lastNormalId = selected.id; return selected; }
      throw accessError("CURRENT_WINDOW_UNAVAILABLE", "Bitte ein normales Firefox-Fenster aktivieren und die Anfrage erneut stellen.");
    }
    stop() { this.browser.windows.onFocusChanged.removeListener(this.listener); }
  }
  class ContentAccess {
    constructor(browser, { now = Date.now, requestApproval = async () => false, settings = DEFAULTS } = {}) {
      this.browser = browser; this.now = now; this.requestApproval = requestApproval;
      this.settings = normalizeSettings(settings); this.revision = 0; this.expiresAt = null; this.promptPending = false;
      this.tabGrants = new Map(); this.tabRevisions = new Map(); this.authorizations = new WeakMap();
      const revokeTab = tabId => {
        this.tabGrants.delete(tabId);
        this.tabRevisions.set(tabId, (this.tabRevisions.get(tabId) || 0) + 1);
      };
      browser.tabs.onUpdated.addListener((tabId, change) => { if (Object.prototype.hasOwnProperty.call(change, "url") || change.discarded === true) revokeTab(tabId); });
      browser.tabs.onRemoved.addListener(revokeTab);
      this.windowTracker = new NormalWindowTracker(browser);
    }
    getCurrentWindow() { return this.windowTracker.getCurrent(); }
    setSettings(settings) {
      const next = normalizeSettings(settings);
      if (JSON.stringify(this.settings) !== JSON.stringify(next)) { this.settings = next; this.resetApprovals(); }
      return this.settings;
    }
    resetApprovals() {
      this.revision += 1; this.expiresAt = null; this.tabGrants.clear();
    }
    async assertTarget(tabId, expectedUrl, revision) {
      if (!this.settings.enabled) throw accessError("MCP_DISABLED", "MCP-Zugriff ist deaktiviert.");
      if (revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Zugriffseinstellungen wurden während der Anfrage geändert.");
      const tab = await this.browser.tabs.get(tabId);
      if (tab.url !== expectedUrl) throw accessError("PAGE_CHANGED", "Die Tab-URL hat sich während der Freigabe geändert. Erneut anfragen.");
      if (tab.discarded) throw accessError("TAB_DISCARDED", "Der Tab wurde entladen. Zuerst ausdrücklich reload_tabs aufrufen.");
      if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Zugriffseinstellungen wurden während der Anfrage geändert.");
      return tab;
    }
    async isActiveTab(tabId) {
      const window = await this.getCurrentWindow();
      return window.tabs?.some(candidate => candidate.id === tabId && candidate.active) === true;
    }
    assertGrant(grant, tabId, url, revision) {
      if (grant.tabId !== tabId || grant.url !== url) throw accessError("CONTENT_SCOPE", "Die Freigabe gilt nur für den angefragten Tab und seine URL.");
      if (grant.revision !== revision || revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
      if (grant.tabRevision !== (this.tabRevisions.get(tabId) || 0)) throw accessError("PAGE_CHANGED", "Die Seite wurde seit der Freigabe gewechselt. Erneut anfragen.");
      if (grant.expiresAt !== null && this.now() >= grant.expiresAt) throw accessError("SESSION_EXPIRED", "Die Tab-Freigabe ist während des Auslesens abgelaufen. Erneut anfragen.");
      if (grant.expiresAt !== null && this.tabGrants.get(tabId) !== grant) throw accessError("CONTENT_DENIED", "Die Tab-Freigabe wurde widerrufen.");
    }
    async assertScope(tabId, expectedUrl, revision = this.revision, authorization) {
      const tab = await this.assertTarget(tabId, expectedUrl, revision);
      const grant = this.authorizations.get(authorization);
      if (grant) this.assertGrant(grant, tabId, expectedUrl, revision);
      else if (this.settings.contentScope === "active" && !await this.isActiveTab(tabId)) {
        throw accessError("CONTENT_SCOPE", "Der Tab ist nicht mehr aktiv. Für diesen Tab erneut eine Inhaltsfreigabe anfragen.");
      }
      if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Zugriffseinstellungen wurden während der Anfrage geändert.");
      return tab;
    }
    async authorize(tab, authorization = {}, { signal } = {}) {
      const assertPending = () => { if (signal?.aborted) throw signal.reason || accessError("CANCELLED", "Die Inhaltsanfrage wurde abgebrochen."); };
      assertPending();
      this.authorizations.delete(authorization);
      const revision = this.revision, tabRevision = this.tabRevisions.get(tab.id) || 0;
      await this.assertTarget(tab.id, tab.url, revision);
      assertPending();
      const mode = this.settings.contentMode;
      if (mode === "deny") throw accessError("CONTENT_DENIED", "Inhaltszugriff ist in der Erweiterung gesperrt.");
      const tabScoped = this.settings.contentScope === "active" && !await this.isActiveTab(tab.id);
      assertPending();
      await this.assertTarget(tab.id, tab.url, revision);
      assertPending();
      if (this.settings.contentScope === "active") {
        const grant = this.tabGrants.get(tab.id);
        if (mode === "ask-session" && grant?.url === tab.url && grant.revision === revision && grant.tabRevision === tabRevision && this.now() < grant.expiresAt) {
          this.authorizations.set(authorization, grant);
          return this.assertScope(tab.id, tab.url, revision, authorization);
        }
      }
      if (!tabScoped) {
        await this.assertScope(tab.id, tab.url, revision);
        assertPending();
        if (mode === "allow") return this.assertScope(tab.id, tab.url, revision);
        if (mode === "ask-session" && this.expiresAt !== null && this.now() < this.expiresAt) return this.assertScope(tab.id, tab.url, revision);
      }
      if (this.promptPending) throw accessError("APPROVAL_BUSY", "Eine Inhaltsfreigabe wartet bereits auf eine Antwort.");
      this.promptPending = true;
      let allowed;
      try { allowed = await this.requestApproval({ tabId: tab.id, url: tab.url, title: tab.title || "", mode: tabScoped && mode === "allow" ? "ask-every-time" : mode, scope: tabScoped ? "tab" : this.settings.contentScope }, { signal }); }
      finally { this.promptPending = false; }
      assertPending();
      if (!allowed) throw accessError("CONTENT_DENIED", "Inhaltszugriff wurde nicht freigegeben.");
      if (tabScoped) {
        await this.assertTarget(tab.id, tab.url, revision);
        assertPending();
        if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
        if (tabRevision !== (this.tabRevisions.get(tab.id) || 0)) throw accessError("PAGE_CHANGED", "Die Seite wurde während der Freigabe gewechselt. Erneut anfragen.");
        const grant = { tabId: tab.id, url: tab.url, revision, tabRevision, expiresAt: mode === "ask-session" ? this.now() + SESSION_MS : null };
        if (mode === "ask-session") this.tabGrants.set(tab.id, grant);
        this.authorizations.set(authorization, grant);
        return this.assertScope(tab.id, tab.url, revision, authorization);
      }
      const current = await this.assertScope(tab.id, tab.url, revision);
      assertPending();
      if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
      if (mode === "ask-session") this.expiresAt = this.now() + SESSION_MS;
      return current;
    }
    async assertAfterRead(tabId, url, revision, authorization) {
      const tab = await this.assertScope(tabId, url, revision, authorization);
      if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
      const grant = this.authorizations.get(authorization);
      if (grant) this.assertGrant(grant, tabId, url, revision);
      if (this.settings.contentMode === "deny") throw accessError("CONTENT_DENIED", "Inhaltszugriff wurde gesperrt.");
      if (!this.authorizations.has(authorization) && this.settings.contentMode === "ask-session" && (this.expiresAt === null || this.now() >= this.expiresAt)) throw accessError("SESSION_EXPIRED", "Die Sitzungsfreigabe ist während des Auslesens abgelaufen. Erneut anfragen.");
      return tab;
    }
  }
  globalThis.FirefoxBridgePolicy = { SESSION_MS, DEFAULTS, normalizeSettings, iconStatus, NormalWindowTracker, ContentAccess };
})();
