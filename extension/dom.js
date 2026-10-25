/* Fixed DOM operations only. Callers provide data, never executable code. */
(() => {
  "use strict";
  const actions = ["fill", "set_checked", "select", "click"];
  const error = (code, message) => Object.assign(new Error(message), { code });
  const invalid = message => { throw error("INVALID_PARAMS", message); };
  function validate(method, p) {
    const fields = method === "read_dom" ? ["tabId", "selector", "visibleOnly", "limit", "offset", "maxChars"] : ["tabId", "documentId", "elementId", "action", "value", "checked"];
    for (const key of Object.keys(p)) if (!fields.includes(key)) invalid(`Unbekannter Parameter: ${key}`);
    if (!Number.isInteger(p.tabId) || p.tabId < 0 || p.tabId > 2147483647) invalid("tabId muss eine nichtnegative Ganzzahl sein.");
    if (method === "read_dom") {
      if (p.selector !== undefined && (typeof p.selector !== "string" || !p.selector.length || p.selector.length > 4096)) invalid("selector muss 1–4096 Zeichen enthalten.");
      if (p.visibleOnly !== undefined && typeof p.visibleOnly !== "boolean") invalid("visibleOnly muss boolean sein.");
      for (const [name, min, max] of [["limit",1,100],["offset",0,10000],["maxChars",1,100000]]) if (p[name] !== undefined && (!Number.isInteger(p[name]) || p[name] < min || p[name] > max)) invalid(`${name} muss zwischen ${min} und ${max} liegen.`);
      return;
    }
    if (typeof p.documentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.documentId) || typeof p.elementId !== "string" || !/^e[1-9][0-9]{0,8}$/.test(p.elementId)) invalid("documentId und elementId müssen aus read_dom stammen.");
    if (!actions.includes(p.action)) invalid("action muss fill, set_checked, select oder click sein.");
    if (["fill", "select"].includes(p.action)) {
      if (typeof p.value !== "string" || p.value.length > 10000 || p.checked !== undefined) invalid("fill/select benötigen value (höchstens 10000 Zeichen), kein checked.");
    } else if (p.action === "set_checked") {
      if (typeof p.checked !== "boolean" || p.value !== undefined) invalid("set_checked benötigt checked, kein value.");
    } else if (p.value !== undefined || p.checked !== undefined) invalid("click akzeptiert keinen Wert.");
  }

  // Serialized into Firefox's isolated content world. Its references are bound
  // to this document and exact DOM nodes, not reusable CSS selectors.
  function pageOperation(options) {
    const fail = (code, message) => ({ domError: code, message });
    if (options.expectedUrl && location.href !== options.expectedUrl) return fail("PAGE_CHANGED", "Die Seite wurde seit der Inhaltsfreigabe gewechselt.");
    const stateKey = "__firefoxCodexDomReferences_v1";
    let state = globalThis[stateKey];
    if (!state) {
      state = { document, id: crypto.randomUUID(), sequence: 0, elements: new Map(), ids: new WeakMap() };
      globalThis[stateKey] = state;
    }
    if (state.document !== document) return fail("PAGE_CHANGED", "Das Dokument wurde gewechselt. Erneut read_dom aufrufen.");
    const visible = element => {
      if (!element.getClientRects().length) return false;
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const short = (value, max = 512) => String(value ?? "").slice(0, max);
    const reference = element => {
      let id = state.ids.get(element);
      if (!id || !state.elements.has(id)) {
        id = `e${++state.sequence}`; state.ids.set(element, id); state.elements.set(id, element);
        if (state.elements.size > 1000) state.elements.delete(state.elements.keys().next().value);
      }
      return id;
    };
    if (options.method === "read_dom") {
      let root;
      try { root = options.selector ? document.querySelector(options.selector) : document.body || document.documentElement; }
      catch { return fail("INVALID_SELECTOR", "Ungültiger CSS-Selektor."); }
      if (!root) return fail("SELECTOR_NOT_FOUND", "Kein Element passt zum Selektor.");
      const controls = 'input,textarea,select,button,a[href],[role="button"],[role="checkbox"],[contenteditable="true"]';
      const nodes = root.matches(controls) ? [root, ...root.querySelectorAll(controls)] : [...root.querySelectorAll(controls)];
      const candidates = nodes.slice(0,10000).filter(node => !options.visibleOnly || visible(node));
      const page = candidates.slice(options.offset, options.offset + options.limit);
      const elements = page.map(element => {
        const rect = element.getBoundingClientRect();
        const password = element.localName === "input" && element.type === "password";
        const labels = element.labels ? [...element.labels].map(label => label.innerText || "").join(" ") : "";
        const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.innerText || "").join(" ");
        const result = { elementId: reference(element), tag: element.localName, type: short(element.type || element.getAttribute("role") || ""),
          label: short(element.getAttribute("aria-label") || labelledBy || labels || element.innerText || element.getAttribute("title") || element.getAttribute("placeholder") || ""),
          text: short(element.innerText || ""), visible: visible(element), disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || !!element.closest("[inert]"),
          readOnly: !!element.readOnly, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        if ("value" in element) { result.value = password ? null : short(element.value,2048); result.valueRedacted = password; result.valueTruncated = !password && String(element.value).length > 2048; }
        if (["checkbox", "radio"].includes(element.type)) { result.checked = !!element.checked; result.indeterminate = !!element.indeterminate; }
        if (element.localName === "a") result.href = short(element.href,4096);
        if (element.localName === "select") {
          result.options = [...element.options].slice(0,100).map(option => ({ value: short(option.value,2048), label: short(option.label), selected: option.selected, disabled: option.disabled || !!option.closest("optgroup[disabled]") }));
          result.optionsTruncated = element.options.length > 100;
          result.multiple = element.multiple;
        }
        return result;
      });
      const text = root.innerText || "";
      const end = options.offset + elements.length;
      return { url: location.href, documentId: state.id, text: text.slice(0,options.maxChars), textTruncated: text.length > options.maxChars,
        elements, total: candidates.length, returned: elements.length, offset: options.offset, nextOffset: end < candidates.length ? end : null,
        scanTruncated: nodes.length > 10000, referenceLimit: 1000, frames: "main" };
    }
    if (options.documentId !== state.id) return fail("PAGE_CHANGED", "Die Elementreferenz gehört zu einem anderen Dokument. Erneut read_dom aufrufen.");
    const element = state.elements.get(options.elementId);
    if (!element || !element.isConnected || element.ownerDocument !== document) return fail("STALE_ELEMENT", "Das ausgelesene Element existiert nicht mehr. Erneut read_dom aufrufen.");
    if (!visible(element)) return fail("ELEMENT_NOT_VISIBLE", "Das Element ist nicht sichtbar.");
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || element.closest("[inert]")) return fail("ELEMENT_DISABLED", "Das Element ist deaktiviert.");
    if (options.method === "describe") return { url: location.href, documentId: state.id, elementId: options.elementId,
      description: short(element.getAttribute("aria-label") || (element.labels ? [...element.labels].map(label => label.innerText || "").join(" ") : "") || element.innerText || element.getAttribute("placeholder") || element.name || element.id || element.localName) };
    if (Number.isFinite(options.expiresAt) && Date.now() >= options.expiresAt) return fail("SESSION_EXPIRED", "Die Freigabe ist vor der Bedienung abgelaufen.");
    const url = location.href;
    const response = { url, documentId: state.id, elementId: options.elementId, action: options.action, dispatched: true, eventsTrusted: false };
    const dispatchChange = () => { element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); };
    if (options.action === "fill") {
      if (element.readOnly) return fail("ELEMENT_READ_ONLY", "Das Eingabefeld ist schreibgeschützt.");
      if (element.localName === "textarea" || element.localName === "input" && ["text","search","tel","url","email","number","password","date","datetime-local","month","week","time","color","range"].includes(element.type)) {
        const prototype = element.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
        setter.call(element, options.value); dispatchChange();
      } else if (element.isContentEditable) { element.textContent = options.value; dispatchChange(); }
      else return fail("UNSUPPORTED_ELEMENT", "fill unterstützt Texteingaben, textarea und contenteditable.");
    } else if (options.action === "set_checked") {
      if (element.localName !== "input" || !["checkbox","radio"].includes(element.type)) return fail("UNSUPPORTED_ELEMENT", "set_checked benötigt eine Checkbox oder einen Radio-Button.");
      if (element.checked !== options.checked) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"checked").set.call(element,options.checked); dispatchChange(); }
    } else if (options.action === "select") {
      if (element.localName !== "select" || element.multiple) return fail("UNSUPPORTED_ELEMENT", "select benötigt ein einfaches Auswahlfeld.");
      const selected = [...element.options].find(option => option.value === options.value);
      if (!selected) return fail("OPTION_NOT_FOUND", "Kein Eintrag hat diesen value.");
      if (selected.disabled || selected.closest("optgroup[disabled]")) return fail("ELEMENT_DISABLED", "Der gewünschte Eintrag ist deaktiviert.");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(element,options.value); dispatchChange();
    } else if (options.action === "click") {
      if (element.localName === "a" && !/^https?:\/\//i.test(element.href)) return fail("RESTRICTED_URL", "Links dürfen nur HTTP(S)-Ziele öffnen.");
      if (element.localName === "input" && element.type === "file") return fail("UNSUPPORTED_ELEMENT", "Dateiauswahl wird nicht unterstützt.");
      if (typeof element.click !== "function") return fail("UNSUPPORTED_ELEMENT", "Dieses Element kann nicht angeklickt werden.");
      element.click();
      response.mayNavigate = true;
    }
    return response;
  }
  function createDom(browser, { contentAccess, interactionAccess } = {}) {
    return { async handle(method, p, context = {}) {
      const writing = method === "interact";
      if (!contentAccess) throw error("CONTENT_DENIED", "DOM-Zugriff benötigt die Inhaltsfreigabe.");
      if (writing && !interactionAccess) throw error("INTERACTION_DENIED", "Seitenelemente bedienen ist in der Erweiterung gesperrt.");
      let tab = await browser.tabs.get(p.tabId);
      // Never inspect an element for a write prompt before checking hard site denials.
      contentAccess.assertSiteAllowed(tab.url);
      if (writing && interactionAccess.settings.contentMode === "deny" && !interactionAccess.siteBypass(tab.url)) throw error("INTERACTION_DENIED", "Seitenelemente bedienen ist in der Erweiterung gesperrt.");
      if (tab.discarded) throw error("TAB_DISCARDED", "Der Tab ist entladen. Zuerst ausdrücklich reload_tabs aufrufen.");
      if (!/^https?:\/\//i.test(tab.url || "")) throw error("RESTRICTED_PAGE", "DOM-Zugriff ist nur auf HTTP(S)-Seiten möglich.");
      const url = tab.url, readRevision = contentAccess.revision, writeRevision = interactionAccess?.revision;
      const readAuthorization = {}, writeAuthorization = {};
      tab = await contentAccess.authorize(tab, readAuthorization, { signal: context.signal });
      context.assertLive?.();
      const execute = async opts => {
        let result;
        try { [result] = await browser.tabs.executeScript(p.tabId, { code: `(${pageOperation.toString()})(${JSON.stringify({ ...opts, expectedUrl: url })})`, frameId: 0, allFrames: false, runAt: "document_idle" }); }
        catch { throw error("DOM_UNAVAILABLE", writing ? "Firefox konnte die Bedienung nicht bestätigen. Zustand vor einem erneuten Versuch prüfen." : "Firefox erlaubt hier keinen DOM-Zugriff."); }
        if (!result) throw error("DOM_UNAVAILABLE", "Keine Antwort vom Hauptframe.");
        if (result.domError) throw error(result.domError,result.message);
        if (result.url !== url) throw error("PAGE_CHANGED", "Die Seite wurde gewechselt. Erneut read_dom aufrufen.");
        return result;
      };
      if (writing) {
        await contentAccess.assertAfterRead(p.tabId,url,readRevision,readAuthorization);
        context.assertLive?.();
        const target = await execute({ method: "describe", documentId: p.documentId, elementId: p.elementId });
        await contentAccess.assertAfterRead(p.tabId,url,readRevision,readAuthorization);
        context.assertLive?.();
        await interactionAccess.authorize(tab, writeAuthorization, { signal: context.signal, operation: { action: p.action, elementId: p.elementId, description: target.description } });
      }
      context.assertLive?.();
      await contentAccess.assertAfterRead(p.tabId,url,readRevision,readAuthorization);
      if (writing) await interactionAccess.assertAfterRead(p.tabId,url,writeRevision,writeAuthorization);
      context.assertLive?.();
      // Authorizations are checked again immediately before injection. Document
      // IDs prevent even same-URL reloads from reusing old element references.
      for (const [access, revision] of [[contentAccess,readRevision], ...(writing ? [[interactionAccess,writeRevision]] : [])]) {
        if (!access.settings.enabled || access.revision !== revision || access.settings.contentMode === "deny" && !access.siteBypass(url)) throw error("PERMISSION_CHANGED", "Die Freigabe wurde vor der Bedienung geändert.");
      }
      const expires = access => {
        const grant = access.authorizations.get(access === contentAccess ? readAuthorization : writeAuthorization);
        return grant ? grant.expiresAt ?? Infinity : ["ask-session","ask-five-days"].includes(access.settings.contentMode) ? access.expiresAt ?? Infinity : Infinity;
      };
      const expiresAt = Math.min(expires(contentAccess), writing ? expires(interactionAccess) : Infinity, context.expiresAt ?? Infinity);
      const opts = writing ? { ...p, method, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null }
        : { method, selector: p.selector, visibleOnly: p.visibleOnly ?? true, limit: p.limit ?? 50, offset: p.offset ?? 0, maxChars: p.maxChars ?? 30000 };
      const result = await execute(opts);
      if (!writing) {
        await contentAccess.assertAfterRead(p.tabId,url,readRevision,readAuthorization);
        context.assertLive?.();
      }
      // A click may intentionally navigate; don't convert its confirmed dispatch
      // to PAGE_CHANGED after the side effect or recommend automatically retrying.
      return { tabId: p.tabId, ...result };
    } };
  }
  globalThis.FirefoxBridgeDom = { validate, createDom, pageOperation };
})();
