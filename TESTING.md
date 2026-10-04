# Prüfstand vom 4. Oktober 2026

## Warten auf Seitenzustände mit `firefox_wait_for`

Das 26. MCP-Werkzeug `firefox_wait_for` wartet auf die UND-Verknüpfung von exakter kanonisierter URL, Firefox-Ladestatus und gewählten Hauptdokument-Bedingungen für sichtbare Selektortreffer, Bilder und Schriften. Metadatenbedingungen benötigen keine Inhaltsfreigabe; DOM-Bedingungen warten zunächst auf Tabstatus `complete` und verwenden dann die bestehenden Inhaltsregeln. Die gesamte Frist einschließlich Freigabe beträgt standardmäßig 10000 ms und ist von 1 bis 120000 ms einstellbar. Native Host und MCP-Client geben dieser Frist 5 beziehungsweise 10 Sekunden zusätzlichen Transportpuffer; Abbruch beendet die Warteschleife und eine zugehörige offene Inhaltsabfrage.

Der abschließende vollständige Node-Lauf mit `--test-concurrency=2` bestand mit **236 erfolgreichen Tests, 0 Fehlern und 1 bestehenden ACL-Skip** (237 insgesamt). Die Syntax von **97 JavaScript-Dateien** und die Manifestkonsistenz wurden erfolgreich geprüft. Mozilla `web-ext lint` meldete **0 Fehler, 0 Hinweise und die bestehenden 19 Warnungen** zu Android und mitgeliefertem SingleFile-Code. `git diff --check` war sauber.

Der zusätzliche isolierte Headless-Lauf mit **Firefox 157.0** bestand mit **31 Prüfungen**. Er prüfte eine zunächst abweichende URL, verzögerte Sichtbarkeit unter mehreren Selektortreffern, sichtbare Elemente außerhalb des Bildausschnitts ohne Scrollen, erfolgreiche und kaputte Bilder, angeforderte und ungenutzte Schriften sowie die UND-Verknüpfung aller Bedingungen. Die lokale HTTP-Testseite verzögerte Bild- und Schriftantworten um 300 ms; die Schrift wurde als `FontFace` aus der lokalen Arial-Datei angefordert. Ungültige CSS-Selektoren, `PAGE_CHANGED` nach Neuladen, `WAIT_TIMEOUT`, Abbruch über `AbortSignal` und das Freigeben des offenen Approval-Slots nach Abbruch oder Timeout funktionierten.

Die produktiven Inhaltsregeln wurden auch mit verweigertem DOM-Zugriff, erlaubtem reinem Metadatenzugriff trotz Sperre und einer Freigabe für den anderen Tab ohne Aktivierung geprüft. Freigabeantworten kamen dabei von einem Testadapter; ein echtes Freigabepopup und die vollständige MCP-Abbruchstrecke wurden in diesem Browserlauf nicht bedient. Letztere sind Teil der automatisierten Node-Prüfungen. Das Benutzerprofil und der Native Host wurden nicht verwendet. Wiederholbar mit `npm run test:firefox-wait`; Report und Browserlog liegen unter `work/wait-firefox-65e06cc8-3a04-46b0-adaa-eb4ec93663ae/`.

## Codex-Registrierung bei gemischten Zeilenumbrüchen

Die Installationswarnung „Der verwaltete TOML-Block ist unvollstaendig“ entstand bei einer vollständigen, korrekt registrierten Firefox-Konfiguration mit LF-Zeilenumbrüchen im eigenen Block und CRLF-Zeilenumbrüchen in anderen Teilen der Datei. Der Installer suchte den Abschlussmarker mit dem global erkannten Zeilenumbruch. Er erkennt die Marker jetzt unabhängig davon und akzeptiert den Abschlussmarker auch am Dateiende ohne folgenden Zeilenumbruch. Prüfsumme und erwarteter Blockinhalt bleiben strikt geprüft; fremde oder geänderte Einträge werden weiterhin nicht übernommen.

