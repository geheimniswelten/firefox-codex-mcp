# Prüfstand vom 30. September 2026

## Automatisierte Tests

`node --test test/*.test.mjs`: **86 bestanden, 0 fehlgeschlagen**.

Abgedeckt sind Firefox-Zustände und Metadaten, native Gruppen mit großen IDs, Inhaltsbegrenzung, die vier Inhaltsregeln, aktiver Tab, Navigation während der Freigabe, feste zwölfstündige Sitzungsfreigaben, Widerruf und Abbruch laufender Stapel. Die Zeitgrenzen werden mit einer kontrollierten Uhr geprüft, ohne zwölf Stunden zu warten. Hinzu kommen die Erweiterungsliste mit Statusfiltern und Pagination sowie Anfordern, Ablehnen, Widerrufen und externe Änderungen der optionalen Datenfreigabe im Symbolleistenmenü.

Zusätzlich geprüft: echte MCP-SDK-Verbindungen über Standard-Ein-/Ausgabe mit beiden unterstützten Protokollvarianten, Abbruchsignale, Offline-Verhalten, Tokenauthentifizierung, Schutz der lokalen HTTP-Verbindung, Nachrichtengrößen, Parallelität und idempotente Setup-Erzeugung mit Windows-Dateirechten.

## Windows-Installationsmenü

Die Zuordnung der CHOICE-Auswahl und die Weitergabe von Fehlercodes werden geprüft. `install.ps1` wurde mit tatsächlichem Windows PowerShell **5.1** und Node aus einem Testpfad mit Leerzeichen und Apostroph ausgeführt: Registrierung anfordern, `-GenerateOnly` mit Port und Abbruch bei fehlgeschlagener Paketinstallation. npm und die anschließende Registrierung wurden dabei durch protokollierende Testskripte ersetzt; es wurde nichts installiert.

Der Firefox-Aufruf nach erfolgreicher Installation wird mit aufgezeichneten Startargumenten geprüft. Bei `-GenerateOnly`, `-NoOpenFirefox` und fehlgeschlagener Installation erfolgt kein Aufruf. Fehlendes Firefox und Startfehler lassen die abgeschlossene Installation erfolgreich und zeigen Adresse und vollständigen Manifestpfad zur manuellen Einrichtung. Browsererkennung und Prozessstart sind in diesen Tests ersetzt; dabei wird kein echtes Browserfenster geöffnet.

Echte `cmd.exe`-Tests mit harmlosen PowerShell-Testskripten prüfen alle drei Menüaktionen, fehlendes PowerShell, Fehlercodes und die Abschlussanzeige. Die gemeldete Ursache des sofortigen Schließens ist reproduziert: Ein Enter nach der Menüziffer wurde vom späteren `pause` verbraucht. Der neue Abschluss mit `CHOICE /C 0` bleibt trotz dieses Enter offen. Pfade mit Leerzeichen, Apostroph und Ausrufezeichen sowie aktivierte verzögerte CMD-Expansion sind abgedeckt.

Vier isolierte Runtime-Tests prüfen Wiederverwendung ohne globales Node/npm, offiziellen versionsgebundenen Download, SHA256-Abgleich, abgelehnte beschädigte Downloads, `-NoDownload` und den Erhalt unbekannter vorhandener Dateien. Netzwerk und Versionsproben werden dabei gezielt ersetzt.

Zusätzlich wurde der tatsächliche Installer unter Windows PowerShell **5.1** mit dem normalen Windows-Pfad ohne vorhandenes Node/npm erfolgreich ausgeführt: Node **24.21.0** und npm **11.19.0** wurden nach Prüfung des offiziellen Downloads im Projekt eingerichtet, die 14 Laufzeitpakete installiert und der Firefox Native Host registriert. Die systemweite Node-Installation und der dauerhafte Windows-Pfad wurden nicht verändert. Der vollständige Testlauf verwendet anschließend diese Projekt-Runtime.

Die Deinstallation wurde in getrennten Testverzeichnissen geprüft: eigene erzeugte Dateien entfernen, unbekannte Dateien erhalten, Wiederholung, `-WhatIf` und Ablehnen von Verknüpfungen. Registrierungszugriffe und Prozesslisten waren in diesen Tests ersetzt. Ein zusätzlich selbst gestarteter, harmloser Node-Testprozess wurde mit tatsächlicher Prozesszuordnung und dem auf Mikrosekunden angepassten Erstellungszeitvergleich beendet. Die echte Deinstallation im Benutzerprofil wurde nicht ausgeführt.

