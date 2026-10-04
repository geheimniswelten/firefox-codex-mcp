import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHtmlVendor } from './single-file-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await buildHtmlVendor(root);
console.log('Rebuilt the static Firefox HTML bundle from the reviewed SingleFile 1.6.19 source.');