Die **50 relevanten Konfigurations-, Installer- und Deinstallationstests** bestanden mit **0 Fehlern und 1 übersprungenen Test** (51 insgesamt). Der bestehende Skip betrifft Windows-ACL-Operationen, deren ausdrücklich blockierter Zustand in dieser Umgebung nicht vorliegt. Neue Regressionstests decken gemischte externe Zeilenumbrüche, unabhängig geänderte Markerzeilen, den Abschlussmarker am Dateiende, tatsächliche Präfixseparatoren, Erhalt fremder Folgetabellen sowie unveränderte Konflikterkennung bei manipuliertem Inhalt, Hash, Argumenten und Markern ab. Beim Entfernen bleibt bei später angehängten Einstellungen ein benötigter Zeilentrenner erhalten; ohne solche Ergänzungen gilt weiterhin der exakte ursprüngliche Roundtrip.

Ein **schreibfreier Probelauf mit der tatsächlichen Benutzerkonfiguration** meldete für Codex „unveraendert – Bereits passend registriert“ und endete mit Fehlercode **0**. Die Benutzerdateien wurden nicht geändert. Die folgenden Abschnitte dokumentieren frühere Prüfstände.

# Prüfstand vom 3. Oktober 2026

## Tabsuche nach Titel und URL

`firefox_list_tabs` unterstützt jetzt `query`, `searchIn`, `matchMode` und `caseSensitive`. Die Erweiterung filtert vollständige Tab-Metadaten vor Sortierung, Pagination und Antwortkürzung; nur Treffer werden übertragen. RegEx-Matching läuft in einem kurzlebigen Worker mit einer Sekunde Zeitlimit. Die Syntaxprüfung erfolgt in Firefox, damit dessen RegEx-Funktionen nicht von einer abweichenden Node-Version eingeschränkt werden.

Der vollständige Lauf mit Node **22.23.2** bestand mit **208 erfolgreichen Tests, 0 Fehlern und 1 übersprungenen Test** (209 insgesamt). Übersprungen wurde der bestehende Test für ausdrücklich blockierte Windows-ACL-Operationen, weil die Operationen in dieser Umgebung verfügbar sind. Die neuen Tests decken Teilsuche/RegEx, Titel/URL/ODER-Verknüpfung, Groß-/Kleinschreibung, vorhandene Filter, Treffer nach der ersten Inventarseite, Trefferpagination, vollständige Rohtexte, ungültige Parameter und Muster sowie Worker-Timeout, Fehler und Aufräumen ab. Die MCP-Integration prüft die Übertragung der Suchoptionen und die Weitergabe eines Firefox-Syntaxfehlers.

Der zusätzliche Headless-Lauf mit **Firefox 157.0** bestand mit **26 Prüfungen**. Ein eigenes Profil und eine Kopie der Erweiterung unter `work/` enthielten 105 Fülltabs vor vier Treffern sowie ein zweites Fenster. Echte Titel-/URL-Suchen, Teilsuche und RegEx, Trefferpagination, Fenster- und Entladefilter funktionierten. Firefox akzeptierte auch disjunkte Alternativen mit gleichnamigen Capture-Gruppen, die Node 22 ablehnt. Der problematische Ausdruck `(a+)+$` auf 20.000 `a` mit abschließendem `!` wurde nach **1006 ms** mit `SEARCH_TIMEOUT` beendet; eine weitere RegEx-Suche bestand unmittelbar danach. Das Benutzerprofil und der Native Host wurden dafür nicht verwendet. Wiederholbar mit `npm run test:firefox-tab-search`.

Die Syntax von **94 JavaScript-Dateien** und das Manifest wurden erfolgreich geprüft. Mozilla `web-ext lint` meldete **0 Fehler, 0 Hinweise und die bereits vorhandenen 19 Warnungen** zu Android und mitgeliefertem SingleFile-Code. `git diff --check` war sauber. Die folgenden Abschnitte dokumentieren frühere Prüfstände.

