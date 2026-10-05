#!/bin/sh
# Self-contained companion __VERSION__; registration revision __REVISION__.
set -eu
firefox_root=''
firefox_port=''
firefox_no_clients=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || { echo '--root needs a directory.' >&2; exit 1; }; firefox_root=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || { echo '--port needs a number.' >&2; exit 1; }; firefox_port=$2; shift 2 ;;
    --no-register-clients) firefox_no_clients='--no-register-clients'; shift ;;
    --help) echo 'sh register.sh [--root ABSOLUTE_DIRECTORY] [--port 38477] [--no-register-clients]'; echo 'Requires Node.js 22+ and npm. Updates companion files in the selected directory.'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22+ and npm, then run this script again.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Node.js 22+ is required.' >&2; exit 1; }
case "$(uname -s)" in
  Darwin) firefox_default="$HOME/Library/Application Support/FirefoxCodexMCP"; firefox_manifest="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/de.codex.firefox_bridge.json" ;;
  Linux) firefox_default="$HOME/.local/share/firefox-codex-mcp"; firefox_manifest="$HOME/.mozilla/native-messaging-hosts/de.codex.firefox_bridge.json" ;;
  *) echo 'This script supports Linux and macOS.' >&2; exit 1 ;;
esac
firefox_installed=$(node -e 'const fs=require("node:fs"),p=require("node:path");try{const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.name!=="de.codex.firefox_bridge"||m.type!=="stdio"||m.allowed_extensions.length!==1||m.allowed_extensions[0]!=="firefox-codex-mcp@local.invalid"||p.basename(m.path)!=="native-host.sh"||p.basename(p.dirname(m.path))!==".local")process.exit(0);process.stdout.write(p.dirname(p.dirname(m.path)))}catch{}' "$firefox_manifest")
if [ -n "$firefox_installed" ]; then firefox_default=$firefox_installed; fi
if [ -z "$firefox_root" ]; then
  [ -t 0 ] || { echo 'Supply --root ABSOLUTE_DIRECTORY for non-interactive setup.' >&2; exit 1; }
  printf 'Installation directory [%s]: ' "$firefox_default"
  read -r firefox_root
  if [ -z "$firefox_root" ]; then firefox_root=$firefox_default; fi
fi
case "$firefox_root" in /*) ;; *) echo '--root needs an absolute directory.' >&2; exit 1 ;; esac
firefox_root=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$firefox_root")
if [ -n "$firefox_installed" ]; then firefox_installed=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$firefox_installed"); fi
node --input-type=module - "$firefox_root" "$firefox_no_clients" "$firefox_port" <<'FIREFOX_COMPANION_JS'
__PAYLOAD_MODULE__
const payload = decodePayload('__PAYLOAD__', '__PAYLOAD_SHA__');
const root = await extractPayload(payload, process.argv[2]);
const { pathToFileURL } = await import('node:url');
const { main } = await import(pathToFileURL(join(root, 'scripts/install-companion.mjs')).href);
const args = ['--root', root];
if (process.argv[3]) args.push(process.argv[3]);
if (process.argv[4]) args.push('--port', process.argv[4]);
process.exitCode = await main(args);
FIREFOX_COMPANION_JS
echo 'Return to the extension settings and choose Check again.'
