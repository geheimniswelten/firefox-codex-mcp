### Kurz

- Firefox mit KI verwalten: Tabs/Fenster/Plugins suchen/durchsuchen/schließen/verschieben/...
   - Codex, Claude Code (CLI / VS Code), Claude Desktop, Eigent, Gemini CLI / Code Assist, Gemini Desktop, Hermes, LM Studio and OpenClaw
- **ACHTUNG:** derzeit im Testmodus, nur als temporäres Add-on
- Downloaden und install.cmd ausführen
   - in about:debugging#/runtime/this-firefox "Temporäres Add-on laden" -> ...\firefox-codex-mcp\extension\manifest.json
   - als FF-Plugin, online, zum direkt Installieren, aktuell noch nicht (aus Firefox heraus ist eine Registrierung bei den KI-Agenten sowieso nicht möglich)
- Windows + Firefox _(FF im OSX und Linux prinzipiell möglich, also Plugin inkl. MCP-Server, aber erstellen und registrieren aktuell manuell)_
- Zugriff auf Seiteninhalte standardmäßig gesperrt (bei Erstzugriff wird nach Freigabe gefragt)
- Export von Webseiten als PNG und Single-HTML (auch als PDF -> öffnet aber nur den Speichern-Dialog des FF)

# Firefox ↔ Codex MCP

Firefox-Erweiterung und lokaler MCP-Server für die vorhandenen Firefox-Fenster, Tabs, nativen Tabgruppen, installierten Erweiterungen und Seiteninhalte. Die Verbindung nutzt Firefox Native Messaging, einen ausschließlich an `127.0.0.1` gebundenen Host mit Zugriffstoken und MCP über Standard-Ein-/Ausgabe. Es ist kein OpenAI-API-Schlüssel nötig.

Ist die Erweiterung bzw. MCP-Anbindung registriert, aber nicht aktiv oder erreichbar, soll der KI-Agent zuerst rückfragen: auf die Verbindung warten oder `about:debugging#/runtime/this-firefox` in Firefox öffnen, um das Add-on zu laden bzw. neu zu laden? Nach der Prüfung durch den Nutzer wird `firefox_status` erneut aufgerufen. Computer Use oder andere Browser-Automatisierung sind erst nach erfolgloser Wiederherstellung oder auf ausdrücklichen Wunsch des Nutzers vorgesehen. Diese Reihenfolge steht in den MCP-Server-Anweisungen sowie in der `FIREFOX_OFFLINE`-Fehlermeldung. Ist der MCP-Server selbst nicht gestartet und kann keine Anweisungen liefern, muss der KI-Client diese Vorgabe aus einer zuvor geladenen Anweisung kennen. Die Debugging-Seite wird über eine verfügbare Browser-/Betriebssystemfunktion geöffnet, da die nicht erreichbare MCP-Verbindung das nicht übernehmen kann.

## Voraussetzungen

Der optionale Skill `skills/firefox-browser/SKILL.md` bevorzugt Firefox auch bei allgemeinen Bezeichnungen wie „Browser“ und „Webbrowser“. Eine ausdrücklich andere Browserauswahl (z. B. Chrome oder Edge) hat Vorrang. Für Codex den Ordner `skills/firefox-browser` nach `%USERPROFILE%\.codex\skills\firefox-browser` kopieren (bei gesetztem `CODEX_HOME` in dessen `skills`-Verzeichnis). Der Skill enthält den Wiederherstellungsablauf auch für den Fall, dass der MCP-Server selbst nicht erreichbar ist. Er wird dadurch unabhängig von den Server-Anweisungen auffindbar.

Bei Suchtreffern zu offenen Tabs nennt der Skill Titel und Tab-ID; URLs erscheinen bei Bedarf als nicht anklickbarer Code. Ein Folgeauftrag wie „Zeige Tab 123 in Firefox“ aktiviert den bestehenden Tab und holt sein Fenster nach vorne. Anklickbare Folgeaktionen setzen eine tatsächlich unterstützende Client-Oberfläche voraus; eine Skill-Änderung allein macht Webseiten-Links nicht zu MCP-Aufrufen.

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

   Das CHOICE-Menü bietet **1: Erzeugen + Installieren** (`install.ps1`), **2: Nur Erzeugen** (`install.ps1 -GenerateOnly`), **3: Add-on im Firefox neu laden** (`install.ps1 -OpenFirefoxOnly`), **4: Deinstallieren** (`uninstall.ps1`) und **0: Beenden**. Eine Ziffer ohne Enter drücken. Nach dem Vorgang bleibt das Fenster bis zur ausdrücklichen Eingabe von **0** offen. Die PowerShell-Dateien lassen sich auch direkt aufrufen.

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

