# TODO: Node-Helfer durch native Pascal-Anwendung ersetzen

Stand: 31.10.2026. Zusammenfassung der Diskussion vom 22.10.2026 im Chat
„Firefox-MCP“ zu Delphi/Free Pascal, Linux-Kompatibilität und kompakter
Auslieferung. Dies ist ein Vorhaben; der Umbau ist noch nicht umgesetzt.
Die vorhandene Node-Lösung bleibt bis zu einem getesteten Ersatz bestehen.

## Ziel

Alles außerhalb des Firefox-Add-ons (XPI) soll künftig durch eine kleine native
Anwendung ersetzt werden: MCP-Server, Native-Messaging-Helfer, lokale Verbindung,
Export-Dateizugriffe sowie Registrierung bei Firefox und KI-Clients.

- Beim Anwender kein Node.js, npm oder `node_modules` mehr erforderlich.
- Fertige Programme ausliefern; Anwender sollen nichts selbst kompilieren müssen.
- Möglichst **XPI plus eine Programmdatei pro Betriebssystem/Architektur**.
  Alternativ zwei Programme: MCP-Server/Native Host und separate STDIO-Bridge.
- Keine grafische Oberfläche im Helfer. Menü, Einstellungen und Freigabeabfragen
  bleiben in der Extension. Registrierung darf einen Konsolenmodus besitzen.
- „Single-EXE“ bezeichnet die Auslieferungsform: Unter Linux/macOS ist es eine
  native Programmdatei ohne `.exe`. Erzeugte Konfigurationen und das
  Native-Messaging-Manifest werden weiterhin benötigt.

## Ausgangslage und mögliche Aufteilung

Aktuell:

```text
KI-Agent
  ↕ MCP über STDIO
MCP-Server (Node.js)
  ↕ privates HTTP/RPC auf 127.0.0.1
Native Host (Node.js)
  ↕ Firefox Native Messaging
Firefox-Extension: Browserfunktionen, UI und Freigaben
```

Der vorhandene HTTP-Anschluss ist ein internes Brückenprotokoll, kein direkt
von HTTP-MCP-Clients verwendbarer MCP-Endpunkt. Als Ausgangspunkte dienen
`server/mcp.mjs`, `server/native-host.mjs`, `server/bridge-client.mjs`,
`server/framing.mjs`, `server/exports.mjs` und `server/diagnostics.mjs`.

- [ ] **Ein Programm mit mehreren Startmodi** prüfen: Registrierung,
  Deregistrierung, Firefox Native Host und MCP über STDIO. Eine Programmdatei
  kann dabei mehrfach als Prozess laufen.
- [ ] Gegen **zwei Programme** abwägen: gemeinsamer Server/Native Host und kleine
  STDIO-Bridge für KI-Clients. Protokollkern und JSON-Code gemeinsam verwenden.
- [ ] Verbindung zwischen Firefox-gestartetem Native Host und den von KI-Clients
  gestarteten Prozessen festlegen. „Nur STDIO“ beseitigt diesen IPC-Bedarf nicht.
  Möglichkeiten: bisherige lokale HTTP-Brücke oder Named Pipes/Unix-Sockets.
- [ ] Direktes MCP über HTTP als optionale Erweiterung entscheiden. Dafür wäre
  ein eigener standardkonformer MCP-HTTP-Transport nötig. Nicht allein wegen
  der Umstellung von Node auf Pascal einführen.
- [ ] Framing getrennt implementieren: MCP-STDIO mit zeilengetrennten
  JSON-Nachrichten; Firefox Native Messaging mit 4-Byte-Längenpräfix und UTF-8.
  STDOUT ausschließlich für Protokolldaten verwenden, Diagnosen auf STDERR.

## Voraussetzungen: erst Komponenten, dann Firefox-Umbau

Die im Chat vereinbarte Reihenfolge:

1. [ ] Eigene JSON-Komponente fertigstellen.
2. [ ] Allgemeinen MCP-Kern aus dem DAI-Projekt als eigene, auch für andere
   Projekte verwendbare Komponente auslagern.
3. [ ] JSON und MCP-Kern unter Delphi und Free Pascal kompilieren und testen.
4. [ ] Erst auf dieser Grundlage den konkreten Firefox-Umbau planen.

Der MCP-Kern soll weder Firefox noch Delphi-IDE, GUI oder einen bestimmten
Transport voraussetzen. Werkzeugregistrierung, JSON-RPC/MCP-Verarbeitung und
Ergebnisse/Fehler gehören in den Kern; STDIO, optional HTTP, Firefox-Anbindung
und Einrichtung in getrennte Adapter.

### JSON-Records und Compiler-Kompatibilität

