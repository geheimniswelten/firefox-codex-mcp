### Kurz

- Firefox mit KI verwalten (Tabs/Fenster/Plugins suchen/durchsuchen/schließen/verschieben/...)
   - Codex, Claude Code (CLI / VS Code), Claude Desktop, Eigent, Gemini CLI / Code Assist, Gemini Desktop, Hermes, LM Studio and OpenClaw
- **ACHTUNG:** derzeit im Testmodus, nur als temporäres Add-on
- Downloaden und install.cmd ausführen
   - in about:debugging#/runtime/this-firefox "Temporäres Add-on laden" -> ...\firefox-codex-mcp\extension\manifest.json
   - als FF-Plugin, online, zum Direktinstallieren, aktuell noch nicht (aus Firefox heraus ist eine Registrierung bei den KI-Agenten sowieso nicht möglich)
- Windows + Firefox _(FF im OSX und Linux prinzipiell möglich, also Plugin inkl. MCP-Server, aber erstellen und registrieren aktuell manuell)_
- Zugriff auf Seiteninhalte standardmäßig gesperrt (bei Erstzugriff wird nach Freigabe gefragt)

# Firefox ↔ Codex MCP

Firefox-Erweiterung und lokaler MCP-Server für die vorhandenen Firefox-Fenster, Tabs, nativen Tabgruppen, installierten Erweiterungen und Seiteninhalte. Die Verbindung nutzt Firefox Native Messaging, einen ausschließlich an `127.0.0.1` gebundenen Host mit Zugriffstoken und MCP über Standard-Ein-/Ausgabe. Es ist kein OpenAI-API-Schlüssel nötig.

## Voraussetzungen

- Desktop-Firefox **140 oder neuer** für native Tabgruppen und die aktuelle Firefox-Datenfreigabe bei der Installation.
- **Node.js 22 oder neuer** einschließlich npm. Der Windows-Installer verwendet eine passende vorhandene Installation oder richtet automatisch Node 24 LTS samt npm unter `.runtime/node` im Projekt ein. Eine vorherige systemweite Node-Installation ist damit nicht erforderlich.
- Ein KI-Client mit Unterstützung für lokale MCP-Server, beispielsweise Codex oder Claude Code.
- Windows: PowerShell; Einrichtung erfolgt im eigenen Benutzerkonto ohne Administratorrechte.

Die Dateien sind Quellcode und eine unsignierte Entwicklungs-Erweiterung. Sie sind durch das Erstellen dieses Projekts noch nicht in Firefox oder Codex installiert.

## Windows: Installation

