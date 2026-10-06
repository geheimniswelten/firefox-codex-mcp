# Firefox ↔ Codex MCP

Der lokale Stand **1.0.6** korrigiert die Skript-Downloads und die Einrichtung nach einem Pfadwechsel. Die oben verlinkte signierte XPI hat noch den Stand **1.0.5**. Zum Prüfen der Korrektur die lokale `extension/manifest.json` temporär laden bzw. neu laden; das aktualisierte Paket in `dist` ist unsigniert.

Firefox-Erweiterung und lokaler MCP-Server für die vorhandenen Firefox-Fenster, Tabs, nativen Tabgruppen, installierten Erweiterungen, Chronik, Lesezeichen und Seiteninhalte. Die Verbindung nutzt Firefox Native Messaging, einen ausschließlich an `127.0.0.1` gebundenen Host mit Zugriffstoken und MCP über Standard-Ein-/Ausgabe. Es ist kein OpenAI-API-Schlüssel nötig.

Ist die Erweiterung bzw. MCP-Anbindung registriert, aber nicht aktiv oder erreichbar, soll der KI-Agent zuerst rückfragen: auf die Verbindung warten oder `about:debugging#/runtime/this-firefox` in Firefox öffnen, um das Add-on zu laden bzw. neu zu laden? Nach der Prüfung durch den Nutzer wird `firefox_status` erneut aufgerufen. Computer Use oder andere Browser-Automatisierung sind erst nach erfolgloser Wiederherstellung oder auf ausdrücklichen Wunsch des Nutzers vorgesehen. Diese Reihenfolge steht in den MCP-Server-Anweisungen sowie in der `FIREFOX_OFFLINE`-Fehlermeldung. Ist der MCP-Server selbst nicht gestartet und kann keine Anweisungen liefern, muss der KI-Client diese Vorgabe aus einer zuvor geladenen Anweisung kennen. Die Debugging-Seite wird über eine verfügbare Browser-/Betriebssystemfunktion geöffnet, da die nicht erreichbare MCP-Verbindung das nicht übernehmen kann.

## Voraussetzungen

Der optionale Skill `skills/firefox-browser/SKILL.md` bevorzugt Firefox auch bei allgemeinen Bezeichnungen wie „Browser“ und „Webbrowser“. Eine ausdrücklich andere Browserauswahl (z. B. Chrome oder Edge) hat Vorrang. Für Codex den Ordner `skills/firefox-browser` nach `%USERPROFILE%\.codex\skills\firefox-browser` kopieren (bei gesetztem `CODEX_HOME` in dessen `skills`-Verzeichnis). Der Skill enthält den Wiederherstellungsablauf auch für den Fall, dass der MCP-Server selbst nicht erreichbar ist. Er wird dadurch unabhängig von den Server-Anweisungen auffindbar.

Bei Suchtreffern zu offenen Tabs nennt der Skill Titel und Tab-ID; URLs erscheinen bei Bedarf als nicht anklickbarer Code. Ein Folgeauftrag wie „Zeige Tab 123 in Firefox“ aktiviert den bestehenden Tab und holt sein Fenster nach vorne. Anklickbare Folgeaktionen setzen eine tatsächlich unterstützende Client-Oberfläche voraus; eine Skill-Änderung allein macht Webseiten-Links nicht zu MCP-Aufrufen.

- Desktop-Firefox **140 oder neuer** für native Tabgruppen und die aktuelle Firefox-Datenfreigabe bei der Installation. Firefox für Android wird nicht unterstützt.
- **Node.js 22 oder neuer** einschließlich npm. Die Windows-Einrichtung verwendet eine passende vorhandene Installation oder richtet automatisch Node 24 LTS samt npm unter `.runtime/node` im gewählten Installationsordner ein. Unter Linux und macOS müssen Node und npm bereits vorhanden sein.
- Ein KI-Client mit Unterstützung für lokale MCP-Server, beispielsweise Codex oder Claude Code.
- Windows: PowerShell; Einrichtung erfolgt im eigenen Benutzerkonto ohne Administratorrechte.

Die Dateien sind Quellcode und eine unsignierte Entwicklungs-Erweiterung. Sie sind durch das Erstellen dieses Projekts noch nicht in Firefox oder Codex installiert.

## Einrichtung über das Add-on

Die Einrichtungsseite `extension/setup/setup.html` öffnet sich als Add-on-Optionsseite in einem eigenen Firefox-Tab. Sie bietet Registrierung und Deregistrierung für Windows, Linux und macOS sowie den Verbindungs- und Registrierungsstatus des lokalen Helfers. Alle Texte sind auswählbar. Zwei schreibgeschützte Befehlsfelder für Registrierung und Deregistrierung bieten Kopierbuttons mit den passenden Aufrufen für Windows PowerShell beziehungsweise Linux/macOS mit `sh`. Falls das Kopieren nicht gelingt, lässt sich der Befehl im Feld manuell auswählen und kopieren; zusätzliche Berechtigungen sind dafür nicht nötig. Firefox lädt das gewählte Skript herunter; anschließend führt der Nutzer es außerhalb des Browsers aus. Das Add-on selbst schreibt keine Betriebssystemregistrierung und startet kein Installationsskript.

Die Registrierungsdateien enthalten einen vollständigen, komprimierten Server-Quellpayload mit Installationslogik und `package-lock.json`. Ein zusätzlich heruntergeladener Projektordner ist dafür nicht erforderlich. Node-Runtime und npm-Abhängigkeiten sind nicht eingebettet: Windows kann die passende Runtime nachladen, die Einrichtung installiert die festgelegten Laufzeitpakete mit npm. Für diese Downloads wird eine Internetverbindung benötigt.

1. Die Einrichtungsseite im Add-on öffnen und das Skript für das eigene Betriebssystem speichern.
2. Den angezeigten Registrierungsbefehl kopieren und im Ordner der gespeicherten Skripte ausführen: `register.ps1` unter Windows in PowerShell beziehungsweise `register.sh` unter Linux/macOS mit `sh`. Der angezeigte Installationsordner kann übernommen oder durch einen absoluten Pfad ersetzt werden. Eine vorhandene Native-Host-Installation wird angeboten; die Wiederverwendung wird ausdrücklich bestätigt.
3. Die Ergebnisliste für Native Host und erkannte KI-Clients prüfen. Eine eigene frühere Registrierung und unveränderte Firefox-MCP-Einträge werden auf den gewählten Installationsordner umgestellt, auch wenn der alte Ordner verschoben oder gelöscht wurde. Vorher werden Sicherungen erstellt. Fremde Registrierungen und geänderte MCP-Einträge werden als Konflikt behandelt. Die neue Standardinstallation liegt im Benutzerkonto, unabhängig von einem Entwicklungs-Repository:

   | Betriebssystem | Standardordner |
   | --- | --- |
   | Windows | `%LOCALAPPDATA%\FirefoxCodexMCP` |
   | Linux | `~/.local/share/firefox-codex-mcp` |
   | macOS | `~/Library/Application Support/FirefoxCodexMCP` |

4. In Firefox den Verbindungs-/Registrierungsstatus erneut prüfen und die MCP-Verbindung im KI-Client neu starten. Dann `firefox_status` und `firefox_get_current` aufrufen.

