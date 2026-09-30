import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureClients } from './client-config.mjs';

export async function main(args = process.argv.slice(2)) {
  const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--remove') options.remove = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--root') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) throw new Error('--root requires an absolute project directory.');
      options.root = value;
    } else if (args[i] === '--help') {
      console.log('node scripts/configure-clients.mjs [--root ABSOLUTE_PROJECT] [--remove] [--dry-run]');
      return 0;
    } else throw new Error('Unknown client setup option.');
  }
  const labels = {
    configured: 'eingerichtet', removed: 'entfernt', unchanged: 'unveraendert',
    not_detected: 'kein Konfigurationsordner gefunden', skipped: 'uebersprungen',
    conflict: 'Konflikt - bestehende Einstellung bleibt erhalten', error: 'Fehler',
    dry_run: 'Vorschau - keine Aenderung',
  };
  const results = await configureClients(options);
  for (const item of results) {
    console.log(`${item.label}: ${labels[item.status] ?? item.status}${item.message ? ` - ${item.message}` : ''}`);
    if (item.path && !['not_detected', 'skipped'].includes(item.status)) console.log(`  Datei: ${item.path}`);
    if (item.backup) console.log(`  Sicherung: ${item.backup}`);
  }
  console.log('Gemini Desktop (Consumer): Kein dokumentierter lokaler MCP-Anschluss; keine Konfiguration geschrieben.');
  if (!options.remove) console.log('Betroffene KI-Apps bzw. deren MCP-Verbindung anschliessend neu laden. Skills-Ordner sind keine MCP-Konfiguration.');
  return results.some(item => ['error', 'conflict'].includes(item.status)) ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    // Client configuration can contain credentials. Never echo parser input.
    console.error('KI-Client-Einrichtung fehlgeschlagen. Konfigurationen und Dateirechte pruefen.');
    process.exitCode = 2;
  });
}
