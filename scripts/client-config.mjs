import { parseExpressionAt, tokenizer } from 'acorn';
import yaml from 'js-yaml';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_BYTES = 4 * 1024 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && equal(a[k], b[k]));
};
class Conflict extends Error {}
const conflict = message => { throw new Conflict(message); };
const eolOf = text => text.includes('\r\n') ? '\r\n' : '\n';
const lineIndent = (text, offset) => /^\s*/u.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset))[0].replace(/[\r\n]/gu, '');
// A fresh download can use a different Node runtime during removal. Ownership
// comes from the exact original script/config arguments and unchanged settings.
const sameOwnedEntry = (actual, expected, remove) => equal(actual, expected) || (remove && object(actual)
  && typeof actual.command === 'string' && isAbsolute(actual.command) && /^node(?:\.exe)?$/iu.test(basename(actual.command))
  && equal(actual, { ...expected, command: actual.command }));

function literal(node) {
  if (node.type === 'Literal' && !node.regex && !node.bigint && (node.value === null || ['string', 'boolean', 'number'].includes(typeof node.value))) {
    if (typeof node.value === 'number' && !Number.isFinite(node.value)) conflict('Nicht-endliche Zahlen werden nicht bearbeitet.');
    return node.value;
  }
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) && node.argument.type === 'Literal' && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)) {
    return node.operator === '-' ? -node.argument.value : node.argument.value;
  }
  if (node.type === 'ArrayExpression') {
    if (node.elements.some(v => !v)) conflict('Array-Luecken werden nicht bearbeitet.');
    return node.elements.map(literal);
  }
  if (node.type === 'ObjectExpression') {
    const result = Object.create(null);
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed || property.shorthand) conflict('Nur statische Konfigurationswerte sind erlaubt.');
      const key = property.key.type === 'Identifier' ? property.key.name : literal(property.key);
      if (!['string', 'number'].includes(typeof key)) conflict('Unbekannte Schluesselsyntax.');
      if (own(result, key)) conflict('Doppelte Konfigurationsschluessel werden nicht bearbeitet.');
      result[key] = literal(property.value);
    }
    return result;
  }
  conflict('Ausfuehrbare oder nicht unterstuetzte Konfigurationssyntax.');
}

function parseJson(text) {
  const source = text.replace(/^\uFEFF/u, ' ');
  const tokens = tokenizer(source, { ecmaVersion: 'latest' });
  const first = tokens.getToken();
  if (first.type.label === 'eof') return { value: Object.create(null), node: null };
  const node = parseExpressionAt(source, first.start, { ecmaVersion: 'latest' });
  if (node.type !== 'ObjectExpression' || first.start !== node.start) conflict('Die Konfiguration muss ein statisches Objekt sein.');
  if (tokenizer(source.slice(node.end), { ecmaVersion: 'latest' }).getToken().type.label !== 'eof') conflict('Zusaetzlicher ausfuehrbarer Inhalt hinter der Konfiguration.');
  return { value: literal(node), node };
}