# Prüfstand vom 1. Oktober 2026

## Seitenexport als PNG, HTML und PDF

Die neuen MCP-Werkzeuge heißen `firefox_save_png`, `firefox_save_html` und `firefox_save_pdf`. PNG/HTML verwenden eine begrenzte Übertragung in Teilstücken statt einer auf die Native-Messaging-Paketgröße gekürzten Datei. Der lokale MCP-Server schreibt ausschließlich neue Dateien an den angegebenen absoluten Pfad. Die bisherigen Inhaltsfreigaben gelten auch für Exporte.

Der vollständige automatisierte Lauf für Version **0.1.3** bestand mit **197 erfolgreichen Tests, 0 Fehlern und 1 übersprungenen Test** (198 insgesamt). Übersprungen wurde ausschließlich der bereits vorhandene Test für ausdrücklich blockierte Windows-ACL-Operationen: Diese Operationen sind in dieser Umgebung verfügbar, sodass der geprüfte Fehlerzustand nicht vorliegt. Die Exportprüfungen decken unter anderem unveränderte vollständige Dateibytes über mehrere Native-Messaging-Pakete, Größen- und Pfadgrenzen, Vermeiden von Überschreiben, Entfernen unvollständiger Dateien, Freigabewiderruf einschließlich der letzten Fensterprüfung vor dem PDF-Aufruf, abgelaufene Transfers und Abbruchsignale ab.

`node scripts/check.mjs` prüfte die Syntax aller **90 JavaScript-Dateien** und die Manifestkonsistenz erfolgreich. `git diff --check` meldete keine Fehler. Mozilla `web-ext lint` meldete **0 Fehler, 0 Hinweise und 19 Warnungen**: eine bereits vorhandene Android-Mindestversionswarnung sowie 18 Warnungen zu mitgeliefertem SingleFile-Upstreamcode, unter anderem in deaktivierten Kompressions-, Infobar- und Noscript-Pfaden und abgesicherten `chrome`-API-Zugriffen. Desktop-Firefox bleibt die unterstützte Plattform.

Ein zusätzlicher echter Browserlauf mit **Firefox 157** im Headless-Modus bestand. Dafür wurden ausschließlich ein getrenntes Profil und eine Testkopie der Erweiterung unter `work/` verwendet. Die PNG-Aufnahme hatte **1349 × 3339 Pixel**, enthielt den Seiteninhalt unterhalb des sichtbaren Ausschnitts und stellte die vorherige Scrollposition **y=500** sowie vorübergehend veränderte Inline-Stile wieder her. Der HTML-Export erhielt den bereits gerenderten DOM-Zustand, den aktuellen Formularwert, CSS, Bilder einschließlich eines nachgeladenen Bildes, Canvas-Inhalt, einen zugänglichen Iframe und einen in einen normalen Link umgewandelten JS-Verweis. Beim erneuten Laden der gespeicherten HTML-Datei waren **0 ausführbare Seitenskripte** vorhanden; weitere Anfragen für externe Ressourcen wurden nicht beobachtet.

Der optionale Browserlauf lässt sich getrennt mit `npm run test:firefox-exports` wiederholen. Er benötigt Firefox und die Entwicklungsabhängigkeit `web-ext`, erstellt ein eigenes Testprofil unter `work/` und verwendet das normale Benutzerprofil nicht. Er öffnet keinen PDF-Speicherdialog und ist nicht Bestandteil des gewöhnlichen `npm test`-Laufs.

