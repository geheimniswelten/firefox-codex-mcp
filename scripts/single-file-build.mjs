import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

export const SINGLE_FILE_VERSION = '1.6.19';

// Pin every source file replaced or transformed by this build. Line endings are
// normalized so the same checked-in sources also build after a Git EOL checkout.
const REVIEWED_SOURCES = Object.freeze({
  'single-file.js': '6749b98d7cbf2e13c73290f08022448aa2220065f7b3d54b2c0588ac445f07b4',
  'core/index.js': '97804a361107350b3ed1c47161e9d5426f623156215a05f72423e90c2f68cc98',
  'core/helper.js': 'd0c81aaf532ebef599c3c5af2cf75512a1818475918f63ba874c1cd3b78d2fbd',
  'core/infobar.js': '387d30ac12c2ffe7882500cb898992e4df75d0d804fb43f689aa949e4e3414b8',
  'processors/compression/compression.js': 'db92120efc3a7874f6c07746574cb54168916885d061c38ef7cdba41a6b9c947',
  'vendor/zip/zip.js': '98845a3d01e62202269dc455a37d2ca24e8310f23e39c00fe46ec66546309fd0'
});

const LOAD_OPTIONS_FROM_PAGE = `\tloadOptionsFromPage() {
\t\tconst optionsElement = this.doc.body.querySelector("script[type=\\\"application/json\\\"][" + SCRIPT_OPTIONS + "]");
\t\tif (optionsElement) {
\t\t\tconst options = JSON.parse(optionsElement.textContent);
\t\t\tObject.keys(options).forEach(option => this.options[option] = options[option]);
\t\t\tthis.options.saveDate = new Date(this.options.saveDate);
\t\t\tthis.options.visitDate = new Date(this.options.visitDate);
\t\t}
\t}`;

const KEEP_NOSCRIPT_HTML = `\t\tif (this.options.removeNoScriptTags === false) {
\t\t\tconst noscriptPlaceholders = new Map();
\t\t\tthis.doc.querySelectorAll("noscript").forEach(noscriptElement => {
\t\t\t\tconst placeholderElement = this.doc.createElement("div");
\t\t\t\tplaceholderElement.innerHTML = noscriptElement.dataset[util.NO_SCRIPT_PROPERTY_NAME];
\t\t\t\tnoscriptElement.replaceWith(placeholderElement);
\t\t\t\tnoscriptPlaceholders.set(placeholderElement, noscriptElement);
\t\t\t});
\t\t\tnoscriptPlaceholders.forEach((noscriptElement, placeholderElement) => {
\t\t\t\tnoscriptElement.dataset[util.NO_SCRIPT_PROPERTY_NAME] = placeholderElement.innerHTML;
\t\t\t\tplaceholderElement.replaceWith(noscriptElement);
\t\t\t});
\t\t} else {
\t\t\tthis.doc.querySelectorAll("noscript").forEach(element => element.remove());
\t\t}`;

const CROSS_BROWSER_SHADOW_ROOT = `function getShadowRoot(element) {
\tconst chrome = globalThis.chrome;
\tif (element.openOrClosedShadowRoot) {
\t\treturn element.openOrClosedShadowRoot;
\t} else if (chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
\t\ttry {
\t\t\treturn chrome.dom.openOrClosedShadowRoot(element);
\t\t\t// eslint-disable-next-line no-unused-vars
\t\t} catch (error) {
\t\t\treturn element.shadowRoot;
\t\t}
\t} else {
\t\treturn element.shadowRoot;
\t}
}`;

const UNAVAILABLE_FEATURE = `function unavailableFeature(feature) {
  const error = new Error("This static Firefox HTML build does not support " + feature + ".");
  error.code = "UNSUPPORTED_SINGLE_FILE_OPTION";
  throw error;
}`;

const STUBS = Object.freeze({
  'processors/compression/compression.js': `${UNAVAILABLE_FEATURE}
export const PROCESS_OPTION_NAMES = [];
export function process() { unavailableFeature("compressContent"); }
`,
  'vendor/zip/zip.js': `${UNAVAILABLE_FEATURE}
export function configure() { unavailableFeature("ZIP archives"); }
export function inflateRaw() { unavailableFeature("ZIP archives"); }
export function deflateRaw() { unavailableFeature("ZIP archives"); }
export class ZipReader { constructor() { unavailableFeature("ZIP archives"); } }
export class ZipWriter { constructor() { unavailableFeature("ZIP archives"); } }
`,
  'core/infobar.js': `${UNAVAILABLE_FEATURE}
export const INFOBAR_TAGNAME = "single-file-infobar";
export function appendInfobar() { unavailableFeature("includeInfobar"); }
`
});