const propertyKey = p => p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
const propertyAt = (node, key) => node.properties.find(p => propertyKey(p) === key);
function edits(text, changes) {
  return [...changes].sort((a, b) => b.start - a.start).reduce((current, edit) => current.slice(0, edit.start) + edit.text + current.slice(edit.end), text);
}
function commaIn(text, start, end) {
  const token = tokenizer(text.slice(start, end), { ecmaVersion: 'latest' }).getToken();
  return token.type.label === ',' ? start + token.start : null;
}
function insertJson(text, node, key, value) {
  const eol = eolOf(text), indent = lineIndent(text, node.start), childIndent = indent + '  ';
  const serialized = JSON.stringify(value, null, 2).split('\n').map((line, index) => index ? childIndent + line : line).join(eol);
  const close = node.end - 1, lineStart = text.lastIndexOf('\n', close - 1) + 1;
  const ownClosingLine = /^[\t ]*$/u.test(text.slice(lineStart, close));
  const position = ownClosingLine ? lineStart : close;
  const inserted = `${ownClosingLine ? '' : eol}${childIndent}${JSON.stringify(key)}: ${serialized}${eol}${ownClosingLine ? '' : indent}`;
  const changes = [{ start: position, end: position, text: inserted }];
  const last = node.properties.at(-1);
  if (last && commaIn(text, last.end, close) === null) changes.push({ start: last.end, end: last.end, text: ',' });
  return edits(text, changes);
}
function removeJson(text, node, property) {
  const index = node.properties.indexOf(property), next = node.properties[index + 1], previous = node.properties[index - 1];
  const changes = [{ start: property.start, end: property.end, text: '' }];
  const followingComma = commaIn(text, property.end, next?.start ?? node.end - 1);
  if (followingComma !== null) changes.push({ start: followingComma, end: followingComma + 1, text: '' });
  else if (previous) {
    const precedingComma = commaIn(text, previous.end, property.start);
    if (precedingComma === null) conflict('Kommatrennung kann nicht sicher bearbeitet werden.');
    changes.push({ start: precedingComma, end: precedingComma + 1, text: '' });
  }
  return edits(text, changes);
}
function mergeJson(text, keys, entry, remove) {
  const parsed = parseJson(text);
  if (!parsed.node) {
    if (remove) return null;
    let value = entry;
    for (const key of [...keys, 'firefox'].reverse()) value = { [key]: value };
    return text + (text && !text.endsWith('\n') ? eolOf(text) : '') + JSON.stringify(value, null, 2).replaceAll('\n', eolOf(text)) + eolOf(text);
  }
  let node = parsed.node, value = parsed.value;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (!own(value, key)) {
      if (remove) return null;
      let addition = { firefox: entry };
      for (const child of keys.slice(index + 1).reverse()) addition = { [child]: addition };
      return insertJson(text, node, key, addition);
    }
    if (!object(value[key])) conflict(`Der MCP-Bereich ${key} ist kein Objekt.`);
    node = propertyAt(node, key).value;
    value = value[key];
  }
  if (!own(value, 'firefox')) return remove ? null : insertJson(text, node, 'firefox', entry);
  if (!sameOwnedEntry(value.firefox, entry, remove)) conflict('Der Firefox-Eintrag gehoert zu einer anderen Installation oder wurde angepasst; er bleibt erhalten.');
  return remove ? removeJson(text, node, propertyAt(node, 'firefox')) : null;
}