Die JSON-Komponente verwendet Records als referenzgezählte Handles auf interne
Records („Fake-Interface“ über Pointer). Zuweisungen teilen die Daten;
`Clone` erzeugt eine unabhängige Kopie eines Elements oder eines ganzen Baums.

- [ ] Gemeinsame Referenzzählungs-/Freigabelogik von compilerabhängigen
  Record-Operatoren trennen.
- [ ] Delphi `Initialize`, `Finalize`, `Assign` gegen FPC-Managementoperatoren
  (`Initialize`, `Finalize`, `Copy`, gegebenenfalls `AddRef`) prüfen; Semantik
  und Verfügbarkeit mit der tatsächlich gewählten FPC-Version nachweisen.
- [ ] Selbstzuweisung, bereits gemeinsam referenzierte Daten, Parameter,
  Funktionsrückgaben, temporäre Records, Arrays und Exceptions testen.
  Weder doppelte Referenzzählung noch vorzeitige Freigabe zulassen.
- [ ] `Clone` für verschachtelte Bäume und unabhängige Änderungen prüfen.
- [ ] Bibliotheksabhängigkeiten prüfen: FPCs Delphi-Modus ersetzt keine
  Delphi-Units wie `System.JSON`, VCL oder IDE-Schnittstellen.

### Wiederverwendung aus DAI

Im eigenen Projekt `DAI (DelphiAI, MCP-Server for Delphi)` waren insbesondere
`Source/h5u.DAI.MCP.Protocol.pas`, `Source/h5u.DAI.Launcher.Protocol.pas` und
`DAI.McpBridge.dpr` als mögliche Ausgangspunkte identifiziert worden.

- [ ] Wiederverwendbare Protokolllogik und STDIO-Verarbeitung herauslösen.
- [ ] `System.JSON`, IDE-Anbindung und HTTP-spezifische Annahmen ersetzen
  beziehungsweise hinter Adapter verschieben.
- [ ] Kleinen gemeinsamen Prototyp zuerst nachweisen: Initialisierung,
  Werkzeugliste und ein Test-Werkzeugaufruf über STDIO.

Delphi bleibt die bevorzugte Sprache/Umgebung des Entwicklers. Free Pascal ist
für die gemeinsame Windows-/Linux-/macOS-Auslieferung zu prüfen; die damals
genannten Grenzen der vorhandenen Delphi-Lizenz und der Apple-Buildumgebung
sollen dabei berücksichtigt werden. Lazarus kann als IDE dienen, der Helfer
soll aber ohne LCL, GTK, Qt oder andere GUI-Abhängigkeiten auskommen.

## Zielsysteme und Linux-Kompatibilität

**Gewünschter Umfang: Desktop-Systeme, auf denen Firefox eingesetzt wird.**
Das ist ein Supportziel, noch keine Garantie für jede Firefox-Plattform.
Android und iOS gehören nicht zum geplanten Umfang dieses Desktop-Helfers.

Vorläufige Build-Matrix aus der Diskussion:

| Ziel | Geplante Architektur | Noch festzulegen |
| --- | --- | --- |
| Windows | zunächst x64 | Mindestversion; zusätzlicher ARM64-Build bei Bedarf |
| macOS | Intel x64 und Apple Silicon ARM64 | Mindestversion, Buildumgebung, Signierung/Notarisierung |
| Linux | zunächst x86_64, anschließend ARM64 | Kernel-/libc-Mindestanforderungen und Firefox-Paketierung |

### Welche Linux-Distributionen?

Möglichst **ein Build pro Architektur**, keine eigene Programmdatei für jede
Distribution. Entscheidend sind CPU, Kernel-/Bibliotheksabhängigkeiten und die
Art der Firefox-Installation, nicht allein der Distributionsname.

- [ ] Zum Umsetzungszeitpunkt die tatsächlich unterstützten Firefox- und
  FPC-Zielsysteme sowie deren Mindestanforderungen anhand offizieller Quellen
  bestimmen. Konkrete Distributionsversionen sind bisher nicht beschlossen.
- [ ] Repräsentative Tests für Debian/Ubuntu beziehungsweise Linux Mint,
  Fedora, openSUSE und Arch planen. Diese Liste ist eine Testauswahl und noch
  keine bestätigte Kompatibilitätsliste.
- [ ] glibc als erste Linux-Basis untersuchen; Alpine/musl separat bewerten.
  Ein glibc-Build ist nicht automatisch auf musl-Systemen lauffähig.
- [ ] Bei dynamischen Abhängigkeiten gegen eine bewusst gewählte ältere
  unterstützte Basis bauen, damit neuere Bibliotheksanforderungen ältere
  Zielsysteme nicht unbeabsichtigt ausschließen.