Für einen ausdrücklich gewählten Installationsordner und optional einen anderen Port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\register.ps1 -ProjectRoot "C:\Tools\FirefoxCodexMCP" -Port 38478
```

```sh
sh ./register.sh --root "$HOME/.local/share/firefox-codex-mcp" --port 38478
```

Windows unterstützt außerdem `-NoDownload` und `-NoRegisterClients`; Linux/macOS `--no-register-clients`. `-NoDownload` setzt ein passendes vorhandenes Node samt npm voraus. Die Windows-Registrierung nutzt den bestehenden Installer mit `-NoOpenFirefox`; unter Unix übernimmt `scripts/install-companion.mjs` die Einrichtung. Ein bestehendes Repository wird nur dann als Installationsziel verwendet, wenn dieser Pfad ausdrücklich gewählt wird.

Die Einrichtungsseite zeigt die vom Helfer gemeldete Serverversion, benötigte und aktuelle Registrierungsrevision, ausgeführte Skriptversion, Zeitpunkt und Manifestpfad. Die Registrierungsrevision wird unabhängig von der Add-on-Version gezählt. „Registrierung bestätigt“ setzt eine aktuelle Verbindung mit passendem Registrierungsnachweis voraus; bei abweichendem Protokoll, zu alter Revision oder falscher Plattform erscheint „Aktualisierung erforderlich“. Eine gespeicherte letzte Bestätigung ist nur ein früherer Prüfstand. Fehlender Native Host, Verbindungsfehler und eine noch unbestätigte Registrierung werden unterschieden. Nach Ausführen eines Skripts **„Erneut prüfen“** anklicken. Eine vorhandene Registrierung allein beweist keine laufende MCP-Client-Verbindung.

Für eine spätere dauerhafte Installation in regulärem Firefox ist eine von Mozilla signierte XPI erforderlich. AMO kann öffentlich gelistete und nicht gelistete Erweiterungen signieren; die lokale Vorbereitung erzeugt weiterhin unsignierte Pakete. Der vorbereitete Einreichungs- und Reviewer-Leitfaden steht in [docs/AMO-submission.md](docs/AMO-submission.md). [Mozilla: Signierung und Verteilung](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Windows: temporäre Entwicklung und bisherige Installation

1. Den Projektordner an einen dauerhaften Ort entpacken. Die Einrichtung speichert absolute Pfade; bei späterem Verschieben muss sie erneut ausgeführt werden.
2. `install.cmd` doppelklicken oder im Projektordner ausführen:

   ```cmd
   install.cmd
   ```

   Das CHOICE-Menü bietet **1: Erzeugen + Installieren** (`install.ps1`), **2: Nur Erzeugen** (`install.ps1 -GenerateOnly`), **3: Add-on im Firefox neu laden** (`install.ps1 -OpenFirefoxOnly`), **4: Deinstallieren** (`uninstall.ps1`) und **0: Beenden**. Eine Ziffer ohne Enter drücken. Nach dem Vorgang bleibt das Fenster bis zur ausdrücklichen Eingabe von **0** offen. Die PowerShell-Dateien lassen sich auch direkt aufrufen.

   Fehlen Node oder npm, lädt das Skript das passende Windows-ZIP von [nodejs.org](https://nodejs.org/en/download), prüft dessen SHA256-Prüfsumme und entpackt es im Projekt. Es ändert weder den systemweiten Windows-Pfad noch eine vorhandene Node-Installation. Internetzugriff ist für den ersten Download und die Paketinstallation nötig. `install.ps1 -NoDownload` unterbindet den automatischen Node-Download; dann muss bereits ein geeignetes Node samt npm vorhanden sein. Eine einmal eingerichtete Projekt-Runtime wird wiederverwendet.

   Bei der Installation führt das Skript `npm ci --omit=dev` aus, erzeugt private Konfigurationsdateien in `.local` und registriert den Native Host unter `HKCU\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge`. Eine eigene bestehende Registrierung wird bei einem Pfadwechsel nach Sicherung auf den aktuellen Projektordner umgestellt; der alte Ordner muss dafür nicht mehr vorhanden sein. Anschließend richtet der Installer den lokalen MCP-Server `firefox` in erkannten KI-Client-Konfigurationen ein und aktualisiert unveränderte eigene Einträge aus früheren Installationsordnern. Das CMD-Menü setzt die PowerShell-Ausführungsrichtlinie nur für seinen jeweiligen Skriptprozess; eine systemweite Richtlinie wird nicht verändert. Die entsprechenden Einzelschritte sind:

   ```powershell
   npm ci --omit=dev
   node scripts/setup.mjs --register-native
   node scripts/configure-clients.mjs --relocate
   ```

   Nur Dateien erzeugen, ohne Registrierung: `npm run setup` oder `.\install.ps1 -GenerateOnly`. Einen anderen Port wählen: `node scripts/setup.mjs --port 38478 --register-native`. Ein erneuter Setup-Aufruf behält ein vorhandenes Token; ohne `--port` bleibt auch der bestehende Port erhalten.
3. Nach erfolgreicher Installation öffnet das Skript automatisch Firefox mit `about:debugging#/runtime/this-firefox`. Dort **Temporäres Add-on laden** wählen und `extension/manifest.json` auswählen; den vollständigen Dateipfad zeigt der Installer an. Wird Firefox nicht gefunden oder kann es nicht geöffnet werden, bleibt die Installation erfolgreich und die Adresse wird zum manuellen Öffnen angezeigt. Bei „Nur Erzeugen“ öffnet sich kein Browser. Für unbeaufsichtigte Installationen verhindert `install.ps1 -NoOpenFirefox` das automatische Öffnen. Im Erweiterungsmenü kann die Erweiterung an die Symbolleiste angeheftet werden.
4. Die Ergebnisliste des Installers prüfen: Pro KI-Client erscheinen Erkennung, Einrichtung, Konflikt oder Fehler sowie gegebenenfalls der Pfad zur Sicherung. `-NoRegisterClients` lässt die KI-Client-Konfigurationen unverändert. Bei „Nur Erzeugen“ werden weder KI-Clients noch Firefox registriert. Als manuelle Codex-Vorlage bleibt `.local/codex-config.toml` verfügbar; niemals damit die vollständige vorhandene Konfiguration ersetzen.
5. Die MCP-Verbindung betroffener KI-Apps neu laden oder die Apps neu starten. Claude Code in VS Code benötigt eine neue Konversation; Gemini Code Assist gegebenenfalls **Developer: Reload Window**. Zunächst `firefox_status`, danach `firefox_get_current` aufrufen.

