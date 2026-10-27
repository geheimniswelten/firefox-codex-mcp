# Technische Diagnose ab 1.0.9

Alle sechs Werkzeuge sind lesend. Sie benötigen aktives MCP, aber keine Inhalts- oder Bedienfreigabe. Sie ändern keine Einstellungen oder Seitenfilter und öffnen keine Freigabefrage. Allgemeine Tab-Metadaten bleiben wie bisher verfügbar; die Diagnoseantworten lassen Titel und URLs zusätzlich weg. Browser-Version und Erweiterungsinventar behalten ihre separate technische Datenfreigabe.

| Werkzeug ohne Präfix `firefox_` | Daten |
| --- | --- |
| `get_environment` | Betriebssystemplattform, Architektur, gesamter/freier System-RAM, verfügbare Messquellen; Browser-Version nur mit Inventarfreigabe |
| `get_processes` | Unter Windows PID, Prozessstartzeit, kumulierte CPU-Sekunden, Working Set, Private Bytes, Thread- und Handleanzahl |
| `monitor_resources` | Zwei Prozessmessungen mit Wartezeit `durationMs` von 1000 bis 10000 ms, Standard 2000; CPU-Auslastung und Veränderung privater Speicherbelegung |
| `get_network_state` | Unter Windows zusammengefasste TCP-Verbindungszustände der Firefox-Prozesse, ohne Endpunkte |
| `diagnostics_snapshot` | Tab-Zählwerte, System-RAM, Prozesse und TCP-Zustände; Browser-Version nur mit Inventarfreigabe |
| `diagnose_tab` | Technischer Zustand eines bestehenden Tabs (`tabId`), etwa geladen/entladen, aktiv, hörbar und Ladestatus; ergänzend browserweite Prozessdaten |

## Messumfang und Interpretation

Die Windows-Messung verwendet feste PowerShell-Abfragen über `Get-Process` und `Get-NetTCPConnection`. Der Aufrufer kann weder Befehle noch Filterausdrücke übergeben. Die Werte umfassen **alle Prozesse namens Firefox, auch aus anderen Profilen**. Es besteht keine verlässliche Zuordnung zu einzelnen Tabs. Browserweite Last ist deshalb kein Beleg gegen den angefragten Tab. Prozesse können während der Abfrage verschwinden oder unzugänglich sein.

`cpuSeconds` ist kumulierte CPU-Zeit. Erst die Differenz zweier Messungen ergibt Auslastung: `cpuPercentOneCore = CPU-Sekunden-Differenz / vergangene Sekunden * 100`. 100 Prozent entspricht einem ausgelasteten logischen Prozessor; Werte über 100 sind möglich. Neue Prozesse oder wiederverwendete PIDs erhalten ohne passende Vergleichsmessung keinen CPU-Prozentwert. Die reale Messspanne steht in `elapsedMs` und umfasst auch Abfragezeit. Eine kurze Messung beweist kein Speicherleck. Working Sets können gemeinsamen Speicher enthalten; ihre Summe ist kein eindeutiger physischer RAM-Verbrauch.

Jede OS-Abfrage hat höchstens fünf Sekunden und eine begrenzte Ausgabe. Höchstens zwei Diagnoseabfragen erfassen gleichzeitig OS-Daten; weitere melden `DIAGNOSTICS_BUSY`. Messungen enden mit Antwort, Timeout, Verbindungsabbruch oder abgeschaltetem MCP. Es gibt keine Hintergrundaufzeichnung. Snapshots sind zeitlich aufeinanderfolgende Messungen, keine atomare Gesamtaufnahme.

## Verfügbarkeitsgrenzen

Unter Linux/macOS bleiben technische Tabinformationen und System-RAM verfügbar. Prozess- und Socketquellen sind dort zunächst ausdrücklich als nicht unterstützt gekennzeichnet. Fehlgeschlagene Quellen liefern `available:false` mit einem technischen Grund, statt erfundene Nullwerte oder rohe Fehlertexte auszugeben.

Interne Daten aus `about:unloads`, `about:memory`, `about:logging`, `about:cache`, DNS-/HTTP-Timings, Profiler-Stacks, Seitenfehler, Service Worker, Drittmodule und Unternehmensrichtlinien sind noch nicht angebunden. TCP-Zustände allein erklären keinen Ladefehler; UDP/QUIC fehlt in dieser Messung. Weder Seiteninhalte noch Netzwerkadressen, Ports, URLs, Header, Cookies, Request-Inhalte, Dateipfade oder Kommandozeilen werden durch diese Diagnosewerkzeuge ausgegeben.

Nach einem Update Add-on neu laden und die MCP-Verbindung im KI-Client neu starten. Entwicklungsinstallationen verwenden ihre Repository-Skripte; heruntergeladene Paketinstaller dürfen keine Git-Arbeitsverzeichnisse überschreiben.