function tomlBody(entry, eol) {
  for (const value of [entry.command, ...entry.args]) if (/[\u0000-\u001f\u007f]/u.test(value)) conflict('Steuerzeichen in TOML-Pfaden werden nicht unterstuetzt.');
  return ['[mcp_servers.firefox]', `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`, 'startup_timeout_sec = 15', 'tool_timeout_sec = 180'].join(eol) + eol;
}
function mergeToml(text, entry, remove) {
  const eol = eolOf(text), body = tomlBody(entry, eol);
  // A textual marker inside a multiline user string is not a managed table.
  if (/"""|'''/u.test(text)) conflict('Mehrzeilige TOML-Zeichenfolgen werden konservativ nicht automatisch bearbeitet.');
  const begins = [...text.matchAll(/^# BEGIN firefox-codex-mcp sha256=([a-f0-9]{64}) prefix=([012])\r?\n/gmu)];
  if (begins.length || text.includes('# BEGIN firefox-codex-mcp') || text.includes('# END firefox-codex-mcp')) {
    if (begins.length !== 1) conflict('Der verwaltete TOML-Block ist mehrdeutig oder veraendert.');
    const begin = begins[0], bodyStart = begin.index + begin[0].length;
    // Marker newlines can differ from unrelated TOML lines; END may be at EOF.
    const ends = [...text.matchAll(/^# END firefox-codex-mcp(?:\r?\n|(?![\s\S]))/gmu)];
    if (ends.length !== 1 || ends[0].index < bodyStart) conflict('Der verwaltete TOML-Block ist unvollstaendig.');
    const end = ends[0], endAfter = end.index + end[0].length;
    if (text.indexOf('# END firefox-codex-mcp', endAfter) >= 0) conflict('Der verwaltete TOML-Block ist unvollstaendig.');
    const actualBody = text.slice(bodyStart, end.index), prefix = Number(begin[2]);
    const bodyEol = eolOf(actualBody);
    let expectedBody = tomlBody(entry, bodyEol);
    if (remove) {
      const oldCommand = /^command = (.+)$/mu.exec(actualBody)?.[1]?.replace(/\r$/u, '');
      if (oldCommand) {
        const command = JSON.parse(oldCommand);
        if (typeof command === 'string' && isAbsolute(command) && /^node(?:\.exe)?$/iu.test(basename(command))) expectedBody = tomlBody({ ...entry, command }, bodyEol);
      }
    }
    let prefixStart = begin.index;
    for (let remaining = prefix; remaining > 0; remaining--) {
      if (text[prefixStart - 1] !== '\n') conflict('Der verwaltete TOML-Block gehoert zu einer anderen Installation oder wurde angepasst.');
      prefixStart -= text[prefixStart - 2] === '\r' ? 2 : 1;
    }
    if (hash(`${prefix}\n${actualBody}`) !== begin[1] || actualBody !== expectedBody) conflict('Der verwaltete TOML-Block gehoert zu einer anderen Installation oder wurde angepasst.');
    if (!remove) return null;
    const before = text.slice(0, prefixStart), after = text.slice(endAfter);
    // Later user sections still need a separator if the original file had none.
    const separator = before && after && !before.endsWith('\n') && !/^\r?\n/u.test(after)
      ? /^\r?\n/u.exec(text.slice(prefixStart, begin.index))?.[0] ?? bodyEol : '';
    return before + separator + after;
  }
  if (remove) return null;
  // TOML is deliberately not reserialized without a full TOML parser. Ambiguous
  // declarations and multiline strings are left for a manual registration.
  if (/firefox/iu.test(text) || /^\s*["']?mcp_servers["']?\s*[=.]/mu.test(text) || /"""|'''/u.test(text)) conflict('Vorhandene Firefox-, Inline-MCP- oder mehrzeilige TOML-Syntax wird nicht automatisch geaendert.');
  const stack = [];
  let quote = null, comment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (comment) { if (char === '\n') comment = false; continue; }
    if (quote) {
      if (char === '\n' || char === '\r') conflict('Nicht abgeschlossene TOML-Zeichenfolge.');
      if (quote === '"' && char === '\\') { index++; continue; }
      if (char === quote) quote = null;
    } else if (char === '#') comment = true;
    else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') stack.push(char);
    else if (char === ']' || char === '}') { if (stack.pop() !== (char === ']' ? '[' : '{')) conflict('Nicht abgeschlossene TOML-Struktur.'); }
  }
  if (quote || stack.length) conflict('Nicht abgeschlossene TOML-Struktur.');
  const prefix = text ? (text.endsWith('\n') ? 1 : 2) : 0;
  return text + eol.repeat(prefix) + `# BEGIN firefox-codex-mcp sha256=${hash(`${prefix}\n${body}`)} prefix=${prefix}${eol}` + body + `# END firefox-codex-mcp${eol}`;
}

function mergeYaml(text, entry, remove) {
  if (text.length > MAX_BYTES || /[\t]|(?:^|\s)[&*][\w-]+|(?:^|\s)!/mu.test(text)) conflict('YAML mit Tabs, Ankern, Aliasen oder Tags wird nicht automatisch geaendert.');
  const value = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (value !== undefined && value !== null && !object(value)) conflict('Die YAML-Konfiguration muss ein Mapping sein.');
  const root = value ?? {}, eol = eolOf(text);
  const dump = valueToDump => yaml.dump(valueToDump, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1, indent: 2 }).replaceAll('\n', eol);
  if (!own(root, 'mcp_servers')) return remove ? null : text + (text && !text.endsWith('\n') ? eol : '') + dump({ mcp_servers: { firefox: entry } });
  if (root.mcp_servers !== null && !object(root.mcp_servers)) conflict('mcp_servers ist kein YAML-Mapping.');
  const servers = root.mcp_servers ?? {};
  const headers = [...text.matchAll(/^mcp_servers:[ \t]*(?:#[^\r\n]*)?\r?\n/gmu)];
  if (headers.length !== 1) conflict('Nur einfache eingerueckte YAML-MCP-Mappings werden automatisch bearbeitet.');
  const header = headers[0], start = header.index + header[0].length;
  const following = /^(?=[^ #\r\n])[^\r\n]+/gmu;
  following.lastIndex = start;
  const end = following.exec(text)?.index ?? text.length;
  const block = text.slice(start, end);
  if (/^[ ]+[^#\r\n]+:\s*[|>]/mu.test(block)) conflict('Mehrzeilige YAML-Skalare im MCP-Bereich werden nicht automatisch bearbeitet.');
  const indents = [...block.matchAll(/^( +)[^ #\r\n]/gmu)].map(m => m[1].length);
  const indentation = indents.length ? Math.min(...indents) : 2;
  const addition = dump({ firefox: entry }).split(eol).filter((line, index, all) => index !== all.length - 1 || line).map(line => ' '.repeat(indentation) + line).join(eol) + eol;
  if (!own(servers, 'firefox')) {
    if (remove) return null;
    return text.slice(0, start) + addition + text.slice(start);
  }
  if (!sameOwnedEntry(servers.firefox, entry, remove)) conflict('Der YAML-Firefox-Eintrag gehoert zu einer anderen Installation oder wurde angepasst.');
  if (!remove) return null;
  const expression = new RegExp(`^ {${indentation}}firefox:[ \\t]*(?:#[^\\r\\n]*)?\\r?\\n`, 'gmu');
  const matches = [...block.matchAll(expression)];
  if (matches.length !== 1) conflict('Der YAML-Firefox-Eintrag kann nicht eindeutig entfernt werden.');
  const entryStart = start + matches[0].index;
  const ownedAddition = dump({ firefox: servers.firefox }).split(eol).filter((line, index, all) => index !== all.length - 1 || line).map(line => ' '.repeat(indentation) + line).join(eol) + eol;
  if (!text.startsWith(ownedAddition, entryStart)) conflict('Der erzeugte YAML-Eintrag wurde formatiert oder ergaenzt und bleibt erhalten.');
  return text.slice(0, entryStart) + text.slice(entryStart + ownedAddition.length);
}

/** Pure, non-evaluating text editor; exported for parser and preservation tests. */
export function mergeConfigText({ text, format = 'json', keys = ['mcpServers'], entry, remove = false }) {
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) conflict('Konfiguration ist groesser als 4 MiB.');
    if (!['json', 'jsonc', 'json5', 'toml', 'yaml'].includes(format)) conflict('Unbekanntes Konfigurationsformat.');
    if (format === 'json' && text.replace(/^\uFEFF/u, '').trim()) JSON.parse(text.replace(/^\uFEFF/u, ''));
    const next = format === 'toml' ? mergeToml(text, entry, remove) : format === 'yaml' ? mergeYaml(text, entry, remove) : mergeJson(text, keys, entry, remove);
    if (next === null || next === text) return { status: 'unchanged', text, message: remove ? 'Kein unveraenderter eigener Eintrag zu entfernen.' : 'Bereits passend registriert.' };
    // Validate the complete edited document again before any filesystem write.
    if (format === 'json') JSON.parse(next.replace(/^\uFEFF/u, ''));
    if (['json', 'jsonc', 'json5'].includes(format)) parseJson(next);
    if (format === 'yaml') yaml.load(next, { schema: yaml.JSON_SCHEMA });
    return { status: remove ? 'removed' : 'configured', text: next, message: remove ? 'Eigener Firefox-Eintrag entfernt.' : 'Firefox-MCP registriert.' };
  } catch (error) {
    return { status: 'conflict', text, message: error instanceof Conflict ? error.message : 'Konfiguration ist ungueltig oder verwendet nicht unterstuetzte Syntax; unveraendert.' };
  }
}

// Discovery only supplies a candidate root. The existing exact ownership checks
// still prove the complete entry before it may be removed or relocated.
function discoverFirefoxRoot({ text, format, keys = ['mcpServers'] }) {
  if (Buffer.byteLength(text) > MAX_BYTES) conflict('Konfiguration ist groesser als 4 MiB.');
  let entry;
  if (format === 'toml') {
    if (/"""|'''/u.test(text)) conflict('Mehrzeilige TOML-Zeichenfolgen werden konservativ nicht automatisch bearbeitet.');
    const begins = [...text.matchAll(/^# BEGIN firefox-codex-mcp sha256=([a-f0-9]{64}) prefix=([012])\r?\n/gmu)];
    if (!begins.length && !text.includes('# BEGIN firefox-codex-mcp') && !text.includes('# END firefox-codex-mcp')) return null;
    if (begins.length !== 1) conflict('Der verwaltete TOML-Block ist mehrdeutig oder veraendert.');
    const body = text.slice(begins[0].index + begins[0][0].length, text.indexOf('# END firefox-codex-mcp', begins[0].index));
    const command = /^command = (.+)\r?$/mu.exec(body)?.[1];
    const args = /^args = (.+)\r?$/mu.exec(body)?.[1];
    if (!command || !args) conflict('Der verwaltete TOML-Block ist unvollstaendig.');
    entry = { command: JSON.parse(command), args: JSON.parse(args) };
  } else {
    let value;
    if (format === 'yaml') value = yaml.load(text, { schema: yaml.JSON_SCHEMA }) ?? {};
    else {
      if (format === 'json' && text.replace(/^\uFEFF/u, '').trim()) JSON.parse(text.replace(/^\uFEFF/u, ''));
      value = parseJson(text).value;
    }
    for (const key of keys) {
      if (!object(value)) conflict('Der MCP-Bereich ist kein Objekt.');
      if (!own(value, key)) return null;
      value = value[key];
    }
    if (!object(value)) conflict('Der MCP-Bereich ist kein Objekt.');
    if (!own(value, 'firefox')) return null;
    entry = value.firefox;
  }
  if (!object(entry) || typeof entry.command !== 'string' || !isAbsolute(entry.command)
      || !/^node(?:\.exe)?$/iu.test(basename(entry.command)) || !Array.isArray(entry.args)
      || entry.args.length !== 3 || entry.args[1] !== '--config'
      || [entry.command, entry.args[0], entry.args[2]].some(value => typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value))) {
    conflict('Der Firefox-Eintrag ist keiner unveraenderten Installation eindeutig zuzuordnen.');
  }
  const root = dirname(dirname(entry.args[0]));
  if (entry.args[0] !== join(root, 'server', 'mcp.mjs') || entry.args[2] !== join(root, '.local', 'config.json')) {
    conflict('Die Firefox-Startargumente gehoeren nicht zur selben bekannten Installation.');
  }
  return root;
}