Zusätzliche Tests prüfen die Deinstallation aus einer frischen Downloadkopie: gelöschter ursprünglicher Ordner, noch vorhandene Installation an anderer Stelle, fehlendes altes Laufwerk, unveränderte Dateien der neuen Kopie und eindeutig der alten Installation zugeordnete Prozesse. Ohne Registrierung wird die lokale „Nur Erzeugen“-Konfiguration bereinigt. Nicht erkennbare Manifestpfade und fehlerhafte Registrywert-Typen führen nur zum Entfernen des festen Anwendungseintrags. Eine zwischenzeitlich geänderte Registrierung bleibt erhalten; diese Zugriffe werden einschließlich der produktiven Löschfunktion mit ersetzten Registry-Grenzen getestet.

## Firefox auf Windows

Die ursprünglichen **21 MCP-Werkzeuge** wurden über die vollständige Verbindung getestet: MCP-Client → MCP-Server → lokale Brücke → Firefox Native Messaging → Erweiterung. Der laufende Firefox meldete im ersten Durchlauf Version **157.0**. Für die Tests wurden ausschließlich neu erzeugte, getrennte Firefox-Profile und lokale Testseiten verwendet.

Erfolgreich waren Fenster-/Tabübersicht, neue Tabs, Zeitmetadaten, Text/HTML/Links, Kürzung und aktiver Tab, Audio-Stummschaltung, Anheften, native Gruppen anlegen/ändern/auflösen, Gruppen und Tabs zwischen Fenstern verschieben, Fenster steuern/schließen, entladen, explizit neuladen und Tabs schließen. Nur für diesen Befehlsdurchlauf wurde in einer Testkopie die Inhaltsregel auf „Erlauben“ gesetzt.

Ein zweiter Durchlauf nutzte **unveränderte Produktionsregeln** und bediente die tatsächlichen Popup- und Freigabeseiten in einer Testkopie: **acht Prüfgruppen mit vier echten Freigabedialogen**. Geprüft wurden die Standardeinstellung, erste Sitzungsfreigabe, weitere Abfragen ohne neue Nachfrage oder Fristverlängerung, Nachfrage bei jedem Zugriff, Ablehnen, Sperren, alle/aktive Tabs, MCP ausschalten und wieder verbinden sowie die zugehörigen Statusfarben. Testhelfer sind kein Bestandteil der ausgelieferten Erweiterung.

Das hinzugefügte 22. Werkzeug `firefox_list_extensions` wurde unter Firefox **157.0** in **sechs weiteren Prüfgruppen** getestet: verweigerter Zugriff ohne Freigabe, tatsächliche Freigabe über das unveränderte Popup, echte `management.getAll`-Ergebnisse, Typ-/Statusfilter, Pagination und Widerruf. Das isolierte Profil enthielt eine aktive Erweiterung und vier Themes, davon drei deaktiviert. Die Berechtigungs-API wurde nicht simuliert. Nur der zusätzliche native Bestätigungsdialog war im Testprofil abgeschaltet; die erste Freigabe erfolgte durch einen vertrauenswürdigen WebDriver-Klick auf die Produktionscheckbox.

Die Testprofile waren vom normalen Firefox-Profil getrennt. Alle nur für die Tests angelegten Native-Messaging-Registrierungen wurden danach entfernt.

## Paketprüfung

JavaScript-Syntax und Manifestkonsistenz wurden geprüft. Mozilla `web-ext lint` meldet **0 Fehler** und eine Android-Kompatibilitätswarnung: Die Datenfreigabe benötigt dort Firefox 142, während das Desktop-Minimum 140 ist. Dieses Projekt ist für **Desktop-Firefox** ausgelegt; Android wird nicht unterstützt.

Die ZIP-Pakete enthalten weder lokale Tokens/Konfiguration noch `node_modules` oder `.runtime`. Die Erweiterung ist **unsigniert**. Das Laden des Firefox-Add-ons und der Eintrag beim KI-Agenten werden vom Installer weiterhin nicht automatisch vorgenommen. Tests mit den verwendeten Versionen sind keine Zusage für alle zukünftigen Firefox-/Codex-Versionen.