1. Den Projektordner an einen dauerhaften Ort entpacken. Die Einrichtung speichert absolute Pfade; bei späterem Verschieben muss sie erneut ausgeführt werden.
2. `install.cmd` doppelklicken oder im Projektordner ausführen:

   ```cmd
   install.cmd
   ```

   Das CHOICE-Menü bietet **1: Erzeugen + Installieren** (`install.ps1`), **2: Nur Erzeugen** (`install.ps1 -GenerateOnly`), **3: Deinstallieren** (`uninstall.ps1`) und **0: Beenden**. Eine Ziffer ohne Enter drücken. Nach dem Vorgang bleibt das Fenster bis zur ausdrücklichen Eingabe von **0** offen. Die PowerShell-Dateien lassen sich auch direkt aufrufen.

   Fehlen Node oder npm, lädt das Skript das passende Windows-ZIP von [nodejs.org](https://nodejs.org/en/download), prüft dessen SHA256-Prüfsumme und entpackt es im Projekt. Es ändert weder den systemweiten Windows-Pfad noch eine vorhandene Node-Installation. Internetzugriff ist für den ersten Download und die Paketinstallation nötig. `install.ps1 -NoDownload` unterbindet den automatischen Node-Download; dann muss bereits ein geeignetes Node samt npm vorhanden sein. Eine einmal eingerichtete Projekt-Runtime wird wiederverwendet.

   Bei der Installation führt das Skript `npm ci --omit=dev` aus, erzeugt private Konfigurationsdateien in `.local` und registriert den Native Host unter `HKCU\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge`. Eine bestehende Registrierung auf einen anderen Pfad wird nicht überschrieben. Anschließend ergänzt der Installer den lokalen MCP-Server `firefox` in erkannten KI-Client-Konfigurationen (Details unten). Das CMD-Menü setzt die PowerShell-Ausführungsrichtlinie nur für seinen jeweiligen Skriptprozess; eine systemweite Richtlinie wird nicht verändert. Die entsprechenden Einzelschritte sind:

   ```powershell
   npm ci --omit=dev
   node scripts/setup.mjs --register-native
   node scripts/configure-clients.mjs
   ```

   Nur Dateien erzeugen, ohne Registrierung: `npm run setup` oder `.\install.ps1 -GenerateOnly`. Einen anderen Port wählen: `node scripts/setup.mjs --port 38478 --register-native`. Ein erneuter Setup-Aufruf behält ein vorhandenes Token; ohne `--port` bleibt auch der bestehende Port erhalten.
3. Nach erfolgreicher Installation öffnet das Skript automatisch Firefox mit `about:debugging#/runtime/this-firefox`. Dort **Temporäres Add-on laden** wählen und `extension/manifest.json` auswählen; den vollständigen Dateipfad zeigt der Installer an. Wird Firefox nicht gefunden oder kann es nicht geöffnet werden, bleibt die Installation erfolgreich und die Adresse wird zum manuellen Öffnen angezeigt. Bei „Nur Erzeugen“ öffnet sich kein Browser. Für unbeaufsichtigte Installationen verhindert `install.ps1 -NoOpenFirefox` das automatische Öffnen. Im Erweiterungsmenü kann die Erweiterung an die Symbolleiste angeheftet werden.
4. Die Ergebnisliste des Installers prüfen: Pro KI-Client erscheinen Erkennung, Einrichtung, Konflikt oder Fehler sowie gegebenenfalls der Pfad zur Sicherung. `-NoRegisterClients` lässt die KI-Client-Konfigurationen unverändert. Bei „Nur Erzeugen“ werden weder KI-Clients noch Firefox registriert. Als manuelle Codex-Vorlage bleibt `.local/codex-config.toml` verfügbar; niemals damit die vollständige vorhandene Konfiguration ersetzen.
5. Die MCP-Verbindung betroffener KI-Apps neu laden oder die Apps neu starten. Claude Code in VS Code benötigt eine neue Konversation; Gemini Code Assist gegebenenfalls **Developer: Reload Window**. Zunächst `firefox_status`, danach `firefox_get_current` aufrufen.

Temporäre Firefox-Add-ons verschwinden beim Firefox-Neustart und müssen dann erneut geladen werden. Für dauerhafte Installation in regulärem Firefox muss die Erweiterung über Mozilla signiert werden, beispielsweise als nicht öffentlich gelistetes Add-on. Das mit `npm run package` erzeugte ZIP ist noch nicht signiert. Siehe [temporäre Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) und [Signieren und Verteilen](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Automatische Einrichtung der KI-Clients

„Erzeugen + Installieren“ prüft vorhandene Konfigurationsordner im Benutzerkonto. Ein verbliebener Ordner kann auch von einer früheren Installation stammen; die Erkennung ist kein Beweis, dass das Programm noch installiert ist. Fehlt der jeweilige Ordner, wird kein neues App-Profil angelegt. `%USERPROFILE%\.agents\skills` und `.claude\skills` enthalten Arbeitsanweisungen und sind keine Orte für MCP-Servereinträge. Für diese Brücke ist kein zusätzlicher Skill nötig.

| KI-Client | Standarddatei unter Windows | MCP-Abschnitt |
| --- | --- | --- |
| Codex App, CLI und IDE-Erweiterung | `%USERPROFILE%\.codex\config.toml` | `mcp_servers.firefox` |
| Claude Desktop (Chat) | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers.firefox` |
| Claude Code, auch in VS Code | `%USERPROFILE%\.claude.json` | `mcpServers.firefox` |
| LM Studio | `%USERPROFILE%\.lmstudio\mcp.json` | `mcpServers.firefox` |
| Hermes Desktop / Agent von Nous | `%LOCALAPPDATA%\hermes\config.yaml` | `mcp_servers.firefox` |
| Gemini CLI / Code Assist | `%USERPROFILE%\.gemini\settings.json` | `mcpServers.firefox` |
| Eigent | `%USERPROFILE%\.eigent\mcp.json` | `mcpServers.firefox` |
| OpenClaw | `%USERPROFILE%\.openclaw\openclaw.json` | `mcp.servers.firefox` |

Unterstützte Pfadüberschreibungen: `CODEX_HOME`, `CLAUDE_CONFIG_DIR` (enthält dann `.claude.json`), `HERMES_HOME`, `OPENCLAW_CONFIG_PATH` und `OPENCLAW_STATE_DIR`. `GEMINI_CLI_HOME` bezeichnet den **Elternordner** von `.gemini`; die IDE kann weiterhin ihren Standardordner verwenden. Mehrdeutige OpenClaw-Profil-/Home-Overrides werden mit Hinweis übersprungen; dafür den konkreten Konfigurationspfad angeben. OpenClaw im Read-only-/Nix-Modus wird nicht verändert. Bei Hermes wird ein vorhandener älterer `.hermes`-Ordner berücksichtigt; mehrere mögliche Profile benötigen einen eindeutigen `HERMES_HOME`.

Die normale **Gemini-Desktop-App** auf gemini.google hat keine hier belegte benutzerdefinierte lokale MCP-Konfiguration. Der Installer zeigt dafür einen Hinweis; die Unterstützung der CLI/Code-Assist-Variante ist davon unabhängig.

Jeder Eintrag startet Node mit absoluten Pfaden zum MCP-Server und seiner privaten Konfiguration. Das Zugriffstoken wird nicht in Client-Konfigurationen kopiert. Vor Änderungen vorhandener Dateien wird eine eigene Sicherung angelegt. Unverwandte Einstellungen bleiben erhalten; vorhandene fremde oder geänderte `firefox`-Einträge werden als Konflikt gemeldet. Wiederholtes Installieren erzeugt keine doppelten Einträge. Kommentare und fremde Abschnitte werden durch gezielte Textänderungen erhalten; nicht sicher bearbeitbare komplexe Konfigurationen werden mit Hinweis übersprungen. Eine App kann zusätzlich eigene Freigaben oder Unternehmensrichtlinien verlangen; diese werden nicht umgangen.

Bei einem Client-Fehler bleibt der erfolgreich eingerichtete Native Host bestehen. Das Installationsmenü meldet den Teilfehler mit Rückgabecode `2`. Die Client-Einrichtung lässt sich getrennt wiederholen oder zunächst anzeigen:

```powershell
.\.runtime\node\node.exe scripts/configure-clients.mjs --dry-run
.\.runtime\node\node.exe scripts/configure-clients.mjs
```

Dokumentation der Konfigurationsformate: [Codex](https://learn.chatgpt.com/docs/extend/mcp), [Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Claude Code](https://code.claude.com/docs/en/mcp), [LM Studio](https://lmstudio.ai/docs/app/mcp), [Hermes](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference), [Hermes unter Windows](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native/), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/), [Gemini Code Assist](https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer), [Eigent](https://www.eigent.ai/blog/eigent-how-to-setting-up-your-first-custom-mcp-server), [OpenClaw](https://docs.openclaw.ai/gateway/config-extensions).

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

Die Freigabefrage erscheint direkt im Popup des Add-ons. Dazu wird das zuletzt aktive normale Firefox-Fenster in den Vordergrund geholt; ein minimiertes Fenster wird wiederhergestellt. Der ausgewählte Tab bleibt erhalten. Ist das Add-on nicht an die Symbolleiste angeheftet, verwendet Firefox den allgemeinen Erweiterungen-Button als Anker. Es entsteht kein zusätzliches Browserfenster.

Während eine Antwort aussteht, zeigt das Add-on-Symbol ein **„?“**. Ab Firefox 149 kann das Popup automatisch geöffnet werden. In Firefox 140–148 oder wenn Firefox das Öffnen verhindert, auf das Add-on-Symbol beziehungsweise auf **Erweiterungen → Firefox ↔ Codex MCP** klicken. Das Schließen des Popups erteilt keine Freigabe: Bis zum Ablauf der ursprünglichen zwei Minuten lässt es sich erneut öffnen. Nur **Freigeben** erlaubt den Zugriff; **Ablehnen** beendet die Anfrage sofort. Quellen: [browserAction.openPopup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/browserAction/openPopup), [Firefox 149: Aufruf ohne Benutzeraktion](https://bugzilla.mozilla.org/show_bug.cgi?id=1799344), [Fenster aktivieren](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/update).

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

`check` prüft JavaScript-Syntax und Manifestkonsistenz. Tests umfassen Protokoll-/Serverlogik, Erweiterungslogik und Setup in temporären Verzeichnissen; Setup-Tests registrieren nichts im Benutzerprofil. `npm ci` installiert für Entwicklung zusätzlich `web-ext` als lokale Test-/Lint-Abhängigkeit; eine globale Installation ist nicht nötig. Mit `npx --no-install web-ext lint --source-dir extension` lässt sich die Erweiterung zusätzlich prüfen. Bei einer Projekt-Runtime kann etwa `.\.runtime\node\node.exe --test test/*.test.mjs` direkt ausgeführt werden. Die Pakete entstehen unter `dist/`: `firefox-codex-mcp-extension.zip` enthält die Erweiterung, `firefox-codex-mcp-source.zip` das Projekt einschließlich Lockdatei ohne Abhängigkeiten, Projekt-Runtime, Tokens und lokale Konfiguration. Ein automatisierter Test ersetzt keinen vollständigen Test mit dem eigenen Firefox-Profil.

Bei „Native host not found“ die Registrierung und den Manifestpfad prüfen, dann die Erweiterung neu laden. Bei Verbindungsfehlern den Popup-Schalter, den gespeicherten Port und die Node-Pfade prüfen. Bei Portkonflikten einen anderen Port einrichten und Firefox-Erweiterung sowie Codex-Verbindung neu starten. Die Erweiterung kommuniziert mit dem gestarteten Firefox-Profil. Gleichzeitiger Betrieb mehrerer Profile ist in dieser Version nicht vorgesehen: Die Native-Host-Registrierung gilt benutzerweit und ein Host belegt den konfigurierten Port.

Unter Linux/macOS erzeugt `npm run setup` eine ausführbare Shell-Startdatei. Das generierte Hostmanifest kann nach Prüfung an den benutzerspezifischen Mozilla-Native-Messaging-Pfad kopiert werden. `--register-native` und `install.ps1` sind auf Windows ausgerichtet. Plattformpfade und Protokoll beschreibt [Mozilla Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging).

## Deinstallation

In `install.cmd` die **3** wählen oder `uninstall.ps1` ausführen. Das funktioniert auch aus einer neu heruntergeladenen Kopie, etwa im Downloadordner, wenn der ursprüngliche Projektordner bereits gelöscht wurde. Eine erneute Installation ist dafür nicht erforderlich; das Entfernen der Native-Host-Registrierung und der zugehörigen lokalen Dateien benötigt weder Node noch npm.

Das Skript ermittelt die frühere Installation aus der benutzerspezifischen Native-Messaging-Registrierung `de.codex.firefox_bridge`. Es entfernt diesen Eintrag auch bei fehlendem ursprünglichem Ordner. Ist der registrierte Pfad erkennbar, beendet es eindeutig dieser Installation zugeordnete Brücken-/MCP-Prozesse und entfernt deren bekannte erzeugte Dateien in `.local`, soweit noch vorhanden. Der Speicherort der neuen Downloadkopie muss damit nicht übereinstimmen.

Ohne Registrierung werden nur die erzeugten Dateien der aufgerufenen Projektkopie bereinigt, etwa nach „Nur Erzeugen“. Bei einem nicht erkennbaren registrierten Pfad wird ausschließlich der Anwendungseintrag entfernt. Quellcode, Abhängigkeiten einschließlich `.runtime/node`, unbekannte Dateien und die Registrierungen anderer Anwendungen bleiben erhalten. Wiederholtes Deinstallieren ist möglich. `uninstall.ps1 -WhatIf` zeigt die vorgesehenen Schritte ohne Änderungen an.

Wenn eine passende Node-Runtime und die Parserpakete in der aktuellen oder ursprünglichen Projektkopie verfügbar sind, entfernt das Skript zusätzlich eindeutig zu dieser Installation gehörende, unveränderte Firefox-MCP-Einträge der erkannten KI-Clients. Fremde und nachträglich geänderte Einträge bleiben erhalten. Fehlen Runtime oder Pakete nach dem Löschen des ursprünglichen Ordners, wird die Native-Host-Deinstallation trotzdem abgeschlossen; der Installer weist auf manuell zu entfernende Client-Einträge hin. Dafür wird nichts heruntergeladen. `-WhatIf` verändert auch die Client-Konfigurationen nicht.

Das Firefox-Add-on unter `about:addons` separat entfernen. Eventuell übersprungene Client-Einträge anhand der obigen Tabelle prüfen und die betroffenen KI-Apps neu starten. Sicherungskopien werden nicht automatisch zurückgespielt, da dies spätere Änderungen anderer Einstellungen verlieren könnte. Anschließend kann der Projektordner bei Bedarf entfernt werden.

## TODO / MAYBE

Die Bereitstellung bleibt vorerst bei GitHub. Ein Upload zu Mozilla beziehungsweise eine Veröffentlichung im Add-on-Katalog ist derzeit nicht vorgesehen.

- [ ] Optional eine von Mozilla signierte XPI für die dauerhafte Add-on-Installation anbieten, öffentlich gelistet oder zur eigenen Verteilung. Bis zu einer ausdrücklichen Entscheidung bleibt dies eine Idee.
- [ ] Optional eine geführte Einrichtung der KI-Apps im Add-on anbieten. Die Registrierung würde der separat installierte lokale Helfer ausführen; die erstmalige Installation dieses Helfers bleibt erforderlich.