const ENTRY_POINT = `import { getPageData as capture, processors, helper } from "./single-file.js";
export { processors, helper };

export async function getPageData(options = {}, initOptions, doc, win) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("SingleFile options must be an object.");
  }
  for (const name of ["compressContent", "includeInfobar", "userScriptEnabled"]) {
    if (options[name]) unsupportedOption(name);
  }
  for (const name of ["blockScripts", "removeNoScriptTags"]) {
    if (options[name] !== undefined && options[name] !== true) unsupportedOption(name);
  }
  return capture({ ...options, blockScripts: true, removeNoScriptTags: true,
    compressContent: false, includeInfobar: false, userScriptEnabled: false }, initOptions, doc, win);
}

function unsupportedOption(name) {
  const error = new Error("This static Firefox HTML build does not support option " + name + ".");
  error.code = "UNSUPPORTED_SINGLE_FILE_OPTION";
  error.details = { option: name };
  throw error;
}
`;

function replaceReviewed(contents, before, after, file) {
  const position = contents.indexOf(before);
  if (position === -1 || contents.indexOf(before, position + before.length) !== -1) {
    throw new Error(`SingleFile ${SINGLE_FILE_VERSION} build transform no longer matches ${file}; review the source before rebuilding.`);
  }
  return contents.slice(0, position) + after + contents.slice(position + before.length);
}

async function reviewedSources(source) {
  const metadata = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  if (metadata.version !== SINGLE_FILE_VERSION) {
    throw new Error('Unexpected SingleFile version; review vendor updates before rebuilding.');
  }
  const entries = await Promise.all(Object.entries(REVIEWED_SOURCES).map(async ([file, expected]) => {
    const contents = (await readFile(resolve(source, file), 'utf8')).replace(/\r\n/g, '\n');
    if (createHash('sha256').update(contents).digest('hex') !== expected) {
      throw new Error(`SingleFile ${SINGLE_FILE_VERSION} reviewed source changed: ${file}; review the build adaptations before rebuilding.`);
    }
    return [file, contents];
  }));
  return new Map(entries);
}

export async function createSingleFileBuildOptions({ source, outfile, write = true }) {
  source = resolve(source);
  const files = await reviewedSources(source);
  let core = files.get('core/index.js');
  core = replaceReviewed(core, LOAD_OPTIONS_FROM_PAGE, `\tloadOptionsFromPage() {
\t\t// Archived page metadata must not override this build's fixed capture policy.
\t}`, 'core/index.js loadOptionsFromPage');
  core = replaceReviewed(core, KEEP_NOSCRIPT_HTML,
    '\t\tthis.doc.querySelectorAll("noscript").forEach(element => element.remove());', 'core/index.js removeDiscardedResources');
  files.set('core/index.js', core);
  files.set('core/helper.js', replaceReviewed(files.get('core/helper.js'), CROSS_BROWSER_SHADOW_ROOT,
    'function getShadowRoot(element) {\n\treturn element.openOrClosedShadowRoot || element.shadowRoot;\n}', 'core/helper.js getShadowRoot'));

  return {
    stdin: { contents: ENTRY_POINT, resolveDir: source, sourcefile: 'firefox-static-html-entry.js', loader: 'js' },
    outfile,
    write,
    bundle: true,
    format: 'iife',
    globalName: 'FirefoxBridgeSingleFile',
    target: 'firefox140',
    platform: 'browser',
    legalComments: 'inline',
    plugins: [{
      name: 'reviewed-single-file-static-firefox',
      setup(builder) {
        builder.onLoad({ filter: /\.js$/ }, args => {
          const file = relative(source, args.path).split(sep).join('/');
          const contents = STUBS[file] ?? files.get(file);
          return contents === undefined ? undefined : { contents, loader: 'js', resolveDir: resolve(args.path, '..') };
        });
      }
    }],
    banner: { js: '/* SingleFile Core 1.6.19, static Firefox HTML build; AGPL-3.0-or-later. License: vendor/single-file-LICENSE.txt. Corresponding source: firefox-codex-mcp-source.zip (vendor/single-file-core and scripts/single-file-build.mjs). https://github.com/gildas-lormeau/single-file-core/tree/v1.6.19 */\nif (!globalThis.FirefoxBridgeSingleFile) {' },
    footer: { js: 'globalThis.FirefoxBridgeSingleFile = FirefoxBridgeSingleFile; globalThis.singlefile = FirefoxBridgeSingleFile;\n}' }
  };
}

export async function buildHtmlVendor(root) {
  await build(await createSingleFileBuildOptions({
    source: resolve(root, 'vendor/single-file-core'),
    outfile: resolve(root, 'extension/vendor/single-file.bundle.js')
  }));
}