export function relocateConfigText({ text, format = 'json', keys = ['mcpServers'], entry, discover = false, remove = false }) {
  try {
    if (discover && !remove) conflict('Client-Erkennung ist nur bei der Deregistrierung moeglich.');
    if (!remove) {
      const current = mergeConfigText({ text, format, keys, entry });
      if (current.status !== 'conflict') return current;
    }
    const previousRoot = discoverFirefoxRoot({ text, format, keys });
    if (!previousRoot) return remove
      ? { status: 'unchanged', text, message: 'Kein unveraenderter eigener Eintrag zu entfernen.' }
      : mergeConfigText({ text, format, keys, entry });
    const previous = { ...entry, args: [join(previousRoot, 'server', 'mcp.mjs'), '--config', join(previousRoot, '.local', 'config.json')] };
    const removed = mergeConfigText({ text, format, keys, entry: previous, remove: true });
    if (removed.status !== 'removed' || remove) return removed;
    const added = mergeConfigText({ text: removed.text, format, keys, entry });
    if (added.status !== 'configured') return { ...added, text };
    return { ...added, message: 'Eigener Firefox-Eintrag auf den aktuellen Installationspfad umgestellt.' };
  } catch (error) {
    return { status: 'conflict', text, message: error instanceof Conflict ? error.message : 'Konfiguration ist ungueltig oder verwendet nicht unterstuetzte Syntax; unveraendert.' };
  }
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function absoluteEnv(value, name) {
  if (!isAbsolute(value)) conflict(`${name} muss ein absoluter Pfad sein.`);
  return resolve(value);
}

/** Detect existing configuration directories, not an assertion that an app is installed. */
export async function detectClients({ home = homedir(), appData, localAppData, env = process.env, platform = process.platform } = {}) {
  home = absoluteEnv(home, 'home');
  const windows = platform === 'win32' || platform === 'win', mac = platform === 'darwin' || platform === 'mac';
  if (!windows && !mac && platform !== 'linux') conflict('Client-Erkennung unterstützt Windows, Linux und macOS.');
  const xdg = (value, fallback) => typeof value === 'string' && isAbsolute(value) ? value : fallback;
  appData ??= windows ? env.APPDATA || join(home, 'AppData', 'Roaming') : mac ? join(home, 'Library', 'Application Support') : xdg(env.XDG_CONFIG_HOME, join(home, '.config'));
  localAppData ??= windows ? env.LOCALAPPDATA || join(home, 'AppData', 'Local') : xdg(env.XDG_DATA_HOME, join(home, '.local', 'share'));
  const definitions = [
    { id: 'codex', label: 'Codex', folder: env.CODEX_HOME || join(home, '.codex'), filename: 'config.toml', format: 'toml' },
    { id: 'claude-code', label: 'Claude Code (CLI / VS Code)', folder: env.CLAUDE_CONFIG_DIR || home, marker: env.CLAUDE_CONFIG_DIR || join(home, '.claude'), filename: '.claude.json', format: 'json', extra: { type: 'stdio', timeout: 180000 } },
    { id: 'claude-desktop', label: 'Claude Desktop', folder: join(appData, 'Claude'), filename: 'claude_desktop_config.json', format: 'json' },
    { id: 'lm-studio', label: 'LM Studio', folder: join(home, '.lmstudio'), filename: 'mcp.json', format: 'json' },
    { id: 'eigent', label: 'Eigent', folder: join(home, '.eigent'), filename: 'mcp.json', format: 'json' },
    { id: 'gemini', label: 'Gemini CLI / Code Assist', folder: join(env.GEMINI_CLI_HOME || home, '.gemini'), filename: 'settings.json', format: 'json', extra: { timeout: 180000 } },
    { id: 'hermes', label: 'Hermes', folder: env.HERMES_HOME || (windows ? join(localAppData, 'hermes') : join(home, '.hermes')), filename: 'config.yaml', format: 'yaml', keys: ['mcp_servers'], extra: { timeout: 180 } },
    { id: 'openclaw', label: 'OpenClaw', folder: env.OPENCLAW_STATE_DIR || join(home, '.openclaw'), filename: 'openclaw.json', format: 'json5', keys: ['mcp', 'servers'], extra: { requestTimeoutMs: 180000 } },
  ];
  const results = [];
  for (const definition of definitions) {
    const candidate = { ...definition };
    try {
      if (candidate.id === 'openclaw') {
        if (env.OPENCLAW_CONFIG_READONLY === '1' || env.OPENCLAW_NIX_MODE === '1') { candidate.skip = 'OpenClaw ist als schreibgeschuetzt konfiguriert.'; }
        else if (env.OPENCLAW_CONFIG_PATH) {
          const path = absoluteEnv(env.OPENCLAW_CONFIG_PATH, 'OPENCLAW_CONFIG_PATH');
          candidate.folder = dirname(path); candidate.filename = path.slice(candidate.folder.length + 1);
        } else if (!env.OPENCLAW_STATE_DIR && (env.OPENCLAW_PROFILE || env.OPENCLAW_HOME)) candidate.skip = 'OpenClaw-Profil ist mehrdeutig; zuerst OPENCLAW_CONFIG_PATH explizit setzen.';
      }
      if (candidate.id === 'hermes' && !env.HERMES_HOME) {
        const legacy = join(home, '.hermes');
        if (resolve(candidate.folder) !== resolve(legacy)) {
          const modernExists = await exists(candidate.folder), legacyExists = await exists(legacy);
          if (modernExists && legacyExists) candidate.skip = 'Mehrere Hermes-Konfigurationsordner; zuerst HERMES_HOME explizit setzen.';
          else if (legacyExists) candidate.folder = legacy;
        }
      }
      candidate.folder = absoluteEnv(candidate.folder, `${candidate.id}-Konfigurationsordner`);
      candidate.path = join(candidate.folder, candidate.filename);
      candidate.detected = await exists(candidate.path) || await exists(candidate.marker || candidate.folder);
    } catch (error) { candidate.skip = error instanceof Conflict ? error.message : 'Konfigurationsordner konnte nicht sicher geprueft werden.'; }
    results.push(candidate);
  }
  return results;
}

async function safeParents(path) {
  for (let current = dirname(path); ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) conflict('Verknuepfte oder unpassende Konfigurationsordner werden nicht bearbeitet.');
    if (dirname(current) === current) break;
  }
}
async function snapshot(path) {
  await safeParents(path);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { bytes: null }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) conflict('Nur normale, nicht verknuepfte Konfigurationsdateien werden bearbeitet.');
  if (!(info.mode & 0o222)) conflict('Die Konfigurationsdatei ist schreibgeschuetzt.');
  if (info.size > MAX_BYTES) conflict('Konfiguration ist groesser als 4 MiB.');
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1) conflict('Konfiguration wurde gleichzeitig ersetzt.');
    const bytes = await handle.readFile();
    return { bytes, info };
  } finally { await handle.close(); }
}
async function compare(path, before) {
  const now = await snapshot(path);
  if (Boolean(now.bytes) !== Boolean(before.bytes) || (now.bytes && (!now.bytes.equals(before.bytes) || now.info.ino !== before.info.ino || now.info.dev !== before.info.dev || now.info.mode !== before.info.mode))) conflict('Konfiguration wurde gleichzeitig geaendert; bitte erneut ausfuehren.');
}

