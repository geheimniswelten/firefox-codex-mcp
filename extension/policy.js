(() => {
  "use strict";
  const SESSION_MS = 12 * 60 * 60 * 1000;
  const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
  const APPROVALS_KEY = "bridgeFiveDayApprovals", TAB_APPROVAL_KEY = "firefoxBridgeContentApprovalId";
  const uuid = () => globalThis.crypto.randomUUID();
  const isUuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const DEFAULTS = Object.freeze({ enabled: true, contentMode: "ask-session", contentScope: "active" });
  const accessError = (code, message) => Object.assign(new Error(message), { code });
  function normalizeSettings(value = {}) {
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
      contentMode: ["allow", "deny", "ask-every-time", "ask-session", "ask-five-days"].includes(value.contentMode) ? value.contentMode : DEFAULTS.contentMode,
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
      this.policyEpoch = null; this.globalApproval = null; this.savedTabGrants = new Map(); this.tabTokens = new Map();
      this.persistEnabled = false; this.persistQueue = Promise.resolve(); this.persistFailure = null; this.persistNotice = null;
      const revokeTab = tabId => {
        this.tabGrants.delete(tabId);
        this.tabRevisions.set(tabId, (this.tabRevisions.get(tabId) || 0) + 1);
        const token = this.tabTokens.get(tabId);
        if (token && this.savedTabGrants.delete(token)) this.persistApprovals();
      };
      browser.tabs.onUpdated.addListener((tabId, change) => { if (Object.prototype.hasOwnProperty.call(change, "url") || change.discarded === true || (this.settings.contentMode === "ask-five-days" && change.status === "loading")) revokeTab(tabId); });
      browser.tabs.onRemoved.addListener(tabId => { revokeTab(tabId); this.tabTokens.delete(tabId); });
      browser.tabs.onCreated?.addListener(tab => {
        if (this.settings.contentMode !== "ask-five-days" || !this.savedTabGrants.size) return;
        this.browser.sessions?.getTabValue?.(tab.id, TAB_APPROVAL_KEY).then(token => {
          if (this.savedTabGrants.has(token)) this.revokeToken(token);
        }).catch(() => { for (const token of this.savedTabGrants.keys()) this.revokeToken(token); });
      });
      this.windowTracker = new NormalWindowTracker(browser);
    }
    getCurrentWindow() { return this.windowTracker.getCurrent(); }
    setSettings(settings, { persist = true } = {}) {
      const next = normalizeSettings(settings);
      if (JSON.stringify(this.settings) !== JSON.stringify(next)) {
        const hadFiveDays = this.settings.contentMode === "ask-five-days";
        this.settings = next; this.resetApprovals({ persist, hadFiveDays });
      }
      return this.settings;
    }
    resetApprovals({ persist = true, hadFiveDays = false } = {}) {
      this.revision += 1; this.expiresAt = null; this.tabGrants.clear();
      this.globalApproval = null; this.savedTabGrants.clear(); this.tabTokens.clear();
      if (persist && (hadFiveDays || this.persistEnabled || this.settings.contentMode === "ask-five-days")) {
        this.persistEnabled = true; this.policyEpoch = uuid(); this.persistApprovals();
      }
    }
    approvalSnapshot() {
      return { version: 1, epoch: this.policyEpoch, settingsSignature: JSON.stringify(this.settings), global: this.globalApproval && { issuedAt: this.globalApproval.issuedAt, expiresAt: this.globalApproval.expiresAt }, tabs: [...this.savedTabGrants.values()].map(grant => ({ token: grant.token, url: grant.url, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt })) };
    }
    persistApprovals() {
      if (!this.persistEnabled) return Promise.resolve();
      const snapshot = this.approvalSnapshot();
      const write = this.persistQueue.then(async () => {
        try {
          if (!this.browser.storage?.local?.set) throw new Error("Browser-Speicher ist nicht verfügbar.");
          await this.browser.storage.local.set({ [APPROVALS_KEY]: snapshot });
          this.persistFailure = null;
        } catch {
          const error = accessError("APPROVAL_PERSISTENCE_FAILED", "Die fünftägige Freigabe konnte nicht sicher gespeichert werden. Erneut anfragen.");
          this.persistFailure = error; this.persistNotice ||= error;
          throw error;
        }
      });
      // A failed save must not prevent a queued revocation from being written.
      this.persistQueue = write.catch(() => {});
      return write;
    }
    async flushApprovals() {
      await this.persistQueue;
      if (this.persistNotice) { const error = this.persistNotice; this.persistNotice = null; throw error; }
    }
    validFiveDayTimes(grant) {
      return grant && Number.isSafeInteger(grant.issuedAt) && Number.isSafeInteger(grant.expiresAt) && grant.issuedAt <= this.now() && grant.expiresAt - grant.issuedAt === FIVE_DAYS_MS && this.now() < grant.expiresAt;
    }
    async restoreApprovals() {
      if (this.settings.contentMode !== "ask-five-days") return;
      const revision = this.revision;
      let stored;
      try { stored = (await this.browser.storage.local.get(APPROVALS_KEY))[APPROVALS_KEY]; }
      catch { throw accessError("APPROVAL_PERSISTENCE_FAILED", "Gespeicherte Inhaltsfreigaben konnten nicht sicher geladen werden."); }
      if (revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Inhaltsfreigaben wurden während des Ladens geändert.");
      this.persistEnabled = true; this.policyEpoch = uuid();
      const valid = stored?.version === 1 && isUuid(stored.epoch) && stored.settingsSignature === JSON.stringify(this.settings) && Array.isArray(stored.tabs);
      if (!valid) { await this.persistApprovals(); return; }
      this.policyEpoch = stored.epoch;
      const restoredTabs = [];
      if (stored.tabs.length && this.browser.sessions?.getTabValue && this.browser.sessions?.setTabValue && this.browser.tabs.query) {
        let tabs;
        try { tabs = await this.browser.tabs.query({}); } catch { tabs = []; }
        const identities = await Promise.all(tabs.map(async tab => {
          const generation = this.tabRevisions.get(tab.id) || 0;
          try { return { tab, token: await this.browser.sessions.getTabValue(tab.id, TAB_APPROVAL_KEY), generation }; }
          catch { return { tab, token: null, generation }; }
        }));
        const counts = new Map();
        for (const { token } of identities) if (isUuid(token)) counts.set(token, (counts.get(token) || 0) + 1);
        const records = new Map();
        for (const record of stored.tabs) {
          if (!isUuid(record?.token) || typeof record.url !== "string" || !this.validFiveDayTimes(record) || records.has(record.token)) { records.set(record?.token, null); continue; }
          records.set(record.token, record);
        }
        for (const { tab, token, generation } of identities) {
          const record = records.get(token);
          if (counts.get(token) !== 1 || !record || tab.discarded || tab.url !== record.url || generation !== 0) continue;
          let current;
          try { current = await this.browser.tabs.get(tab.id); } catch { continue; }
          if (current.url === record.url && !current.discarded && generation === (this.tabRevisions.get(tab.id) || 0)) restoredTabs.push({ ...record, tabId: tab.id, tabRevision: generation, revision });
        }
      }
      if (revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Inhaltsfreigaben wurden während des Ladens geändert.");
      if (this.validFiveDayTimes(stored.global)) { this.globalApproval = { ...stored.global }; this.expiresAt = stored.global.expiresAt; }
      for (const grant of restoredTabs) {
        if (grant.tabRevision !== (this.tabRevisions.get(grant.tabId) || 0)) continue;
        this.savedTabGrants.set(grant.token, grant); this.tabTokens.set(grant.tabId, grant.token); this.tabGrants.set(grant.tabId, grant);
      }
      // Remove expired, closed, ambiguous and URL-mismatched tab grants on disk too.
      await this.persistApprovals();
      if (revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Inhaltsfreigaben wurden während des Ladens geändert.");
    }
    revokeToken(token) {
      if (!this.savedTabGrants.delete(token)) return;
      for (const [tabId, value] of this.tabTokens) if (value === token) {
        this.tabGrants.delete(tabId); this.tabRevisions.set(tabId, (this.tabRevisions.get(tabId) || 0) + 1);
      }
      this.persistApprovals();
    }
    async tabToken(tabId) {
      if (!this.browser.sessions?.getTabValue || !this.browser.sessions?.setTabValue || !this.browser.tabs.query) throw accessError("APPROVAL_PERSISTENCE_FAILED", "Firefox kann diese Tab-Freigabe nicht dauerhaft eindeutig speichern.");
      const tabs = await this.browser.tabs.query({});
      const values = await Promise.all(tabs.map(async tab => ({ id: tab.id, token: await this.browser.sessions.getTabValue(tab.id, TAB_APPROVAL_KEY) })));
      let token = values.find(tab => tab.id === tabId)?.token;
      if (!isUuid(token) || values.filter(tab => tab.token === token).length !== 1) {
        if (isUuid(token)) this.revokeToken(token);
        token = uuid(); await this.browser.sessions.setTabValue(tabId, TAB_APPROVAL_KEY, token);
      }
      return token;
    }
    async commitFiveDay(tab, grant, revision, tabRevision, assertPending, signal) {
      assertPending(); await this.assertTarget(tab.id, tab.url, revision); assertPending();
      if (!grant.token) { await this.assertScope(tab.id, tab.url, revision); assertPending(); }
      if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde vor dem Speichern widerrufen.");
      if (tabRevision !== (this.tabRevisions.get(tab.id) || 0)) throw accessError("PAGE_CHANGED", "Die Seite wurde vor dem Speichern gewechselt.");
      if (!this.validFiveDayTimes(grant)) throw accessError("SESSION_EXPIRED", "Die Inhaltsfreigabe ist vor dem Speichern abgelaufen.");
      this.persistEnabled = true; this.policyEpoch ||= uuid();
      const rollback = () => {
        let changed = false;
        if (grant.token && this.savedTabGrants.get(grant.token) === grant) { this.savedTabGrants.delete(grant.token); this.tabGrants.delete(tab.id); changed = true; }
        if (!grant.token && this.globalApproval === grant) { this.globalApproval = null; this.expiresAt = null; changed = true; }
        if (changed) this.persistApprovals();
      };
      grant.pending = true;
      if (grant.token) { this.tabTokens.set(tab.id, grant.token); this.savedTabGrants.set(grant.token, grant); this.tabGrants.set(tab.id, grant); }
      else { this.globalApproval = grant; this.expiresAt = grant.expiresAt; }
      signal?.addEventListener("abort", rollback, { once: true });
      try {
        await this.persistApprovals();
        assertPending(); await this.assertTarget(tab.id, tab.url, revision); assertPending();
        if (revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während des Speicherns widerrufen.");
        if (tabRevision !== (this.tabRevisions.get(tab.id) || 0)) throw accessError("PAGE_CHANGED", "Die Seite wurde während des Speicherns gewechselt.");
        if (grant.token ? this.tabGrants.get(tab.id) !== grant : this.globalApproval !== grant) throw accessError("CONTENT_DENIED", "Die Freigabe wurde während des Speicherns widerrufen.");
        grant.pending = false;
        return rollback;
      } catch (error) { rollback(); throw error; }
      finally { signal?.removeEventListener("abort", rollback); }
    }
    async assertTarget(tabId, expectedUrl, revision) {
      if (!this.settings.enabled) throw accessError("MCP_DISABLED", "MCP-Zugriff ist deaktiviert.");
      if (revision !== this.revision) throw accessError("PERMISSION_CHANGED", "Die Zugriffseinstellungen wurden während der Anfrage geändert.");
      if (this.settings.contentMode === "ask-five-days" && this.persistFailure) throw this.persistFailure;
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
      if (grant.pending) throw accessError("APPROVAL_BUSY", "Die Inhaltsfreigabe wird noch gespeichert.");
      if (grant.expiresAt !== null && this.now() >= grant.expiresAt) throw accessError("SESSION_EXPIRED", "Die Tab-Freigabe ist während des Auslesens abgelaufen. Erneut anfragen.");
      if (grant.expiresAt !== null && !grant.global && this.tabGrants.get(tabId) !== grant) throw accessError("CONTENT_DENIED", "Die Tab-Freigabe wurde widerrufen.");
    }
    bindFiveDayGlobal(tab, authorization, revision, tabRevision) {
      this.authorizations.set(authorization, { tabId: tab.id, url: tab.url, revision, tabRevision, expiresAt: this.expiresAt, global: true });
    }
    async assertTabIdentity(grant) {
      let token;
      try { token = await this.browser.sessions.getTabValue(grant.tabId, TAB_APPROVAL_KEY); }
      catch { this.revokeToken(grant.token); throw accessError("CONTENT_DENIED", "Die gespeicherte Tab-Identität kann nicht mehr geprüft werden."); }
      if (token !== grant.token) { this.revokeToken(grant.token); throw accessError("CONTENT_DENIED", "Die gespeicherte Tab-Identität wurde geändert."); }
    }
    async assertScope(tabId, expectedUrl, revision = this.revision, authorization) {
      const tab = await this.assertTarget(tabId, expectedUrl, revision);
      const grant = this.authorizations.get(authorization);
      if (grant) {
        this.assertGrant(grant, tabId, expectedUrl, revision);
        if (grant.token) await this.assertTabIdentity(grant);
        this.assertGrant(grant, tabId, expectedUrl, revision);
        if (grant.global && this.settings.contentScope === "active" && !await this.isActiveTab(tabId)) throw accessError("CONTENT_SCOPE", "Der Tab ist nicht mehr aktiv. Für diesen Tab erneut eine Inhaltsfreigabe anfragen.");
      }
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
      const finiteMode = mode === "ask-session" || mode === "ask-five-days";
      if (mode === "deny") throw accessError("CONTENT_DENIED", "Inhaltszugriff ist in der Erweiterung gesperrt.");
      const tabScoped = this.settings.contentScope === "active" && !await this.isActiveTab(tab.id);
      assertPending();
      await this.assertTarget(tab.id, tab.url, revision);
      assertPending();
      if (this.settings.contentScope === "active") {
        const grant = this.tabGrants.get(tab.id);
        if (finiteMode && !grant?.pending && grant?.url === tab.url && grant.revision === revision && grant.tabRevision === tabRevision && this.now() < grant.expiresAt) {
          if (!grant.token || await this.tabToken(tab.id) === grant.token) {
            this.authorizations.set(authorization, grant);
            const approved = await this.assertScope(tab.id, tab.url, revision, authorization); assertPending(); return approved;
          }
        }
      }
      if (!tabScoped) {
        await this.assertScope(tab.id, tab.url, revision);
        assertPending();
        if (mode === "allow") return this.assertScope(tab.id, tab.url, revision);
        if (finiteMode && !this.globalApproval?.pending && this.expiresAt !== null && this.now() < this.expiresAt) {
          if (mode === "ask-five-days") this.bindFiveDayGlobal(tab, authorization, revision, tabRevision);
          return this.assertScope(tab.id, tab.url, revision, authorization);
        }
      }
      if (this.promptPending || this.globalApproval?.pending || [...this.tabGrants.values()].some(grant => grant.pending)) throw accessError("APPROVAL_BUSY", "Eine Inhaltsfreigabe wartet bereits auf eine Antwort oder wird gespeichert.");
      this.promptPending = true;
      let allowed;
      try {
        allowed = await this.requestApproval({ tabId: tab.id, url: tab.url, title: tab.title || "", mode: tabScoped && mode === "allow" ? "ask-every-time" : mode, scope: tabScoped ? "tab" : this.settings.contentScope }, { signal });
        const acceptedAt = this.now();
        assertPending();
        if (!allowed) throw accessError("CONTENT_DENIED", "Inhaltszugriff wurde nicht freigegeben.");
        if (tabScoped) {
          await this.assertTarget(tab.id, tab.url, revision);
          assertPending();
          if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
          if (tabRevision !== (this.tabRevisions.get(tab.id) || 0)) throw accessError("PAGE_CHANGED", "Die Seite wurde während der Freigabe gewechselt. Erneut anfragen.");
          const issuedAt = mode === "ask-five-days" ? acceptedAt : this.now();
          const grant = { tabId: tab.id, url: tab.url, revision, tabRevision, expiresAt: finiteMode ? issuedAt + (mode === "ask-five-days" ? FIVE_DAYS_MS : SESSION_MS) : null };
          let rollback;
          if (mode === "ask-five-days") {
            grant.issuedAt = issuedAt; grant.token = await this.tabToken(tab.id); assertPending();
            rollback = await this.commitFiveDay(tab, grant, revision, tabRevision, assertPending, signal);
          } else if (mode === "ask-session") this.tabGrants.set(tab.id, grant);
          this.authorizations.set(authorization, grant);
          try { const approved = await this.assertScope(tab.id, tab.url, revision, authorization); assertPending(); return approved; }
          catch (error) { rollback?.(); throw error; }
        }
        const current = await this.assertScope(tab.id, tab.url, revision);
        assertPending();
        if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
        if (mode === "ask-session") this.expiresAt = this.now() + SESSION_MS;
        if (mode === "ask-five-days") {
          if (tabRevision !== (this.tabRevisions.get(tab.id) || 0)) throw accessError("PAGE_CHANGED", "Die Seite wurde während der Freigabe gewechselt. Erneut anfragen.");
          const issuedAt = acceptedAt;
          const rollback = await this.commitFiveDay(tab, { issuedAt, expiresAt: issuedAt + FIVE_DAYS_MS }, revision, tabRevision, assertPending, signal);
          try {
            this.bindFiveDayGlobal(tab, authorization, revision, tabRevision);
            const approved = await this.assertScope(tab.id, tab.url, revision, authorization); assertPending(); return approved;
          } catch (error) { rollback(); throw error; }
        }
        return current;
      } finally { this.promptPending = false; }
    }
    async assertAfterRead(tabId, url, revision, authorization) {
      const tab = await this.assertScope(tabId, url, revision, authorization);
      if (revision !== this.revision || !this.settings.enabled) throw accessError("PERMISSION_CHANGED", "Die Freigabe wurde während der Anfrage widerrufen.");
      const grant = this.authorizations.get(authorization);
      if (grant) this.assertGrant(grant, tabId, url, revision);
      if (this.settings.contentMode === "deny") throw accessError("CONTENT_DENIED", "Inhaltszugriff wurde gesperrt.");
      if (!this.authorizations.has(authorization) && ["ask-session", "ask-five-days"].includes(this.settings.contentMode) && (this.expiresAt === null || this.now() >= this.expiresAt)) throw accessError("SESSION_EXPIRED", "Die Inhaltsfreigabe ist während des Auslesens abgelaufen. Erneut anfragen.");
      return tab;
    }
  }
  globalThis.FirefoxBridgePolicy = { SESSION_MS, FIVE_DAYS_MS, DEFAULTS, normalizeSettings, iconStatus, NormalWindowTracker, ContentAccess };
})();
