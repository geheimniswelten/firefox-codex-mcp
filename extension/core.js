/* Shared as a plain background script and a side-effect module in Node tests. */
(() => {
  "use strict";
  const VERSION = "0.1.3";
  const SESSION_KEY = "firefox-codex-mcp.metadata.v1";
  const MAX_RESPONSE_BYTES = 800000; // Leave room for the native RPC envelope.
  const COLORS = ["blue", "cyan", "grey", "green", "orange", "pink", "purple", "red", "yellow"];
  class BridgeError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }
  const fail = (message) => { throw new BridgeError("INVALID_PARAMS", message); };
  const errorData = (error) => ({ code: error.code || "FIREFOX_ERROR", message: String(error.message || error).slice(0, 2000), ...(error.details ? { details: error.details } : {}) });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const pick = (object, names) => Object.fromEntries(names.filter(name => own(object, name)).map(name => [name, object[name]]));
  const date = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : null;
  const validISO = (value) => typeof value === "string" && value.length < 40 && Number.isFinite(Date.parse(value));
  const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  const METHODS = {
    status: [], get_current: [], list_windows: ["populate"],
    list_extensions: ["enabled", "type", "limit", "offset"],
    list_tabs: ["windowId", "active", "audible", "muted", "discarded", "groupId", "limit", "offset"],
    get_tabs: ["tabIds"], create_tab: ["url", "windowId", "active", "pinned", "index"],
    update_tab: ["tabId", "url", "active", "pinned", "muted"], set_muted: ["tabIds", "muted"],
    close_tabs: ["tabIds"], move_tabs: ["tabIds", "windowId", "index"], discard_tabs: ["tabIds"], reload_tabs: ["tabIds", "bypassCache"],
    create_window: ["url", "tabId", "focused", "incognito"], update_window: ["windowId", "focused", "state"], close_window: ["windowId"],
    list_groups: ["windowId"], group_tabs: ["tabIds", "groupId", "windowId", "title", "color", "collapsed"],
    ungroup_tabs: ["tabIds"], update_group: ["groupId", "title", "color", "collapsed"], move_group: ["groupId", "windowId", "index"],
    read_content: ["tabId", "format", "selector", "maxChars", "includeLinks"],
    save_png: ["tabId", "fullPage", "loadDeferred", "maxHeight"], save_html: ["tabId", "loadDeferred"], save_pdf: ["tabId"],
    export_chunk: ["transferId", "index"], export_release: ["transferId"]
  };
  function validUrl(value) {
    if (typeof value !== "string" || value.length > 32768) fail("url muss eine Zeichenfolge mit höchstens 32768 Zeichen sein.");
    if (value === "about:blank") return;
    try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol)) throw new Error(); }
    catch { fail("Nur absolute HTTP(S)-URLs und about:blank sind erlaubt."); }
  }
  function validate(method, p) {
    if (!own(METHODS, method)) throw new BridgeError("METHOD_NOT_FOUND", "Unbekannte Firefox-Methode.");
    if (!p || typeof p !== "object" || Array.isArray(p)) fail("params muss ein Objekt sein.");
    for (const key of Object.keys(p)) if (!METHODS[method].includes(key)) fail(`Unbekannter Parameter: ${key}`);
    for (const key of ["tabId", "windowId", "groupId", "index", "limit", "offset", "maxChars"]) {
      if (!own(p, key)) continue;
      const min = (key === "index" || (key === "groupId" && method === "list_tabs")) ? -1 : 0;
      const max = key === "groupId" ? Number.MAX_SAFE_INTEGER : 2147483647;
      if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > max) fail(`${key} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
    }
    for (const key of ["active", "audible", "muted", "discarded", "pinned", "bypassCache", "focused", "incognito", "populate", "collapsed", "includeLinks", "enabled", "fullPage", "loadDeferred"]) {
      if (own(p, key) && typeof p[key] !== "boolean") fail(`${key} muss boolean sein.`);
    }
    if (own(p, "tabIds")) {
      if (!Array.isArray(p.tabIds) || p.tabIds.length < 1 || p.tabIds.length > 100 || p.tabIds.some(id => !Number.isSafeInteger(id) || id < 0 || id > 2147483647) || new Set(p.tabIds).size !== p.tabIds.length) fail("tabIds muss 1–100 eindeutige, nichtnegative Ganzzahlen bis 2147483647 enthalten.");
    }
    for (const [key, methods] of Object.entries({tabIds: ["get_tabs", "set_muted", "close_tabs", "move_tabs", "discard_tabs", "reload_tabs", "group_tabs", "ungroup_tabs"], tabId: ["update_tab", "read_content", "save_png", "save_html", "save_pdf"], windowId: ["update_window", "close_window"], groupId: ["update_group", "move_group"], index: ["move_tabs", "move_group", "export_chunk"], muted: ["set_muted"], transferId: ["export_chunk", "export_release"]})) {
      if (methods.includes(method) && !own(p, key)) fail(`${key} fehlt.`);
    }
    if (own(p, "url")) {
      if (method === "create_window") {
        if (!Array.isArray(p.url) || p.url.length < 1 || p.url.length > 100) fail("url muss 1–100 URLs enthalten.");
        p.url.forEach(validUrl);
      } else validUrl(p.url);
    }
    if (method === "create_window" && own(p, "url") && own(p, "tabId")) fail("url und tabId können nicht kombiniert werden.");
    if (method === "group_tabs" && own(p, "windowId") && own(p, "groupId")) fail("windowId gilt nur für neue Gruppen; für vorhandene Gruppen nur groupId angeben.");
    if (own(p, "state") && !["normal", "minimized", "maximized", "fullscreen"].includes(p.state)) fail("Ungültiger Fensterzustand.");
    if (own(p, "type") && !["extension", "theme", "all"].includes(p.type)) fail("type muss extension, theme oder all sein.");
    if (own(p, "color") && !COLORS.includes(p.color)) fail("Ungültige Gruppenfarbe.");
    if (own(p, "title") && (typeof p.title !== "string" || p.title.length > 512)) fail("title darf höchstens 512 Zeichen enthalten.");
    if (own(p, "format") && !["text", "html"].includes(p.format)) fail("format muss text oder html sein.");
    if (own(p, "selector") && (typeof p.selector !== "string" || p.selector.length < 1 || p.selector.length > 4096)) fail("selector muss 1–4096 Zeichen enthalten.");
    if (own(p, "limit") && (p.limit < 1 || p.limit > 500)) fail("limit muss zwischen 1 und 500 liegen.");
    if (own(p, "maxChars") && (p.maxChars < 1 || p.maxChars > 100000)) fail("maxChars muss zwischen 1 und 100000 liegen.");
    if (own(p, "maxHeight") && (!Number.isInteger(p.maxHeight) || p.maxHeight < 1 || p.maxHeight > 100000)) fail("maxHeight muss zwischen 1 und 100000 liegen.");
    if (own(p, "transferId") && (typeof p.transferId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(p.transferId))) fail("Ungültige Export-ID.");
    if (method === "export_chunk" && p.index < 0) fail("Export-Blockindex muss nichtnegativ sein.");
    if (method === "create_tab" && p.index === -1) fail("index muss beim Erstellen eines Tabs nichtnegativ sein.");
    for (const name of ["update_tab", "update_window", "update_group"]) if (method === name && Object.keys(p).length < 2) fail("Mindestens eine Änderung muss angegeben werden.");
  }

  class Tracker {
    constructor(browser, now = Date.now) {
      this.browser = browser; this.now = now; this.records = new Map(); this.pending = new Map(); this.writes = new Map(); this.ownDiscards = new Set(); this.listeners = [];
    }
    listen(event, fn) { event.addListener(fn); this.listeners.push([event, fn]); }
    async start() {
      this.listen(this.browser.tabs.onCreated, tab => { this.ensure(tab, true).catch(() => {}); });
      this.listen(this.browser.tabs.onRemoved, id => { this.records.delete(id); this.pending.delete(id); this.ownDiscards.delete(id); });
      this.listen(this.browser.tabs.onActivated, info => { this.activate(info.tabId).catch(() => {}); });
      this.listen(this.browser.tabs.onUpdated, (id, change, tab) => {
        this.update(id, change, tab).catch(() => {});
      });
      this.listen(this.browser.windows.onFocusChanged, id => {
        if (id < 0) return;
        this.browser.tabs.query({ windowId: id, active: true }).then(tabs => Promise.all(tabs.map(tab => this.activate(tab.id)))).catch(() => {});
      });
      const tabs = await this.browser.tabs.query({});
      await Promise.all(tabs.map(tab => this.ensure(tab)));
    }
    async ensure(tab, created = false) {
      if (this.records.has(tab.id)) return this.records.get(tab.id);
      if (this.pending.has(tab.id)) return this.pending.get(tab.id);
      const observedAt = date(this.now());
      const job = (async () => {
        let saved;
        try { saved = await this.browser.sessions.getTabValue(tab.id, SESSION_KEY); } catch { /* Tab may have closed. */ }
        const restored = saved && saved.version === 1 && validISO(saved.firstSeenAt);
        const lastAccessed = date(tab.lastAccessed);
        const metadata = {
          version: 1,
          createdAt: restored && validISO(saved.createdAt) ? saved.createdAt : (restored || !created ? null : observedAt),
          createdAtSource: restored && validISO(saved.createdAt) ? "observed-onCreated" : (restored || !created ? "unknown" : "observed-onCreated"),
          firstSeenAt: restored ? saved.firstSeenAt : observedAt,
          lastActiveAt: restored && validISO(saved.lastActiveAt) ? saved.lastActiveAt : null,
          lastActiveSource: restored && validISO(saved.lastActiveAt) ? (saved.lastActiveSource === "observed" ? "observed" : "firefox-lastAccessed") : "unknown",
          discardSource: tab.discarded ? "unknown" : null
        };
        if (lastAccessed && (!metadata.lastActiveAt || lastAccessed > metadata.lastActiveAt)) { metadata.lastActiveAt = lastAccessed; metadata.lastActiveSource = "firefox-lastAccessed"; }
        // A tab ID is an in-memory handle only; persistence lives on the tab session.
        if (this.pending.get(tab.id) === job) {
          this.records.set(tab.id, metadata);
          await this.save(tab.id, metadata);
        }
        return metadata;
      })();
      this.pending.set(tab.id, job);
      try { return await job; } finally { if (this.pending.get(tab.id) === job) this.pending.delete(tab.id); }
    }
    save(id, metadata) {
      const copy = { ...metadata };
      const job = (this.writes.get(id) || Promise.resolve()).catch(() => {}).then(() => this.browser.sessions.setTabValue(id, SESSION_KEY, copy)).catch(() => {});
      this.writes.set(id, job);
      job.finally(() => { if (this.writes.get(id) === job) this.writes.delete(id); });
      return job;
    }
    async activate(id) {
      const tab = await this.browser.tabs.get(id), metadata = await this.ensure(tab);
      metadata.lastActiveAt = date(this.now()); metadata.lastActiveSource = "observed";
      await this.save(id, metadata);
    }
    async update(id, change, tab) {
      const metadata = await this.ensure(tab);
      if (own(change, "discarded")) {
        metadata.discardSource = change.discarded ? (this.ownDiscards.has(id) ? "this-extension" : "unknown") : null;
        await this.save(id, metadata);
      }
    }
    async format(tab) {
      const metadata = await this.ensure(tab);
      if (!tab.discarded) metadata.discardSource = null;
      const accessed = date(tab.lastAccessed);
      if (accessed && (!metadata.lastActiveAt || accessed > metadata.lastActiveAt)) { metadata.lastActiveAt = accessed; metadata.lastActiveSource = "firefox-lastAccessed"; }
      return { ...pick(tab, ["id", "windowId", "index", "groupId", "url", "title", "active", "pinned", "status", "discarded", "autoDiscardable", "audible", "mutedInfo", "incognito", "hidden", "lastAccessed"]), ...pick(metadata, ["createdAt", "createdAtSource", "firstSeenAt", "lastActiveAt", "lastActiveSource"]), discardSource: tab.discarded ? metadata.discardSource || "unknown" : null };
    }
    stop() { for (const [event, fn] of this.listeners) event.removeListener(fn); this.listeners = []; }
  }

  // This function is serialized, then run in Firefox's isolated content world.
  // Options are JSON data, never caller-provided JavaScript.
  function extractContent(options) {
    let root;
    try { root = options.selector ? document.querySelector(options.selector) : document.documentElement; }
    catch { return { extractionError: "INVALID_SELECTOR", message: "Ungültiger CSS-Selektor." }; }
    if (!root) return { extractionError: "SELECTOR_NOT_FOUND", message: "Kein Element passt zum Selektor." };
    const raw = options.format === "html" ? root.outerHTML : (root.innerText || root.textContent || "");
    const links = [];
    let linksTruncated = false;
    if (options.includeLinks) {
      const elements = root.querySelectorAll("a[href]");
      for (const anchor of elements) {
        if (links.length >= 100) { linksTruncated = true; break; }
        const href = anchor.href || "";
        if (!/^https?:/i.test(href)) continue;
        const label = (anchor.innerText || anchor.textContent || "").trim();
        links.push({ url: href.slice(0, 2048), text: label.slice(0, 256), truncated: href.length > 2048 || label.length > 256 });
      }
    }
    return {
      url: location.href, title: document.title.slice(0, 2048),
      format: options.format, content: raw.slice(0, options.maxChars), totalChars: raw.length,
      truncated: raw.length > options.maxChars, frame: "main", untrustedContent: true,
      ...(options.includeLinks ? { links, linksTruncated } : {})
    };
  }

  // Keep mutation outcomes intact, including partial failures, while bounding strings.
  function boundResponse(result) {
    let truncatedStrings = false;
    function clip(value, max) {
      if (typeof value === "string") { if (value.length > max) { truncatedStrings = true; return value.slice(0, max); } return value; }
      if (Array.isArray(value)) return value.map(item => clip(item, max));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, clip(val, max)]));
      return value;
    }
    let output = result;
    if (size(output) <= MAX_RESPONSE_BYTES) return output;
    // Reduce paginated pages before clipping strings, keeping the cursor exact.
    const listKey = Array.isArray(output.tabs) ? "tabs" : Array.isArray(output.extensions) ? "extensions" : null;
    if (listKey && own(output, "offset")) {
      output = { ...output, [listKey]: [...output[listKey]], truncated: true, truncationReason: "packet-size" };
      const candidates = output[listKey];
      let low = 1, high = candidates.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (size({ ...output, [listKey]: candidates.slice(0, middle) }) <= MAX_RESPONSE_BYTES - 1000) low = middle;
        else high = middle - 1;
      }
      output[listKey] = candidates.slice(0, low);
      output.returned = output[listKey].length;
      output.nextOffset = output.offset + output[listKey].length < output.total ? output.offset + output[listKey].length : null;
    }
    for (let max = 50000; size(output) > MAX_RESPONSE_BYTES && max >= 128; max = Math.floor(max / 2)) output = clip(output, max);
    if (truncatedStrings) output = { ...output, truncated: true, truncationReason: "packet-size", stringsTruncated: true };
    if (size(output) > MAX_RESPONSE_BYTES) {
      // Windows may contain thousands of tabs; use list_tabs per window for details.
      if (Array.isArray(output.windows)) {
        output = { ...output, windows: output.windows.map(window => {
          const { tabs, ...rest } = window;
          return tabs ? { ...rest, tabs: [], tabsTotal: tabs.length, tabsTruncated: true } : window;
        }), truncated: true, truncationReason: "packet-size", hint: "Für Tabdetails list_tabs mit windowId und offset verwenden." };
      }
    }
    if (size(output) > MAX_RESPONSE_BYTES) throw new BridgeError("RESPONSE_TOO_LARGE", "Antwort zu groß. Bitte den Bereich einschränken.");
    return output;
  }

  function createService(browser, options = {}) {
    const tracker = new Tracker(browser, options.now);
    const transfers = globalThis.FirefoxBridgeTransfers?.createTransfers({ now: options.now });
    const exporting = new Set();
    const ready = tracker.start();
    const groupApi = () => {
      if (!browser.tabGroups || typeof browser.tabs.group !== "function") throw new BridgeError("UNSUPPORTED", "Native Tabgruppen benötigen Firefox 139 oder neuer.");
    };
    const formatWindow = async window => ({ ...pick(window, ["id", "focused", "incognito", "type", "state", "alwaysOnTop", "width", "height", "left", "top"]), ...(window.tabs ? { tabs: await Promise.all(window.tabs.map(tab => tracker.format(tab))) } : {}) });
    const getTab = async id => tracker.format(await browser.tabs.get(id));
    const batch = async (ids, operation, assertLive) => {
      const results = [];
      for (const tabId of ids) { try { assertLive?.(); results.push({ tabId, result: await operation(tabId) }); } catch (error) { results.push({ tabId, error: errorData(error) }); } }
      return { results, partialFailure: results.some(item => item.error) };
    };
    const groupFields = p => pick(p, ["title", "color", "collapsed"]);
    const requireInventoryPermission = async () => {
      const permissions = browser.permissions?.getAll ? await browser.permissions.getAll() : {};
      if (!permissions.data_collection?.includes("technicalAndInteraction")) {
        throw new BridgeError("INVENTORY_PERMISSION_REQUIRED", "Im Symbolleistenmenü zuerst ‚Erweiterungsliste und Browser-Version freigeben‘ aktivieren. Alternativ die optionalen technischen Daten unter about:addons freigeben.");
      }
    };
    async function handle(method, params = {}, context = {}) {
      validate(method, params); await ready;
      context.assertLive?.();
      const p = params;
      switch (method) {
        case "status": {
          const permissions = browser.permissions?.getAll ? await browser.permissions.getAll() : {};
          const technicalAllowed = permissions.data_collection?.includes("technicalAndInteraction");
          return { version: VERSION, connected: true, nativeGroups: Boolean(browser.tabGroups && browser.tabs.group), exports: { png: Boolean(transfers && globalThis.FirefoxBridgePng && browser.tabs.captureTab), html: Boolean(transfers && globalThis.FirefoxBridgeHtml), pdf: Boolean(globalThis.FirefoxBridgePdf && browser.tabs.saveAsPDF), pdfDestination: "save-dialog" }, tracking: "session-tab-values", createdAtSemantics: "Observed onCreated time; pre-existing unknown; restored metadata retained.", discardAttribution: "Only successful discards from this extension can be attributed. Firefox and Auto Tab Discard share discarded state.", ...(technicalAllowed && browser.runtime.getBrowserInfo ? { browser: await browser.runtime.getBrowserInfo() } : {}) };
        }
        case "get_current": {
          const window = options.contentAccess ? await options.contentAccess.getCurrentWindow() : await browser.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
          return { window: await formatWindow({ ...window, tabs: undefined }), tab: window.tabs?.find(tab => tab.active) ? await tracker.format(window.tabs.find(tab => tab.active)) : null, semantics: "last-focused-normal-window", firefoxFocused: Boolean(window.focused) };
        }
        case "list_windows": return { windows: await Promise.all((await browser.windows.getAll({ populate: p.populate ?? false })).map(formatWindow)) };
        case "list_extensions": {
          await requireInventoryPermission();
          context.assertLive?.();
          if (typeof browser.management?.getAll !== "function") throw new BridgeError("MANAGEMENT_UNAVAILABLE", "Die Erweiterungsverwaltung ist nicht verfügbar. Aktualisierte Erweiterung mit management-Berechtigung neu laden.");
          const type = p.type ?? "extension";
          const addons = (await browser.management.getAll())
            .filter(addon => ["extension", "theme"].includes(addon.type) && (type === "all" || addon.type === type) && (!own(p, "enabled") || addon.enabled === p.enabled))
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
          // Permission revocation must also stop an in-flight inventory response.
          await requireInventoryPermission();
          context.assertLive?.();
          const offset = p.offset ?? 0, limit = p.limit ?? 100;
          const extensions = addons.slice(offset, offset + limit).map(addon => pick(addon, ["id", "name", "version", "type", "enabled", "description", "installType", "disabledReason"]));
          return { extensions, total: addons.length, offset, limit, returned: extensions.length, nextOffset: offset + extensions.length < addons.length ? offset + extensions.length : null };
        }
        case "list_tabs": {
          const tabs = await browser.tabs.query(pick(p, ["windowId", "active", "audible", "muted", "discarded", "groupId"]));
          tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
          const offset = p.offset ?? 0, limit = p.limit ?? 100;
          const page = tabs.slice(offset, offset + limit);
          return { tabs: await Promise.all(page.map(tab => tracker.format(tab))), total: tabs.length, offset, limit, returned: page.length, nextOffset: offset + page.length < tabs.length ? offset + page.length : null };
        }
        case "get_tabs": return batch(p.tabIds, getTab, context.assertLive);
        case "create_tab": return tracker.format(await browser.tabs.create(p));
        case "update_tab": return tracker.format(await browser.tabs.update(p.tabId, pick(p, ["url", "active", "pinned", "muted"])));
        case "set_muted": return batch(p.tabIds, async id => tracker.format(await browser.tabs.update(id, { muted: p.muted })), context.assertLive);
        case "close_tabs": return batch(p.tabIds, async id => { await browser.tabs.remove(id); return { closed: true }; }, context.assertLive);
        case "reload_tabs": return batch(p.tabIds, async id => { await browser.tabs.reload(id, { bypassCache: p.bypassCache ?? false }); return { reloadRequested: true }; }, context.assertLive);
        case "discard_tabs": return batch(p.tabIds, async id => {
          const before = await browser.tabs.get(id);
          if (before.discarded) return { ...await tracker.format(before), alreadyDiscarded: true };
          if (before.active) throw new BridgeError("ACTIVE_TAB", "Aktive Tabs lassen sich nicht entladen. Zuerst einen anderen Tab aktivieren.");
          context.assertLive?.();
          tracker.ownDiscards.add(id);
          try {
            await browser.tabs.discard(id);
            const tab = await browser.tabs.get(id);
            if (!tab.discarded) throw new BridgeError("DISCARD_REFUSED", "Firefox hat den Tab nicht entladen (z. B. wegen Medienwiedergabe).");
            const metadata = await tracker.ensure(tab); metadata.discardSource = "this-extension"; await tracker.save(id, metadata);
            return tracker.format(tab);
          } finally { tracker.ownDiscards.delete(id); }
        }, context.assertLive);
        case "move_tabs": {
          // Firefox moves the set together, preserving its native order semantics.
          try {
            await browser.tabs.move(p.tabIds, pick(p, ["windowId", "index"]));
            return batch(p.tabIds, getTab, context.assertLive);
          } catch (error) {
            // The native call is not guaranteed transactional; report current state.
            return { results: await Promise.all(p.tabIds.map(async tabId => ({ tabId, error: errorData(error), current: await getTab(tabId).catch(() => null) }))), partialFailure: true, stateMayHaveChanged: true };
          }
        }
        case "create_window": return formatWindow(await browser.windows.create(p));
        case "update_window": return formatWindow(await browser.windows.update(p.windowId, pick(p, ["focused", "state"])));
        case "close_window": await browser.windows.remove(p.windowId); return { windowId: p.windowId, closed: true };
        case "list_groups": groupApi(); return { groups: await browser.tabGroups.query(pick(p, ["windowId"])) };
        case "group_tabs": {
          groupApi();
          const properties = { tabIds: p.tabIds, ...(own(p, "groupId") ? { groupId: p.groupId } : { createProperties: pick(p, ["windowId"]) }) };
          let id;
          try { id = await browser.tabs.group(properties); }
          catch (error) { return { results: p.tabIds.map(tabId => ({ tabId, error: errorData(error) })), partialFailure: true }; }
          let group, updateError;
          try { context.assertLive?.(); group = Object.keys(groupFields(p)).length ? await browser.tabGroups.update(id, groupFields(p)) : await browser.tabGroups.get(id); }
          catch (error) { updateError = errorData(error); }
          return { ...await batch(p.tabIds, getTab, context.assertLive), groupId: id, ...(group ? { group } : {}), ...(updateError ? { groupUpdateError: updateError, partialFailure: true } : {}) };
        }
        case "ungroup_tabs": groupApi(); return batch(p.tabIds, async id => { await browser.tabs.ungroup(id); return getTab(id); }, context.assertLive);
        case "update_group": groupApi(); return browser.tabGroups.update(p.groupId, groupFields(p));
        case "move_group": groupApi(); return browser.tabGroups.move(p.groupId, pick(p, ["windowId", "index"]));
        case "export_chunk": {
          if (!transfers) throw new BridgeError("EXPORT_UNAVAILABLE", "Aktualisierte Erweiterung neu laden.");
          const result = await transfers.chunk(p.transferId, p.index);
          context.assertLive?.(); return result;
        }
        case "export_release": return transfers ? transfers.release(p.transferId) : { released: false };
        case "save_png": case "save_html": case "save_pdf": {
          let tab = await browser.tabs.get(p.tabId);
          if (tab.discarded) throw new BridgeError("TAB_DISCARDED", "Tab ist entladen. Vor dem Export ausdrücklich reload_tabs aufrufen.");
          if (!/^https?:\/\//i.test(tab.url || "")) throw new BridgeError("RESTRICTED_PAGE", "Exporte sind nur für HTTP(S)-Seiten verfügbar.");
          const authorizedUrl = tab.url, revision = options.contentAccess?.revision, authorization = {};
          if (options.contentAccess) tab = await options.contentAccess.authorize(tab, authorization);
          const tabRevision = options.contentAccess?.tabRevisions?.get(p.tabId) || 0;
          const assertExportLive = () => {
            context.assertLive?.();
            const access = options.contentAccess;
            if (access && access.revision !== revision) throw new BridgeError("PERMISSION_CHANGED", "Die Inhaltsfreigabe wurde während des Exports widerrufen.");
            if (access?.tabRevisions && (access.tabRevisions.get(p.tabId) || 0) !== tabRevision) throw new BridgeError("PAGE_CHANGED", "Die Seite wurde seit der Inhaltsfreigabe gewechselt.");
            const grant = access?.authorizations?.get(authorization);
            if (grant) access.assertGrant(grant, p.tabId, authorizedUrl, revision);
            else if (access?.settings?.contentMode === "ask-session" && (access.expiresAt === null || access.now() >= access.expiresAt)) throw new BridgeError("SESSION_EXPIRED", "Die Inhaltsfreigabe ist während des Exports abgelaufen.");
          };
          const assertAccess = async () => {
            const current = options.contentAccess
              ? await options.contentAccess.assertAfterRead(p.tabId, authorizedUrl, revision, authorization)
              : await browser.tabs.get(p.tabId);
            if (current.url !== authorizedUrl) throw new BridgeError("PAGE_CHANGED", "Die Seite wurde während des Exports gewechselt.");
            if (current.discarded) throw new BridgeError("TAB_DISCARDED", "Der Tab wurde während des Exports entladen.");
          };
          await assertAccess(); assertExportLive();
          if (exporting.has(p.tabId)) throw new BridgeError("EXPORT_BUSY", "In diesem Tab läuft bereits ein Export.");
          exporting.add(p.tabId);
          try {
            const module = globalThis[method === "save_png" ? "FirefoxBridgePng" : method === "save_html" ? "FirefoxBridgeHtml" : "FirefoxBridgePdf"];
            if (!module || (method !== "save_pdf" && !transfers)) throw new BridgeError("EXPORT_UNAVAILABLE", "Aktualisierte Erweiterung mit Export-Unterstützung neu laden.");
            const exportContext = { assertLive: assertExportLive, assertAccess };
            // PDF is saved by Firefox's native picker: its completed outcome must not
            // be erased by a later policy change or represented as an unsaved file.
            if (method === "save_pdf") return await module.save(browser, tab, exportContext);
            const result = await module.capture(browser, p.tabId, p, exportContext);
            await assertAccess(); assertExportLive();
            let bytes;
            if (method === "save_html") {
              if (typeof result.content !== "string") throw new BridgeError("INVALID_EXPORT", "HTML-Export lieferte keinen Seiteninhalt.");
              const limit = globalThis.FirefoxBridgeTransfers.MAX_BYTES;
              let byteLength = 0;
              for (let i = 0; i < result.content.length; i++) {
                const char = result.content.charCodeAt(i);
                if (char < 0x80) byteLength++;
                else if (char < 0x800) byteLength += 2;
                else if (char >= 0xd800 && char <= 0xdbff && result.content.charCodeAt(i + 1) >= 0xdc00 && result.content.charCodeAt(i + 1) <= 0xdfff) { byteLength += 4; i++; }
                else byteLength += 3;
                if (byteLength > limit) throw new BridgeError("EXPORT_TOO_LARGE", "HTML-Export überschreitet 128 MiB.");
              }
              bytes = new TextEncoder().encode(result.content);
            } else {
              if (typeof result.data !== "string") throw new BridgeError("INVALID_EXPORT", "PNG-Export lieferte keine Bilddaten.");
              const byteLength = result.data.length / 4 * 3 - (result.data.endsWith("==") ? 2 : result.data.endsWith("=") ? 1 : 0);
              if (byteLength > globalThis.FirefoxBridgeTransfers.MAX_BYTES) throw new BridgeError("EXPORT_TOO_LARGE", "PNG-Export überschreitet 128 MiB.");
              bytes = new Uint8Array(byteLength);
              // Decode in bounded pieces instead of allocating a second full-size
              // binary string or constructing an intermediate iterable array.
              let offset = 0;
              for (let start = 0; start < result.data.length; start += 32768) {
                const binary = atob(result.data.slice(start, start + 32768));
                for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i);
              }
            }
            return transfers.put(bytes, { tabId: p.tabId, url: authorizedUrl, mimeType: method === "save_png" ? "image/png" : "text/html", ...(method === "save_png" ? pick(result, ["width", "height", "scale", "fullPage"]) : {}), warnings: (result.warnings || []).slice(0, 50).map(warning => String(warning).slice(0, 2000)), untrustedContent: true }, assertAccess);
          } finally { exporting.delete(p.tabId); }
        }
        case "read_content": {
          let tab = await browser.tabs.get(p.tabId);
          if (tab.discarded) throw new BridgeError("TAB_DISCARDED", "Tab ist entladen. Erst ausdrücklich reload_tabs aufrufen, dann erneut lesen.");
          if (!/^https?:\/\//i.test(tab.url || "")) throw new BridgeError("RESTRICTED_PAGE", "Seiteninhalt ist nur für HTTP(S)-Seiten verfügbar; interne Firefox- und Erweiterungsseiten sind ausgeschlossen.");
          const authorizedUrl = tab.url, policyRevision = options.contentAccess?.revision, authorization = {};
          if (options.contentAccess) tab = await options.contentAccess.authorize(tab, authorization);
          context.assertLive?.();
          if (tab.discarded) throw new BridgeError("TAB_DISCARDED", "Der Tab wurde während der Freigabe entladen. Zuerst ausdrücklich reload_tabs aufrufen.");
          const extraction = { format: p.format ?? "text", maxChars: p.maxChars ?? 30000, includeLinks: p.includeLinks ?? false, ...(p.selector ? { selector: p.selector } : {}) };
          let result;
          try { [result] = await browser.tabs.executeScript(p.tabId, { code: `(${extractContent.toString()})(${JSON.stringify(extraction)})`, frameId: 0, allFrames: false, runAt: "document_idle" }); }
          catch (error) { throw new BridgeError("CONTENT_UNAVAILABLE", `Firefox erlaubt hier keinen Inhaltszugriff oder die Seite wurde geschlossen: ${String(error.message || error).slice(0, 1000)}`); }
          if (!result) throw new BridgeError("CONTENT_UNAVAILABLE", "Keine Antwort vom Hauptframe.");
          if (result.extractionError) throw new BridgeError(result.extractionError, result.message);
          context.assertLive?.();
          if (result.url !== authorizedUrl) throw new BridgeError("PAGE_CHANGED", "Die Seite wurde während des Auslesens gewechselt. Erneut anfragen.");
          if (options.contentAccess) await options.contentAccess.assertAfterRead(p.tabId, authorizedUrl, policyRevision, authorization);
          context.assertLive?.();
          return { tabId: p.tabId, ...result };
        }
      }
    }
    return { ready, tracker, clearExports: () => transfers?.clear(), handle: async (method, params, context) => {
      const result = await handle(method, params, context);
      // Binary blocks must never pass through generic string clipping.
      if (method === "export_chunk") {
        if (size(result) > MAX_RESPONSE_BYTES) throw new BridgeError("RESPONSE_TOO_LARGE", "Export-Block überschreitet die Paketgrenze.");
        return result;
      }
      return boundResponse(result);
    } };
  }
  globalThis.FirefoxBridgeCore = { VERSION, SESSION_KEY, MAX_RESPONSE_BYTES, BridgeError, errorData, validate, Tracker, createService, extractContent, boundResponse };
})();
