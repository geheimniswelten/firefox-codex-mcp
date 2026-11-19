(() => {
  "use strict";
  const MAX_TABS = 20;
  const MAX_HTML_BYTES = 2 * 1024 * 1024;
  const MAX_TEXT_CHARS = 100_000;
  const TAB_TIMEOUT_MS = 15_000;
  const SEARCH_TIMEOUT_MS = 125_000;
  const METADATA_KEYS = new Set(["og:title", "og:description", "twitter:title", "twitter:description", "description", "author", "article:author"]);
  const FIREFOX_PROTECTED_HOSTS = new Set([
    "accounts-static.cdn.mozilla.net", "accounts.firefox.com", "addons.cdn.mozilla.net", "addons.mozilla.org",
    "api.accounts.firefox.com", "content.cdn.mozilla.net", "discovery.addons.mozilla.org", "install.mozilla.org",
    "oauth.accounts.firefox.com", "profile.accounts.firefox.com", "support.mozilla.org", "sync.services.mozilla.com"
  ]);
  const error = (code, message, details) => Object.assign(new Error(message), { code, details });
  const normalize = text => text.replace(/\s+/gu, " ").trim();
  const field = (value, max = 512) => typeof value === "string" ? normalize(value).slice(0, max) : "";

  function validate(p) {
    if (!Array.isArray(p.tabIds) || p.tabIds.length < 1 || p.tabIds.length > MAX_TABS ||
        p.tabIds.some(id => !Number.isInteger(id) || id < 0 || id > 2147483647) || new Set(p.tabIds).size !== p.tabIds.length) {
      throw error("INVALID_PARAMS", "tabIds benötigt 1–20 verschiedene Tab-IDs.");
    }
    if (typeof p.query !== "string" || p.query.length > 512 || !p.query.trim()) {
      throw error("INVALID_PARAMS", "query benötigt 1–512 Zeichen und darf nicht leer sein.");
    }
    if (Object.hasOwn(p, "caseSensitive") && typeof p.caseSensitive !== "boolean") {
      throw error("INVALID_PARAMS", "caseSensitive muss ein boolescher Wert sein.");
    }
    if (Object.hasOwn(p, "discardedMode") && !["html", "render"].includes(p.discardedMode)) {
      throw error("INVALID_PARAMS", "discardedMode muss html oder render sein.");
    }
  }

  // Only parse JSON data. Do not load JSON-LD contexts, linked author pages, or resources.
  function metadata({ title, meta, json }) {
    const structured = [];
    for (const source of json) {
      try {
        const pending = [JSON.parse(source)];
        for (let i = 0; i < pending.length && i < 100; i++) {
          const node = pending[i];
          if (!node || typeof node !== "object") continue;
          if (Array.isArray(node)) { pending.push(...node.slice(0, 100)); continue; }
          if ([node["@type"]].flat().some(type => /^(?:VideoObject|Article|NewsArticle|BlogPosting|SocialMediaPosting|ImageObject)$/u.test(type))) structured.push(node);
          if (node["@graph"]) pending.push(node["@graph"]);
          if (node.mainEntity) pending.push(node.mainEntity);
        }
      } catch { /* Invalid structured metadata is common. */ }
    }
    let name = "", author = "", description = "";
    for (const item of structured) {
      name ||= field(item.headline) || field(item.name);
      description ||= field(item.description, 1024);
      author ||= [item.author ?? item.creator].flat().slice(0, 5).map(person => field(typeof person === "string" ? person : person?.name)).filter(Boolean).join(", ").slice(0, 512);
    }
    const byline = field(meta.author || meta["article:author"]);
    return {
      title: name || field(meta["og:title"] || meta["twitter:title"] || title),
      author: author || (/^https?:\/\//iu.test(byline) ? "" : byline),
      description: description || field(meta["og:description"] || meta["twitter:description"] || meta.description, 1024)
    };
  }

  function extractHtml(html) {
    const document = FirefoxBridgeHtmlParser.parse(html, { scriptingEnabled: true });
    const meta = Object.create(null), json = [], text = [];
    const skipped = new Set(["style", "noscript", "template", "svg", "iframe", "object", "select", "textarea"]);
    const blocks = new Set(["address", "article", "blockquote", "br", "dd", "div", "dt", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "p", "pre", "section", "td", "tr"]);
    const pending = [{ node: document, inBody: false }];
    const boundary = {};
    let title = "", length = 0;
    while (pending.length) {
      const { node, inBody } = pending.pop();
      if (node === boundary) { if (length <= MAX_TEXT_CHARS) { text.push(" "); length++; } continue; }
      const tag = node.tagName;
      if (skipped.has(tag)) continue;
      const attribute = name => node.attrs?.find(attr => attr.name === name)?.value;
      if (inBody && (attribute("hidden") !== undefined || attribute("aria-hidden") === "true")) continue;
      if (node.nodeName === "#text" && inBody && length <= MAX_TEXT_CHARS) {
        text.push(node.value.slice(0, MAX_TEXT_CHARS + 1 - length));
        length += node.value.length;
      }
      if (tag === "title" && !title) title = node.childNodes?.[0]?.value || "";
      if (tag === "meta") {
        const key = (attribute("property") || attribute("name") || "").toLowerCase();
        if (METADATA_KEYS.has(key) && !meta[key]) meta[key] = attribute("content") || "";
      }
      if (tag === "script") {
        const value = node.childNodes?.[0]?.value;
        if (attribute("type") === "application/ld+json" && value && value.length <= 100_000 && json.length < 8) json.push(value);
        continue;
      }
      const block = inBody && blocks.has(tag);
      if (block && length <= MAX_TEXT_CHARS) {
        text.push(" "); length++;
        pending.push({ node: boundary, inBody });
      }
      for (let i = (node.childNodes?.length || 0) - 1; i >= 0; i--) pending.push({ node: node.childNodes[i], inBody: inBody || tag === "body" });
    }
    return { ...metadata({ title, meta, json }), text: text.join("").slice(0, MAX_TEXT_CHARS), truncated: length > MAX_TEXT_CHARS };
  }

  async function fetchHtml(url, signal, fetchPage) {
    let response;
    try {
      response = await fetchPage(url, {
        signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
    } catch {
      signal.throwIfAborted();
      throw error("HTML_UNAVAILABLE", "Die HTML-Antwort konnte nicht abgerufen werden. Weiterleitungen werden nicht verfolgt.");
    }
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !response.body || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(type)) {
      void response.body?.cancel().catch(() => {});
      throw error("HTML_UNAVAILABLE", "Die URL lieferte keine erfolgreiche HTML-Antwort.", { httpStatus: response.status });
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0, truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        chunks.push(value.subarray(0, MAX_HTML_BYTES - received));
        received += value.byteLength;
        if (received > MAX_HTML_BYTES) { truncated = true; break; }
      }
    } finally {
      if (truncated || signal.aborted) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(Math.min(received, MAX_HTML_BYTES));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headerCharset = /charset\s*=\s*["']?([\w.-]+)/iu.exec(type)?.[1];
    const earlyHtml = new TextDecoder("windows-1252").decode(bytes.subarray(0, 1024));
    const metaCharset = /<meta\b[^>]*\bcharset\s*=\s*["']?([\w.-]+)/iu.exec(earlyHtml)?.[1];
    let decoder;
    try { decoder = new TextDecoder(headerCharset || metaCharset || "utf-8"); }
    catch { decoder = new TextDecoder(); }
    const data = extractHtml(decoder.decode(bytes));
    return { ...data, truncated: data.truncated || truncated };
  }

  // Serialized into the isolated content world for a single main-frame read.
  function probe({ url, maxChars, keys }) {
    if (location.href !== url) return null;
    const meta = Object.create(null), json = [];
    for (const element of document.querySelectorAll("head meta[name], head meta[property]")) {
      const key = (element.getAttribute("property") || element.getAttribute("name") || "").toLowerCase();
      if (keys.includes(key) && !meta[key]) meta[key] = (element.getAttribute("content") || "").slice(0, 1024);
    }
    for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
      const value = element.textContent;
      if (value && value.length <= 100_000) json.push(value);
      if (json.length === 8) break;
    }
    const text = document.body?.innerText || "";
    return { url: location.href, title: document.title.slice(0, 1024), meta, json, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  async function cancellable(signal, work) {
    signal.throwIfAborted();
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([work(), stopped]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  async function readDom(browser, tab, url, signal) {
    const settings = { url, maxChars: MAX_TEXT_CHARS, keys: [...METADATA_KEYS] };
    let data;
    try {
      [data] = await cancellable(signal, () => browser.tabs.executeScript(tab.id, {
        code: [ "(", probe.toString(), ")(", JSON.stringify(settings), ")" ].join(""),
        frameId: 0, allFrames: false, runAt: "document_idle"
      }));
    } catch {
      signal.throwIfAborted();
      throw error("CONTENT_UNAVAILABLE", "Firefox konnte den Hauptframe nicht lesen.");
    }
    if (!data || data.url !== url) throw error("PAGE_CHANGED", "Die URL hat sich während der Inhaltssuche geändert.");
    return { ...metadata(data), text: data.text, truncated: data.truncated };
  }

  async function renderBackground(browser, tab, signal, assertAccess) {
    let id, selected = false, removed = false;
    const onActivated = event => { if (event.tabId === id) selected = true; };
    const onRemoved = tabId => { if (tabId === id) removed = true; };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onRemoved.addListener(onRemoved);
    try {
      // A fresh GET avoids replaying a detached tab's session or POST history.
      const temporary = await browser.tabs.create({ windowId: tab.windowId, url: tab.url, active: false, muted: true });
      id = temporary.id;
      selected ||= temporary.active;
      if (id === tab.id) throw error("RENDER_CLEANUP_FAILED", "Firefox lieferte keine separate Tab-ID.");
      const assertBackground = async () => {
        await assertAccess();
        signal.throwIfAborted();
        const current = await browser.tabs.get(id);
        selected ||= current.active;
        if (selected) throw error("RENDER_TAB_SELECTED", "Der temporäre Tab wurde ausgewählt und bleibt geöffnet.", { temporaryTabId: id });
        if (current.url !== tab.url || current.discarded) throw error("PAGE_CHANGED", "Der temporäre Tab hat die erwartete URL oder den Ladezustand gewechselt.");
      };
      await FirefoxBridgeWait.waitFor(browser, { tabId: id, url: tab.url, loadComplete: true, timeoutMs: TAB_TIMEOUT_MS }, { signal });
      await assertBackground();
      const result = await readDom(browser, temporary, tab.url, signal);
      await assertBackground();
      return result;
    } finally {
      try {
        if (id !== undefined && id !== tab.id && !removed) {
          let current;
          try { current = await browser.tabs.get(id); }
          catch { if (!removed) throw error("RENDER_CLEANUP_FAILED", "Der Status des temporären Tabs ist unbekannt.", { temporaryTabId: id }); }
          if (selected || current?.active) {
            throw error("RENDER_TAB_SELECTED", "Der temporäre Tab wurde ausgewählt und bleibt geöffnet.", { temporaryTabId: id });
          }
          if (current && !removed) {
            try { await browser.tabs.remove(id); }
            catch { if (!removed) throw error("RENDER_CLEANUP_FAILED", "Firefox konnte den temporären Tab nicht schließen.", { temporaryTabId: id }); }
            if (!removed && await browser.tabs.get(id).catch(() => null)) {
              throw error("RENDER_CLEANUP_FAILED", "Firefox hat den temporären Tab noch nicht geschlossen. Die Suche wurde gestoppt.", { temporaryTabId: id });
            }
          }
        }
      } finally {
        browser.tabs.onActivated.removeListener(onActivated);
        browser.tabs.onRemoved.removeListener(onRemoved);
      }
    }
  }

  function matchPage(data, query, caseSensitive) {
    const needle = normalize(query);
    const fold = value => caseSensitive ? value : value.toLowerCase();
    const fields = ["title", "author", "description", "text"];
    for (const key of fields) {
      const value = normalize(data[key]);
      const index = fold(value).indexOf(fold(needle));
      if (index < 0) continue;
      const start = Math.max(0, index - 80), end = Math.min(value.length, index + needle.length + 80);
      return { field: key, snippet: value.slice(start, end) };
    }
    return null;
  }

  function createSearch(browser, { contentAccess, fetchPage = globalThis.fetch } = {}) {
    let running = false;
    return async (p, context = {}) => {
      if (running) throw error("BUSY", "Eine Tab-Inhaltssuche läuft bereits.");
      if (!contentAccess) throw error("CONTENT_DENIED", "Für die Tab-Inhaltssuche ist eine Inhaltsfreigabe erforderlich.");
      running = true;
      const controller = new AbortController();
      const cancel = () => controller.abort(context.signal.reason);
      context.signal?.addEventListener("abort", cancel, { once: true });
      if (context.signal?.aborted) cancel();
      const timeout = setTimeout(() => controller.abort(error("SEARCH_TIMEOUT", "Das Zeitlimit der Inhaltssuche wurde erreicht.")),
        Math.max(1, Math.min(SEARCH_TIMEOUT_MS, (context.expiresAt ?? Infinity) - Date.now() - 1000)));
      const searchRevision = contentAccess.revision;
      const guard = signal => {
        signal.throwIfAborted();
        context.assertLive?.();
        if (searchRevision !== contentAccess.revision) throw error("PERMISSION_CHANGED", "Die Inhaltsfreigaben wurden während der Suche geändert.");
      };
      const results = [];
      try {
        for (const tabId of p.tabIds) {
          if (controller.signal.aborted) {
            if (controller.signal.reason?.code !== "SEARCH_TIMEOUT") controller.signal.throwIfAborted();
            break;
          }
          guard(controller.signal);
          const page = new AbortController();
          const signal = AbortSignal.any([controller.signal, page.signal]);
          let watched = false, timer;
          const onUpdated = (id, change) => {
            if (id === tabId && (Object.hasOwn(change, "url") || change.status === "loading" || Object.hasOwn(change, "discarded"))) {
              page.abort(error("PAGE_CHANGED", "Der ursprüngliche Tab hat während der Suche URL oder Ladezustand gewechselt."));
            }
          };
          const onRemoved = id => { if (id === tabId) page.abort(error("TAB_CLOSED", "Der ursprüngliche Tab wurde geschlossen.")); };
          try {
            browser.tabs.onUpdated.addListener(onUpdated);
            browser.tabs.onRemoved.addListener(onRemoved);
            watched = true;
            const tab = await browser.tabs.get(tabId);
            let url;
            try { url = new URL(tab.url); } catch { /* Invalid or unavailable URL. */ }
            if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || FIREFOX_PROTECTED_HOSTS.has(url.hostname.replace(/\.$/u, ""))) {
              throw error("RESTRICTED_PAGE", "Die Inhaltssuche ist nur für zugängliche HTTP(S)-Seiten verfügbar.");
            }
            const source = !tab.discarded ? "live-dom" : p.discardedMode === "render" ? "background-dom" : "fetched-html";
            if (source === "fetched-html" && tab.incognito) {
              throw error("PRIVATE_TAB", "Der HTML-Abruf steht in privaten Tabs nicht zur Verfügung.");
            }
            const authorization = {}, policyOptions = { allowDiscarded: tab.discarded === true };
            const assertAccess = async () => {
              guard(signal);
              await contentAccess.assertAfterRead(tabId, tab.url, searchRevision, authorization, policyOptions);
              guard(signal);
            };
            guard(signal);
            await contentAccess.authorize(tab, authorization, { ...policyOptions, signal });
            await assertAccess();
            timer = setTimeout(() => page.abort(error("TAB_SEARCH_TIMEOUT", "Das Zeitlimit für diesen Tab wurde erreicht.")), TAB_TIMEOUT_MS);
            let data;
            if (source === "fetched-html") {
              if (browser.permissions?.contains && !await browser.permissions.contains({ origins: [url.protocol + "//" + url.hostname + "/*"] })) {
                throw error("CONTENT_UNAVAILABLE", "Firefox hat der Erweiterung keinen Zugriff auf diese Website gewährt.");
              }
              await assertAccess();
              data = await fetchHtml(url.href, signal, fetchPage);
            } else if (source === "background-dom") {
              data = await renderBackground(browser, tab, signal, assertAccess);
            } else {
              data = await readDom(browser, tab, tab.url, signal);
            }
            await assertAccess();
            const match = matchPage(data, p.query, p.caseSensitive);
            const { title, author, description } = data;
            results.push({ tabId, url: tab.url.slice(0, 4096), source, matched: Boolean(match), truncated: data.truncated, ...(match && { match, title, author, description }) });
          } catch (failure) {
            const { errorData } = globalThis.FirefoxBridgeCore;
            results.push({ tabId, error: errorData(failure) });
            if (["RENDER_CLEANUP_FAILED", "RENDER_TAB_SELECTED", "PERMISSION_CHANGED", "MCP_DISABLED"].includes(failure.code)) break;
          } finally {
            clearTimeout(timer);
            if (watched) {
              browser.tabs.onUpdated.removeListener(onUpdated);
              browser.tabs.onRemoved.removeListener(onRemoved);
            }
          }
        }
        if (controller.signal.aborted && controller.signal.reason?.code !== "SEARCH_TIMEOUT") controller.signal.throwIfAborted();
        if (searchRevision !== contentAccess.revision) throw error("PERMISSION_CHANGED", "Die Inhaltsfreigaben wurden während der Suche geändert.");
        const unsearchedTabIds = p.tabIds.slice(results.length);
        return {
          results, matches: results.filter(result => result.matched).length, unsearchedTabIds,
          incomplete: unsearchedTabIds.length > 0 || results.some(result => result.error || result.truncated),
          partialFailure: results.some(result => result.error), untrustedContent: true
        };
      } finally {
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", cancel);
        running = false;
      }
    };
  }

  globalThis.FirefoxBridgeContentSearch = { validate, createSearch };
})();
