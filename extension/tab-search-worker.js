/* One request per worker; the caller always terminates it after completion. */
(() => {
  "use strict";
  globalThis.onmessage = event => {
    try {
      const { query, searchIn, caseSensitive, tabs } = event.data;
      const regex = new RegExp(query, caseSensitive ? "" : "i");
      const fields = searchIn === "both" ? ["title", "url"] : [searchIn];
      const indices = [];
      for (let index = 0; index < tabs.length; index++) {
        if (fields.some(field => regex.test(tabs[index][field] ?? ""))) indices.push(index);
      }
      globalThis.postMessage({ indices });
    } catch {
      globalThis.postMessage({ error: "SEARCH_FAILED" });
    }
  };
})();