- [ ] Am fertigen Programm mit `readelf`/`ldd` beziehungsweise passenden
  Plattformwerkzeugen nachweisen, welche Loader und Bibliotheken nötig sind.
  Prüfen, ob die gewählten FPC-Units ohne libc auskommen oder etwa durch
  Threading/Netzwerk zusätzliche Systembibliotheken benötigen.
- [ ] Native Firefox-Pakete/Mozilla-Archive sowie Snap und Flatpak getrennt
  testen: Registrierung, Auffinden und Start des Native Hosts, IPC und Exporte.
  Sandbox-/Portal-Integration wird durch Pascal nicht automatisch gelöst.

### Node gegenüber Free Pascal und zukünftige OS-Versionen

Node benötigt selbst eine zum Betriebssystem passende native Laufzeit und hat
eigene Plattform-Mindestanforderungen. Der benötigte Pascal-Laufzeitcode kann
in das Programm eingebunden werden; eine separat installierte FPC-Runtime ist
nicht das Auslieferungsziel. Verbleibende Systemabhängigkeiten hängen dennoch
von den verwendeten Units und der Buildkonfiguration ab.

- [ ] Externe Abhängigkeiten gezielt klein halten und dokumentieren.
- [ ] Alte Builds auf neueren Systemen testen; zusätzlich auf der ältesten
  unterstützten Basis prüfen. Aus „läuft auf neuerem Linux“ folgt nicht
  automatisch „läuft auf älterem Linux“.
- [ ] Keine pauschale Zukunftsgarantie zusagen. Neue Betriebssystemversionen,
  Architekturen und Firefox-Paketierungen regelmäßig testen; notwendige neue
  Builds und Pflege des MCP-Protokolls bleiben Projektaufgabe.

## Gemeinsame Portverwaltung mit DAI unter Windows

Die projektübergreifende Vereinbarung steht in
[PORT_RESERVATION.md](PORT_RESERVATION.md). Die aktuelle Node-Variante ist über
`server/port-reservation.mjs` und einen lokalen Windows-PowerShell-/C#-Helfer
angebunden. Mehrere Windows-Benutzer und RDP-Sitzungen sowie DAI und Firefox MCP
können damit ihre Listener-Ports gemeinsam abstimmen. Der spätere Pascal-Umbau
soll denselben Vertrag weiterverwenden. Die Abnahme mit getrennten Konten/RDP
steht noch aus; diese Anbindung ist unabhängig vom Pascal-Vorhaben.

Es handelt sich um eine dauerhafte kooperative Vormerkung, nicht um eine
exklusive Windows-Socketreservierung. Nicht teilnehmende Programme können den
Port weiterhin belegen; der tatsächliche Listener muss Bindefehler melden.

- [x] Den bestehenden HTTP-Listener (Standardport 38477) als `FirefoxMCP:http`
  anbinden. `.FirefoxMCP` verwendet `Schema=1`, vorläufig den Suchbereich
  38477–38576 und Loopback. Ein reiner STDIO-Prozess benötigt keine eigene
  Reservierung. Bereich vor einer gemeinsamen Veröffentlichung mit DAI abstimmen.
- [x] Dasselbe Verzeichnis `FOLDERID_ProgramData\h5uPortReservation` und die
  bestehenden SID-Benutzerdateien verwenden. `ProgramData` über Windows
  ermitteln; keine zweite, nur Firefox betreffende Reservierungsdatei führen.
  Die SID aus dem Prozesstoken verwenden und Konto-Umbenennungen tolerieren.
- [x] Alle Benutzerdateien und Anwendungen berücksichtigen. Ports sind
  verwaltungsweit eindeutig; fremde Kennungen, Zeilen und Kommentare erhalten.
  Mehrere Dateien für dieselbe SID, doppelte Ports, unlesbare oder fehlerhafte
  Dateien dürfen keine neue Vergabe ermöglichen. Format und Leselimits aus
  `PORT_RESERVATION.md` übernehmen.
- [x] Den gesamten Lese-/Prüf-/Schreibvorgang unter exakt
  `Global\h5uPortReservation.v1` ausführen. Mutex-Rechte, Wartezeit und
  Behandlung eines verlassenen Mutex gemäß Vereinbarung umsetzen; ein
  sitzungslokaler Mutex oder separates Lockfile ist kein Ersatz.
- [x] Für Node einen Windows-Helfer mit dem vollständigen kritischen Abschnitt
  einbinden; keine Abhängigkeit von laufendem DAI oder dessen BPLs.
- [ ] Für Delphi/FPC später denselben Vertrag direkt über die Windows-API
  implementieren und die Abhängigkeit vom PowerShell-/C#-Helfer ablösen.