Die **sieben gezielten PDF-Tests** bestanden mit kontrollierten Firefox-API-Antworten. Geprüft wurden Speichern, Ersetzen und Abbrechen; fehlende oder fehlschlagende PDF-API; nicht ausgewählter Tab, falsches/anderes Fenster, geänderte URL und entladener Tab; Widerruf beziehungsweise Ablauf während asynchroner Prüfungen; sowie Navigation, Neuladen, Entladen oder Schließen während des Speicherdialogs einschließlich Aufräumen der Ereignislistener. Es wurde dabei keine echte PDF und kein echter Speicherdialog geöffnet. Der native PDF-Pfad verwendet die tatsächliche Firefox-API `tabs.saveAsPDF({})`, keine aus einem Screenshot erzeugte Raster-PDF.

Für einen manuellen Test nach dem Neuladen des Add-ons und Neustart der MCP-Verbindung eine eigene lokale HTTP-Testseite mit weiter unten liegenden Bildern, CSS, einfachem JS-Link und einer Druck-CSS-Regel öffnen. PNG bei unveränderter Fensterbreite über die gesamte Höhe und als sichtbaren Ausschnitt speichern. HTML bei getrenntem Netz öffnen: Darstellung, eingebettete Ressourcen und normale/umgewandelte Links prüfen; Skripte dürfen nicht erneut laufen. PDF im ausgewählten Tab des zuletzt aktiven normalen Fensters speichern und abbrechen; Druck-CSS darf die PDF-Darstellung verändern. Anschließend bei PNG/HTML einen bestehenden Dateinamen und einen nicht vorhandenen Zielordner prüfen sowie während einer Aufnahme die Inhaltsfreigabe zurücksetzen. Die folgenden Abschnitte dokumentieren vorherige Prüfstände.

## Menüpunkt zum erneuten Laden des Add-ons

`install.cmd` bietet jetzt **3: Add-on im Firefox neu laden** und **4: Deinstallieren**. Der zugehörige Aufruf `install.ps1 -OpenFirefoxOnly` öffnet die Debugging-Seite und zeigt den Manifestpfad sowie den Hinweis auf **Neu laden** an. Er erfolgt vor der Node-Erkennung und führt weder npm noch Native-Host- oder KI-Client-Einrichtung aus.

Die **14 gezielten CMD-/Installer-Tests** bestanden mit echtem `cmd.exe` und Windows PowerShell **5.1**. Geprüft wurden die neue Menüzuordnung, Fehlercodeweitergabe und die weiterhin ausdrückliche Eingabe von **0** zum Schließen. Der Direktaufruf funktioniert auch mit ungültigem Node-Pfad und absichtlich fehlschlagenden Installationshelfern; diese werden nicht aufgerufen. Fehlendes Firefox und Startfehler liefern für diesen eigenständigen Menüpunkt Fehlercode `1` samt manueller Adresse und Manifestpfad. Browsererkennung und Prozessstart wurden ersetzt; es wurde kein echtes Firefox-Fenster geöffnet. Die folgenden Abschnitte dokumentieren die vorherigen Prüfstände.

## Einzelne Tabfreigaben und sofortiger Widerruf

In `C:\DevApps.git\Firefox MCP-Server` öffnen Inhaltsanfragen für andere geladene Tabs jetzt direkt die vorhandene Toolbar-Freigabe. Im Sitzungsmodus gelten diese Freigaben für genau einen Tab und seine URL mit eigener fester Zwölfstundenfrist. Aktive Sitzungsfreigaben bleiben davon getrennt. Bei „Erlauben“ und „Jedes Mal fragen“ wird ein anderer Tab für jede Anfrage einzeln freigegeben; „Nicht erlauben“ und deaktiviertes MCP bleiben Sperren.

Der neue Knopf **„Temporäre Freigaben zurücksetzen“** widerruft sämtliche Sitzungs- und Tabfreigaben sofort und lehnt offene Freigabeanfragen ab. Laufende Leseanfragen prüfen den Widerruf vor der Inhaltsausgabe erneut. Tests decken außerdem Navigation weg und zurück, Tabwechsel, Entladen und Schließen, getrennte Tab-IDs bei gleicher URL, feste Ablaufzeiten sowie einen Reset unmittelbar nach einer asynchronen Berechtigungsprüfung ab.

