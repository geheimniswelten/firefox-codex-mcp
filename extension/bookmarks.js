/* Shared as a plain background script and a side-effect module in Node tests. */
(() => {
  "use strict";
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const error = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
  const invalid = message => { throw error("INVALID_PARAMS", message); };
  const ROOT_IDS = new Set(["root________", "toolbar_____", "menu________", "unfiled_____", "mobile______"]);
  const SEARCH_KEYS = ["query", "searchIn", "matchMode", "caseSensitive"];
  const LIST_KEYS = ["parentId", "recursive", "limit", "offset"];
  const METHODS = {
    list_bookmark_folders: LIST_KEYS,
    search_bookmarks: [...SEARCH_KEYS, ...LIST_KEYS],
    create_bookmark: ["title", "url", "parentId", "index", "type"],
    update_bookmark: ["id", "title", "url"],
    move_bookmark: ["id", "parentId", "index"],
    delete_bookmark: ["id", "recursive"]
  };

  function id(value, name) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${name} muss eine nichtleere Lesezeichen-ID mit höchstens 128 Zeichen sein.`);
    return value;
  }

  function url(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 32768 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid("url muss eine absolute HTTP(S)-URL oder about:blank sein.");
    let parsed;
    try { parsed = new URL(value); } catch { invalid("url muss eine absolute HTTP(S)-URL oder about:blank sein."); }
    if (value !== "about:blank" && (!/^https?:\/\//iu.test(value) || !["http:", "https:"].includes(parsed.protocol))) invalid("url muss eine absolute HTTP(S)-URL oder about:blank sein.");
    return parsed.href;
  }

  function validate(method, params) {
    if (!own(METHODS, method)) throw error("METHOD_NOT_FOUND", "Unbekannte Lesezeichen-Methode.");
    if (!params || typeof params !== "object" || Array.isArray(params)) invalid("params muss ein Objekt sein.");
    for (const key of Object.keys(params)) if (!METHODS[method].includes(key)) invalid(`Unbekannter Parameter: ${key}`);
    const p = { ...params };
    for (const key of ["id", "parentId"]) if (own(p, key)) p[key] = id(p[key], key);
    for (const key of ["index", "offset"]) if (own(p, key) && (!Number.isSafeInteger(p[key]) || p[key] < 0 || p[key] > 2147483647)) invalid(`${key} muss eine nichtnegative Ganzzahl bis 2147483647 sein.`);
    for (const key of ["recursive"]) if (own(p, key) && typeof p[key] !== "boolean") invalid(`${key} muss boolean sein.`);
    if (own(p, "title") && (typeof p.title !== "string" || p.title.length > 512)) invalid("title darf höchstens 512 Zeichen enthalten.");
    if (own(p, "url")) p.url = url(p.url);
    if (["list_bookmark_folders", "search_bookmarks"].includes(method)) {
      if (own(p, "limit") && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 500)) invalid("limit muss eine Ganzzahl zwischen 1 und 500 sein.");
      if (method === "search_bookmarks") globalThis.FirefoxBridgeTabSearch.validateSearch(p);
      p.limit ??= 100;
      p.offset ??= 0;
      p.recursive ??= true;
    }
    if (method === "create_bookmark") {
      if (own(p, "type") && !["bookmark", "folder", "separator"].includes(p.type)) invalid("type muss bookmark, folder oder separator sein.");
      p.type ??= "bookmark";
      if (p.type === "bookmark" && !own(p, "url")) invalid("url fehlt für das Lesezeichen.");
      if (p.type !== "bookmark" && own(p, "url")) invalid("Ordner und Trennzeichen dürfen keine url enthalten.");
      p.title ??= "";
      p.parentId ??= "unfiled_____";
    }
    if (["update_bookmark", "move_bookmark", "delete_bookmark"].includes(method) && !own(p, "id")) invalid("id fehlt.");
    if (method === "update_bookmark" && !["title", "url"].some(key => own(p, key))) invalid("Mindestens title oder url muss geändert werden.");
    if (method === "move_bookmark" && !["parentId", "index"].some(key => own(p, key))) invalid("Mindestens parentId oder index muss angegeben werden.");
    if (method === "delete_bookmark") p.recursive ??= false;
    return p;
  }

  const nodeType = node => ["bookmark", "folder", "separator"].includes(node.type) ? node.type : typeof node.url === "string" ? "bookmark" : "folder";

  // Keep the Firefox/UI order and preserve each node's opaque, stable ID.
  function snapshot(tree) {
    if (!Array.isArray(tree)) throw error("BOOKMARKS_OPERATION_FAILED", "Firefox lieferte keinen gültigen Lesezeichenbaum.");
    const entries = [], byId = new Map(), roots = new Set();
    const stack = tree.map(node => ({ node, parentId: undefined, path: [] })).reverse();
    while (stack.length) {
      const frame = stack.pop(), node = frame.node;
      if (!node || typeof node.id !== "string" || byId.has(node.id)) throw error("BOOKMARKS_OPERATION_FAILED", "Firefox lieferte keinen gültigen Lesezeichenbaum.");
      const parentId = typeof node.parentId === "string" ? node.parentId : frame.parentId;
      const entry = { node, parentId, path: frame.path };
      entries.push(entry); byId.set(node.id, entry);
      if (parentId === undefined) roots.add(node.id);
      if (Array.isArray(node.children)) {
        const path = parentId === undefined ? frame.path : [...frame.path, typeof node.title === "string" ? node.title : ""];
        for (let position = node.children.length - 1; position >= 0; position--) stack.push({ node: node.children[position], parentId: node.id, path });
      }
    }
    return { entries, byId, roots };
  }

  function format(entry) {
    const { node, parentId, path } = entry;
    const result = { id: node.id, type: nodeType(node), title: typeof node.title === "string" ? node.title : "", path: [...path] };
    if (typeof node.url === "string") result.url = node.url;
    if (typeof parentId === "string") result.parentId = parentId;
    if (Number.isInteger(node.index) && node.index >= 0) result.index = node.index;
    if (typeof node.dateAdded === "number" && Number.isFinite(node.dateAdded) && Math.abs(node.dateAdded) <= 8640000000000000) result.dateAdded = new Date(node.dateAdded).toISOString();
    return result;
  }

  function requireNode(state, targetId) {
    const entry = state.byId.get(targetId);
    if (!entry) throw error("BOOKMARK_NOT_FOUND", "Die angegebene Lesezeichen-ID ist nicht vorhanden.");
    return entry;
  }

  function protect(state, entry) {
    if (state.roots.has(entry.node.id) || ROOT_IDS.has(entry.node.id)) throw error("BOOKMARK_ROOT_PROTECTED", "Firefox-Wurzelordner dürfen nicht geändert, verschoben oder gelöscht werden.");
    if (entry.node.unmodifiable) throw error("BOOKMARK_UNMODIFIABLE", "Dieses Lesezeichen kann nicht geändert werden.");
  }

  function parent(state, parentId, forMutation = false) {
    const entry = requireNode(state, parentId);
    if (nodeType(entry.node) !== "folder") throw error("BOOKMARK_PARENT_NOT_FOLDER", "parentId muss einen vorhandenen Lesezeichenordner bezeichnen.");
    if (forMutation && state.roots.has(parentId)) throw error("BOOKMARK_ROOT_PROTECTED", "Direkt im Firefox-Wurzelordner dürfen keine Einträge erstellt oder abgelegt werden.");
    if (forMutation && entry.node.unmodifiable) throw error("BOOKMARK_UNMODIFIABLE", "Der Zielordner kann nicht geändert werden.");
    return entry;
  }

  function descendants(state, p) {
    const parentId = p.parentId;
    if (parentId !== undefined) parent(state, parentId);
    return state.entries.filter(entry => {
      if (state.roots.has(entry.node.id)) return false;
      if (!p.recursive) return parentId === undefined ? state.roots.has(entry.parentId) : entry.parentId === parentId;
      if (parentId === undefined) return true;
      let ancestorId = entry.parentId;
      while (ancestorId !== undefined) {
        if (ancestorId === parentId) return true;
        ancestorId = state.byId.get(ancestorId)?.parentId;
      }
      return false;
    });
  }

  function createBookmarks(browser, options = {}) {
    const api = browser.bookmarks;
    const supported = method => {
      if (!api || typeof api[method] !== "function") throw error("UNSUPPORTED", `Die Firefox-Lesezeichen-API ${method} ist nicht verfügbar. Die Erweiterung mit bookmarks-Berechtigung neu laden.`);
    };
    async function call(method, args, context) {
      supported(method);
      context.assertLive?.();
      let result;
      try { result = await api[method](...args); }
      catch { throw error("BOOKMARKS_OPERATION_FAILED", "Firefox konnte die Lesezeichenanfrage nicht ausführen.", method === "getTree" ? undefined : { stateMayHaveChanged: true }); }
      // Reads must still be live when they finish. A completed mutation already
      // changed Firefox and must retain its concrete outcome after a deadline.
      if (method === "getTree") context.assertLive?.();
      return result;
    }

    async function handle(method, params = {}, context = {}) {
      const p = validate(method, params);
      const state = snapshot(await call("getTree", [], context));
      if (["list_bookmark_folders", "search_bookmarks"].includes(method)) {
        const folders = method === "list_bookmark_folders";
        let matches = descendants(state, p).filter(entry => nodeType(entry.node) === (folders ? "folder" : "bookmark")).map(format);
        if (!folders) matches = await globalThis.FirefoxBridgeTabSearch.filterTabs(matches, p, options);
        context.assertLive?.();
        return {
          [folders ? "folders" : "bookmarks"]: matches.slice(p.offset, p.offset + p.limit),
          total: matches.length, returned: Math.min(p.limit, Math.max(0, matches.length - p.offset)), offset: p.offset, limit: p.limit,
          nextOffset: p.offset + p.limit < matches.length ? p.offset + p.limit : null,
          untrustedContent: true
        };
      }

      if (method === "create_bookmark") {
        const destination = parent(state, p.parentId, true);
        const details = { title: p.title, type: p.type, parentId: p.parentId };
        if (own(p, "url")) details.url = p.url;
        if (own(p, "index")) details.index = p.index;
        const node = await call("create", [details], context);
        return { bookmark: format({ node, parentId: node.parentId ?? p.parentId, path: [...destination.path, destination.node.title ?? ""] }), untrustedContent: true };
      }

      const entry = requireNode(state, p.id);
      protect(state, entry);
      if (method === "update_bookmark") {
        if (own(p, "url") && nodeType(entry.node) !== "bookmark") invalid("Nur URL-Lesezeichen können eine url erhalten.");
        const changes = Object.fromEntries(["title", "url"].filter(key => own(p, key)).map(key => [key, p[key]]));
        const node = await call("update", [p.id, changes], context);
        return { bookmark: format({ ...entry, node }), untrustedContent: true };
      }
      if (method === "move_bookmark") {
        const destination = parent(state, p.parentId ?? entry.parentId, true);
        for (let ancestor = destination; ancestor; ancestor = state.byId.get(ancestor.parentId)) {
          if (ancestor.node.id === p.id) throw error("BOOKMARK_CYCLE", "Ein Ordner kann nicht in sich selbst oder einen seiner Unterordner verschoben werden.");
        }
        const changes = Object.fromEntries(["parentId", "index"].filter(key => own(p, key)).map(key => [key, p[key]]));
        const node = await call("move", [p.id, changes], context);
        return { bookmark: format({ node, parentId: node.parentId ?? destination.node.id, path: [...destination.path, destination.node.title ?? ""] }), untrustedContent: true };
      }
      if (method === "delete_bookmark") {
        const folder = nodeType(entry.node) === "folder";
        const hasChildren = state.entries.some(child => child.parentId === p.id);
        if (folder && hasChildren && !p.recursive) throw error("FOLDER_NOT_EMPTY", "Der Ordner enthält Einträge. Zum Löschen des gesamten Ordners recursive:true angeben.");
        await call(folder && p.recursive ? "removeTree" : "remove", [p.id], context);
        return { deleted: true, id: p.id, type: nodeType(entry.node), recursive: p.recursive, untrustedContent: true };
      }
      throw error("METHOD_NOT_FOUND", "Unbekannte Lesezeichen-Methode.");
    }

    return { handle };
  }

  globalThis.FirefoxBridgeBookmarks = { validate, createBookmarks };
})();
