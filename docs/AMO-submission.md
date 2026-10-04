# AMO-Einreichung vorbereiten

Diese Unterlagen bereiten die Mozilla-Einreichung von **Codex MCP for Firefox** vor. Die aktuelle Add-on-ID bleibt `firefox-codex-mcp@local.invalid`; die Version stammt aus den bestehenden Projektdefinitionen. Die lokalen ZIP-Dateien sind unsigniert. Die hier beschriebenen Buildschritte führen keinen Upload, keine Signierung und keine Veröffentlichung aus. Für reguläre Firefox-Release-/Beta-Versionen erfolgt die Signierung über AMO, sowohl bei öffentlicher Listung als auch bei eigener, nicht gelisteter Verteilung. [Mozilla: Signierung und Verteilung](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Funktion und notwendiger lokaler Helfer

Das Add-on verbindet vorhandene Firefox-Tabs, Fenster, native Tabgruppen, Chronik, Lesezeichen, Erweiterungsinformationen und freigegebene Seiteninhalte mit einem lokalen MCP-Client. Es unterstützt ausschließlich Desktop-Firefox unter Windows, Linux und macOS. Firefox für Android wird nicht unterstützt, da dort die benötigte Native-Messaging-Anbindung für dieses Add-on nicht verfügbar ist. [Mozilla: Kompatibilitätsdaten für Native Messaging](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/runtime.json#L512-L525). Es benötigt zusätzlich einen im Benutzerkonto installierten Native-Messaging-Helfer. Die signierte Erweiterung allein ersetzt diese Betriebssystemregistrierung nicht.

Die Optionsseite `extension/setup/setup.html` öffnet in einem eigenen Firefox-Tab und stellt die mitgelieferten Registrierungsskripte zum Download bereit. Texte sind auswählbar; zwei schreibgeschützte Befehlsfelder mit Kopierbuttons zeigen die passenden Aufrufe für Registrierung und Deregistrierung mit Windows PowerShell beziehungsweise Linux/macOS mit `sh`. Manuelles Auswählen und Kopieren dient als Rückfall ohne zusätzliche Berechtigung. Der Nutzer führt die Skripte anschließend außerhalb von Firefox aus und bestätigt den Installationsordner. Die Skripte enthalten den Serverquellcode einschließlich Installationslogik und Lockdatei als gzip/base64 JSON-Archiv. Es wird keine Node-Runtime und kein `node_modules`-Verzeichnis in der Erweiterung eingebettet. Windows verwendet den bestehenden Installer mit `-NoOpenFirefox` und kann eine lokale Node-24-Runtime einrichten; Linux/macOS benötigen Node >=22 und npm und starten `scripts/install-companion.mjs` aus einem POSIX-`sh`-Skript. Netzwerkzugriff ist für eventuell benötigte Node- und npm-Downloads erforderlich. Die Skripte werden über gewöhnliche Downloadlinks zu eigenen Erweiterungsdateien gespeichert; dafür wird keine zusätzliche `downloads`-API-Berechtigung angefordert.

Die Registrierung gilt nur für den Benutzer. Standardziele sind `%LOCALAPPDATA%\FirefoxCodexMCP`, `~/.local/share/firefox-codex-mcp` und `~/Library/Application Support/FirefoxCodexMCP`. Vorhandene Installationen werden nach ausdrücklicher Auswahl/Bestätigung wiederverwendet. Die Deregistrierung entfernt eindeutig zugeordnete Native-Host- und unveränderte Client-Einträge, erhält aber Serverdateien und lokale Konfiguration. Der Native Host meldet seine Version und verfügbare Registrierungsmetadaten im internen `setup_status`-Handshake. Eine laufende Verbindung und ein vorhandener Eintrag werden getrennt angezeigt.

## Beschreibung für die spätere Listung

> Ausschließlich für Desktop-Firefox unter Windows, Linux und macOS. Firefox für Android wird nicht unterstützt, da dort die benötigte Native-Messaging-Anbindung nicht verfügbar ist.
>
> Codex MCP for Firefox verbindet Ihre vorhandenen Firefox-Tabs mit einem lokal eingerichteten MCP-Client. KI-Apps können damit Tabs, Fenster und Tabgruppen verwalten, Chronik und Lesezeichen gezielt durchsuchen und freigegebene Seiteninhalte lesen oder exportieren. Ein zusätzlicher lokaler Native-Messaging-Helfer ist erforderlich; die Einrichtungsseite stellt dafür Registrierungsskripte für Windows, Linux und macOS bereit. Die Skripte müssen außerhalb von Firefox ausgeführt werden. Inhaltszugriff ist durch die Regeln und Freigaben im Add-on begrenzt. Die Bridge sendet Werkzeugantworten an die gewählte KI-App auf demselben Rechner; diese App kann die Antworten gemäß ihren eigenen Einstellungen an externe Dienste weitergeben. Das Projekt betreibt keine Telemetrie und benötigt keinen OpenAI-API-Schlüssel.

Diese Beschreibung vor der tatsächlichen Einreichung mit dem endgültigen Paket abgleichen. Der Name folgt der Mozilla-Regel für Add-on-Namen mit Firefox-Bezug. Die Beschreibung muss den lokalen Helfer und die Datenweitergabe klar nennen. Auch Native-Messaging-Daten unterliegen Mozillas Vorgaben zur Offenlegung und Zustimmung. [Mozilla: Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).

## Berechtigungen und Datenweitergabe

Die angeforderten API-Berechtigungen entsprechen den Funktionen:

| Berechtigung | Zweck |
| --- | --- |
| `tabs`, `tabGroups` | Tab-Metadaten und ausdrücklich angeforderte Tab-/Fenster-/Gruppensteuerung |
| `sessions` | Eigene Zeitmetadaten und Wiedererkennung derselben Tab-Sitzung für individuelle Freigaben |
| `storage` | Add-on-Einstellungen und ausdrücklich gewährte, feste Freigabefristen |
| `nativeMessaging` | Verbindung zum lokal registrierten Helfer |
| `management` | Erweiterungsinformationen nach optionaler technischer Datenfreigabe |
| `history` | Vom MCP-Client angeforderte Suche nach einzelnen Chronikbesuchen |
| `bookmarks` | Suche und ausdrücklich angeforderte Lesezeichen-/Ordneränderungen |
| `<all_urls>` | Freigegebene DOM-Abfragen und Seitenexporte auf geladenen HTTP(S)-Seiten |

Das Manifest deklariert `browsingActivity`, `websiteContent` und `bookmarksInfo` als erforderliche Datenkategorien. `technicalAndInteraction` bleibt optional und steuert Erweiterungsinventar und Browser-Versionsinformationen. Die optionale Datenfreigabe wird über Firefox angefordert und kann wieder entzogen werden; die übrigen Browserfunktionen bleiben verfügbar. Die separate Inhaltsrichtlinie im Popup begrenzt tatsächlich gelesene Seiten zusätzlich. Desktop-Firefox ab 140 unterstützt die verwendete eingebaute Zustimmung. Die Datenkategorien gelten auch für Weitergabe an eine lokale Native-App; eine rein lokale Bridge rechtfertigt daher keine Deklaration `none`. [Mozilla: eingebaute Datenzustimmung und Taxonomie](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

Der Host bindet HTTP ausschließlich an Loopback und authentifiziert die lokale MCP-Verbindung. Zugangstoken und lokale Konfiguration werden erst im gewählten Installationsordner erzeugt und gehören weder ins Add-on-ZIP noch ins Quellpaket. Der Setup-Handshake liefert Registrierungsdaten ohne Token. Die Bridge selbst überträgt keine Telemetrie; für die anschließende Verarbeitung der Werkzeugantworten durch eine KI-App gelten deren Einstellungen und Dienste.

## Quellpaket und nachvollziehbarer Build

Mozilla benötigt bei gebündelten oder anderweitig erzeugten Dateien passende lesbare Quellen und Buildanweisungen. Das Quellpaket enthält Projektquellen, Lockdatei, Generatoren sowie die vendorten Quellen und Lizenzen; es enthält keine Benutzerkonfiguration, Tokens, installierten npm-Abhängigkeiten oder lokale Runtime. Der Reviewer muss den erzeugten Code mit dem eingereichten Paket vergleichen können. [Mozilla: Source Code Submission](https://extensionworkshop.com/documentation/publish/source-code-submission/).

Voraussetzungen für den Build: Node >=22, npm sowie Zugriff auf die in `package-lock.json` angegebenen öffentlichen npm-Pakete. Das konkrete Betriebssystem, die Node-/npm-Version und die finalen Prüfergebnisse vor der Einreichung zusammen mit dem Release festhalten. Die Befehle werden im entpackten Quellpaket ausgeführt:

```sh
npm ci
npm run build:html-vendor
node scripts/build-setup-downloads.mjs
npm run check
npm test
npm run package
```

`scripts/build-html-vendor.mjs` erzeugt `extension/vendor/single-file.bundle.js` aus den unveränderten Originalquellen unter `vendor/single-file-core/` mit der in der Lockdatei festgelegten esbuild-Version. Nachvollziehbare Buildtransformationen entfernen nicht unterstützte Kompressions-/ZIP-Worker, Infobar, Noscript-Wiederherstellung und den Chromium-spezifischen DOM-Zweig. Nicht unterstützte Upstream-Optionen werden abgewiesen. `loadOptionsFromPage` ist deaktiviert, damit eine Webseite die festen Exportoptionen nicht überschreiben kann. Die unterstützten DOM-, CSS-, Ressourcen-, Canvas-, Shadow-DOM- und Frame-Aufnahmen bleiben Bestandteil des Bundles. Der Build verändert die Originalquellen nicht; Bundle und Transformationen lassen sich aus dem Quellpaket deterministisch erneut erzeugen.

`scripts/build-setup-downloads.mjs` erzeugt die selbständigen Einrichtungsskripte aus dem Server-/Installerquellstand. Die Paketierung baut das SingleFile-Bundle und die Einrichtungsskripte vor jedem Paket neu und erzeugt Standard-ZIP-Dateien mit Deflate-Kompression. Resultate:

| Datei | Inhalt |
| --- | --- |
| `dist/firefox-codex-mcp-extension.zip` | Erweiterung mit Manifest an der ZIP-Wurzel, Optionsseite, Einrichtungsskripten und SingleFile-Bundle einschließlich vollständiger Lizenz und Herkunftshinweis; unsigniert |
| `dist/firefox-codex-mcp-source.zip` | Vollständiger Quellstand einschließlich unveränderter Originalquellen unter `vendor/single-file-core/`, Lockdatei und nachvollziehbaren Generatoren für denselben Add-on-Build |

Bei einer AMO-Einreichung das separate Quell-ZIP für Reviewer bereitstellen. Beim Vergleich sind die entpackten Inhalte maßgeblich. Das Ausführen des Buildprozesses registriert den Native Host nicht im Benutzerkonto. Installationsskripte für Funktionstests werden separat und bewusst ausgeführt.

## Mitgelieferte Bibliotheken und Lizenzen

Die vollständigen, unveränderten Originalquellen von SingleFile Core **1.6.19** einschließlich ihrer **AGPL-3.0-or-later**-Lizenz liegen unter `vendor/single-file-core/` im Quellpaket. Das Add-on enthält das lokal daraus erzeugte Bundle, die vollständige Lizenz als `extension/vendor/single-file-LICENSE.txt` und `extension/vendor/NOTICE.txt`; der Buildbanner nennt Version, Herkunft und Lizenz. Als feste Upstream-Referenz dient der [SingleFile-Core-Release v1.6.19](https://github.com/gildas-lormeau/single-file-core/tree/v1.6.19). Die Projektlizenz steht separat in `LICENSE.md` (MPL 2.0); sie ersetzt die Lizenz mitgelieferter Bibliotheken nicht.

Für AMO die Originalquellen der verwendeten Drittbibliotheken, ihre Releaseversionen und die Buildzuordnung nennen. Die Server-Laufzeitabhängigkeiten sind in `package.json` und `package-lock.json` festgelegt und werden vom bewusst ausgeführten Installer über npm bezogen. [Mozilla: Third Party Library Usage](https://extensionworkshop.com/documentation/publish/third-party-library-usage/).

## Hinweise für Reviewer und letzte Schritte vor Upload

Der bestätigte lokale Linterlauf meldet **0 Fehler, 0 Hinweise und drei Warnungen**; Prüfungen und Grenzen stehen in `TESTING.md`. Eine Warnung betrifft die Android-Kompatibilitätsangabe: Das Add-on unterstützt ausschließlich Desktop-Firefox ab 140 und enthält daher keinen `gecko_android`-Eintrag, der Android-Unterstützung aktivieren würde. Zwei `FLAGGED_FILE_EXTENSION`-Markierungen betreffen die mitgelieferten `register.sh` und `unregister.sh`. Diese lesbaren Downloads bleiben bewusst Teil der Einrichtung, werden nicht im Add-on ausgeführt und behalten ihre Dateiendung. Die vollständigen Originalquellen, Buildtransformationen, Skriptquellen, Payload-Generatoren und Dateiprüfsummen liegen im separaten Quellpaket. Die lokale Prüfung ersetzt keine Mozilla-Freigabe.

Für einen Funktionstest ein getrenntes Firefox-Testprofil und lokale HTTP-Testseiten verwenden. Die Erweiterung kann während der Prüfung über `about:debugging#/runtime/this-firefox` temporär geladen werden. Der bestehende Entwicklerweg mit `install.cmd` bleibt verfügbar; alternativ die Optionsseite öffnen und die passende Registrierungsdatei ausführen. Installation und Deregistrierung verändern dabei die eigene Native-Host-Registrierung und gegebenenfalls erkannte MCP-Client-Konfigurationen. Es sind keine Anmeldedaten für einen Projektserver nötig.

Den Setup-Handshake und die Verbindung prüfen, anschließend den lokalen MCP-Client neu starten und `firefox_status` aufrufen. Inhalte zunächst mit den Standardregeln testen, eine Inhaltsfreigabe ablehnen und erlauben sowie die optionale technische Datenfreigabe deaktiviert und aktiviert prüfen. Die optionalen Browser-Testskripte verwenden eigene Headless-Profile; Umfang und Grenzen ihrer Tests sind in `TESTING.md` beschrieben.

Vor dem tatsächlichen Upload den endgültigen Paketstand, Version, Datenkategorien, Plattformvoraussetzungen, Originalquellen und Buildausgaben abgleichen und die bestätigten Ergebnisse aus `TESTING.md` in die Reviewer-Hinweise übernehmen. Öffentliche Listung oder nicht gelistete Signierung ist eine ausdrückliche Entscheidung des Eigentümers; diese Vorbereitung führt beides nicht aus.
