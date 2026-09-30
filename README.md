# Firefox ↔ Codex MCP

Firefox-Erweiterung und lokaler MCP-Server für die vorhandenen Firefox-Fenster, Tabs, nativen Tabgruppen, installierten Erweiterungen und Seiteninhalte. Die Verbindung nutzt Firefox Native Messaging, einen ausschließlich an `127.0.0.1` gebundenen Host mit Zugriffstoken und MCP über Standard-Ein-/Ausgabe. Es ist kein OpenAI-API-Schlüssel nötig.

## Voraussetzungen

- Desktop-Firefox **140 oder neuer** für native Tabgruppen und die aktuelle Firefox-Datenfreigabe bei der Installation.
- **Node.js 22 oder neuer** einschließlich npm.
- Codex mit Unterstützung für lokale MCP-Server.
- Windows: PowerShell; Einrichtung erfolgt im eigenen Benutzerkonto ohne Administratorrechte.

Die Dateien sind Quellcode und eine unsignierte Entwicklungs-Erweiterung. Sie sind durch das Erstellen dieses Projekts noch nicht in Firefox oder Codex installiert.

## Windows: Installation

1. Den Projektordner an einen dauerhaften Ort entpacken. Die Einrichtung speichert absolute Pfade; bei späterem Verschieben muss sie erneut ausgeführt werden.
2. `install.cmd` doppelklicken oder im Projektordner ausführen:

   ```cmd
   install.cmd
   ```

   Das CHOICE-Menü bietet **1: Erzeugen + Installieren** (`install.ps1`), **2: Nur Erzeugen** (`install.ps1 -GenerateOnly`), **3: Deinstallieren** (`uninstall.ps1`) und **0: Beenden**. Die PowerShell-Dateien lassen sich auch direkt aufrufen.

   Bei der Installation führt das Skript `npm ci --omit=dev` aus, erzeugt private Konfigurationsdateien in `.local` und registriert den Native Host unter `HKCU\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge`. Eine bestehende Registrierung auf einen anderen Pfad wird nicht überschrieben. Codex wird dabei nicht umkonfiguriert. Das CMD-Menü setzt die PowerShell-Ausführungsrichtlinie nur für seinen jeweiligen Skriptprozess; eine systemweite Richtlinie wird nicht verändert. Die entsprechenden Einzelschritte sind:

   ```powershell
   npm ci --omit=dev
   node scripts/setup.mjs --register-native
   ```

   Nur Dateien erzeugen, ohne Registrierung: `npm run setup` oder `.\install.ps1 -GenerateOnly`. Einen anderen Port wählen: `node scripts/setup.mjs --port 38478 --register-native`. Ein erneuter Setup-Aufruf behält ein vorhandenes Token; ohne `--port` bleibt auch der bestehende Port erhalten.
3. In Firefox `about:debugging#/runtime/this-firefox` öffnen, **Temporäres Add-on laden** wählen und `extension/manifest.json` auswählen. Im Erweiterungsmenü kann die Erweiterung an die Symbolleiste angeheftet werden.
4. Den generierten Abschnitt aus `.local/codex-config.toml` in die vorhandene Codex-MCP-Konfiguration übernehmen, üblicherweise `%USERPROFILE%\.codex\config.toml` bzw. `$CODEX_HOME\config.toml`, wenn `CODEX_HOME` gesetzt ist. Einen bestehenden Abschnitt `[mcp_servers.firefox]` vorher prüfen; die vorhandene Konfiguration nicht durch die Beispieldatei ersetzen. Der Abschnitt enthält absolute Node-/Serverpfade und `tool_timeout_sec = 180` für Inhaltsfreigaben.
5. Codex-MCP-Verbindung neu laden bzw. Codex neu starten. Zunächst `firefox_status`, danach `firefox_get_current` aufrufen.