Der abschließende vollständige Lauf mit Node **22.23.2** bestand mit **156 erfolgreichen Tests, 0 Fehlern und 1 übersprungenen Test** (157 insgesamt). Übersprungen wurde ausschließlich der Test für ausdrücklich blockierte Windows-ACL-Operationen, weil diese Operationen in dieser Umgebung verfügbar sind. `TEMP` und `TMP` wurden nur für die Testprozesse auf ein Arbeitsverzeichnis gesetzt; die Installer-/Deinstallationstests arbeiten weiterhin mit isolierten Testverzeichnissen und ersetzten Registrierungsgrenzen.

`node scripts/check.mjs` prüfte die Syntax aller **29 JavaScript-Dateien** und das Manifest erfolgreich; `git diff --check` meldete keine Fehler. Mozilla `web-ext lint` konnte in dieser Projektinstallation nicht ausgeführt werden, weil die Entwicklungsabhängigkeit `web-ext` fehlt. Es wurden keine Abhängigkeiten nachinstalliert. Die laufende Benutzer-Erweiterung wurde weder neu geladen noch mit den Änderungen live getestet; zum Aktivieren ist das Add-on neu zu laden. Die folgenden Abschnitte dokumentieren frühere Prüfstände.

## Toolbar-Freigabe in Version 0.1.2

Die Inhaltsfreigabe verwendet jetzt das vorhandene Add-on-Popup. Neue Tests prüfen das Aktivieren des zuletzt aktiven normalen Fensters, Wiederherstellen minimierter Fenster, den Verzicht auf Tabwechsel und zusätzliche Fenster sowie die manuelle Antwort bei fehlgeschlagenem automatischem Öffnen. Der produktive Berechtigungsprüfer wird dabei mit kontrollierten Browser-API-Antworten verwendet.

Weitere Prüfungen decken die feste Zweiminutenfrist, Schließen und Wiederöffnen, abgelaufene und doppelte Antworten, Absender- und Anfrage-ID-Prüfung, parallele Anfragen, Abbruch bei Verbindungs-/Einstellungsänderungen und verspätete Popup-Aufrufe ab. Die Frontendtests prüfen Textdarstellung, Geltungsbereich, deaktivierte Schaltflächen und überholte Statusantworten; auch eine zwischen Speichern und Statusabfrage mögliche Rückkehr zu alten Einstellungen ist abgesichert.

Die Änderung wurde mit Genehmigung direkt in `S:\Develop\firefox-codex-mcp` übernommen. Das laufende Benutzer-Add-on muss zum Aktivieren neu geladen werden. Der neue Popup-Anker und das Verhalten auf mehreren echten Monitoren wurden in diesem Durchlauf noch nicht am laufenden Firefox überprüft; die unten beschriebenen früheren Firefox-Tests beziehen sich auf den damaligen Stand mit eigenem Freigabefenster.

## Automatisierte Tests

`node --test test/*.test.mjs`: **131 bestanden, 0 fehlgeschlagen, 2 übersprungen** (133 insgesamt). Ein Test benötigt hier gesperrte CIM-Prozessabfragen. Der zweite prüft ausdrücklich blockierte Windows-ACL-Operationen; dieser Fehlerzustand lag im Hauptlauf nicht vor. Im getrennten eingeschränkten Prüflauf wurde der sichere Abbruch bei blockierten ACL-Operationen erfolgreich geprüft. Für den aktuellen vollständigen Lauf wurden `TEMP` und `TMP` nur im Testprozess auf ein Testverzeichnis im freigegebenen Workspace gesetzt; der erste Versuch scheiterte bei PowerShell-Testdateien im nicht zugänglichen Standard-Temp-Pfad.

