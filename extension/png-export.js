/* Firefox-native screenshot of the current layout; no caller-supplied script. */
(() => {
  "use strict";
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  // Serialized into the main frame's isolated extension world.
  async function prepare(options) {
    const key = "__firefoxBridgePngState";
    if (globalThis[key]) return { error: "EXPORT_BUSY", message: "In diesem Tab läuft bereits eine Aufnahme." };
    const root = document.scrollingElement || document.documentElement;
    const state = { token: options.token, url: location.href, x: scrollX, y: scrollY, styles: [] };
    globalThis[key] = state;
    for (const element of [document.documentElement, document.body].filter(Boolean)) {
      for (const name of ["scroll-behavior", "scroll-snap-type"]) {
        state.styles.push([element, name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
        element.style.setProperty(name, name === "scroll-behavior" ? "auto" : "none", "important");
      }
    }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const height = () => Math.max(root.scrollHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight);
    const warnings = [];
    if (options.fullPage && options.loadDeferred) {
      const deadline = Date.now() + 20000;
      let y = 0, steps = 0;
      while (y < height() && steps < 150 && Date.now() < deadline) {
        if (height() > options.maxHeight) break;
        scrollTo({ left: state.x, top: y, behavior: "instant" });
        await wait(100);
        y += Math.max(1, Math.floor(innerHeight * 0.85)); steps++;
      }
      if (y < height() && height() <= options.maxHeight) warnings.push("Das Nachladen wurde nach Erreichen des Zeit-/Schrittlimits beendet; weitere Inhalte können fehlen.");
    }
    if (options.fullPage) scrollTo({ left: state.x, top: 0, behavior: "instant" });
    await wait(150);
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, wait(2000)]);
    if (options.loadDeferred) await Promise.race([Promise.all([...document.images].filter(image => !image.complete).map(image => new Promise(resolve => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); }))), wait(2000)]);
    const rect = { x: state.x, y: options.fullPage ? 0 : state.y, width: document.documentElement.clientWidth || innerWidth, height: options.fullPage ? height() : innerHeight };
    // Nested/virtual scroll areas cannot be unfolded without changing the layout.
    if ([...document.querySelectorAll("main, [role='main'], [role='grid'], [role='list']")].some(element => element !== root && element.scrollHeight > element.clientHeight + 4 && ["auto", "scroll"].includes(getComputedStyle(element).overflowY))) warnings.push("Die Seite enthält einen eigenen Scrollbereich; dessen verdeckte Inhalte sind nicht Teil der Seitenaufnahme.");
    return { url: location.href, title: document.title, rect, warnings };
  }
  function restore(token) {
    const key = "__firefoxBridgePngState", state = globalThis[key];
    if (!state || state.token !== token) return false;
    try {
      if (location.href === state.url) {
        scrollTo({ left: state.x, top: state.y, behavior: "instant" });
      }
      for (const [element, name, value, priority] of state.styles) {
        if (value) element.style.setProperty(name, value, priority); else element.style.removeProperty(name);
      }
    } finally { delete globalThis[key]; }
    return true;
  }
  async function capture(browser, tabId, options = {}, context = {}) {
    if (typeof browser.tabs.captureTab !== "function") fail("SCREENSHOT_UNAVAILABLE", "Firefox-Screenshot-API fehlt. Aktualisierte Erweiterung mit <all_urls>-Berechtigung neu laden.");
    const settings = { token: crypto.randomUUID(), fullPage: options.fullPage ?? true, loadDeferred: options.loadDeferred ?? true, maxHeight: options.maxHeight ?? 30000 };
    const check = async () => { context.assertLive?.(); await context.assertAccess?.(); context.assertLive?.(); };
    let result;
    await check();
    try {
      [result] = await browser.tabs.executeScript(tabId, { code: `(${prepare.toString()})(${JSON.stringify(settings)})`, frameId: 0, runAt: "document_idle" });
      if (!result) fail("CONTENT_UNAVAILABLE", "Keine Antwort vom Hauptframe für die Aufnahme.");
      if (result.error) fail(result.error, result.message);
      await check();
      const { rect } = result;
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) fail("INVALID_DIMENSIONS", "Die Seitengröße konnte nicht ermittelt werden.");
      if (rect.height > settings.maxHeight || rect.height > 32760 || rect.width > 32760 || rect.width * rect.height > 100000000) fail("PAGE_TOO_LARGE", "Die Seite überschreitet die Aufnahmegrenze (maxHeight, 32760 Pixel je Kante oder 100 Megapixel). Es wurde keine gekürzte Datei gespeichert.");
      const dataUrl = await browser.tabs.captureTab(tabId, { format: "png", rect, scale: 1 });
      await check();
      if (typeof dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) fail("INVALID_IMAGE", "Firefox lieferte kein gültiges PNG.");
      return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 1, fullPage: settings.fullPage, url: result.url, warnings: result.warnings || [] };
    } finally {
      try { await browser.tabs.executeScript(tabId, { code: `(${restore.toString()})(${JSON.stringify(settings.token)})`, frameId: 0, runAt: "document_idle" }); }
      catch { /* A navigated or closed document no longer needs restoration. */ }
    }
  }
  globalThis.FirefoxBridgePng = { capture, prepare, restore };
})();
