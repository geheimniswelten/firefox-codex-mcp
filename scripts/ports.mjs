import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { managePortReservation } from '../server/port-reservation.mjs';

export async function main(args = process.argv.slice(2), { manage = managePortReservation } = {}) {
  if (args.includes('--help') || args.length === 0) {
    console.log('node scripts/ports.mjs status|init|suggest|reserve|release [--root ABS] [--port 38477] [--json]\nWindows: gemeinsame Portverwaltung mit DAI. reserve/release ändern nur die Vormerkung, niemals die lokale Konfiguration.');
    return;
  }
  const action = args[0];
  if (!['status', 'init', 'suggest', 'reserve', 'release'].includes(action)) throw new Error('Unknown port command.');
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), port, json = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--json') json = true;
    else if (args[index] === '--root') {
      const value = args[++index];
      if (!value || !isAbsolute(value)) throw new Error('--root requires an absolute installation directory.');
      root = value;
    } else if (args[index] === '--port') {
      const value = args[++index];
      if (!/^[0-9]+$/u.test(value || '') || Number(value) < 1024 || Number(value) > 65535) throw new Error('--port must be between 1024 and 65535.');
      port = Number(value);
    } else throw new Error('Unknown port option: ' + args[index]);
  }
  if (action === 'release' && port === undefined) throw new Error('release requires an explicit --port.');
  if (port === undefined) {
    try {
      const config = JSON.parse(await readFile(join(root, '.local/config.json'), 'utf8'));
      if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid configured bridge port.');
      port = config.port;
    } catch (error) { if (error.code !== 'ENOENT') throw error; port = 38477; }
  }
  const result = await manage(action, { port });
  console.log(JSON.stringify(result, null, json ? 0 : 2));
  if (!json && ['init', 'reserve', 'release'].includes(action)) console.log('Nur die gemeinsame Vormerkung wurde bearbeitet. Konfiguration und Clientregistrierungen bleiben erhalten.');
  if (!json && action === 'suggest') console.log(`Vorschlag ohne Änderung. Bewusst übernehmen: node scripts/setup.mjs --root ${JSON.stringify(root)} --port ${result.port} --reserve-port --register-native`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`${error.code || 'PORT_ERROR'}: ${error.message}`); process.exitCode = 1; });
}