async function windowsAcl(path, sddl = undefined) {
  const childEnv = { ...process.env, FIREFOX_MCP_ACL_PATH: path };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  if (sddl !== undefined) childEnv.FIREFOX_MCP_ACL_SDDL = sddl;
  const read = sddl === undefined;
  const script = read
    ? "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:FIREFOX_MCP_ACL_PATH).Sddl"
    : "$ErrorActionPreference='Stop'; $acl=[System.Security.AccessControl.FileSecurity]::new(); if ($env:FIREFOX_MCP_ACL_SDDL) { $acl.SetSecurityDescriptorSddlForm($env:FIREFOX_MCP_ACL_SDDL) } else { $acl.SetAccessRuleProtection($true,$false); $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); foreach ($sid in @($user,$system)) { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')) } }; Set-Acl -LiteralPath $env:FIREFOX_MCP_ACL_PATH -AclObject $acl";
  try {
    const result = await exec(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnv, encoding: 'utf8', timeout: 15000, windowsHide: true });
    return result.stdout.trim();
  } catch { throw new Error('Windows-Dateirechte konnten nicht sicher gelesen oder erhalten werden; keine Konfiguration ersetzt.'); }
}

async function writeAtomic(path, before, content) {
  const suffix = `${Date.now()}-${randomUUID()}`, temp = `${path}.firefox-mcp-${suffix}.tmp`;
  const backup = before.bytes === null ? undefined : `${path}.firefox-mcp-${suffix}.bak`;
  const originalAcl = process.platform === 'win32' && before.bytes !== null ? await windowsAcl(path) : undefined;
  let tempCreated = false, backupCreated = false, backupComplete = false;
  try {
    await compare(path, before);
    const handle = await open(temp, 'wx', 0o600);
    tempCreated = true;
    try {
      // Restrict an empty file before placing any potentially secret content in it.
      if (process.platform === 'win32') await windowsAcl(temp, originalAcl ?? '');
      await handle.writeFile(content); await handle.sync();
      if (process.platform !== 'win32' && before.info) await handle.chmod(before.info.mode & 0o777);
    } finally { await handle.close(); }
    if (backup) {
      const handle = await open(backup, 'wx', 0o600);
      backupCreated = true;
      try {
        if (process.platform === 'win32') await windowsAcl(backup, '');
        await handle.writeFile(before.bytes); await handle.sync(); backupComplete = true;
      } finally { await handle.close(); }
    }
    await compare(path, before);
    if (originalAcl !== undefined && await windowsAcl(path) !== originalAcl) conflict('Windows-Dateirechte wurden gleichzeitig geaendert.');
    await rename(temp, path);
    tempCreated = false;
    return backup;
  } catch (error) {
    if (backupComplete) error.backup = backup;
    throw error;
  } finally {
    if (tempCreated) await unlink(temp).catch(() => {});
    if (backupCreated && !backupComplete) await unlink(backup).catch(() => {});
  }
}

