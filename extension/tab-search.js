/* Shared as a plain background script and a side-effect module in Node tests. */
(() => {
  "use strict";
  const SEARCH_TIMEOUT_MS = 1000;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const error = (code, message) => Object.assign(new Error(message), { code });
  const invalid = message => { throw error("INVALID_PARAMS", message); };
  const tabText = (tab, field) => typeof tab?.[field] === "string" ? tab[field] : "";

  function validateSearch(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) invalid("params muss ein Objekt sein.");
    if (!own(params, "query")) {
      if (["searchIn", "matchMode", "caseSensitive"].some(key => own(params, key))) invalid("Suchoptionen erfordern query.");
      return null;
    }
    if (typeof params.query !== "string" || params.query.length < 1 || params.query.length > 4096) invalid("query muss 1–4096 Zeichen enthalten.");
    if (own(params, "searchIn") && !["title", "url", "both"].includes(params.searchIn)) invalid("searchIn muss title, url oder both sein.");
    if (own(params, "matchMode") && !["contains", "regex"].includes(params.matchMode)) invalid("matchMode muss contains oder regex sein.");
    if (own(params, "caseSensitive") && typeof params.caseSensitive !== "boolean") invalid("caseSensitive muss boolean sein.");
    const search = {
      query: params.query,
      searchIn: params.searchIn ?? "both",
      matchMode: params.matchMode ?? "contains",
      caseSensitive: params.caseSensitive ?? false
    };
    if (search.matchMode === "regex") {
      try { new RegExp(search.query, search.caseSensitive ? "" : "i"); }
      catch { invalid("query enthält einen ungültigen regulären Ausdruck."); }
    }
    return search;
  }

  async function filterTabs(tabs, params, options = {}) {
    const search = validateSearch(params);
    if (!search) return tabs;
    const fields = search.searchIn === "both" ? ["title", "url"] : [search.searchIn];
    if (search.matchMode === "contains") {
      const query = search.caseSensitive ? search.query : search.query.toLowerCase();
      return tabs.filter(tab => fields.some(field => {
        const value = tabText(tab, field);
        return (search.caseSensitive ? value : value.toLowerCase()).includes(query);
      }));
    }

    // A pathological regex must never block the extension's background thread.
    const workerFactory = options.workerFactory ?? (() => new Worker("tab-search-worker.js"));
    const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let worker, timer, finished = false;
      const finish = (failure, indices) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (worker) {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onError);
          worker.terminate();
        }
        if (failure) reject(failure);
        else resolve(indices.map(index => tabs[index]));
      };
      const onError = event => {
        event.preventDefault?.();
        finish(error("SEARCH_FAILED", "Die Tab-Suche konnte nicht ausgeführt werden."));
      };
      const onMessage = event => {
        const indices = event.data?.indices;
        if (!Array.isArray(indices) || indices.some((index, position) => !Number.isInteger(index) || index < 0 || index >= tabs.length || (position > 0 && index <= indices[position - 1]))) {
          finish(error("SEARCH_FAILED", "Die Tab-Suche lieferte eine ungültige Antwort."));
        } else finish(null, indices);
      };
      try {
        worker = workerFactory();
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onError);
        timer = setTimeout(() => finish(error("SEARCH_TIMEOUT", "Die Regex-Tab-Suche hat das Zeitlimit überschritten.")), timeoutMs);
        worker.postMessage({
          ...search,
          tabs: tabs.map(tab => Object.fromEntries(fields.map(field => [field, tabText(tab, field)])))
        });
      } catch {
        finish(error("SEARCH_FAILED", "Die Tab-Suche konnte nicht gestartet werden."));
      }
    });
  }

  globalThis.FirefoxBridgeTabSearch = { validateSearch, filterTabs };
})();