Abgedeckt sind Firefox-Zustände und Metadaten, native Gruppen mit großen IDs, Inhaltsbegrenzung, die vier Inhaltsregeln, aktiver Tab, Navigation während der Freigabe, feste zwölfstündige Sitzungsfreigaben, Widerruf und Abbruch laufender Stapel. Die Zeitgrenzen werden mit einer kontrollierten Uhr geprüft, ohne zwölf Stunden zu warten. Hinzu kommen die Erweiterungsliste mit Statusfiltern und Pagination sowie Anfordern, Ablehnen, Widerrufen und externe Änderungen der optionalen Datenfreigabe im Symbolleistenmenü.

Zusätzlich geprüft: echte MCP-SDK-Verbindungen über Standard-Ein-/Ausgabe mit beiden unterstützten Protokollvarianten, Abbruchsignale, Offline-Verhalten, Tokenauthentifizierung, Schutz der lokalen HTTP-Verbindung, Nachrichtengrößen, Parallelität und idempotente Setup-Erzeugung mit Windows-Dateirechten.

## Windows-Installationsmenü

Die Zuordnung der CHOICE-Auswahl und die Weitergabe von Fehlercodes werden geprüft. `install.ps1` wurde mit tatsächlichem Windows PowerShell **5.1** und Node aus einem Testpfad mit Leerzeichen und Apostroph ausgeführt: Registrierung anfordern, `-GenerateOnly` mit Port und Abbruch bei fehlgeschlagener Paketinstallation. npm und die anschließende Registrierung wurden dabei durch protokollierende Testskripte ersetzt; es wurde nichts installiert.

Der Firefox-Aufruf nach erfolgreicher Installation wird mit aufgezeichneten Startargumenten geprüft. Bei `-GenerateOnly`, `-NoOpenFirefox` und fehlgeschlagener Installation erfolgt kein Aufruf. Fehlendes Firefox und Startfehler lassen die abgeschlossene Installation erfolgreich und zeigen Adresse und vollständigen Manifestpfad zur manuellen Einrichtung. Browsererkennung und Prozessstart sind in diesen Tests ersetzt; dabei wird kein echtes Browserfenster geöffnet.

Echte `cmd.exe`-Tests mit harmlosen PowerShell-Testskripten prüfen alle drei Menüaktionen, fehlendes PowerShell, Fehlercodes und die Abschlussanzeige. Die gemeldete Ursache des sofortigen Schließens ist reproduziert: Ein Enter nach der Menüziffer wurde vom späteren `pause` verbraucht. Der neue Abschluss mit `CHOICE /C 0` bleibt trotz dieses Enter offen. Pfade mit Leerzeichen, Apostroph und Ausrufezeichen sowie aktivierte verzögerte CMD-Expansion sind abgedeckt.

Vier isolierte Runtime-Tests prüfen Wiederverwendung ohne globales Node/npm, offiziellen versionsgebundenen Download, SHA256-Abgleich, abgelehnte beschädigte Downloads, `-NoDownload` und den Erhalt unbekannter vorhandener Dateien. Netzwerk und Versionsproben werden dabei gezielt ersetzt.

Vor der Erweiterung um automatische KI-Client-Einträge wurde der tatsächliche Installer unter Windows PowerShell **5.1** mit dem normalen Windows-Pfad ohne vorhandenes Node/npm erfolgreich ausgeführt: Node **24.21.0** und npm **11.19.0** wurden nach Prüfung des offiziellen Downloads im Projekt eingerichtet, die damals 14 Laufzeitpakete installiert und der Firefox Native Host registriert. Die systemweite Node-Installation und der dauerhafte Windows-Pfad wurden nicht verändert.

Die Deinstallation wurde in getrennten Testverzeichnissen geprüft: eigene erzeugte Dateien entfernen, unbekannte Dateien erhalten, Wiederholung, `-WhatIf` und Ablehnen von Verknüpfungen. Registrierungszugriffe und Prozesslisten waren in diesen Tests ersetzt. Ein zusätzlich selbst gestarteter, harmloser Node-Testprozess wurde mit tatsächlicher Prozesszuordnung und dem auf Mikrosekunden angepassten Erstellungszeitvergleich beendet. Die echte Deinstallation im Benutzerprofil wurde nicht ausgeführt.