Der Inhaltsumfang ist wahlweise **alle Tabs** oder **aktiver Tab; andere Tabs einzeln auf Anfrage**. Standard ist **Sitzungsfreigabe + aktiver Tab**. Eine Inhaltsanfrage für einen anderen Tab öffnet ebenfalls die Freigabefrage, ohne den Tab zu aktivieren oder die Einstellung auf „Alle Tabs“ umzustellen. Die Frage nennt Titel und URL des angefragten Tabs.

Im Sitzungsmodus gilt eine solche Freigabe ausschließlich für **diesen Tab und genau diese URL**, mit eigenen festen 12 Stunden ab Zustimmung. Sie ist von der Freigabe für den jeweils aktiven Tab getrennt und erlaubt weder andere Tabs noch andere URLs. Ein Wechsel der URL, Entladen oder Schließen des Tabs widerruft seine Freigabe; eine Rückkehr zur vorherigen URL stellt sie nicht wieder her. Bei „Erlauben“ oder „Jedes Mal fragen“ muss jede Anfrage für einen anderen Tab einzeln bestätigt werden. „Nicht erlauben“ sperrt weiterhin sämtliche Inhaltsanfragen. Bei „Alle Tabs“ gelten die gewählten Inhaltsregeln für alle Tabs wie bisher.

**„Temporäre Freigaben zurücksetzen“** widerruft alle aktiven Sitzungs- und Tabfreigaben sofort und lehnt eine offene Freigabefrage ab. Die gewählten Inhaltsregeln bleiben erhalten; die nächste Anfrage fragt entsprechend diesen Regeln erneut.

Diese Regeln betreffen das Lesen und Exportieren der Seite; das Auflisten von Tab-Metadaten und die ausdrücklich angeforderte Tabsteuerung bleiben bei aktivem MCP möglich. Entladene Tabs werden durch Inhaltslesen oder Exportieren nicht aufgeweckt.

## Werkzeuge

Alle 26 Werkzeugnamen haben das Präfix `firefox_`:

| Bereich | Namen ohne Präfix |
| --- | --- |
| Status und Übersicht | `status`, `get_current`, `list_windows`, `list_tabs`, `get_tabs` |
| Installierte Erweiterungen | `list_extensions` |
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

## Seiten als PNG, einzelne HTML-Datei oder PDF speichern

Die drei Exportwerkzeuge verwenden dieselben Inhaltsfreigaben wie `read_content`. Die Tab-ID zunächst über `firefox_get_current` oder `firefox_list_tabs` ermitteln. PNG und HTML werden im Dateisystem des Rechners gespeichert, auf dem der lokale MCP-Server läuft. Dafür einen vollständigen absoluten Zielpfad in einem vorhandenen Ordner angeben. Vorhandene Dateien werden nicht überschrieben. Ein Export über **128 MiB** schlägt fehl, statt unbemerkt gekürzt zu werden; eine unvollständige neu angelegte Datei wird bei einem Fehler entfernt.

```javascript
firefox_save_png({tabId: 123, path: "C:\\Exports\\seite.png"})
firefox_save_png({tabId: 123, path: "C:\\Exports\\ausschnitt.png", fullPage: false})
firefox_save_html({tabId: 123, path: "C:\\Exports\\seite.html"})
firefox_save_pdf({tabId: 123})
```

**PNG:** Standardmäßig wird die gesamte Seite von oben bis unten in der aktuellen Breite des Tabs aufgenommen. `fullPage:false` nimmt nur den sichtbaren Ausschnitt auf. Die Aufnahme verwendet einen Bildpixel je CSS-Pixel. `loadDeferred:true` ist Standard: Ein Scroll-Durchlauf von höchstens 20 Sekunden beziehungsweise 150 Schritten versucht zuerst, nachgeladene Inhalte zu laden, und stellt anschließend die vorherige Scrollposition wieder her. Die Seite kann dabei eigene Nachladeaktionen ausführen. Mit `loadDeferred:false` wird dieser Durchlauf ausgelassen. `maxHeight` begrenzt die Aufnahme auf standardmäßig **30.000 CSS-Pixel**; bis **100.000** sind ausdrücklich einstellbar. Zusätzlich gelten technische Bildgrenzen von **32.760 Pixeln je Kante** und **100 Millionen Bildpunkten**. Bei Überschreitung meldet das Werkzeug einen Fehler. Endlos nachladende Seiten, virtuelle Listen und eigene Scrollbereiche können nicht vollständig garantiert werden; die Antwort meldet entsprechende Einschränkungen unter `warnings`.

