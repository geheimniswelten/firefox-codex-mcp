/* Shared as a plain background script and a side-effect module in Node tests. */
(() => {
  "use strict";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_DAYS = 3660;
  const MAX_CANDIDATES = 50000;
  const MAX_VISITS = 100000;
  const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
  const MAX_SNAPSHOTS = 4;
  const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_SNAPSHOT_BYTES = 32 * 1024 * 1024;
  const SNAPSHOT_METADATA_BYTES = 1024;
  const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
  const SCAN_BUDGET_MS = 20000;
  const MAX_CONCURRENT_SEARCHES = 2;
  const VISIT_CONCURRENCY = 4;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const error = (code, message) => Object.assign(new Error(message), { code });
  const invalid = message => { throw error("INVALID_PARAMS", message); };
  const searchKeys = ["query", "searchIn", "matchMode", "caseSensitive"];
  const rangeKeys = ["lastHours", "lastDays", "from", "to"];
  const pageKeys = ["snapshotId", "offset", "limit"];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const iso = timestamp => new Date(timestamp).toISOString();

  function dateTime(value, field) {
    if (typeof value !== "string") invalid(`${field} muss ein ISO-Zeitpunkt mit Z oder explizitem Offset sein.`);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) invalid(`${field} muss ein ISO-Zeitpunkt mit Z oder explizitem Offset sein.`);
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? 0) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) invalid(`${field} enthält keinen gültigen ISO-Zeitpunkt.`);
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) invalid(`${field} enthält keinen gültigen ISO-Zeitpunkt.`);
    return timestamp;
  }

  function validate(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) invalid("params muss ein Objekt sein.");
    const allowed = own(params, "snapshotId") ? pageKeys : [...searchKeys, ...rangeKeys, ...pageKeys];
    if (Object.keys(params).some(key => !allowed.includes(key))) invalid(own(params, "snapshotId") ? "Eine Snapshot-Seite erlaubt nur snapshotId, offset und limit." : "Unbekannter Parameter für die Chronik-Suche.");
    if (own(params, "limit") && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 500)) invalid("limit muss eine ganze Zahl von 1 bis 500 sein.");
    if (own(params, "offset") && (!Number.isInteger(params.offset) || params.offset < 0 || params.offset > 2147483647)) invalid("offset muss eine ganze Zahl von 0 bis 2147483647 sein.");
    const pagination = { limit: params.limit ?? 100, offset: params.offset ?? 0 };
    if (own(params, "snapshotId")) {
      if (typeof params.snapshotId !== "string" || params.snapshotId.length < 1 || params.snapshotId.length > 128) invalid("snapshotId muss 1–128 Zeichen enthalten.");
      return { ...pagination, snapshotId: params.snapshotId };
    }
    const textSearch = globalThis.FirefoxBridgeTabSearch;
    if (!textSearch || typeof textSearch.validateSearch !== "function" || typeof textSearch.filterTabs !== "function") throw error("UNSUPPORTED", "Die Textsuche für die Chronik ist nicht verfügbar.");
    const search = textSearch.validateSearch(params);
    if (own(params, "lastHours") && own(params, "lastDays")) invalid("lastHours und lastDays können nicht kombiniert werden.");
    const relative = own(params, "lastHours") || own(params, "lastDays");
    if (relative && (own(params, "from") || own(params, "to"))) invalid("Relative und absolute Zeitfilter können nicht kombiniert werden.");
    for (const [field, maximum] of [["lastHours", MAX_DAYS * 24], ["lastDays", MAX_DAYS]]) {
      if (own(params, field) && (!Number.isFinite(params[field]) || params[field] <= 0 || params[field] > maximum)) invalid(`${field} muss eine positive Zahl bis ${maximum} sein.`);
    }
    const from = own(params, "from") ? dateTime(params.from, "from") : undefined;
    const to = own(params, "to") ? dateTime(params.to, "to") : undefined;
    if (from !== undefined && to !== undefined && from >= to) invalid("from muss vor to liegen.");
    return {
      ...pagination,
      search,
      ...(relative ? { durationMs: own(params, "lastHours") ? params.lastHours * 60 * 60 * 1000 : params.lastDays * DAY_MS } : {}),
      ...(from !== undefined || to !== undefined ? { absolute: true, from, to } : {})
    };
  }

  function createHistory(browser, options = {}) {
    const now = options.now ?? Date.now;
    const randomId = options.randomId ?? (() => globalThis.crypto.randomUUID());
    const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
    const maxVisits = options.maxVisits ?? MAX_VISITS;
    const maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
    const snapshotTtlMs = options.snapshotTtlMs ?? SNAPSHOT_TTL_MS;
    const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
    const maxTotalSnapshotBytes = options.maxTotalSnapshotBytes ?? MAX_TOTAL_SNAPSHOT_BYTES;
    const scanBudgetMs = options.scanBudgetMs ?? SCAN_BUDGET_MS;
    const maxCandidateBytes = options.maxCandidateBytes ?? MAX_CANDIDATE_BYTES;
    const maxConcurrentSearches = options.maxConcurrentSearches ?? MAX_CONCURRENT_SEARCHES;
    const budgetNow = () => globalThis.performance?.now() ?? Date.now();
    const filterOptions = { ...(options.workerFactory ? { workerFactory: options.workerFactory } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) };
    for (const [name, value, maximum] of [["maxCandidates", maxCandidates, MAX_CANDIDATES], ["maxVisits", maxVisits, MAX_VISITS], ["maxSnapshots", maxSnapshots, MAX_SNAPSHOTS], ["snapshotTtlMs", snapshotTtlMs, SNAPSHOT_TTL_MS], ["scanBudgetMs", scanBudgetMs, SCAN_BUDGET_MS], ["maxConcurrentSearches", maxConcurrentSearches, MAX_CONCURRENT_SEARCHES]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} muss eine ganze Zahl von 1 bis ${maximum} sein.`);
    }
    for (const [name, value, maximum] of [["maxSnapshotBytes", maxSnapshotBytes, MAX_SNAPSHOT_BYTES], ["maxTotalSnapshotBytes", maxTotalSnapshotBytes, MAX_TOTAL_SNAPSHOT_BYTES], ["maxCandidateBytes", maxCandidateBytes, MAX_CANDIDATE_BYTES]]) {
      if (!Number.isSafeInteger(value) || value < SNAPSHOT_METADATA_BYTES || value > maximum) throw new TypeError(`${name} muss eine ganze Zahl von ${SNAPSHOT_METADATA_BYTES} bis ${maximum} sein.`);
    }
    const snapshotByteLimit = Math.min(maxSnapshotBytes, maxTotalSnapshotBytes);
    const encoder = new TextEncoder();
    const snapshots = new Map();
    const activeSearches = new Set();
    let generation = 0, totalSnapshotBytes = 0;
    function removeSnapshot(id) {
      const snapshot = snapshots.get(id);
      if (snapshot) { totalSnapshotBytes -= snapshot.bytes; snapshots.delete(id); }
    }
    function prune(timestamp) {
      for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= timestamp) removeSnapshot(id);
    }
    function page(snapshot, normalized) {
      const visits = snapshot.visits.slice(normalized.offset, normalized.offset + normalized.limit).map(visit => ({ ...visit }));
      const hasMore = normalized.offset + visits.length < snapshot.visits.length;
      return {
        visits,
        total: snapshot.visits.length,
        returned: visits.length,
        offset: normalized.offset,
        limit: normalized.limit,
        hasMore,
        nextOffset: hasMore ? normalized.offset + visits.length : null,
        snapshotId: snapshot.id,
        expiresAt: iso(snapshot.expiresAt),
        range: { ...snapshot.range },
        incomplete: snapshot.warnings.length > 0,
        warnings: [...snapshot.warnings],
        untrustedContent: true
      };
    }
    function clear() {
      generation += 1;
      snapshots.clear();
      totalSnapshotBytes = 0;
      for (const controller of activeSearches) controller.abort(error("CANCELLED", "Die Chronik-Suche wurde beendet und ihr Snapshot verworfen."));
    }
    // New visits do not disturb a snapshot; removals explicitly invalidate it.
    // Firefox only reports a URL here once all its visits have been removed.
    if (typeof browser?.history?.onVisitRemoved?.addListener === "function") browser.history.onVisitRemoved.addListener(clear);
    async function search(params, { assertLive, signal } = {}) {
      const normalized = validate(params);
      const currentGeneration = generation;
      const live = () => {
        assertLive?.();
        if (signal?.aborted) throw signal.reason ?? error("CANCELLED", "Die Chronik-Suche wurde abgebrochen.");
        if (generation !== currentGeneration) throw error("CANCELLED", "Die Chronik-Suche wurde beendet und ihr Snapshot verworfen.");
      };
      live();
      const startedAt = now();
      prune(startedAt);
      if (normalized.snapshotId) {
        const snapshot = snapshots.get(normalized.snapshotId);
        if (!snapshot) throw error("SNAPSHOT_EXPIRED", "Der Chronik-Snapshot ist abgelaufen oder nicht mehr verfügbar. Bitte eine neue Suche starten.");
        live();
        return page(snapshot, normalized);
      }
      if (!browser?.history || typeof browser.history.search !== "function" || typeof browser.history.getVisits !== "function") throw error("UNSUPPORTED", "Die Firefox-Chronik-API ist nicht verfügbar.");
      if (activeSearches.size >= maxConcurrentSearches) throw error("BUSY", "Es laufen bereits zu viele Chronik-Suchen. Bitte eine laufende Suche abwarten.");
      const to = normalized.absolute ? normalized.to ?? startedAt : startedAt;
      const from = normalized.absolute ? normalized.from ?? 0 : startedAt - (normalized.durationMs ?? DAY_MS);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) invalid("from muss vor to liegen.");

      const controller = new AbortController();
      activeSearches.add(controller);
      const onAbort = () => controller.abort(signal.reason ?? error("CANCELLED", "Die Chronik-Suche wurde abgebrochen."));
      signal?.addEventListener("abort", onAbort, { once: true });
      const deadline = budgetNow() + scanBudgetMs;
      const budgetFailure = error("SCAN_BUDGET_EXCEEDED", "Das interne Chronik-Zeitlimit wurde erreicht.");
      const checkBudget = () => {
        live();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (budgetNow() >= deadline) throw budgetFailure;
      };
      // A separate bounded wait per operation lets us remove timeout and abort
      // handlers immediately, rather than retaining completed API results in a
      // shared Promise.race until the whole search finishes.
      function withinBudget(operation) {
        checkBudget();
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (failure, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", cancelled);
            if (failure) reject(failure); else resolve(value);
          };
          const cancelled = () => finish(controller.signal.reason);
          const timer = setTimeout(() => {
            try { live(); finish(budgetFailure); }
            catch (failure) { finish(failure); }
          }, Math.max(1, deadline - budgetNow()));
          controller.signal.addEventListener("abort", cancelled, { once: true });
          try { Promise.resolve(operation()).then(value => finish(null, value), failure => finish(failure)); }
          catch (failure) { finish(failure); }
        });
      }
      const warnings = [], visits = [];
      let inspectedVisits = 0, snapshotBytes = SNAPSHOT_METADATA_BYTES;
      try {
        try {
          // Do not set endTime here: a URL visited again today can still contain
          // a visit in yesterday's range. Filter the real visits afterwards.
          let candidates = await withinBudget(() => browser.history.search({ text: "", startTime: from, maxResults: maxCandidates + 1 }));
          live();
          if (!Array.isArray(candidates)) throw error("SEARCH_FAILED", "Firefox lieferte keine gültige Chronik-Liste.");
          if (candidates.length > maxCandidates) warnings.push(`Das Kandidatenlimit von ${maxCandidates} URLs wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
          const boundedCandidates = [];
          let candidateBytes = 0;
          for (const item of candidates.slice(0, maxCandidates)) {
            checkBudget();
            const bytes = encoder.encode(JSON.stringify(item)).byteLength + 1;
            if (candidateBytes + bytes > maxCandidateBytes) {
              warnings.push(`Das Kandidaten-Datenlimit von ${maxCandidateBytes} Bytes wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
              break;
            }
            candidateBytes += bytes;
            boundedCandidates.push(item);
          }
          candidates = null;
          const filtered = await withinBudget(() => globalThis.FirefoxBridgeTabSearch.filterTabs(boundedCandidates, normalized.search ?? {}, filterOptions));
          live();
          let stopped = false;
          for (let batchOffset = 0; batchOffset < filtered.length && !stopped; batchOffset += VISIT_CONCURRENCY) {
            checkBudget();
            const batch = filtered.slice(batchOffset, batchOffset + VISIT_CONCURRENCY);
            // Never fan out across the complete history. Processing remains in
            // candidate order even if Firefox answers these four calls out of order.
            const replies = await Promise.all(batch.map(item => typeof item.url === "string" && item.url ? withinBudget(() => browser.history.getVisits({ url: item.url })) : []));
            live();
            for (let position = 0; position < batch.length; position += 1) {
              checkBudget();
              if (inspectedVisits >= maxVisits) {
                warnings.push(`Das Besuchslimit von ${maxVisits} Einträgen wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
                stopped = true;
                break;
              }
              const item = batch[position], entries = replies[position];
              if (!Array.isArray(entries)) throw error("SEARCH_FAILED", "Firefox lieferte keine gültige Besuchsliste.");
              const available = maxVisits - inspectedVisits;
              const examined = entries.slice(0, available);
              inspectedVisits += examined.length;
              for (const visit of examined) {
                checkBudget();
                if (!Number.isFinite(visit.visitTime) || visit.visitTime < from || visit.visitTime >= to) continue;
                const result = {
                  id: visit.id ?? item.id ?? null,
                  visitId: visit.visitId ?? null,
                  url: item.url,
                  title: typeof item.title === "string" ? item.title : "",
                  visitedAt: iso(visit.visitTime),
                  visitTime: visit.visitTime,
                  transition: visit.transition ?? null
                };
                const visitBytes = encoder.encode(JSON.stringify(result)).byteLength + 1;
                if (snapshotBytes + visitBytes > snapshotByteLimit) {
                  warnings.push(`Das Snapshot-Datenlimit von ${snapshotByteLimit} Bytes wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
                  stopped = true;
                  break;
                }
                snapshotBytes += visitBytes;
                visits.push(result);
              }
              if (stopped) break;
              if (entries.length > available) {
                warnings.push(`Das Besuchslimit von ${maxVisits} Einträgen wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
                stopped = true;
                break;
              }
            }
            if (inspectedVisits >= maxVisits && batchOffset + batch.length < filtered.length && !stopped) {
              warnings.push(`Das Besuchslimit von ${maxVisits} Einträgen wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
              stopped = true;
            }
          }
        } catch (failure) {
          if (failure !== budgetFailure) throw failure;
          live();
          warnings.push(`Das Scan-Zeitlimit von ${scanBudgetMs} Millisekunden wurde erreicht. Die Ergebnisse sind unvollständig; total zählt nur erfasste Treffer.`);
        }
        visits.sort((a, b) => b.visitTime - a.visitTime || compare(a.url, b.url) || compare(String(a.visitId ?? ""), String(b.visitId ?? "")) || compare(String(a.id ?? ""), String(b.id ?? "")));
        live();
        const completedAt = now();
        prune(completedAt);
        while (snapshots.size >= maxSnapshots || totalSnapshotBytes + snapshotBytes > maxTotalSnapshotBytes) removeSnapshot(snapshots.keys().next().value);
        const snapshot = { id: randomId(), visits, range: { from: iso(from), to: iso(to) }, expiresAt: completedAt + snapshotTtlMs, warnings, bytes: snapshotBytes };
        snapshots.set(snapshot.id, snapshot);
        totalSnapshotBytes += snapshotBytes;
        return page(snapshot, normalized);
      } finally {
        controller.abort(error("CANCELLED", "Die Chronik-Suche ist beendet."));
        activeSearches.delete(controller);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    return { search, clear };
  }

  globalThis.FirefoxBridgeHistory = { validate, createHistory };
})();
