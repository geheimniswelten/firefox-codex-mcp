import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPayload, encodePayload } from './companion-payload.mjs';
import { REGISTRATION_REVISION } from './registration.mjs';

export async function buildSetupDownloads(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const payload = await buildPayload(root);
  const archive = encodePayload(payload);
  const templateRoot = join(root, 'scripts', 'templates');
  const common = await readFile(join(templateRoot, 'setup-common.ps1'), 'utf8');
  const module = (await readFile(join(root, 'scripts/companion-payload.mjs'), 'utf8')).replace(/^export /gm, '');
  const output = join(root, 'extension', 'setup');
  await mkdir(output, { recursive: true });
  for (const name of ['register.ps1', 'unregister.ps1', 'register.sh', 'unregister.sh']) {
    let source = await readFile(join(templateRoot, name), 'utf8');
    const values = { __VERSION__: payload.version, __REVISION__: String(REGISTRATION_REVISION), __COMMON_PS__: common, __PAYLOAD_MODULE__: module, __PAYLOAD__: archive.base64, __PAYLOAD_SHA__: archive.sha256 };
    // A callback keeps dollar signs in the PowerShell/shell sources literal.
    for (const [marker, value] of Object.entries(values)) source = source.replaceAll(marker, () => value);
    if (/__[A-Z_]+__/.test(source)) throw new Error('Unresolved setup template marker in ' + name);
    await writeFile(join(output, name), source.replace(/\r\n/g, '\n'), { mode: 0o644 });
  }
  await writeFile(join(output, 'payload-manifest.json'), JSON.stringify({
    schemaVersion: payload.schemaVersion, version: payload.version, registrationRevision: REGISTRATION_REVISION,
    archiveSha256: archive.sha256, files: payload.files.map(({ path, sha256 }) => ({ path, sha256 })),
  }, null, 2) + '\n');
  return { output, files: payload.files.length, version: payload.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSetupDownloads().then(result => console.log('Setup downloads generated: ' + result.output + ' (' + result.files + ' companion files).')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
