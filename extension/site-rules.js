(() => {
  "use strict";
  const keys = ["blocked", "readOnly", "fullAccess"];
  const el = id => document.getElementById(id);
  let revision = null, busy = false, dirty = false;
  function lock(value) {
    busy = value;
    for (const key of keys) el(key).disabled = value || revision === null;
    el("save").disabled = value || revision === null;
    el("reload").disabled = value;
  }
  function error(message) {
    el("error").textContent = message;
    el("error").hidden = !message;
  }
  function render(state) {
    if (!state || !Number.isSafeInteger(state.siteRulesRevision)) throw new Error("Die Seitenfilter konnten nicht geladen werden.");
    for (const key of keys) el(key).value = (state.siteRules?.[key] || []).map(rule => `${rule.type} ${rule.value}`).join("\n");
    revision = state.siteRulesRevision; dirty = false;
    error(state.siteRulesError || "");
  }
  async function load() {
    if (busy || dirty && !window.confirm("Ungespeicherte Änderungen verwerfen und gespeicherte Regeln laden?")) return;
    lock(true); error("");
    try { render(await browser.runtime.sendMessage({ type: "bridge_status" })); el("status").textContent = "Gespeicherte Regeln geladen."; }
    catch (err) { error(String(err.message || err)); }
    finally { lock(false); }
  }
  function readRules() {
    return Object.fromEntries(keys.map(key => [key, el(key).value.split(/\r?\n/u).flatMap((line, index) => {
      if (!line.trim()) return [];
      const match = /^(domain|host|url)\s+(.+)$/u.exec(line.trim());
      if (!match) throw new Error(`${el(key).labels[0].textContent}, Zeile ${index + 1}: Bitte domain, host oder url vor das Muster setzen.`);
      return [{ type: match[1], value: match[2] }];
    })]));
  }
  el("rulesForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || revision === null) return;
    error(""); el("status").textContent = "";
    try {
      const siteRules = readRules(); lock(true);
      render(await browser.runtime.sendMessage({ type: "bridge_site_rules", revision, siteRules }));
      el("status").textContent = "Seitenfilter gespeichert. Temporäre Freigaben wurden widerrufen.";
    } catch (err) { error(String(err.message || err)); }
    finally { lock(false); }
  });
  for (const key of keys) el(key).addEventListener("input", () => { dirty = true; el("status").textContent = "Ungespeicherte Änderungen."; });
  el("reload").addEventListener("click", load);
  window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
  load();
})();
