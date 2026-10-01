/* Firefox MCP SingleFile integration. SPDX-License-Identifier: AGPL-3.0-or-later */
/* global browser */
(() => {
  "use strict";
  const RESOURCE_BYTES = 12 * 1024 * 1024, TOTAL_BYTES = 64 * 1024 * 1024;
  const CAPTURE_MS = 60000, RESOURCE_MS = 12000;
  const MARKER = "data-firefox-mcp-navigation";
  const FETCH_MESSAGE = "firefox_mcp_html_resource";
  const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data:; frame-src 'self' data: blob:; object-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  let pageState;

  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  function literalNavigation(source, baseURI) {
    if (typeof source !== "string" || source.length > 4096) return null;
    const expression = source.trim().replace(/^javascript\s*:/iu, "");
    const quoted = "(\"(?:[^\"\\\\\\r\\n]|\\\\[\"'\\\\/bfnrt])*\"|'(?:[^'\\\\\\r\\n]|\\\\[\"'\\\\/bfnrt])*')";
    const location = "(?:(?:window|document)\\s*\\.\\s*)?location";
    const assignment = new RegExp(`^${location}(?:\\s*\\.\\s*href)?\\s*=\\s*${quoted}\\s*;?\\s*(?:return\\s+false\\s*;?)?$`, "u");
    const call = new RegExp(`^${location}\\s*\\.\\s*(?:assign|replace)\\s*\\(\\s*${quoted}\\s*\\)\\s*;?\\s*(?:return\\s+false\\s*;?)?$`, "u");
    const match = expression.match(assignment) || expression.match(call);
    if (!match) return null;
    const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    const value = match[1].slice(1, -1).replace(/\\(["'\\/bfnrt])/gu, (_, char) => escapes[char] ?? char);
    try {
      const url = new URL(value, baseURI);
      if (!["http:", "https:", "mailto:", "tel:", "ftp:"].includes(url.protocol)) return null;
      return value.startsWith("#") ? value : url.href;
    } catch { return null; }
  }

  function roots(root = globalThis.document) {
    const result = [root];
    for (const element of root.querySelectorAll("*")) {
      const shadow = element.openOrClosedShadowRoot || element.shadowRoot;
      if (shadow) result.push(...roots(shadow));
    }
    return result;
  }
  const delay = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms));

  async function preparePage(token, options = {}) {
    cleanupPage();
    const state = pageState = { token, changes: [], links: [], warnings: [], expired: false };
    if (options.loadDeferred) {
      const x = globalThis.scrollX, y = globalThis.scrollY;
      const started = Date.now(), step = Math.max(200, Math.floor(globalThis.innerHeight * 0.8));
      try {
        for (const root of roots()) for (const image of root.querySelectorAll('img[loading="lazy"],iframe[loading="lazy"]')) {
          state.changes.push(() => image.setAttribute("loading", "lazy"));
          image.setAttribute("loading", "eager");
        }
        let pos = 0, count = 0;
        while (!state.expired) {
          const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
          globalThis.scrollTo(x, pos);
          await delay(100);
          if (pos + globalThis.innerHeight >= height) break;
          if (++count >= 100 || Date.now() - started >= 8000 || pos > 100000) {
            state.warnings.push("Nachladen beim Scrollen wurde begrenzt; endlose oder sehr lange Seiten können unvollständig sein."); break;
          }
          pos += step;
        }
        await delay(200);
      } finally { globalThis.scrollTo(x, y); }
    }
    if (state.expired) throw failure("EXPORT_CANCELLED", "HTML-Aufnahme wurde beendet.");
    // Freeze properties currently changed by CSS/Web Animations in the exported
    // snapshot, without keeping a persistent change in the live document.
    for (const animation of document.getAnimations?.() || []) {
      const target = animation.effect?.target;
      if (!target?.style || animation.effect.pseudoElement) continue;
      const saved = target.getAttribute("style");
      state.changes.push(() => saved === null ? target.removeAttribute("style") : target.setAttribute("style", saved));
      const computed = globalThis.getComputedStyle(target);
      const properties = new Set((animation.effect.getKeyframes?.() || []).flatMap(frame => Object.keys(frame)));
      for (const property of properties) if (!["offset", "computedOffset", "easing", "composite"].includes(property)) {
        const cssName = property.replace(/[A-Z]/gu, char => `-${char.toLowerCase()}`);
        target.style.setProperty(cssName, computed.getPropertyValue(cssName), "important");
      }
    }
    let unsupported = 0;
    for (const root of roots()) for (const element of root.querySelectorAll("[onclick],a[href],area[href]")) {
      const href = element.getAttribute("href") || "";
      const handler = element.getAttribute("onclick") || (/^\s*javascript\s*:/iu.test(href) ? href : "");
      if (!handler) continue;
      const target = literalNavigation(handler, document.baseURI);
      if (!target) { unsupported++; continue; }
      const id = `${token}:${globalThis.crypto.randomUUID()}`;
      const previous = element.getAttribute(MARKER);
      state.changes.push(() => previous === null ? element.removeAttribute(MARKER) : element.setAttribute(MARKER, previous));
      element.setAttribute(MARKER, id);
      state.links.push({ id, href: target });
    }
    if (unsupported) state.warnings.push(`${unsupported} JavaScript-Aktionen konnten nicht in normale Links umgewandelt werden.`);
    return { links: state.links, warnings: state.warnings, url: document.location.href };
  }

  function cleanupPage() {
    const state = pageState;
    if (!state) return;
    state.expired = true;
    for (const change of state.changes.reverse()) { try { change(); } catch { /* Detached live nodes need no repair. */ } }
    state.changes.length = 0;
    if (globalThis.FirefoxBridgeSingleFile?.processors?.frameTree && globalThis.sessions) {
      for (const id of [...globalThis.sessions.keys()]) globalThis.FirefoxBridgeSingleFile.processors.frameTree.cleanup(id);
    }
    pageState = undefined;
  }

  async function pageFetch(url, options = {}) {
    if (!pageState || pageState.expired) throw failure("EXPORT_CANCELLED", "HTML-Aufnahme wurde beendet.");
    if (/^(?:data|blob):/iu.test(url)) return globalThis.fetch(url, { signal: AbortSignal.timeout(RESOURCE_MS) });
    const result = await browser.runtime.sendMessage({ type: FETCH_MESSAGE, token: pageState.token, url, accept: options.headers?.accept });
    if (!result?.ok) throw new Error(result?.error || "Ressource konnte nicht geladen werden.");
    const binary = globalThis.atob(result.body);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return { url: result.url, status: result.status, headers: new Headers(result.headers), arrayBuffer: async () => bytes.buffer };
  }

  async function capturePage(token) {
    if (pageState?.token !== token || pageState.expired) throw failure("EXPORT_CANCELLED", "HTML-Aufnahme wurde beendet.");
    return globalThis.FirefoxBridgeSingleFile.getPageData({
      url: document.location.href,
      blockScripts: true, blockAudios: true, blockVideos: true,
      removeFrames: false, removeImports: true, removeNoScriptTags: true,
      removeHiddenElements: false, removeUnusedStyles: false, removeUnusedFonts: false,
      removeAlternativeFonts: false, removeAlternativeImages: false,
      compressHTML: false, compressCSS: false, compressContent: false,
      groupDuplicateImages: false, loadDeferredContent: false,
      insertSingleFileComment: true, insertMetaCSP: false,
      insertMetaNoIndex: true, includeInfobar: false, userScriptEnabled: false,
      saveRawPage: false, saveOriginalURLs: false, resolveLinks: true,
      networkTimeout: RESOURCE_MS, maxResourceSizeEnabled: true, maxResourceSize: 12,
      filenameTemplate: "page.html", filenameMaxLength: 255,
      filenameReplacedCharacters: [], filenameReplacementCharacters: [], filenameReplacementCharacter: "_",
      onprogress: () => { if (pageState?.token !== token || pageState.expired) throw failure("EXPORT_CANCELLED", "HTML-Aufnahme wurde beendet."); }
    }, { fetch: pageFetch, frameFetch: pageFetch }, document, globalThis);
  }

  function sanitize(content, sourceURL, links = [], warnings = [], depth = 0) {
    if (depth > 16) { warnings.push("Ein tief verschachtelter Frame konnte nicht übernommen werden."); return "<!doctype html><html><head></head><body></body></html>"; }
    const doc = new DOMParser().parseFromString(content, "text/html");
    const navigation = new Map(links.map(link => [link.id, link.href]));
    const allRoots = [doc];
    const templates = [...doc.querySelectorAll("template")];
    for (let index = 0; index < templates.length; index++) {
      allRoots.push(templates[index].content);
      templates.push(...templates[index].content.querySelectorAll("template"));
    }
    for (const root of allRoots) {
      // SingleFile also captures HTML embedded through <object>. Preserve that
      // static document as a sandboxed iframe before discarding active embeds.
      for (const object of root.querySelectorAll('object[type="text/html"][data]')) {
        if (!/^data:text\/html[;,]/iu.test(object.getAttribute("data") || "")) continue;
        const frame = doc.createElement("iframe");
        for (const attribute of object.attributes) if (!["data", "type"].includes(attribute.name)) frame.setAttribute(attribute.name, attribute.value);
        frame.setAttribute("src", object.getAttribute("data")); object.replaceWith(frame);
      }
      for (const element of root.querySelectorAll('script,noscript,base,object,embed,meta[http-equiv],link[rel="preload"],link[rel="modulepreload"],link[rel="prefetch"],link[rel="preconnect"]')) element.remove();
      for (let element of [...root.querySelectorAll("*")]) {
        const target = navigation.get(element.getAttribute(MARKER));
        element.removeAttribute(MARKER);
        if (target) {
          if (!["a", "area"].includes(element.localName)) {
            const replacement = doc.createElement("a");
            for (const attribute of element.attributes) replacement.setAttribute(attribute.name, attribute.value);
            while (element.firstChild) replacement.appendChild(element.firstChild);
            if (!replacement.textContent && element.value) replacement.textContent = element.value;
            element.replaceWith(replacement); element = replacement;
          }
          element.setAttribute("href", target);
        }
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase(), scheme = attribute.value.replace(/[\u0000-\u0020]/gu, "").toLowerCase();
          if ((attribute.localName || name).toLowerCase().startsWith("on") || ["autoplay", "nonce", "integrity", "ping"].includes(name) || scheme.startsWith("javascript:") || scheme.startsWith("vbscript:")) element.removeAttribute(attribute.name);
        }
        if (["a", "area"].includes(element.localName)) {
          const href = element.getAttribute("href");
          if (href && !href.startsWith("#")) {
            try { element.setAttribute("href", new URL(href, sourceURL).href); }
            catch { element.removeAttribute("href"); }
          }
          if (element.getAttribute("target") === "_blank") element.setAttribute("rel", "noopener noreferrer");
        }
        if (["iframe", "frame"].includes(element.localName)) {
          let frameContent = element.getAttribute("srcdoc");
          const src = element.getAttribute("src") || "";
          if (!frameContent && /^data:text\/html[;,]/iu.test(src)) {
            try {
              const comma = src.indexOf(",");
              frameContent = /;base64$/iu.test(src.slice(0, comma))
                ? new TextDecoder().decode(Uint8Array.from(atob(src.slice(comma + 1)), char => char.charCodeAt(0)))
                : decodeURIComponent(src.slice(comma + 1));
            } catch { warnings.push("Ein eingebetteter Frame konnte nicht gelesen werden."); }
          }
          element.removeAttribute("src");
          element.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation");
          if (frameContent) element.setAttribute("srcdoc", sanitize(frameContent, sourceURL, links, warnings, depth + 1));
          else { element.setAttribute("srcdoc", "<!doctype html><html><body></body></html>"); warnings.push("Ein nicht zugänglicher Frame wurde als leeres Feld gespeichert."); }
        }
      }
      const pause = doc.createElement("style");
      pause.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}svg animate,svg animateTransform,svg animateMotion,svg set{display:none!important}";
      root === doc ? doc.head.appendChild(pause) : root.appendChild(pause);
      for (const animation of root.querySelectorAll("animate,animateTransform,animateMotion,set")) animation.remove();
    }
    const meta = doc.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy"); meta.setAttribute("content", CSP);
    doc.head.insertBefore(meta, doc.head.firstChild);
    const charset = doc.createElement("meta"); charset.setAttribute("charset", "utf-8"); doc.head.insertBefore(charset, meta);
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  async function capture(browserAPI, tabId, options = {}, context = {}) {
    const token = crypto.randomUUID(), warnings = [], controllers = new Set();
    let finished = false, downloaded = 0, timer;
    async function check() {
      if (finished) throw failure("EXPORT_CANCELLED", "HTML-Aufnahme wurde beendet.");
      context.assertLive?.(); await context.assertAccess?.(); context.assertLive?.();
      if (finished) throw failure("EXPORT_CANCELLED", "HTML-Aufnahme wurde beendet.");
    }
    async function inject(parameters) { await check(); const result = await browserAPI.tabs.executeScript(tabId, parameters); await check(); return result; }
    const listener = (message, sender) => {
      if (finished || sender.id !== browserAPI.runtime.id || sender.tab?.id !== tabId) return undefined;
      if (["singlefile.frameTree.initResponse", "singlefile.frameTree.ackInitRequest"].includes(message?.method)) {
        return check().then(() => browserAPI.tabs.sendMessage(tabId, message, { frameId: 0 })).catch(() => undefined);
      }
      if (message?.type !== FETCH_MESSAGE || message.token !== token) return undefined;
      return (async () => {
        let controller, timeout;
        try {
          await check();
          if (typeof message.url !== "string" || message.url.length > 16384 || !/^https?:\/\//iu.test(message.url)) throw new Error("Nicht unterstützte Ressourcen-Adresse.");
          if (downloaded >= TOTAL_BYTES) throw new Error("Gesamtgrenze von 64 MiB für Ressourcen erreicht.");
          controller = new AbortController(); controllers.add(controller);
          timeout = setTimeout(() => controller.abort(), RESOURCE_MS);
          const response = await fetch(message.url, { credentials: "include", cache: "force-cache", redirect: "follow", signal: controller.signal,
            headers: { accept: typeof message.accept === "string" && message.accept.length <= 256 ? message.accept : "*/*" } });
          await check();
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const declared = Number(response.headers.get("content-length"));
          if (declared > RESOURCE_BYTES) throw new Error("Ressource überschreitet 12 MiB.");
          let bytes;
          if (response.body?.getReader) {
            const reader = response.body.getReader(), chunks = []; let size = 0;
            while (true) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.byteLength; downloaded += part.value.byteLength;
              if (size > RESOURCE_BYTES || downloaded > TOTAL_BYTES) { await reader.cancel(); throw new Error("Ressourcen-Größenlimit erreicht."); }
              chunks.push(part.value);
            }
            bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          } else {
            bytes = new Uint8Array(await response.arrayBuffer()); downloaded += bytes.byteLength;
            if (bytes.byteLength > RESOURCE_BYTES || downloaded > TOTAL_BYTES) throw new Error("Ressourcen-Größenlimit erreicht.");
          }
          await check();
          let binary = "";
          for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
          return { ok: true, body: btoa(binary), url: response.url || message.url, status: response.status,
            headers: { "content-type": response.headers.get("content-type") || "application/octet-stream" } };
        } catch (error) {
          if (!finished && warnings.length < 40) warnings.push(`Eine Ressource konnte nicht eingebettet werden: ${String(error.message || error).slice(0, 180)}`);
          return { ok: false, error: String(error.message || error).slice(0, 300) };
        } finally { clearTimeout(timeout); if (controller) { controller.abort(); controllers.delete(controller); } }
      })();
    };
    browserAPI.runtime.onMessage.addListener(listener);
    try {
      const run = async () => {
        await inject({ file: "vendor/single-file.bundle.js", allFrames: true, matchAboutBlank: true, runAt: "document_idle" });
        await inject({ file: "html-export.js", allFrames: true, matchAboutBlank: true, runAt: "document_idle" });
        const frames = await inject({ code: `globalThis.FirefoxBridgeHtml.preparePage(${JSON.stringify(token)},${JSON.stringify({ loadDeferred: options.loadDeferred !== false })})`, allFrames: true, matchAboutBlank: true });
        for (const frame of frames) warnings.push(...(frame?.warnings || []));
        const results = await inject({ code: `globalThis.FirefoxBridgeHtml.capturePage(${JSON.stringify(token)})` });
        const page = results?.[0];
        if (typeof page?.content !== "string" || !page.content) throw failure("EXPORT_FAILED", "SingleFile lieferte keine HTML-Datei.");
        await check();
        const tab = await browserAPI.tabs.get(tabId); await check();
        const content = sanitize(page.content, tab.url, frames.flatMap(frame => frame?.links || []), warnings);
        await check();
        warnings.push("JavaScript ist deaktiviert. Nur eindeutig erkennbare Navigationen mit festem Ziel wurden in Links umgewandelt; Medien werden als statischer Zustand gespeichert.");
        return { content, warnings: [...new Set(warnings)].slice(0, 50) };
      };
      return await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(failure("EXPORT_TIMEOUT", "HTML-Aufnahme überschreitet 60 Sekunden.")), CAPTURE_MS); })]);
    } finally {
      finished = true; clearTimeout(timer);
      browserAPI.runtime.onMessage.removeListener(listener);
      for (const controller of controllers) controller.abort();
      try { await browserAPI.tabs.executeScript(tabId, { code: "globalThis.FirefoxBridgeHtml?.cleanupPage()", allFrames: true, matchAboutBlank: true }); }
      catch { /* A navigated or closed tab no longer contains the modified DOM. */ }
    }
  }
  globalThis.FirefoxBridgeHtml = { capture, literalNavigation, sanitize, preparePage, cleanupPage, capturePage, CAPTURE_MS, RESOURCE_BYTES, TOTAL_BYTES };
})();
