# Prüfstand vom 30. September 2026

## Automatisierte Tests

`node --test test/*.test.mjs`: **51 bestanden, 0 fehlgeschlagen**.

Abgedeckt sind Firefox-Zustände und Metadaten, native Gruppen mit großen IDs, Inhaltsbegrenzung, die vier Inhaltsregeln, aktiver Tab, Navigation während der Freigabe, feste zwölfstündige Sitzungsfreigaben, Widerruf und Abbruch laufender Stapel. Die Zeitgrenzen werden mit einer kontrollierten Uhr geprüft, ohne zwölf Stunden zu warten.

Zusätzlich geprüft: echte MCP-SDK-Verbindungen über Standard-Ein-/Ausgabe mit beiden unterstützten Protokollvarianten, Abbruchsignale, Offline-Verhalten, Tokenauthentifizierung, Schutz der lokalen HTTP-Verbindung, Nachrichtengrößen, Parallelität und idempotente Setup-Erzeugung mit Windows-Dateirechten.

## Firefox auf Windows

Alle **21 MCP-Werkzeuge** wurden über die vollständige Verbindung getestet: MCP-Client → MCP-Server → lokale Brücke → Firefox Native Messaging → Erweiterung. Der laufende Firefox meldete im ersten Durchlauf Version **157.0**. Für die Tests wurden ausschließlich neu erzeugte, getrennte Firefox-Profile und lokale Testseiten verwendet.

Erfolgreich waren Fenster-/Tabübersicht, neue Tabs, Zeitmetadaten, Text/HTML/Links, Kürzung und aktiver Tab, Audio-Stummschaltung, Anheften, native Gruppen anlegen/ändern/auflösen, Gruppen und Tabs zwischen Fenstern verschieben, Fenster steuern/schließen, entladen, explizit neuladen und Tabs schließen. Nur für diesen Befehlsdurchlauf wurde in einer Testkopie die Inhaltsregel auf „Erlauben“ gesetzt.

Ein zweiter Durchlauf nutzte **unveränderte Produktionsregeln** und bediente die tatsächlichen Popup- und Freigabeseiten in einer Testkopie: **acht Prüfgruppen mit vier echten Freigabedialogen**. Geprüft wurden die Standardeinstellung, erste Sitzungsfreigabe, weitere Abfragen ohne neue Nachfrage oder Fristverlängerung, Nachfrage bei jedem Zugriff, Ablehnen, Sperren, alle/aktive Tabs, MCP ausschalten und wieder verbinden sowie die zugehörigen Statusfarben. Testhelfer sind kein Bestandteil der ausgelieferten Erweiterung.

Die Testprofile waren vom normalen Firefox-Profil getrennt. Alle nur für die Tests angelegten Native-Messaging-Registrierungen wurden danach entfernt.

## Paketprüfung

JavaScript-Syntax und Manifestkonsistenz wurden geprüft. Mozilla `web-ext lint` meldet **0 Fehler** und eine Android-Kompatibilitätswarnung: Die Datenfreigabe benötigt dort Firefox 142, während das Desktop-Minimum 140 ist. Dieses Projekt ist für **Desktop-Firefox** ausgelegt; Android wird nicht unterstützt.

Die ZIP-Pakete enthalten weder lokale Tokens/Konfiguration noch `node_modules`. Die Erweiterung ist **unsigniert** und noch nicht im normalen Firefox-Profil oder in Codex registriert. Tests mit den verwendeten Versionen sind keine Zusage für alle zukünftigen Firefox-/Codex-Versionen.
