**Ja, die Erweiterung kann als normales, dauerhaft installiertes Firefox-Add-on verwendet werden.** Die benötigte `manifest.json` ist im Unterverzeichnis `extension` bereits vorhanden.

Dein Vorgehen stimmt grundsätzlich: Den **Inhalt** von `extension` verpacken, sodass `manifest.json` direkt im Archiv liegt, und bei Mozilla einreichen. Eine XPI-Datei ist technisch ein ZIP mit anderer Endung. Unser [Erweiterungspaket 0.1.2](C:/Users/fsemmling/Documents/Codex/2026-09-30/ein/outputs/firefox-codex-mcp-0.1.2-extension.zip) hat bereits diese Struktur. [Mozilla: Paketformat](https://extensionworkshop.com/documentation/publish/package-your-extension/)

Für die eigene Nutzung kannst du im Developer Hub **„On your own“ / nicht öffentlich gelistet** wählen. Mozilla signiert das Add-on dann zur eigenen Verteilung. Eine öffentliche Veröffentlichung im Add-on-Katalog ist ebenfalls möglich. Die dauerhafte Installation im normalen Firefox benötigt die Mozilla-Signatur. [Signierung und Verteilung](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

**Die Registrierung bei den KI-Apps muss allerdings weiterhin ein lokales Programm erledigen.** Ein Firefox-Add-on kann nicht selbstständig deren Konfigurationsdateien bearbeiten oder den Native-Messaging-Host in Windows installieren. Mozilla sieht dafür ausdrücklich eine separat installierte Anwendung vor. [Mozilla: Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)

Für unser Projekt wären das weiterhin zwei Bestandteile:

| Bestandteil | Aufgabe |
|---|---|
| Signiertes Firefox-Add-on | Browserzugriff, Einstellungen und Freigaben |
| Lokaler Installer | Brücke und MCP-Server installieren sowie erkannte KI-Apps registrieren |

**Die Bedienung könnte trotzdem ins Add-on wandern:** etwa eine Seite „KI-Apps einrichten“, die den installierten Helfer mit der Erkennung und Registrierung beauftragt. Fehlt der Helfer, zeigt sie den Download und die Einrichtungsschritte an. Das wäre eine zusätzliche Funktion.

Auf deinem bereits eingerichteten Rechner könnte die signierte Erweiterung die vorhandene Brücke weiterverwenden, solange ihre Add-on-ID gleich bleibt.