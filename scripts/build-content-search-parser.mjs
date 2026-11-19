import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildContentSearchParser(project = root) {
  const require = createRequire(join(project, 'package.json'));
  const parser = require.resolve('parse5');
  const entities = createRequire(parser).resolve('entities/decode');
  const licenses = await Promise.all([
    readFile(join(dirname(parser), '../../LICENSE'), 'utf8'),
    readFile(join(dirname(entities), '../../LICENSE'), 'utf8'),
  ]);
  await build({
    stdin: { contents: "export { parse } from 'parse5';", resolveDir: project },
    bundle: true,
    format: 'iife',
    globalName: 'FirefoxBridgeHtmlParser',
    target: 'firefox140',
    banner: { js: '/*! parse5 and entities\n' + licenses.join('\n').replace(/\r\n/g, '\n') + '\n*/' },
    outfile: join(project, 'extension/vendor/content-search-parser.js'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildContentSearchParser();
}