Temporäre Firefox-Add-ons verschwinden beim Firefox-Neustart und müssen dann erneut geladen werden. Für dauerhafte Installation in regulärem Firefox muss die Erweiterung über Mozilla signiert werden, beispielsweise als nicht öffentlich gelistetes Add-on. Das mit `npm run package` erzeugte ZIP ist noch nicht signiert. Siehe [temporäre Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) und [Signieren und Verteilen](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

Zum erneuten Laden nach einem Firefox-Neustart oder zum Übernehmen von Änderungen im Menü die **3** wählen, alternativ `.\install.ps1 -OpenFirefoxOnly` aufrufen. Dies öffnet ausschließlich `about:debugging#/runtime/this-firefox` und zeigt den vollständigen Pfad zu `extension/manifest.json`. Dort **Temporäres Add-on laden** wählen; falls das Add-on noch angezeigt wird, **Neu laden** anklicken. Die Aktion benötigt weder Node noch npm und verändert keine Native-Host- oder KI-Client-Registrierung. Wenn Firefox nicht gefunden oder gestartet werden kann, bleiben Adresse und Pfad sichtbar; dieser Menüpunkt meldet dann Fehlercode `1`.

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

Jeder Eintrag startet Node mit absoluten Pfaden zum MCP-Server und seiner privaten Konfiguration. Das Zugriffstoken wird nicht in Client-Konfigurationen kopiert. Vor Änderungen vorhandener Dateien wird eine eigene Sicherung angelegt. Bei Neuinstallation ermittelt `--relocate` den bisherigen Ordner aus den Startargumenten des jeweiligen eigenen Eintrags und ersetzt ihn in einer einzigen Dateischreiboperation. Unverwandte Einstellungen bleiben erhalten; vorhandene fremde oder geänderte `firefox`-Einträge werden als Konflikt gemeldet. Wiederholtes Installieren erzeugt keine doppelten Einträge. Kommentare und fremde Abschnitte werden durch gezielte Textänderungen erhalten; nicht sicher bearbeitbare komplexe Konfigurationen werden mit Hinweis übersprungen. Eine App kann zusätzlich eigene Freigaben oder Unternehmensrichtlinien verlangen; diese werden nicht umgangen.

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

Während laufender MCP-Anfragen wechseln drei größere blaue Punkte unten im Symbol von links nach rechts. Kurze Aufrufe und schnelle Serien werden optisch gebündelt. Sobald die Bewegung endet, bleiben die Punkte noch zehn Sekunden still sichtbar und verschwinden anschließend; die blaue Statusfarbe bleibt unabhängig davon eine Minute erhalten. Ein weiterer Zugriff startet die Bewegung und anschließend eine neue Zehn-Sekunden-Frist. Bei einer ausstehenden Inhaltsfreigabe hat das „?“ Vorrang und die Bewegung pausiert.

`npm run test:firefox-activity` prüft die Symbolvarianten mit der echten Firefox-Symbolleisten-API und erzeugt eine Vorschau in 16, 32 und 48 Pixeln. Dafür wird ein eigenes Headless-Testprofil unter `work/` verwendet; Firefox und die Entwicklungsabhängigkeit `web-ext` sind erforderlich.

„Verbunden“ bestätigt die lokale Erweiterung-/Host-Verbindung. Es bedeutet nicht, dass gerade ein Codex-Tool ausgeführt wird. Ohne laufenden Firefox bleiben MCP-Werkzeugdefinitionen verfügbar; Browseraufrufe melden einen Verbindungsfehler.

Seiteninhalte können **erlaubt**, **gesperrt**, **bei jedem Zugriff abgefragt**, **einmal für eine Sitzung freigegeben** oder mit **„Für 5 Tage fragen (neustartübergreifend)“** freigegeben werden. Die Auswahl eines Fristmodus erteilt noch keine Freigabe. Eine Sitzungsfreigabe endet nach **festen 12 Stunden ab Zustimmung** oder beim Firefox-/Erweiterungsneustart. Eine 5-Tage-Freigabe endet nach **festen 120 Stunden ab tatsächlicher Zustimmung** und überlebt Firefox-/Erweiterungsneustarts. Weitere Zugriffe und Neustarts verlängern keine Frist; nach Ablauf wird erneut gefragt. Eine Änderung der Zugriffsregeln widerruft alle Freigaben. Eine unbeantwortete Inhaltsabfrage läuft nach zwei Minuten ab.

Die Freigabefrage erscheint direkt im Popup des Add-ons. Dazu wird das zuletzt aktive normale Firefox-Fenster in den Vordergrund geholt; ein minimiertes Fenster wird wiederhergestellt. Der ausgewählte Tab bleibt erhalten. Ist das Add-on nicht an die Symbolleiste angeheftet, verwendet Firefox den allgemeinen Erweiterungen-Button als Anker. Es entsteht kein zusätzliches Browserfenster.

Während eine Antwort aussteht, zeigt das Add-on-Symbol ein **„?“**. Ab Firefox 149 kann das Popup automatisch geöffnet werden. In Firefox 140–148 oder wenn Firefox das Öffnen verhindert, auf das Add-on-Symbol beziehungsweise auf **Erweiterungen → Firefox ↔ Codex MCP** klicken. Das Schließen des Popups erteilt keine Freigabe: Bis zum Ablauf der ursprünglichen zwei Minuten lässt es sich erneut öffnen. Nur **Freigeben** erlaubt den Zugriff; **Ablehnen** beendet die Anfrage sofort. Quellen: [browserAction.openPopup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/browserAction/openPopup), [Firefox 149: Aufruf ohne Benutzeraktion](https://bugzilla.mozilla.org/show_bug.cgi?id=1799344), [Fenster aktivieren](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/update).

Der Inhaltsumfang ist wahlweise **alle Tabs** oder **aktiver Tab; andere Tabs einzeln auf Anfrage**. Standard ist **Sitzungsfreigabe + aktiver Tab**. Eine Inhaltsanfrage für einen anderen Tab öffnet ebenfalls die Freigabefrage, ohne den Tab zu aktivieren oder die Einstellung auf „Alle Tabs“ umzustellen. Die Frage nennt Titel und URL des angefragten Tabs.

Im Sitzungs- und 5-Tage-Modus gilt eine solche Hintergrundtab-Freigabe ausschließlich für **diesen Tab und genau diese URL**, mit eigenen festen 12 beziehungsweise 120 Stunden ab Zustimmung. Sie ist von der Freigabe für den jeweils aktiven Tab getrennt und erlaubt weder andere Tabs noch andere URLs. Die 5-Tage-Freigabe bleibt an dieselbe Firefox-Tab-Sitzung gebunden, auch wenn Firefox diesen Tab nach einem Neustart wiederherstellt; ein neu geöffneter Tab mit derselben URL erbt sie nicht. Ein Wechsel der URL, Entladen oder Schließen des Tabs widerruft seine Freigabe; eine Rückkehr zur vorherigen URL oder das Wiederöffnen eines geschlossenen Tabs stellt sie nicht wieder her. Neuladen widerruft zusätzlich die einzelne 5-Tage-Freigabe. Kann die Firefox-Tab-Sitzung nicht eindeutig wiedererkannt werden, wird erneut gefragt. Bei „Erlauben“ oder „Jedes Mal fragen“ muss jede Anfrage für einen anderen Tab einzeln bestätigt werden. „Nicht erlauben“ sperrt weiterhin sämtliche Inhaltsanfragen. Bei „Alle Tabs“ gilt die gewählte Inhaltsregel mit ihrer jeweiligen globalen Freigabe.

**„Temporäre Freigaben zurücksetzen“** widerruft alle aktiven Sitzungs-, 5-Tage- und Tabfreigaben sofort, einschließlich gespeicherter Freigaben, und lehnt eine offene Freigabefrage ab. Die gewählten Inhaltsregeln bleiben erhalten; die nächste Anfrage fragt entsprechend diesen Regeln erneut.

Diese Regeln betreffen das Lesen und Exportieren der Seite; das Auflisten von Tab-Metadaten und die ausdrücklich angeforderte Tabsteuerung bleiben bei aktivem MCP möglich. Entladene Tabs werden durch Inhaltslesen oder Exportieren nicht aufgeweckt.

Für künftig geplante Interaktions- und Debugfunktionen bildet die normale Inhaltsfreigabe die Obergrenze einer zusätzlichen Freigabe. Deren Geltungsbereich und Ablauf müssen innerhalb der normalen Freigabe liegen; wirksam ist jeweils die Schnittmenge. Eine solche Zusatzfreigabe soll höchstens **5 Tage (120 Stunden)** gelten, auch bei der normalen Einstellung „Erlauben“, und keine unbegrenzte „Immer“-Stufe besitzen. Diese Zusatzfreigaben und Funktionen sind noch nicht implementiert.

## Werkzeuge

Alle 33 Werkzeugnamen haben das Präfix `firefox_`:

| Bereich | Namen ohne Präfix |
| --- | --- |
| Status und Übersicht | `status`, `get_current`, `list_windows`, `list_tabs`, `get_tabs` |
| Installierte Erweiterungen | `list_extensions` |
| Chronik | `search_history` |
| Lesezeichen und Ordner | `list_bookmark_folders`, `search_bookmarks`, `create_bookmark`, `update_bookmark`, `move_bookmark`, `delete_bookmark` |
| Tabs | `create_tab`, `update_tab`, `set_muted`, `close_tabs`, `move_tabs`, `discard_tabs`, `reload_tabs` |
| Fenster | `create_window`, `update_window`, `close_window` |
| Native Gruppen | `list_groups`, `group_tabs`, `ungroup_tabs`, `update_group`, `move_group` |
| Seiteninhalt | `read_content` |
| Auf Seitenzustand warten | `wait_for` |
| Seitenexport | `save_png`, `save_html`, `save_pdf` |

Beispiele für Codex: „Liste alle entladenen Firefox-Tabs“, „Finde Tabs mit localhost in der URL“, „Schalte diese drei Tabs stumm“, „Verschiebe die ausgewählten Tabs in ein neues Fenster“, „Fasse den Inhalt des aktiven Tabs zusammen“. IDs zunächst anhand der Übersicht oder einer gezielten Suche auflösen. `list_tabs` unterstützt Fenster, Aktivität, Audio, Stummschaltung, Entladezustand und Gruppe als Filter; Standard sind 100, maximal 500 Tabs pro Seite mit `offset`/`limit`.

Mit `query` sucht `firefox_list_tabs` direkt in Firefox nach Titel oder URL, ohne alle Tabs an den KI-Client zu übertragen. Die Suchoptionen sind:

| Parameter | Bedeutung |
| --- | --- |
| `query` | Suchtext oder RegEx-Quelltext mit 1–4096 Zeichen |
| `searchIn` | `"title"`, `"url"` oder `"both"` (Standard); bei `"both"` genügt ein Treffer in einem der beiden Felder |
| `matchMode` | `"contains"` für eine wörtliche Teilsuche (Standard) oder `"regex"` für einen JavaScript-RegEx |
| `caseSensitive` | Groß-/Kleinschreibung beachten; Standard `false` |

`searchIn`, `matchMode` und `caseSensitive` benötigen `query`. Ein RegEx wird ohne `/.../`-Hülle angegeben; die Flags werden aus `caseSensitive` bestimmt. Ungültige Suchparameter oder RegEx-Syntax melden `INVALID_PARAMS`. Für die RegEx-Auswertung gilt ein Zeitlimit von einer Sekunde; bei Überschreitung meldet die Suche `SEARCH_TIMEOUT`.

Konkrete MCP-Aufrufe:

```text
firefox_list_tabs({"query":"localhost","searchIn":"url"})
firefox_list_tabs({"query":"^https?://localhost(?::[0-9]+)?/","searchIn":"url","matchMode":"regex"})
firefox_list_tabs({"query":"Entwurf","searchIn":"title","caseSensitive":true,"discarded":true,"limit":50})
```

Die Erweiterung kombiniert die Suche mit den übrigen Filtern und prüft vollständige Titel und URLs vor Antwortkürzung, Sortierung und Pagination. `total`, `offset` und `nextOffset` beziehen sich nur auf die Treffer; `nextOffset: null` bedeutet, dass keine weitere Seite folgt. Die Suche aktiviert keine Tabs, weckt keine entladenen Tabs und liest keine Seiteninhalte.

Nach diesem Update das Add-on unter `about:debugging#/runtime/this-firefox` **neu laden** und die MCP-Verbindung im KI-Client **neu starten**, damit beide Seiten die Suchparameter und das neue Werkzeugschema verwenden. Wird der optionale Firefox-Skill genutzt, dessen Projektkopie erneut ins Skill-Verzeichnis des Clients kopieren.

Der optionale Browsertest `npm run test:firefox-tab-search` prüft die Suche mit echten Firefox-Tabs und Workern in einem eigenen Headless-Testprofil unter `work/`. Er benötigt Firefox und die Entwicklungsabhängigkeit `web-ext`; das normale Benutzerprofil wird nicht verwendet.

`read_content` liefert Text oder HTML aus dem Hauptframe, optional für einen CSS-Selektor und mit Links. Standardlimit: 30.000 Zeichen; Maximum: 100.000. Kürzungen werden angezeigt. Schließen, Navigation, Neuladen und Entladen können ungespeicherte Seitendaten verlieren. Batch-Aktionen liefern Einzelergebnisse und können teilweise erfolgreich sein; nach einem Timeout oder Teilfehler zunächst Zustand prüfen, bevor erneut verändert wird. Parameterdetails stehen in `PROTOCOL.md` und den MCP-Werkzeugschemata.

## Chronik nach einzelnen Besuchen durchsuchen

`firefox_search_history` sucht nach URL, Titel und Besuchszeitpunkt im verbundenen Firefox-Profil. Die Textoptionen `query`, `searchIn`, `matchMode` und `caseSensitive` entsprechen der Tab-Suche oben; sie sind optional und werden vor der Pagination angewendet. Ohne Zeitfilter werden die letzten **24 Stunden** durchsucht.

| Zeitfilter | Bedeutung |
| --- | --- |
| `lastHours` | Letzte X Stunden; positive Zahl bis 87840, auch Bruchteile möglich |
| `lastDays` | Letzte X Tage; positive Zahl bis 3660, auch Bruchteile möglich |
| `from`, `to` | ISO-Zeitpunkte mit Sekunden und expliziter Zone, beispielsweise `2026-10-03T18:00:00+02:00` oder `2026-10-03T16:00:00Z` |

`lastHours` und `lastDays` schließen sich gegenseitig aus und können nicht mit `from`/`to` kombiniert werden. Der absolute Bereich ist **[from, to)**: `from` zählt mit, `to` zählt nicht mehr mit. Bei einem absoluten Filter ohne `from` beginnt die Suche am Unix-Epoch; ohne `to` endet sie beim Suchbeginn. Rückgaben verwenden UTC-Zeitpunkte mit `Z`.

```javascript
firefox_search_history({query: "Delphi", lastDays: 2})
firefox_search_history({query: "github\\.com/", searchIn: "url", matchMode: "regex", lastHours: 6})
firefox_search_history({from: "2026-10-03T18:00:00+02:00", to: "2026-10-03T23:00:00+02:00", limit: 50})
```

Die Ausgabe enthält einzelne Besuche mit `url`, `title`, `visitedAt`, dem numerischen `visitTime` und den von Firefox gelieferten Besuchskennungen. Sie ist nach Besuchszeitpunkt absteigend sortiert. Frühere Besuche derselben URL können im gewählten Zeitraum erscheinen, auch wenn die Seite inzwischen erneut geöffnet wurde. Der Titel stammt aus dem aktuellen Chronikeintrag der URL; Firefox liefert über diese API **keinen historischen Titel pro Besuch**.

Eine Suche erzeugt eine stabile Ergebnisliste mit `snapshotId` und `expiresAt`. Weitere Seiten mit **nur** `snapshotId`, `offset` und optional `limit` abrufen:

```javascript
firefox_search_history({snapshotId: "ID aus der ersten Antwort", offset: 100, limit: 100})
```

Neue Besuche verändern diese Ergebnisliste nicht. Die Snapshot-Frist beträgt feste **fünf Minuten** ab Erstellung und wird durch Seitenabrufe nicht verlängert. Höchstens **vier Snapshots** bleiben gleichzeitig im Speicher; neue Suchen können ältere früher verdrängen. Abgelaufene oder verworfene IDs melden `SNAPSHOT_EXPIRED`; dann eine neue Suche starten. Bei deaktiviertem MCP, beim Abbruch der Verbindung zum Native Host sowie beim Erweiterungsneustart werden die Snapshots verworfen.

Standard sind 100, maximal 500 Besuche pro Seite. `total`, `returned`, `nextOffset` und `hasMore` beschreiben die gespeicherten Treffer. Eine Suche prüft höchstens **50.000 Kandidaten-URLs** und **100.000 Besuchseinträge**, verarbeitet höchstens **8 MiB Kandidatendaten** vor der RegEx-Auswertung und hat ein Arbeitsbudget von **20 Sekunden**. Ein Snapshot umfasst höchstens **8 MiB** Ergebnisdaten, insgesamt bleiben höchstens 32 MiB Snapshot-Daten im Speicher. Wird eine Suchgrenze oder das Arbeitsbudget erreicht, melden `incomplete:true` und `warnings` die unvollständige Erfassung; `total` zählt dann nur die tatsächlich erfassten Treffer. Den Zeitraum oder Suchtext weiter einschränken. Höchstens zwei neue Chroniksuchen laufen gleichzeitig; eine weitere meldet `BUSY`. Eine zusätzlich nötige Kürzung auf die Antwortpaketgröße wird getrennt über `truncated` gemeldet; für die nächste Seite den zurückgegebenen `nextOffset` verwenden.

## Lesezeichen, Favoriten und Symbolleiste verwalten

Favoriten werden hier als normale Firefox-Lesezeichen einschließlich der **Lesezeichen-Symbolleiste**, des Lesezeichen-Menüs und eigener Ordner verwaltet. `firefox_list_bookmark_folders` liefert die vorhandenen Zielordner mit ID und Ordnerpfad. IDs sind dauerhafte, undurchsichtige Zeichenfolgen aus dem Firefox-Profil; die gewünschte ID aus der Antwort übernehmen. Ordnernamen können je nach Sprache anders heißen.

`firefox_search_bookmarks` verwendet dieselben Textoptionen wie die Tab- und Chronik-Suche. Die Ergebnisse enthalten `id`, `type`, `title`, `url`, `parentId`, `index`, einen `path` als Liste der übergeordneten Ordnernamen und, falls verfügbar, `dateAdded` als ISO-Zeitpunkt. Mehrere Lesezeichen derselben URL bleiben einzelne Treffer mit eigenen IDs. Ordner werden über `firefox_list_bookmark_folders` aufgelistet.

Beide Listen unterstützen `parentId` zur Einschränkung auf einen Ordner, `recursive` (Standard `true`) sowie `limit`/`offset` (Standard 100, maximal 500). Bei `recursive:false` werden nur direkte Kinder erfasst; ohne `parentId` zeigt die Ordnerliste dann die obersten Firefox-Ordner. Ein angegebener Elternordner selbst wird nicht als eigener Treffer ausgegeben. Suche und Ordnerfilter greifen vor der Pagination; `total`, `returned` und `nextOffset` beziehen sich auf die Treffer.

| Werkzeug | Aufgabe |
| --- | --- |
| `firefox_list_bookmark_folders` | Ordner und ihre IDs ermitteln, einschließlich Symbolleiste und Menü |
| `firefox_search_bookmarks` | URL-Lesezeichen nach Titel oder URL suchen, optional mit RegEx und Ordnerfilter |
| `firefox_create_bookmark` | Lesezeichen, Ordner oder Trennzeichen anlegen |
| `firefox_update_bookmark` | Titel oder URL eines Eintrags anhand seiner exakten ID ändern |
| `firefox_move_bookmark` | Eintrag in einen Ordner verschieben oder seinen `index` ändern |
| `firefox_delete_bookmark` | Eintrag anhand seiner exakten ID löschen; volle Ordner nur mit `recursive:true` |

Beim Anlegen ist `type:"bookmark"` Standard und erfordert `url`; erlaubt sind absolute HTTP(S)-URLs und `about:blank`. `type:"folder"` und `type:"separator"` dürfen keine URL enthalten. `title` ist optional und auf 512 Zeichen begrenzt. Ohne `parentId` verwendet Firefox **Weitere Lesezeichen** (`unfiled_____`); ein optionaler nichtnegativer `index` legt die Position fest. Verschieben ohne `index` hängt den Eintrag hinten an, mit `index` lässt sich auch im bisherigen Ordner umsortieren.

```javascript
firefox_list_bookmark_folders({recursive: false})
firefox_search_bookmarks({query: "Delphi", parentId: "ID des gewünschten Ordners"})
firefox_create_bookmark({title: "DAI", url: "https://github.com/geheimniswelten/DAI", parentId: "ID der Symbolleiste"})
firefox_create_bookmark({type: "folder", title: "Delphi", parentId: "ID der Symbolleiste"})
firefox_update_bookmark({id: "ID des Lesezeichens", title: "DAI – Delphi MCP"})
firefox_move_bookmark({id: "ID des Lesezeichens", parentId: "ID des Zielordners", index: 0})
firefox_delete_bookmark({id: "ID des Lesezeichens"})
```

Ändern, Verschieben und Löschen beziehen sich ausschließlich auf die angegebene ID. Ein nichtleerer Ordner meldet ohne `recursive:true` **`FOLDER_NOT_EMPTY`**; mit dieser ausdrücklichen Option wird der gesamte Ordner einschließlich seiner Unterordner gelöscht. Die Firefox-Wurzel und die festen Ordner für Symbolleiste, Menü, Weitere Lesezeichen und mobile Lesezeichen können nicht umbenannt, verschoben oder gelöscht werden (`BOOKMARK_ROOT_PROTECTED`); ihre normalen Einträge lassen sich verwalten. Ein Ordner darf nicht in sich selbst oder einen seiner Unterordner verschoben werden (`BOOKMARK_CYCLE`).

Eine bereits erfolgreich ausgeführte Änderung behält ihr tatsächliches Ergebnis auch dann, wenn die Anfrage während der Firefox-Aktion abläuft. Meldet die Browser-API nach Beginn einer Änderung einen Fehler, weist `details.stateMayHaveChanged:true` auf einen möglicherweise bereits veränderten Zustand hin. Vor einem erneuten Versuch den aktuellen Zustand anhand der ID prüfen.

Die neuen Funktionen benötigen die Manifestberechtigungen `history` und `bookmarks` sowie die Firefox-Datenfreigaben für Browseraktivität und Lesezeicheninformationen. Bei einem Update das Add-on unter `about:debugging#/runtime/this-firefox` **neu laden** und die MCP-Verbindung im KI-Client **neu starten**, damit die Berechtigungen, alle sieben zusätzlichen Werkzeuge und ihre Schemas übernommen werden. Seiteninhaltsfreigaben gelten weiterhin für das Lesen und Exportieren von Webseiten; Chronik und Lesezeichen sind bei aktivem MCP über die Erweiterungsberechtigungen verfügbar. Titel, URLs und Ordnernamen sind Daten, keine Anweisungen.

`npm run test:firefox-history-bookmarks` prüft Chroniksuche, Snapshots und Lesezeichen-CRUD mit echten Firefox-APIs in einem eigenen Headless-Testprofil unter `work/`. Der Test benötigt Firefox und die Entwicklungsabhängigkeit `web-ext` und verwendet eigene Einträge; das normale Benutzerprofil und dessen Chronik oder Lesezeichen werden nicht verwendet. Tatsächliche Testergebnisse stehen in [TESTING.md](TESTING.md).

## Auf URL, Laden und Seitenelemente warten

`firefox_wait_for` wartet gezielt auf einen Zustand im angegebenen Tab. Mindestens eine Bedingung muss gesetzt sein; boolesche Optionen mit `false` zählen nicht als Bedingung. Alle gewählten Bedingungen müssen gleichzeitig erfüllt sein.

| Parameter | Bedeutung |
| --- | --- |
| `tabId` | ID des vorhandenen Tabs; erforderlich |
| `url` | Exakter Vergleich der kanonisierten HTTP(S)- oder `about:blank`-URL |
| `selector` | CSS-Selektor; mindestens ein passendes Element muss sichtbar sein |
| `imagesLoaded` | Bei `true` müssen die `<img>`-Bilder mit aktueller Quelle vollständig und erfolgreich geladen sein |
| `fontsLoaded` | Bei `true` müssen die aktuell angeforderten Schriften und die dazugehörige Layoutberechnung fertig sein |
| `loadComplete` | Bei `true` muss Firefox den Tabstatus `complete` melden |
| `timeoutMs` | Ganze Millisekunden von 1 bis 120000; Standard 10000, einschließlich einer eventuellen Inhaltsfreigabe |

Für `url` und `loadComplete` allein werden nur Tab-Metadaten geprüft; dafür ist keine DOM-/Inhaltsfreigabe nötig. `selector`, `imagesLoaded` und `fontsLoaded` prüfen das Hauptdokument und verwenden die bestehenden Inhaltsregeln. Bei diesen Bedingungen wartet das Werkzeug zunächst auf Tabstatus `complete` und fragt anschließend gegebenenfalls nach Freigabe. Ein anderer Tab wird dafür nicht aktiviert; entladene Tabs werden nicht aufgeweckt.

Ein Selektortreffer gilt bei vorhandener Layoutfläche und sichtbaren `visibility`-/`opacity`-Werten als sichtbar. Ein Element außerhalb des sichtbaren Bildausschnitts kann diese Bedingung erfüllen; eine Überdeckung durch andere Elemente wird nicht geprüft. Die Bildbedingung verlangt `complete` und `naturalWidth > 0`; kaputte Bilder verhindern den Erfolg. Lazy Loading wird nicht durch Scrollen ausgelöst. Die Schriftbedingung folgt `document.fonts.ready` für die aktuell angeforderten Schriften einschließlich Layout; ungenutzte Schriften im Zustand `unloaded` blockieren sie nicht.

Zum Beispiel erst navigieren und anschließend auf die gerenderte Seite warten:

```javascript
firefox_update_tab({tabId: 123, url: "http://localhost:3000/"})
firefox_wait_for({tabId: 123, url: "http://localhost:3000/", selector: "#app .ready", imagesLoaded: true, fontsLoaded: true, timeoutMs: 30000})
```

Sind die Bedingungen bereits erfüllt, liefert der Aufruf sofort Erfolg. Nach einer Navigation die erwartete URL mitgeben, damit die vorherige Seite die Prüfung nicht erfüllt. Ein separat gestarteter Wait kann einen noch nicht begonnenen Reload derselben URL vor dessen erstem Browserereignis nicht erkennen; ein Navigationstoken gehört nicht zu dieser API.

Wird die Seite nach der Inhaltsfreigabe navigiert oder neu geladen, meldet das Werkzeug `PAGE_CHANGED`. Läuft die gesamte Wartefrist ab, meldet es `WAIT_TIMEOUT`. Ein MCP-Abbruch beendet die Warteschleife und eine zugehörige offene Freigabeabfrage. Nach einem Update das Add-on unter `about:debugging#/runtime/this-firefox` **neu laden** und die MCP-Verbindung im KI-Client **neu starten**, damit `firefox_wait_for` und sein Schema verfügbar sind.

Der optionale Browsertest `npm run test:firefox-wait` prüft die Wartebedingungen in einem eigenen Headless-Firefox-Profil mit einer Testkopie der Erweiterung unter `work/`. Er benötigt Firefox, die Entwicklungsabhängigkeit `web-ext` und eine lokale TrueType-Schrift; unter Windows wird standardmäßig `C:\Windows\Fonts\arial.ttf` verwendet, alternativ der Pfad aus `FIREFOX_WAIT_FONT`. Die Testseite liefert Bild und Schrift über einen verzögerten lokalen HTTP-Server. Inhaltsfreigaben werden über einen Testadapter beantwortet; das Benutzerprofil, der Native Host und das echte Freigabepopup werden nicht verwendet.

Dieser Browsertest prüft außerdem die 5-Tage-Freigaben mit echten Firefox-Storage- und Tab-Sitzungs-APIs.

## Seiten als PNG, einzelne HTML-Datei oder PDF speichern

Die drei Exportwerkzeuge verwenden dieselben Inhaltsfreigaben wie `read_content`. Die Tab-ID zunächst über `firefox_get_current` oder `firefox_list_tabs` ermitteln. PNG und HTML werden im Dateisystem des Rechners gespeichert, auf dem der lokale MCP-Server läuft. Dafür einen vollständigen absoluten Zielpfad in einem vorhandenen Ordner angeben. Vorhandene Dateien werden nicht überschrieben. Ein Export über **128 MiB** schlägt fehl, statt unbemerkt gekürzt zu werden; eine unvollständige neu angelegte Datei wird bei einem Fehler entfernt.

```javascript
firefox_save_png({tabId: 123, path: "C:\\Exports\\seite.png"})
firefox_save_png({tabId: 123, path: "C:\\Exports\\ausschnitt.png", fullPage: false})
firefox_save_html({tabId: 123, path: "C:\\Exports\\seite.html"})
firefox_save_pdf({tabId: 123})
```

**PNG:** Standardmäßig wird die gesamte Seite von oben bis unten in der aktuellen Breite des Tabs aufgenommen. `fullPage:false` nimmt nur den sichtbaren Ausschnitt auf. Die Aufnahme verwendet einen Bildpixel je CSS-Pixel. `loadDeferred:true` ist Standard: Ein Scroll-Durchlauf von höchstens 20 Sekunden beziehungsweise 150 Schritten versucht zuerst, nachgeladene Inhalte zu laden, und stellt anschließend die vorherige Scrollposition wieder her. Die Seite kann dabei eigene Nachladeaktionen ausführen. Mit `loadDeferred:false` wird dieser Durchlauf ausgelassen. `maxHeight` begrenzt die Aufnahme auf standardmäßig **30.000 CSS-Pixel**; bis **100.000** sind ausdrücklich einstellbar. Zusätzlich gelten technische Bildgrenzen von **32.760 Pixeln je Kante** und **100 Millionen Bildpunkten**. Bei Überschreitung meldet das Werkzeug einen Fehler. Endlos nachladende Seiten, virtuelle Listen und eigene Scrollbereiche können nicht vollständig garantiert werden; die Antwort meldet entsprechende Einschränkungen unter `warnings`.

**Eine HTML-Datei:** Die Erweiterung enthält ein lokal erzeugtes Bundle aus **SingleFile Core 1.6.19** mit vollständiger Lizenz und Herkunftshinweis. Die unveränderten Originalquellen liegen unter `vendor/single-file-core/` im separaten Quellpaket. `scripts/build-html-vendor.mjs` erzeugt das Bundle mit nachvollziehbaren Transformationen für die unterstützten Exportfunktionen. Nicht unterstützte Upstream-Optionen werden abgewiesen; Seiten dürfen die festen Exportoptionen nicht überschreiben. Zur Aufnahme wird kein externer Speicherdienst aufgerufen. Gespeichert wird der aktuelle, bereits durch JavaScript aufgebaute DOM-Zustand; unterstützte CSS-, Bild- und Schriftressourcen werden in die Datei eingebettet. Zugängliche Canvas-Inhalte, Shadow DOM und Frames werden soweit möglich übernommen. JavaScript, Ereignishandler und `javascript:`-URLs werden auch aus eingebetteten Dokumenten und Templates entfernt. Eine CSP in der Kopie sperrt Skriptausführung und weitere Ressourcenabrufe. CSS-Animationen werden auf ihren aktuellen Zustand eingefroren; Medien erhalten eine statische Darstellung.

Normale Links bleiben als vollständige URLs erhalten; lokale Sprungmarken bleiben lokal. Erkennbare einfache JavaScript-Navigationen mit einem festen Ziel werden in normale Links umgewandelt, etwa `location.href='/details/123'` oder `location.assign('/details/123')`. Beliebige JS-Schaltflächen und Anwendungen funktionieren in der Kopie nicht weiter. Auch hier ist `loadDeferred:true` Standard; der vorbereitende Scroll-Durchlauf ist auf acht Sekunden beziehungsweise 100 Schritte und 100.000 CSS-Pixel begrenzt. Die HTML-Aufnahme dauert höchstens 60 Sekunden und lädt Ressourcen bis 12 MiB pro Ressource beziehungsweise insgesamt 64 MiB nach. Die Antwort nennt unter `warnings` fehlende, zu große oder nicht vollständig übernommene Ressourcen und Seitenelemente. Geschützte Frames, DRM-Inhalte und geschlossene Shadow Roots können unvollständig bleiben. HTML kann bei anderer Fensterbreite neu umbrechen; für feste Bilddarstellung PNG verwenden.

**PDF über die Firefox-Druckfunktion:** `save_pdf` verwendet [Firefox `tabs.saveAsPDF`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/saveAsPDF). Firefox öffnet den nativen Speicherdialog, in dem Dateiname und Ziel gewählt werden. Der Tab muss bereits im zuletzt aktiven normalen Firefox-Fenster ausgewählt sein; das Werkzeug schaltet weder Tab noch Fenster selbst um. Die PDF nutzt Drucklayout, Druck-CSS und Seitenumbrüche und kann deshalb anders aussehen als der Screenshot. Sie verwendet keine gerasterte PNG-Kopie. Das Werkzeug liefert `status:"saved"` beziehungsweise `"replaced"` und `saved:true`, bei Abbruch `status:"canceled"` und `saved:false`. Firefox gibt den endgültigen Dateipfad nicht an das Add-on zurück. Der Speicherdialog erlaubt ausdrücklich auch das Ersetzen einer vorhandenen PDF.

Exportanfragen warten höchstens fünf Minuten, einschließlich eventueller Inhaltsfreigabe. Ein Timeout oder Verbindungsabbruch schließt den nativen PDF-Speicherdialog nicht: Vor erneutem Aufruf den Dialog und vorhandene Dateien prüfen. Der PDF-Inhalt wird beim Bestätigen des Speicherdialogs gedruckt; Veränderungen der offenen Seite während des Dialogs können im Ergebnis erscheinen. Navigation, Neuladen, Entladen oder Schließen während des Dialogs werden als Warnung gemeldet, ohne eine bereits gespeicherte PDF als ungespeichert auszugeben. Zum Aktivieren der neuen Werkzeuge die Firefox-Erweiterung neu laden und die MCP-Verbindung im KI-Client neu starten.

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

Inhaltszugriff und Export sind auf geladene HTTP(S)-Seiten begrenzt; `read_content` liest nur den Hauptframe. Beim HTML-Export können zusätzlich zugängliche eingebettete Frames übernommen werden. Browserinterne Seiten, andere Erweiterungsseiten, Reader-/Quelltextansicht, der PDF-Viewer sowie geschützte Mozilla-Seiten können keinen Inhalt liefern. Neue Navigationen erlauben HTTP(S) und `about:blank`. Private Fenster sind nur zugänglich, wenn Firefox die Erweiterung für private Fenster ausdrücklich zulässt. Das Add-on bietet keine beliebige JavaScript- oder Shell-Ausführung über MCP.

`.local/config.json` enthält das gemeinsame Zugriffstoken. Das Setup beschränkt `.local` und seine erzeugten Dateien unter Windows auf den aktuellen Benutzer und SYSTEM; unter Unix gelten Verzeichnisrechte `0700` und Dateirechte `0600`. Die Konfiguration gehört nicht in Quellpakete oder Versionskontrolle. Es wird kein Token in die Konsolenausgabe geschrieben. Die Verbindung verlässt den Rechner nicht; von Codex angeforderter Seiteninhalt wird anschließend Teil der normalen Codex-Werkzeugantwort.

Das Firefox-Manifest deklariert die Weitergabe von Browseraktivität, Lesezeicheninformationen und Seiteninhalten an den lokalen MCP-Client. Die Regeln im Symbolleistenmenü beschränken den tatsächlichen Inhaltszugriff zusätzlich. Erweiterungslisten und Browser-Versionsinformationen im Status werden nur ausgegeben, wenn die optionale Firefox-Datenfreigabe für technische Informationen erteilt ist. Es gibt keine Telemetrieübertragung durch dieses Projekt. Hintergrund: [Firefox-Datenfreigaben](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Diagnose, Tests und Pakete

Der geprüfte Stand und die Ergebnisse der Tests mit echtem Firefox sind in [TESTING.md](TESTING.md) dokumentiert.

Unter Windows genügt ein Doppelklick auf **`build.cmd` im Repository-Hauptverzeichnis**. Der Starter findet Node.js wie der Installer, installiert die Entwicklungsabhängigkeiten aus der Lockdatei, prüft Syntax und Manifest, baut das SingleFile-Bundle sowie alle Einrichtungsskripte neu, erzeugt beide ZIPs unter `dist/` und führt den lokalen AMO-Linter aus. Das Ergebnisfenster bleibt bis zur Taste `0` offen. Der Build verwendet die vorhandene Versionsnummer und führt keine Registrierung oder Installation des Native Hosts aus. `install.cmd` und `install.ps1` erzeugen die lokale Einrichtung; ZIP-Pakete entstehen mit dem Build-Starter.

Für einen Aufruf ohne wartendes Ergebnisfenster:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

`-SkipDependencies` verwendet bereits installierte Build-Abhängigkeiten. `-NoDownload` verhindert den automatischen Download einer fehlenden Node-Runtime; npm kann weiterhin Abhängigkeiten herunterladen. Auf Linux/macOS und für direkte npm-Aufrufe gelten die folgenden Befehle:

```powershell
npm ci
npm run check
npm test
npm run package
```

Lokale Chat-Exporte mit dem Namen `Chat - *.md`, bereits signierte `.xpi`-Dateien im Hauptverzeichnis und lokale Sicherungsordner werden aus dem Quellpaket ausgeschlossen.

`check` prüft JavaScript-Syntax und Manifestkonsistenz. Tests umfassen Protokoll-/Serverlogik, Erweiterungslogik und Setup in temporären Verzeichnissen; Setup-Tests registrieren nichts im Benutzerprofil. `npm ci` installiert für Entwicklung zusätzlich `web-ext` als lokale Test-/Lint-Abhängigkeit; eine globale Installation ist nicht nötig. Mit `npx --no-install web-ext lint --source-dir extension` lässt sich die Erweiterung zusätzlich prüfen. Bei einer Projekt-Runtime kann etwa `.\.runtime\node\node.exe --test test/*.test.mjs` direkt ausgeführt werden. `npm run package` erzeugt zuvor die selbständigen Einrichtungsskripte mit `scripts/build-setup-downloads.mjs`. Die Pakete entstehen als Standard-ZIP mit Deflate-Kompression unter `dist/`: `firefox-codex-mcp-extension.zip` enthält die unsignierte Erweiterung mit Einrichtungsseite und Serverpayload in den Skripten sowie das SingleFile-Bundle mit Lizenz und Herkunftshinweis; `firefox-codex-mcp-source.zip` enthält das Projekt einschließlich unveränderter Originalquellen unter `vendor/single-file-core/`, Lockdatei und Generatoren ohne Abhängigkeiten, Projekt-Runtime, Tokens und lokale Konfiguration. Das Quellpaket ist bei einer AMO-Einreichung für Reviewer bereitzustellen. Die Reviewer-Buildanleitung steht in [docs/AMO-submission.md](docs/AMO-submission.md). Ein automatisierter Test ersetzt keinen vollständigen Test mit dem eigenen Firefox-Profil.

Bei „Native host not found“ die Registrierung und den Manifestpfad prüfen, dann die Erweiterung neu laden. Nach einem Wechsel des Installationsordners Firefox vollständig beenden und neu starten, anschließend die MCP-Verbindungen in den KI-Apps neu laden. Ein bereits laufender Firefox kann trotz korrekter neuer Registry weiterhin den bisherigen Host starten; „Neu verbinden“ allein reicht dann nicht. Bei Verbindungsfehlern den Popup-Schalter, den gespeicherten Port und die Node-Pfade prüfen. Bei Portkonflikten einen anderen Port einrichten und Firefox-Erweiterung sowie Codex-Verbindung neu starten. Die Erweiterung kommuniziert mit dem gestarteten Firefox-Profil. Gleichzeitiger Betrieb mehrerer Profile ist in dieser Version nicht vorgesehen: Die Native-Host-Registrierung gilt benutzerweit und ein Host belegt den konfigurierten Port.

Die Registrierung erfolgt pro Benutzer: unter Windows über `HKCU\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge`, unter Linux über `~/.mozilla/native-messaging-hosts/de.codex.firefox_bridge.json`, unter macOS über `~/Library/Application Support/Mozilla/NativeMessagingHosts/de.codex.firefox_bridge.json`. Der Registrierungsort ist vom eigentlichen Server-Installationsordner getrennt. Die Hostmanifest-Datei verweist auf den absoluten Launcherpfad und lässt ausschließlich die feste Add-on-ID zu. [Mozilla: Native-Manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests).

## Deinstallation

Zum Entfernen der Registrierung über die Add-on-Einrichtung das passende `unregister.ps1` beziehungsweise `unregister.sh` herunterladen und außerhalb von Firefox ausführen. Die Skripte ermitteln die bisherige Installation aus der Native-Host-Registrierung; ihr eigener Speicherort muss damit nicht übereinstimmen, und der alte Serverordner darf fehlen. `-ProjectRoot "C:\Tools\FirefoxCodexMCP"` beziehungsweise `--root "$HOME/.local/share/firefox-codex-mcp"` kann als zusätzliche Quelle für die optionale Client-Bereinigung dienen. Diese Deregistrierung entfernt die eindeutig zugeordneten Native-Host- und unveränderten Client-Einträge; Serverdateien und lokale Konfiguration bleiben erhalten. Das Add-on bei Bedarf separat unter `about:addons` entfernen.

Unter Windows benötigt die Native-Host-Deregistrierung weder Node noch npm. Die zusätzliche Client-Bereinigung braucht Node 22 oder neuer und die installierten Laufzeitabhängigkeiten im Serverordner. Fehlen sie, bleibt die Native-Host-Abmeldung erfolgreich; das Skript meldet die nicht abgeschlossene Client-Bereinigung als Teilfehler mit Rückgabecode `2`. Unter Linux/macOS benötigt `unregister.sh` auch für die Native-Host-Abmeldung Node 22 oder neuer, aber kein npm. Mit `-NoRegisterClients` beziehungsweise `--no-register-clients` lässt sich die Client-Bereinigung bewusst überspringen.

In `install.cmd` die **4** wählen oder `uninstall.ps1` ausführen. Das funktioniert auch aus einer neu heruntergeladenen Kopie, etwa im Downloadordner, wenn der ursprüngliche Projektordner bereits gelöscht wurde. Eine erneute Installation ist dafür nicht erforderlich; das Entfernen der Native-Host-Registrierung und der zugehörigen lokalen Dateien benötigt weder Node noch npm.

Das Skript ermittelt die frühere Installation aus der benutzerspezifischen Native-Messaging-Registrierung `de.codex.firefox_bridge`. Es entfernt diesen Eintrag auch bei fehlendem ursprünglichem Ordner. Ist der registrierte Pfad erkennbar, beendet es eindeutig dieser Installation zugeordnete Brücken-/MCP-Prozesse und entfernt deren bekannte erzeugte Dateien in `.local`, soweit noch vorhanden. Der Speicherort der neuen Downloadkopie muss damit nicht übereinstimmen.

Ohne Registrierung werden nur die erzeugten Dateien der aufgerufenen Projektkopie bereinigt, etwa nach „Nur Erzeugen“. Bei einem nicht erkennbaren registrierten Pfad wird der Anwendungseintrag entfernt. Die zusätzliche Client-Bereinigung erkennt eigene unveränderte Firefox-Einträge unabhängig vom aktuellen Ordner und auch ohne Native-Host-Registrierung. Quellcode, Abhängigkeiten einschließlich `.runtime/node`, unbekannte Dateien und die Registrierungen anderer Anwendungen bleiben erhalten. Wiederholtes Deinstallieren ist möglich. `uninstall.ps1 -WhatIf` zeigt die vorgesehenen Schritte ohne Änderungen an.

Wenn eine passende Node-Runtime und die Parserpakete in der aktuellen oder ursprünglichen Projektkopie verfügbar sind, entfernt das Skript zusätzlich eindeutig zu dieser Installation gehörende, unveränderte Firefox-MCP-Einträge der erkannten KI-Clients. Fremde und nachträglich geänderte Einträge bleiben erhalten. Fehlen Runtime oder Pakete nach dem Löschen des ursprünglichen Ordners, wird die Native-Host-Deinstallation trotzdem abgeschlossen; der Installer weist auf manuell zu entfernende Client-Einträge hin. Dafür wird nichts heruntergeladen. `-WhatIf` verändert auch die Client-Konfigurationen nicht.

Das Firefox-Add-on unter `about:addons` separat entfernen. Eventuell übersprungene Client-Einträge anhand der obigen Tabelle prüfen und die betroffenen KI-Apps neu starten. Sicherungskopien werden nicht automatisch zurückgespielt, da dies spätere Änderungen anderer Einstellungen verlieren könnte. Anschließend kann der Projektordner bei Bedarf entfernt werden.

## TODO / MAYBE

Die lokale Vorbereitung umfasst Add-on-Einrichtung, Registrierungsskripte, ein unsigniertes Erweiterungspaket und ein nachvollziehbar baubares Quellpaket. Upload, Signierung und Veröffentlichung bei Mozilla sind ein gesonderter, noch nicht ausgeführter Schritt.

- [ ] Nach ausdrücklicher Entscheidung eine von Mozilla signierte XPI anbieten, öffentlich gelistet oder zur eigenen Verteilung. Vorbereitung: [docs/AMO-submission.md](docs/AMO-submission.md).