export async function configureClients({ root, nodePath = process.execPath, home = homedir(), appData, localAppData, env = process.env, platform = process.platform, remove = false, dryRun = false, relocate = false, discover = false }) {
  if ((discover && !remove) || (relocate && remove) || (relocate && discover)) conflict('Client-Pfadwechsel und Erkennung sind nicht mit dieser Operation kombinierbar.');
  root = absoluteEnv(root, 'root');
  nodePath = absoluteEnv(nodePath, 'nodePath');
  const base = { command: nodePath, args: [join(root, 'server', 'mcp.mjs'), '--config', join(root, '.local', 'config.json')] };
  const results = [];
  for (const candidate of await detectClients({ home, appData, localAppData, env, platform })) {
    const result = { id: candidate.id, label: candidate.label, path: candidate.path || null };
    try {
      if (candidate.skip) { results.push({ ...result, status: 'skipped', message: candidate.skip }); continue; }
      if (!candidate.detected) { results.push({ ...result, status: 'not_detected', message: 'Kein vorhandener Konfigurationsordner erkannt.' }); continue; }
      const before = await snapshot(candidate.path);
      const text = before.bytes?.toString('utf8') ?? '';
      if (before.bytes && !Buffer.from(text, 'utf8').equals(before.bytes)) conflict('Datei ist nicht gueltiges UTF-8.');
      const merge = relocate || discover ? relocateConfigText : mergeConfigText;
      const merged = merge({ text, format: candidate.format, keys: candidate.keys, entry: { ...base, ...candidate.extra }, remove, discover });
      if (!['configured', 'removed'].includes(merged.status)) { results.push({ ...result, status: merged.status, message: merged.message }); continue; }
      if (dryRun) { results.push({ ...result, status: 'dry_run', message: remove ? 'Eigener Eintrag wuerde entfernt.' : 'Firefox-Eintrag wuerde ergaenzt.' }); continue; }
      const backup = await writeAtomic(candidate.path, before, merged.text);
      results.push({ ...result, status: merged.status, message: merged.message, ...(backup ? { backup } : {}) });
    } catch (error) {
      results.push({ ...result, status: error instanceof Conflict ? 'conflict' : 'error', message: error instanceof Conflict ? error.message : error.message?.startsWith('Windows-Dateirechte') ? error.message : 'Konfiguration konnte nicht sicher bearbeitet werden; bitte Pfad und Schreibrechte pruefen.', ...(error.backup ? { backup: error.backup } : {}) });
    }
  }
  return results;
}