Zusätzliche Tests prüfen die Deinstallation aus einer frischen Downloadkopie: gelöschter ursprünglicher Ordner, noch vorhandene Installation an anderer Stelle, fehlendes altes Laufwerk, unveränderte Dateien der neuen Kopie und eindeutig der alten Installation zugeordnete Prozesse. Ohne Registrierung wird die lokale „Nur Erzeugen“-Konfiguration bereinigt. Nicht erkennbare Manifestpfade und fehlerhafte Registrywert-Typen führen nur zum Entfernen des festen Anwendungseintrags. Eine zwischenzeitlich geänderte Registrierung bleibt erhalten; diese Zugriffe werden einschließlich der produktiven Löschfunktion mit ersetzten Registry-Grenzen getestet.

## Automatische KI-Client-Einrichtung

Neue isolierte Prüfungen decken die Client-Erkennung und Pfadüberschreibungen, JSON/JSON5, YAML und den verwalteten Codex-TOML-Block ab. Geprüft werden insbesondere vorhandene andere Server, Kommentare, wiederholtes Installieren, Entfernen und erneutes Installieren, fremde oder nachträglich geänderte Firefox-Einträge, ungültige Eingaben, nicht ausführbare Konfigurationsverarbeitung, mehrdeutige Profile sowie Verknüpfungen und Dateischutz. Parserfehler geben keine Konfigurationszeilen oder Zugangsdaten aus.

Windows-PowerShell-Tests prüfen zusätzlich die Reihenfolge Native Host → KI-Clients → Firefox, `-GenerateOnly`, `-NoRegisterClients`, Abbruch vor der Client-Einrichtung bei Native-Host-Fehlern und den Teilfehlercode `2`. Die Deinstallation wird auch mit einem alten Installationspfad, anderer Node-Runtime, fehlenden Parserpaketen, `-WhatIf` und Fehlern bei der optionalen Client-Erkennung geprüft. Diese Tests verwenden ausschließlich Testverzeichnisse und ersetzte Registry-/Browsergrenzen.

Ein **schreibfreier Probelauf** mit dem tatsächlichen Benutzerprofil und dem Projektpfad `S:\Develop\firefox-codex-mcp` erkannte passende Konfigurationen von **Codex, Claude Code und LM Studio**. Für alle drei würde ein neuer Firefox-Eintrag ergänzt. Es wurden dabei keine Benutzerkonfigurationen geändert und keine realen Client-Neustarts oder Verbindungen über diese neu einzurichtenden Einträge getestet.

Der Hauptlauf bestätigte im isolierten Windows-Test das tatsächliche Schreiben mit Sicherung, unveränderten übrigen Einstellungen, Wiederholung ohne doppelte Einträge und Entfernen des eigenen Eintrags. Ein separater Prüflauf mit PowerShell im eingeschränkten Sprachmodus bestätigte den anderen Fall: Bei nicht erlaubtem Setzen von Dateirechten bricht der Registrar vor dem Schreiben von Konfigurationsinhalten ab, erhält das Original und entfernt seine leeren Arbeitsdateien.

Beim damaligen Durchlauf zur KI-Client-Einrichtung waren Änderungen am Projekt auf `S:` gesperrt. Die Client-Erweiterung wurde deshalb zunächst als getestete Quellkopie und Paket unter `outputs` bereitgestellt und anschließend vom Benutzer installiert. Für die aktuelle Popup-Änderung wurde Schreibzugriff auf das Projekt erteilt. Windows-CIM-Prozessabfragen bleiben im aktuellen Hauptlauf gesperrt; der dazugehörige frühere Deinstallationstest wird nur bei der konkreten Zugriffsverweigerung `0x80041003` übersprungen. Andere Fehler werden weiterhin als Testfehler behandelt.