**Eine HTML-Datei:** Die Erweiterung enthält eine fest mitgelieferte Version von **SingleFile Core 1.6.19** einschließlich Quellcode und Lizenz; zur Aufnahme wird kein externer Speicherdienst aufgerufen. Gespeichert wird der aktuelle, bereits durch JavaScript aufgebaute DOM-Zustand; unterstützte CSS-, Bild- und Schriftressourcen werden in die Datei eingebettet. Zugängliche Canvas-Inhalte, Shadow DOM und Frames werden soweit möglich übernommen. JavaScript, Ereignishandler und `javascript:`-URLs werden auch aus eingebetteten Dokumenten und Templates entfernt. Eine CSP in der Kopie sperrt Skriptausführung und weitere Ressourcenabrufe. CSS-Animationen werden auf ihren aktuellen Zustand eingefroren; Medien erhalten eine statische Darstellung.

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

In `install.cmd` die **4** wählen oder `uninstall.ps1` ausführen. Das funktioniert auch aus einer neu heruntergeladenen Kopie, etwa im Downloadordner, wenn der ursprüngliche Projektordner bereits gelöscht wurde. Eine erneute Installation ist dafür nicht erforderlich; das Entfernen der Native-Host-Registrierung und der zugehörigen lokalen Dateien benötigt weder Node noch npm.

Das Skript ermittelt die frühere Installation aus der benutzerspezifischen Native-Messaging-Registrierung `de.codex.firefox_bridge`. Es entfernt diesen Eintrag auch bei fehlendem ursprünglichem Ordner. Ist der registrierte Pfad erkennbar, beendet es eindeutig dieser Installation zugeordnete Brücken-/MCP-Prozesse und entfernt deren bekannte erzeugte Dateien in `.local`, soweit noch vorhanden. Der Speicherort der neuen Downloadkopie muss damit nicht übereinstimmen.

Ohne Registrierung werden nur die erzeugten Dateien der aufgerufenen Projektkopie bereinigt, etwa nach „Nur Erzeugen“. Bei einem nicht erkennbaren registrierten Pfad wird ausschließlich der Anwendungseintrag entfernt. Quellcode, Abhängigkeiten einschließlich `.runtime/node`, unbekannte Dateien und die Registrierungen anderer Anwendungen bleiben erhalten. Wiederholtes Deinstallieren ist möglich. `uninstall.ps1 -WhatIf` zeigt die vorgesehenen Schritte ohne Änderungen an.

Wenn eine passende Node-Runtime und die Parserpakete in der aktuellen oder ursprünglichen Projektkopie verfügbar sind, entfernt das Skript zusätzlich eindeutig zu dieser Installation gehörende, unveränderte Firefox-MCP-Einträge der erkannten KI-Clients. Fremde und nachträglich geänderte Einträge bleiben erhalten. Fehlen Runtime oder Pakete nach dem Löschen des ursprünglichen Ordners, wird die Native-Host-Deinstallation trotzdem abgeschlossen; der Installer weist auf manuell zu entfernende Client-Einträge hin. Dafür wird nichts heruntergeladen. `-WhatIf` verändert auch die Client-Konfigurationen nicht.

Das Firefox-Add-on unter `about:addons` separat entfernen. Eventuell übersprungene Client-Einträge anhand der obigen Tabelle prüfen und die betroffenen KI-Apps neu starten. Sicherungskopien werden nicht automatisch zurückgespielt, da dies spätere Änderungen anderer Einstellungen verlieren könnte. Anschließend kann der Projektordner bei Bedarf entfernt werden.

## TODO / MAYBE

Die Bereitstellung bleibt vorerst bei GitHub. Ein Upload zu Mozilla beziehungsweise eine Veröffentlichung im Add-on-Katalog ist derzeit nicht vorgesehen.

- [ ] Optional eine von Mozilla signierte XPI für die dauerhafte Add-on-Installation anbieten, öffentlich gelistet oder zur eigenen Verteilung. Bis zu einer ausdrücklichen Entscheidung bleibt dies eine Idee.
- [ ] Optional eine geführte Einrichtung der KI-Apps im Add-on anbieten. Die Registrierung würde der separat installierte lokale Helfer ausführen; die erstmalige Installation dieses Helfers bleibt erforderlich.