Temporäre Firefox-Add-ons verschwinden beim Firefox-Neustart und müssen dann erneut geladen werden. Für dauerhafte Installation in regulärem Firefox muss die Erweiterung über Mozilla signiert werden, beispielsweise als nicht öffentlich gelistetes Add-on. Das mit `npm run package` erzeugte ZIP ist noch nicht signiert. Siehe [temporäre Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) und [Signieren und Verteilen](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Symbolleiste und Zugriffsregeln

Das Popup bietet einen MCP-Ein-/Ausschalter, den Verbindungsstatus und die Inhaltsregeln. Die Farbe des Symbols bedeutet:

| Farbe | Bedeutung |
| --- | --- |
| Grau | MCP deaktiviert oder keine Verbindung zum lokalen Host |
| Grün | Verbunden; kein Zugriff innerhalb der letzten 30 Minuten |
| Gelb/Orange | Letzter Zugriff innerhalb von 30 Minuten, aber länger als eine Minute her |
| Blau | Zugriff innerhalb der letzten Minute |

„Verbunden“ bestätigt die lokale Erweiterung-/Host-Verbindung. Es bedeutet nicht, dass gerade ein Codex-Tool ausgeführt wird. Ohne laufenden Firefox bleiben MCP-Werkzeugdefinitionen verfügbar; Browseraufrufe melden einen Verbindungsfehler.

Seiteninhalte können **erlaubt**, **gesperrt**, **bei jedem Zugriff abgefragt** oder **einmal für eine Sitzung freigegeben** werden. Eine Sitzungsfreigabe läuft nach **festen 12 Stunden** ab; weitere Zugriffe verlängern sie nicht. Firefox-/Erweiterungsneustart und eine Änderung der Zugriffsregeln setzen die Freigabe zurück. Eine unbeantwortete Inhaltsabfrage läuft nach zwei Minuten ab.

Der Inhaltsumfang ist wahlweise **alle Tabs** oder **nur der aktive Tab des zuletzt aktiven Firefox-Fensters**. Standard ist **Sitzungsfreigabe + aktiver Tab**. Das bezieht sich auf das Lesen der Seite; das Auflisten von Tab-Metadaten und die ausdrücklich angeforderte Tabsteuerung bleiben bei aktivem MCP möglich. Ein anderer Tab wird nicht automatisch aktiviert, um die Inhaltsregel zu umgehen. Entladene Tabs werden durch Inhaltslesen nicht aufgeweckt.

## Werkzeuge

Alle 22 Werkzeugnamen haben das Präfix `firefox_`:

| Bereich | Namen ohne Präfix |
| --- | --- |
| Status und Übersicht | `status`, `get_current`, `list_windows`, `list_tabs`, `get_tabs` |
| Installierte Erweiterungen | `list_extensions` |
| Tabs | `create_tab`, `update_tab`, `set_muted`, `close_tabs`, `move_tabs`, `discard_tabs`, `reload_tabs` |
| Fenster | `create_window`, `update_window`, `close_window` |
| Native Gruppen | `list_groups`, `group_tabs`, `ungroup_tabs`, `update_group`, `move_group` |
| Seiteninhalt | `read_content` |

Beispiele für Codex: „Liste alle entladenen Firefox-Tabs“, „Schalte diese drei Tabs stumm“, „Verschiebe die ausgewählten Tabs in ein neues Fenster“, „Fasse den Inhalt des aktiven Tabs zusammen“. IDs zunächst anhand der Übersicht auflösen. `list_tabs` unterstützt Fenster, Aktivität, Audio, Stummschaltung, Entladezustand und Gruppe als Filter; Standard sind 100, maximal 500 Tabs pro Seite mit `offset`/`limit`.

`read_content` liefert Text oder HTML aus dem Hauptframe, optional für einen CSS-Selektor und mit Links. Standardlimit: 30.000 Zeichen; Maximum: 100.000. Kürzungen werden angezeigt. Schließen, Navigation, Neuladen und Entladen können ungespeicherte Seitendaten verlieren. Batch-Aktionen liefern Einzelergebnisse und können teilweise erfolgreich sein; nach einem Timeout oder Teilfehler zunächst Zustand prüfen, bevor erneut verändert wird. Parameterdetails stehen in `PROTOCOL.md` und den MCP-Werkzeugschemata.

## Installierte Erweiterungen abfragen

Ab Version **0.1.1** liefert `firefox_list_extensions` die von Firefox bereitgestellten installierten Erweiterungen mit ID, Name, Version, Typ und `enabled` (aktiviert/deaktiviert). Installationsart, Beschreibung und Deaktivierungsgrund werden ausgegeben, soweit Firefox sie bereitstellt. `enabled` bedeutet aktiviert, nicht momentan laufender Programmcode.

Im Symbolleistenmenü einmal **„Erweiterungsliste und Browser-Version freigeben“** aktivieren und die Firefox-Freigabe bestätigen. Ausschalten widerruft diese Freigabe; die Inhaltsregeln sind davon unabhängig. Die neue Manifestberechtigung `management` wird zum Auflisten benötigt. Bei einem Update die Firefox-Erweiterung neu laden und die Codex-MCP-Verbindung neu starten, damit das zusätzliche Werkzeug erscheint.

```javascript
firefox_list_extensions({})                  // Aktivierte und deaktivierte Erweiterungen
firefox_list_extensions({enabled: true})     // Nur aktivierte Erweiterungen
firefox_list_extensions({enabled: false})    // Nur deaktivierte Erweiterungen
firefox_list_extensions({type: "all"})      // Erweiterungen und Themes
```

Standardmäßig werden bis zu 100 Einträge geliefert; `limit` (maximal 500) und `offset` ermöglichen weitere Seiten. Die Liste bezieht sich auf das verbundene Firefox-Profil und die von Firefox freigegebenen Add-ons. Dieses Werkzeug verändert keine Erweiterung. Quellen: [management.getAll](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/management/getAll), [Aktivierungsstatus und Metadaten](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/management/ExtensionInfo).

## Zeit- und Statusangaben

- `createdAt`: beobachteter Erstellzeitpunkt oder `null`, wenn unbekannt; `createdAtSource` erklärt die Herkunft. Firefox liefert keinen allgemeinen historischen Erstellzeitpunkt für bestehende Tabs.
- `firstSeenAt`: Zeitpunkt, an dem die Erweiterung den Tab erstmals beobachtet hat. Das ist kein Nachweis seines tatsächlichen Alters.
- `lastAccessed` / `lastActiveAt`: Firefox-Zeitstempel bzw. aufbereitete Aktivitätsinformation; `lastActiveSource` erläutert die Herkunft.
- `discarded`: gemeinsamer nativer Entladezustand, unabhängig davon, ob Firefox oder Auto Tab Discard ihn ausgelöst hat. `discardSource` ist nur bei einer eigenen beobachteten Erweiterungsaktion bekannt; sonst `unknown`. Eine separate ATD-Anbindung ist nicht erforderlich.
- `audible` und `mutedInfo`: Audioaktivität und Stummschaltung sind getrennt. Ein Tab kann Audio erzeugen und zugleich stummgeschaltet sein.

Eigene Zeit-Metadaten werden als Firefox-Sitzungswerte gespeichert. Sie können bei Wiederherstellung erhalten bleiben; Tab- und Gruppen-IDs sind nicht als dauerhaft stabile Kennungen geeignet. Native Gruppen werden unterstützt, Gruppensysteme anderer Erweiterungen nicht. Quellen: [Tab-Eigenschaften](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab), [Sitzungswerte](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sessions/getTabValue), [native Tabgruppen](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups), [Auto Tab Discard](https://github.com/rNeomy/auto-tab-discard).

## Grenzen und lokale Daten

Seiteninhalt ist auf geladene HTTP(S)-Seiten und den Hauptframe begrenzt. Browserinterne Seiten, andere Erweiterungsseiten, Reader-/Quelltextansicht, der PDF-Viewer sowie geschützte Mozilla-Seiten können keinen Inhalt liefern. Neue Navigationen erlauben HTTP(S) und `about:blank`. Private Fenster sind nur zugänglich, wenn Firefox die Erweiterung für private Fenster ausdrücklich zulässt. Das Add-on bietet keine beliebige JavaScript- oder Shell-Ausführung über MCP.

`.local/config.json` enthält das gemeinsame Zugriffstoken. Das Setup beschränkt `.local` und seine erzeugten Dateien unter Windows auf den aktuellen Benutzer und SYSTEM; unter Unix gelten Verzeichnisrechte `0700` und Dateirechte `0600`. Die Konfiguration gehört nicht in Quellpakete oder Versionskontrolle. Es wird kein Token in die Konsolenausgabe geschrieben. Die Verbindung verlässt den Rechner nicht; von Codex angeforderter Seiteninhalt wird anschließend Teil der normalen Codex-Werkzeugantwort.

Das Firefox-Manifest deklariert die Weitergabe von Browseraktivität und Seiteninhalten an den lokalen MCP-Client. Die Regeln im Symbolleistenmenü beschränken den tatsächlichen Inhaltszugriff zusätzlich. Erweiterungslisten und Browser-Versionsinformationen im Status werden nur ausgegeben, wenn die optionale Firefox-Datenfreigabe für technische Informationen erteilt ist. Es gibt keine Telemetrieübertragung durch dieses Projekt. Hintergrund: [Firefox-Datenfreigaben](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Diagnose, Tests und Pakete

Der geprüfte Stand und die Ergebnisse der Tests mit echtem Firefox sind in [TESTING.md](TESTING.md) dokumentiert.

```powershell
npm ci
npm run check
npm test
npm run package
```

`check` prüft JavaScript-Syntax und Manifestkonsistenz. Tests umfassen Protokoll-/Serverlogik, Erweiterungslogik und Setup in temporären Verzeichnissen; Setup-Tests registrieren nichts im Benutzerprofil. `npm ci` installiert für Entwicklung zusätzlich `web-ext` als lokale Test-/Lint-Abhängigkeit; eine globale Installation ist nicht nötig. Mit `npx --no-install web-ext lint --source-dir extension` lässt sich die Erweiterung zusätzlich prüfen. Die Pakete entstehen unter `dist/`: `firefox-codex-mcp-extension.zip` enthält die Erweiterung, `firefox-codex-mcp-source.zip` das Projekt einschließlich Lockdatei ohne Abhängigkeiten, Tokens und lokale Konfiguration. Ein automatisierter Test ersetzt keinen vollständigen Test mit dem eigenen Firefox-Profil.

Bei „Native host not found“ die Registrierung und den Manifestpfad prüfen, dann die Erweiterung neu laden. Bei Verbindungsfehlern den Popup-Schalter, den gespeicherten Port und die Node-Pfade prüfen. Bei Portkonflikten einen anderen Port einrichten und Firefox-Erweiterung sowie Codex-Verbindung neu starten. Die Erweiterung kommuniziert mit dem gestarteten Firefox-Profil. Gleichzeitiger Betrieb mehrerer Profile ist in dieser Version nicht vorgesehen: Die Native-Host-Registrierung gilt benutzerweit und ein Host belegt den konfigurierten Port.

Unter Linux/macOS erzeugt `npm run setup` eine ausführbare Shell-Startdatei. Das generierte Hostmanifest kann nach Prüfung an den benutzerspezifischen Mozilla-Native-Messaging-Pfad kopiert werden. `--register-native` und `install.ps1` sind auf Windows ausgerichtet. Plattformpfade und Protokoll beschreibt [Mozilla Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging).

## Deinstallation

In `install.cmd` die **3** wählen oder `uninstall.ps1` ausführen. Das funktioniert auch aus einer neu heruntergeladenen Kopie, etwa im Downloadordner, wenn der ursprüngliche Projektordner bereits gelöscht wurde. Eine erneute Installation ist dafür nicht erforderlich; die Deinstallation benötigt weder Node noch npm.

Das Skript ermittelt die frühere Installation aus der benutzerspezifischen Native-Messaging-Registrierung `de.codex.firefox_bridge`. Es entfernt diesen Eintrag auch bei fehlendem ursprünglichem Ordner. Ist der registrierte Pfad erkennbar, beendet es eindeutig dieser Installation zugeordnete Brücken-/MCP-Prozesse und entfernt deren bekannte erzeugte Dateien in `.local`, soweit noch vorhanden. Der Speicherort der neuen Downloadkopie muss damit nicht übereinstimmen.

Ohne Registrierung werden nur die erzeugten Dateien der aufgerufenen Projektkopie bereinigt, etwa nach „Nur Erzeugen“. Bei einem nicht erkennbaren registrierten Pfad wird ausschließlich der Anwendungseintrag entfernt. Quellcode, Abhängigkeiten, unbekannte Dateien und die Registrierungen anderer Anwendungen bleiben erhalten. Wiederholtes Deinstallieren ist möglich. `uninstall.ps1 -WhatIf` zeigt die vorgesehenen Schritte ohne Änderungen an.

Das Firefox-Add-on unter `about:addons` und den manuell angelegten `[mcp_servers.firefox]`-Eintrag in Codex separat entfernen. Diese beiden Einträge wurden auch vom Installer nicht automatisch angelegt. Anschließend kann der Projektordner bei Bedarf entfernt werden.