Die bereits vorhandenen, in der Lockdatei festgelegten Parser `acorn` und `js-yaml` sind jetzt Laufzeitabhängigkeiten. Dafür wurden keine neuen Pakete aus dem Netz geladen. Das Abhängigkeitsdiagramm wurde lokal geprüft; eine neue Installation per `npm ci` im echten Benutzerprojekt wurde in diesem Durchlauf nicht ausgeführt.

## Firefox auf Windows

Die ursprünglichen **21 MCP-Werkzeuge** wurden über die vollständige Verbindung getestet: MCP-Client → MCP-Server → lokale Brücke → Firefox Native Messaging → Erweiterung. Der laufende Firefox meldete im ersten Durchlauf Version **157.0**. Für die Tests wurden ausschließlich neu erzeugte, getrennte Firefox-Profile und lokale Testseiten verwendet.

Erfolgreich waren Fenster-/Tabübersicht, neue Tabs, Zeitmetadaten, Text/HTML/Links, Kürzung und aktiver Tab, Audio-Stummschaltung, Anheften, native Gruppen anlegen/ändern/auflösen, Gruppen und Tabs zwischen Fenstern verschieben, Fenster steuern/schließen, entladen, explizit neuladen und Tabs schließen. Nur für diesen Befehlsdurchlauf wurde in einer Testkopie die Inhaltsregel auf „Erlauben“ gesetzt.

Ein zweiter Durchlauf nutzte **unveränderte Produktionsregeln** und bediente die tatsächlichen Popup- und Freigabeseiten in einer Testkopie: **acht Prüfgruppen mit vier echten Freigabedialogen**. Geprüft wurden die Standardeinstellung, erste Sitzungsfreigabe, weitere Abfragen ohne neue Nachfrage oder Fristverlängerung, Nachfrage bei jedem Zugriff, Ablehnen, Sperren, alle/aktive Tabs, MCP ausschalten und wieder verbinden sowie die zugehörigen Statusfarben. Testhelfer sind kein Bestandteil der ausgelieferten Erweiterung.

Das hinzugefügte 22. Werkzeug `firefox_list_extensions` wurde unter Firefox **157.0** in **sechs weiteren Prüfgruppen** getestet: verweigerter Zugriff ohne Freigabe, tatsächliche Freigabe über das unveränderte Popup, echte `management.getAll`-Ergebnisse, Typ-/Statusfilter, Pagination und Widerruf. Das isolierte Profil enthielt eine aktive Erweiterung und vier Themes, davon drei deaktiviert. Die Berechtigungs-API wurde nicht simuliert. Nur der zusätzliche native Bestätigungsdialog war im Testprofil abgeschaltet; die erste Freigabe erfolgte durch einen vertrauenswürdigen WebDriver-Klick auf die Produktionscheckbox.

Die Testprofile waren vom normalen Firefox-Profil getrennt. Alle nur für die Tests angelegten Native-Messaging-Registrierungen wurden danach entfernt.

## Paketprüfung

JavaScript-Syntax und Manifestkonsistenz wurden geprüft. Mozilla `web-ext lint` meldet **0 Fehler** und eine Android-Kompatibilitätswarnung: Die Datenfreigabe benötigt dort Firefox 142, während das Desktop-Minimum 140 ist. Dieses Projekt ist für **Desktop-Firefox** ausgelegt; Android wird nicht unterstützt.

Die ZIP-Pakete enthalten weder lokale Tokens/Konfiguration noch `node_modules`, `.runtime` oder Testarbeitsdateien aus `work`. Die Erweiterung ist **unsigniert**. Das Laden des Firefox-Add-ons erfolgt weiterhin manuell; erkannte KI-Client-Konfigurationen werden nun vom Installer ergänzt. Tests mit den verwendeten Versionen sind keine Zusage für alle zukünftigen Firefox-/Client-Versionen.
