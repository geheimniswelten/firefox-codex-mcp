/* Shared as a plain background script and a side-effect module in Node tests. */
(() => {
  "use strict";
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const error = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
  const invalid = message => { throw error("INVALID_PARAMS", message); };
  const canonicalUrl = value => { try { return new URL(value).href; } catch { return null; } };
  const DOM_CONDITIONS = ["selector", "imagesLoaded", "fontsLoaded"];

  function validate(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) invalid("params muss ein Objekt sein.");
    const keys = ["tabId", "url", ...DOM_CONDITIONS, "loadComplete", "timeoutMs"];
    for (const key of Object.keys(params)) if (!keys.includes(key)) invalid(`Unbekannter Parameter: ${key}`);
    if (!Number.isSafeInteger(params.tabId) || params.tabId < 0 || params.tabId > 2147483647) invalid("tabId muss eine nichtnegative Ganzzahl bis 2147483647 sein.");
    const result = { tabId: params.tabId, timeoutMs: own(params, "timeoutMs") ? params.timeoutMs : 10000 };
    if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 120000) invalid("timeoutMs muss eine Ganzzahl zwischen 1 und 120000 sein.");
    if (own(params, "url")) {
      if (typeof params.url !== "string" || params.url.length < 1 || params.url.length > 32768) invalid("url muss 1–32768 Zeichen enthalten.");
      const url = canonicalUrl(params.url);
      if (params.url !== params.url.trim() || /[\u0000-\u001f\u007f]/u.test(params.url)
        || (!/^https?:\/\//iu.test(params.url) && params.url !== "about:blank") || !url) invalid("url muss eine absolute HTTP(S)-URL oder about:blank sein.");
      result.url = url;
    }
    if (own(params, "selector")) {
      if (typeof params.selector !== "string" || params.selector.length < 1 || params.selector.length > 4096) invalid("selector muss 1–4096 Zeichen enthalten.");
      result.selector = params.selector;
    }
    for (const key of ["imagesLoaded", "fontsLoaded", "loadComplete"]) {
      if (own(params, key) && typeof params[key] !== "boolean") invalid(`${key} muss boolean sein.`);
      if (params[key] === true) result[key] = true;
    }
    if (!["url", ...DOM_CONDITIONS, "loadComplete"].some(key => own(result, key))) invalid("Mindestens eine aktive Wartebedingung ist erforderlich.");
    return result;
  }

  // Short snapshots only: no long-lived observer or pending fonts.ready await.
  async function probe(params, expectedUrl) {
    if (location.href !== expectedUrl) return { error: "PAGE_CHANGED" };
    const conditions = {};
    let fontsReady = false;
    if (params.fontsLoaded) {
      if (!document.fonts) return { error: "CONTENT_UNAVAILABLE" };
      let readyTimer;
      try {
        fontsReady = await Promise.race([
          document.fonts.ready.then(() => true),
          new Promise(resolve => { readyTimer = setTimeout(() => resolve(false), 0); })
        ]);
      } finally { clearTimeout(readyTimer); }
      if (location.href !== expectedUrl) return { error: "PAGE_CHANGED" };
    }
    if (params.selector) {
      let matches;
      try { matches = document.querySelectorAll(params.selector); }
      catch { return { error: "INVALID_PARAMS" }; }
      conditions.selector = Array.from(matches).some(element => {
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
        return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
      });
    }
    if (params.imagesLoaded) {
      conditions.imagesLoaded = Array.from(document.images)
        .filter(image => Boolean(image.currentSrc || image.src))
        .every(image => image.complete && image.naturalWidth > 0);
    }
    if (params.fontsLoaded) {
      // Error faces have been requested, including fonts for form values and
      // CSS-generated text. Unrequested faces remain unloaded and do not block.
      conditions.fontsLoaded = fontsReady && document.fonts.status === "loaded"
        && !Array.from(document.fonts).some(face => face.status === "error");
    }
    if (location.href !== expectedUrl) return { error: "PAGE_CHANGED" };
    return { conditions };
  }

  async function waitFor(browser, params, options = {}) {
    const p = validate(params), started = Date.now(), deadline = started + p.timeoutMs;
    const conditions = Object.fromEntries(["url", ...DOM_CONDITIONS, "loadComplete"].filter(key => own(p, key)).map(key => [key, false]));
    const needsDom = DOM_CONDITIONS.some(key => own(p, key));
    const controller = new AbortController();
    let generation = 0, locked, stopped, done = false, timer, pollTimer, rejectStop;
    const stoppedPromise = new Promise((resolve, reject) => { rejectStop = reject; });
    stoppedPromise.catch(() => {});
    const elapsed = () => Math.max(0, Date.now() - started);
    const permissionError = () => locked && options.contentAccess && options.contentAccess.revision !== locked.revision
      ? error("PERMISSION_CHANGED", "Die Inhaltsfreigabe wurde während der Warteanfrage geändert.") : null;
    const timeoutError = () => permissionError() || error("WAIT_TIMEOUT", "Die Wartebedingungen wurden innerhalb des Zeitlimits nicht erfüllt.", { tabId: p.tabId, timeoutMs: p.timeoutMs, elapsedMs: elapsed(), conditions: { ...conditions } });
    const stop = failure => {
      if (stopped || done) return;
      stopped = failure;
      controller.abort(failure);
      rejectStop(failure);
    };
    const onAbort = () => stop(typeof options.signal?.reason?.code === "string" ? options.signal.reason : error("CANCELLED", "Die Warteanfrage wurde abgebrochen."));
    const guard = () => {
      if (!stopped && permissionError()) stop(permissionError());
      if (!stopped && Date.now() >= deadline) stop(timeoutError());
      if (stopped) throw stopped;
      options.assertLive?.();
      if (locked && generation !== locked.generation) throw error("PAGE_CHANGED", "Die Seite wurde während der Warteanfrage gewechselt oder neu geladen.");
    };
    // Both sides of every await are guarded. Late completions cannot read again.
    const call = async operation => {
      guard();
      const result = await Promise.race([Promise.resolve().then(() => { guard(); return operation(); }), stoppedPromise]);
      guard();
      return result;
    };
    const pause = () => call(() => new Promise(resolve => {
      pollTimer = setTimeout(() => { pollTimer = null; resolve(); }, Math.min(50, Math.max(1, deadline - Date.now())));
    }));
    const onUpdated = (tabId, change) => {
      if (tabId !== p.tabId) return;
      if (own(change, "url") || change.status === "loading" || own(change, "discarded")) {
        generation++;
        if (locked) stop(change.discarded === true
          ? error("TAB_DISCARDED", "Der Tab wurde während der Warteanfrage entladen.")
          : error("PAGE_CHANGED", "Die Seite wurde während der Warteanfrage gewechselt oder neu geladen."));
      }
    };
    const onRemoved = tabId => { if (tabId === p.tabId) stop(error("TAB_CLOSED", "Der angefragte Tab wurde geschlossen.")); };
    const assertPage = tab => {
      guard();
      if (tab?.discarded) throw error("TAB_DISCARDED", "Der Tab ist entladen. Zuerst ausdrücklich reload_tabs aufrufen.");
      if (tab && (tab.url !== locked.url || tab.status === "loading")) throw error("PAGE_CHANGED", "Die Seite wurde während der Warteanfrage gewechselt oder neu geladen.");
    };
    const authorization = {};
    try {
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const onTimeout = () => {
        if (stopped || done) return;
        // Timers can fire before the wall-clock deadline by a millisecond.
        // Keep pending approval/probe promises alive until the actual deadline.
        const remaining = deadline - Date.now();
        if (remaining > 0) { timer = setTimeout(onTimeout, remaining); return; }
        stop(timeoutError());
      };
      timer = setTimeout(onTimeout, Math.max(1, deadline - Date.now()));
      while (true) {
        const beforeGet = generation;
        let tab = await call(() => browser.tabs.get(p.tabId));
        if (!locked && generation !== beforeGet) { await pause(); continue; }
        if (own(p, "url")) conditions.url = canonicalUrl(tab.url) === p.url;
        if (p.loadComplete) conditions.loadComplete = tab.status === "complete";
        if (needsDom) {
          if (!locked) {
            if (tab.discarded) throw error("TAB_DISCARDED", "Der Tab ist entladen. Zuerst ausdrücklich reload_tabs aufrufen.");
            if ((own(p, "url") && !conditions.url) || tab.status !== "complete") { await pause(); continue; }
            if (!/^https?:\/\//iu.test(tab.url || "")) throw error("RESTRICTED_PAGE", "DOM-Wartebedingungen sind nur für HTTP(S)-Seiten verfügbar.");
            locked = { url: tab.url, generation, revision: options.contentAccess?.revision };
            if (options.contentAccess) assertPage(await call(() => options.contentAccess.authorize(tab, authorization, { signal: controller.signal })));
          }
          assertPage(tab);
          if (options.contentAccess) assertPage(await call(() => options.contentAccess.assertAfterRead(p.tabId, locked.url, locked.revision, authorization)));
          let results;
          try {
            results = await call(() => browser.tabs.executeScript(p.tabId, {
              code: `(${probe.toString()})(${JSON.stringify(p)},${JSON.stringify(locked.url)})`,
              frameId: 0, allFrames: false, runAt: "document_start"
            }));
          } catch (failure) {
            guard();
            throw error("CONTENT_UNAVAILABLE", "Firefox konnte die DOM-Wartebedingungen nicht prüfen.");
          }
          if (options.contentAccess) assertPage(await call(() => options.contentAccess.assertAfterRead(p.tabId, locked.url, locked.revision, authorization)));
          tab = await call(() => browser.tabs.get(p.tabId));
          assertPage(tab);
          const result = results?.[0];
          if (result?.error) throw error(result.error, result.error === "INVALID_PARAMS" ? "Ungültiger CSS-Selektor." : "Die DOM-Wartebedingungen konnten nicht geprüft werden.");
          for (const key of DOM_CONDITIONS.filter(key => own(p, key))) {
            if (typeof result?.conditions?.[key] !== "boolean") throw error("CONTENT_UNAVAILABLE", "Keine gültige Antwort vom Hauptframe.");
            conditions[key] = result.conditions[key];
          }
        }
        if (Object.values(conditions).every(Boolean)) {
          guard();
          return { tabId: p.tabId, url: tab.url, status: tab.status, elapsedMs: elapsed(), conditions: { ...conditions } };
        }
        await pause();
      }
    } finally {
      done = true;
      clearTimeout(timer); clearTimeout(pollTimer);
      controller.abort(stopped || error("CANCELLED", "Die Warteanfrage ist beendet."));
      options.signal?.removeEventListener("abort", onAbort);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }
  }

  globalThis.FirefoxBridgeWait = { validate, waitFor };
})();