- [x] Dateibesitzer, DACLs, Integritätsstufen, Reparsepunkte und Hardlinks gemäß
  Vereinbarung prüfen. Nur die eigene SID-Datei atomar über eine geflushte
  temporäre Datei ersetzen; bestehende Rechte und Einträge anderer Anwendungen
  auch innerhalb dieser Datei erhalten. Vorhandene gemeinsame ACLs nicht
  ungefragt ändern.
- [x] Bestehende benutzerspezifische Portkonfiguration übernehmen, sofern kein
  Konflikt vorliegt. Konflikte sichtbar melden; keinen Port still wechseln und
  keine vorhandenen Clientregistrierungen unbemerkt umstellen.
- [x] In Einrichtung/Registrierung die Aktionen „freien Port vorschlagen“,
  „Port reservieren“ und „Port freigeben“ unterscheiden. Eine Suche verändert
  keine Reservierung oder Konfiguration. Reservieren versucht den gewählten
  Port; ein Wechsel der Konfiguration bleibt eine bewusste Aktion.
- [x] Bedienung für Desktop und Windows Server festlegen, angelehnt an DAI:
  freiwillige Einrichtung am Desktop, gezielter Hinweis beziehungsweise
  Rückfrage bei fehlender eigener Reservierung auf Windows Server. Eine
  RDP-Verbindung allein macht ein Desktop-System nicht zum Windows Server.
- [x] Reservierungen über Prozessende und Firefox-Neustarts hinweg erhalten.
  Alte Ports bei einer Umstellung nicht vorzeitig freigeben. Deregistrierung
  und bewusste Freigabe so abstimmen, dass verbleibende Clientregistrierungen
  berücksichtigt und keine DAI- oder fremden Benutzereinträge entfernt werden.
- [x] Keine Tokens in der gemeinsamen Verwaltung speichern. Benutzereigene
  geschützte Konfiguration und bisherige Authentifizierung beibehalten:
  Loopback allein trennt Windows-Benutzer nicht voneinander.
- [ ] Mit isolierten Testverzeichnissen bestehende DAI-/Firefox-Einträge,
  beschädigte Dateien, Konto-Umbenennungen, konkurrierende Prozesse,
  Bindekonflikte und Abbrüche beim Schreiben testen. Zusätzlich mit getrennten
  Windows-Konten/RDP-Sitzungen die gemeinsamen Rechte und Sperren nachweisen.

Linux/macOS bleiben zunächst außerhalb dieser Windows-Vereinbarung. Sollte
später statt TCP ausschließlich Named-Pipe-/Unix-Socket-IPC verwendet werden,
gilt die Portverwaltung nur noch für tatsächlich verbleibende TCP-Listener.

## Funktionsumfang, Einrichtung und Abnahme

- [ ] Alle bisherigen Werkzeugdefinitionen, Parameter, Ergebnisse, Fehler,
  Timeouts und Abbrüche mit der Node-Implementierung abgleichen.
- [ ] Mehrere KI-Clients, parallele Aufrufe, Firefox-Neustarts und
  Verbindungsabbrüche prüfen; Schreibaktionen nach Fehlern nicht blind wiederholen.
- [ ] Export-Chunking, Größenlimits, Dateizugriffe und vorhandenen
  Überschreibschutz übernehmen; technische OS-Diagnosen plattformspezifisch
  erhalten oder ihre Verfügbarkeit ausdrücklich ausweisen.
- [ ] Freigaben, Seitenfilter und UI in der Extension beibehalten. Der neue
  Helfer darf diese Grenzen nicht umgehen oder freie JavaScript-Ausführung ergänzen.
- [ ] Lokale Erreichbarkeit und Authentifizierung beibehalten. Bei HTTP nur
  Loopback, kein Listener im LAN; bei anderer IPC entsprechende Zugriffsrechte.
- [ ] Installer/Registrierung für Windows, Linux und macOS auf fertige native
  Programme umstellen; Version und Registrierungsrevision weiter rückmelden.
- [ ] Bestehende Installationen sicher migrieren. Entwicklungsverzeichnisse
  schützen; bei Deregistrierung und Aufräumen nur eindeutig eigene Dateien
  entfernen, niemals pauschal den Installations- oder Projektordner löschen.
- [ ] Reproduzierbare Builds und automatisierte Protokoll-/Integrationstests
  pro Zielplattform einrichten; vollständige Installation ohne Node/npm testen.
- [ ] Erst nach erfolgreicher Abnahme die native Variante als Ersatz ausliefern.

Die vorhandene Node-Lösung dient bis dahin als funktionierende Referenz.
Eine bloße Bündelung von JavaScript wäre eine mögliche Zwischenlösung, erfüllt
aber ohne eingebettete Laufzeit noch nicht das Ziel „kein Node beim Anwender“.
