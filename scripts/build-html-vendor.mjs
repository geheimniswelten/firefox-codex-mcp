import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'extension/vendor/single-file-core');
const metadata = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
if (metadata.version !== '1.6.19') throw new Error('Unexpected SingleFile version; review vendor updates before rebuilding.');
await build({
  entryPoints: [resolve(source, 'single-file.js')],
  outfile: resolve(root, 'extension/vendor/single-file.bundle.js'),
  bundle: true,
  format: 'iife',
  globalName: 'FirefoxBridgeSingleFile',
  target: 'firefox140',
  platform: 'browser',
  legalComments: 'inline',
  banner: { js: '/* SingleFile Core 1.6.19; AGPL-3.0-or-later. Source and license: vendor/single-file-core/; https://github.com/gildas-lormeau/single-file-core/tree/v1.6.19 */\nif (!globalThis.FirefoxBridgeSingleFile) {' },
  footer: { js: 'globalThis.FirefoxBridgeSingleFile = FirefoxBridgeSingleFile; globalThis.singlefile = FirefoxBridgeSingleFile;\n}' }
});
console.log('Rebuilt offline SingleFile bundle from the vendored 1.6.19 source.');
