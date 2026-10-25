# DOM lesen und bedienen (Entwicklungsstand 1.0.8)

`firefox_read_dom` liest sichtbaren Text und Eingaben, Checkboxen, Radio-Buttons,
Auswahlfelder, Buttons, Links und explizit editierbare Bereiche. Es liefert
Beschriftung, Wert, Zustand, Sichtbarkeit, Position und Größe. Passwortwerte sind
maskiert. Standardmäßig werden nur sichtbare Elemente aus dem Hauptframe gelesen.
Ein CSS-Selektor kann den Bereich begrenzen; `limit` und `offset` blättern durch
Elemente. Truncation-Felder machen Grenzen ausdrücklich sichtbar. Sichtbar bedeutet
im Layout vorhanden, nicht zwingend im Bildschirmausschnitt oder unverdeckt.

```javascript
const page = firefox_read_dom({tabId: 123, selector: "form", limit: 50});
// Konkrete elementId aus page.elements wählen, z. B. anhand der Beschriftung.
firefox_interact({tabId: 123, documentId: page.documentId,
  elementId: "e1", action: "fill", value: "Beispiel"});
firefox_interact({tabId: 123, documentId: page.documentId,
  elementId: "e2", action: "set_checked", checked: true});
firefox_interact({tabId: 123, documentId: page.documentId,
  elementId: "e3", action: "select", value: "option-value"});
firefox_interact({tabId: 123, documentId: page.documentId,
  elementId: "e4", action: "click"});
```

Die Beispiele sind MCP-Aufrufe, kein Code für ein Ausführungswerkzeug. `documentId`
und `elementId` müssen aus einer tatsächlichen Antwort stammen. Sie binden eine
Aktion an das gelesene Dokument und den konkreten DOM-Knoten. Nach Navigation,
Neuladen, Austausch des Knotens oder Verdrängung aus dem begrenzten Referenzspeicher
muss erneut gelesen werden. Das schützt auch vor einem Neuladen mit gleicher URL.

## Freigaben

Ab 1.0.8 werden zuerst die [dauerhaften Seitenfilter](Seitenfilter.md) geprüft.
Sperren verhindern Lesen und Bedienung. Die Leseliste umgeht Inhaltsfreigaben,
Bedienung bleibt gesondert freigabepflichtig. Vollzugriff umgeht beide Freigaben.
Ohne passenden Filter gelten die folgenden normalen Regeln:

- Lesen verwendet die normale Inhaltsfreigabe.
- Schreiben benötigt zusätzlich **Seitenelemente bedienen**, standardmäßig gesperrt.
- Bedienung kann bei jedem Zugriff, für eine feste zwölfstündige Sitzung oder für
  feste fünf Tage gefragt werden. Ein unbegrenztes „Immer erlauben“ gibt es nicht.
- Aktiver Tab/alle Tabs sind separat einstellbar. Andere Tabs benötigen gegebenenfalls
  ihre eigene Freigabe, ohne dass sie automatisch aktiviert werden.
- Die tatsächliche Berechtigung ist die Schnittmenge beider Freigaben. Eine lange
  Bedienfreigabe verlängert keine kürzere Inhaltsfreigabe.
- Auswahl eines Fristmodus erteilt keine Freigabe; erst die Antwort im Popup tut das.
- Änderungen der Regeln und Zurücksetzen der Freigaben widerrufen beide Familien.
- Fünf-Tage-Freigaben werden getrennt gespeichert und überleben Neustarts ohne
  Verlängerung. Zwölf-Stunden-Freigaben enden beim Erweiterungs-/Firefox-Neustart.

## Grenzen

Es gibt keine freie JavaScript-Ausführung und keine beliebige HTML-/Attributzuweisung.
Nur fest eingebaute DOM-Operationen laufen in Firefox. Klicken führt reguläre
Seiten-Ereignisbehandlung aus und kann Formulare absenden oder navigieren.
Ereignisse sind programmgesteuert (`isTrusted` ist false); Funktionen, die echte
Benutzereingaben voraussetzen, können sie ablehnen. Dateiauswahl, Mehrfach-Auswahlfelder,
benutzerdefinierte Checkboxzustände und Nicht-HTTP(S)-Links sind nicht unterstützt.
Interne Firefox-/Erweiterungsseiten und entladene Tabs werden nicht bedient.

Ein bestätigter Klick liefert eine Ausführungsbestätigung, auch wenn danach eine
Navigation folgt. Bei Timeout/Verbindungsfehler könnte eine Aktion bereits erfolgt
sein; Zustand prüfen und nicht automatisch wiederholen.

## Prüfen und bereitstellen

`npm run test:firefox-dom` startet eine isolierte Headless-Firefox-Testkopie mit
eigenem Profil. Es verändert weder das Benutzerprofil noch dessen Native Host.
Der Test bestätigt echte DOM-Werte, Seitenevents, getrennte Freigaben, Widerruf und
ungültige Dokumentreferenzen. Zustimmung erfolgt durch einen Testadapter;
Popup-Freigaben werden zusätzlich in den automatisierten UI-Tests geprüft.

Nach dem Build muss das neue Add-on geladen und der Native Host/MCP-Client neu
gestartet werden. Für regulären Firefox die neue ZIP erst bei Mozilla signieren
lassen; die bestehende signierte XPI 1.0.6 enthält diese Funktionen noch nicht.
