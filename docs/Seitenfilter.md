# Seitenfilter

Im Add-on-Popup öffnet **Seitenfilter: sperren oder dauerhaft erlauben** eine eigene Einstellungsseite. Allgemeine Tabinformationen wie Titel und URL werden von den Filtern nicht gesperrt.

## Listen und Vorrang

1. **Seiteninhalte und Bedienung verweigern** (`blocked`) sperrt Text-/HTML-/DOM-Lesen, PNG-/Single-HTML-/PDF-Exporte und Bedienaktionen. Tabverwaltung sowie die nach den allgemeinen Metadatenregeln verfügbaren Titel und URLs bleiben möglich.
2. **Seiteninhalte lesen und Seitenelemente bedienen immer erlauben** (`fullAccess`) erlaubt unterstützte Lese- und Bedienaktionen ohne weitere Inhalts- oder Bedienabfrage.
3. **Seiteninhalte immer lesen erlauben** (`readOnly`) erlaubt Lesen einschließlich DOM und Export ohne weitere Inhaltsabfrage, auch beim allgemeinen Inhaltsmodus „Nicht erlauben“. Bedienaktionen benötigen weiterhin die normale Bedienfreigabe; diese Liste ist keine Schreibsperre.

Die erste passende Liste entscheidet. Ohne Treffer gelten die allgemeinen Regeln. Dauerhafte Erlaubnisse gelten unabhängig vom aktiven Tab und von temporären Freigaben. Sie umgehen weder deaktiviertes MCP noch Firefox-Zugriffsbeschränkungen oder die Begrenzungen der einzelnen Werkzeuge. Passwortmaskierung bleibt bestehen; freie JavaScript-Ausführung wird dadurch nicht verfügbar. Entladene Tabs werden nicht automatisch aufgeweckt.

## Eingabe

Pro Zeile steht ein Typ, gefolgt von einem Leerzeichen und dem Muster:

```text
domain example.org
host www.example.org
url https://example.org/privat
```

- `domain` erfasst die Domain und ihre Subdomains.
- `host` erfasst nur den angegebenen Host.
- `url` berücksichtigt optional HTTP/HTTPS und Port sowie den Pfad. Ein Pfad ohne Platzhalter erfasst auch Unterpfade; `/` erfasst alle Pfade des Hosts. Ohne Schema gilt das Muster für HTTP und HTTPS.
- `*` ist ein Platzhalter. Beispielsweise erfasst `host *.example.org` Subdomains, jedoch nicht die nackte Domain `example.org`.
- Query-Parameter und Fragmente werden ignoriert. Eine Regel kann deshalb nicht anhand von `?konto=...` zwischen Seiten unterscheiden.
- Groß-/Kleinschreibung des Hosts wird vereinheitlicht; Pfade bleiben unterscheidbar. Es gibt höchstens 200 Regeln pro Liste und 2048 Zeichen pro Muster.

### Pfadgrenzen und Platzhalter

| Eingabe | Treffer |
| --- | --- |
| `domain example.org` | Hauptdomain und alle Subdomains, auch `a.b.example.org`; nicht `notexample.org` |
| `host forum.example.org` | Genau dieser Host; weder `example.org` noch `a.forum.example.org` |
| `url example.org/aaa` | `/aaa`, `/aaa/bbb`, `/aaa?x=1`, `/aaa&x=1` und `/aaa#abschnitt`; nicht `/aaabcd` |
| `host shop*.example.org` | Beispielsweise `shop1.example.org` und `shop-de.example.org` |
| `url example.org/a*/bbb` | Beispielsweise `/aaa/bbb` und `/aaa/bbb/ccc` |
| `url example.org/aaa*` | Mit ausdrücklichem `*` auch `/aaabcd` |
| `url http://localhost:5173/app` | Nur dieser HTTP-Port und `/app` mit Unterpfaden |

`*` steht für beliebig viele Zeichen. Reguläre Ausdrücke werden nicht ausgewertet.
Die implizite Erweiterung am Pfadende gilt an den Grenzen `/`, `?`, `&` und `#`;
für Teiltreffer innerhalb eines Pfadsegments ist ein ausdrückliches `*` nötig.
Query-Parameter und Fragmente werden sowohl im Muster als auch bei der Ziel-URL
ignoriert. Eine URL-Regel ohne Host-Platzhalter umfasst keine Subdomains.

### Protokolle, Ports und internationale Domains

`domain` und `host` gelten für HTTP und HTTPS auf allen Ports; sie enthalten
weder Protokoll noch Port oder Pfad. URL-Muster ohne Protokoll gelten ebenfalls
für HTTP und HTTPS und ohne Portangabe für alle Ports. Mit ausdrücklichem
`http://` oder `https://` ist ohne Portangabe nur der jeweilige Standardport
gemeint (80 beziehungsweise 443). `:*` erlaubt jeden Port, `*://` beide
Protokolle. Beispielsweise erfasst `url http://localhost:*/app` den Pfad auf
allen HTTP-Ports, während `url https://example.org/app` Port 8443 ausschließt.

Unicode-Domains ohne Platzhalter werden in Punycode normalisiert, etwa
`bücher.example` zu `xn--bcher-kva.example`. Für Domain-Platzhalter mit
internationalisierten Namen ist die Punycode-Schreibweise zu verwenden.

### Leerzeichen und URL-Kodierung

Leerzeichen und `%20` werden im Muster und in der URL in beide Richtungen gleich
behandelt. `url example.org/Meine Datei` passt zu `/Meine%20Datei`, und ein Muster
mit `%20` passt zur ausgeschriebenen Form. Das gilt auch für Umlaute und ihre
UTF-8-Kodierung, etwa `Grüße` und `Gr%C3%BC%C3%9Fe`. Die Groß-/Kleinschreibung
der Hexziffern ist unerheblich; unreservierte kodierte Zeichen wie `%61` und `a`
sind ebenfalls gleichwertig.

Ein abschließendes Leerzeichen im URL-Pfad ist Teil des Musters und bleibt beim
Speichern als `%20` erhalten. `url example.org/Datei ` wird daher als
`url example.org/Datei%20` angezeigt und erfasst nicht `/Datei` ohne Leerzeichen.
Leerzeilen und Einrückungen vor dem Typ werden ignoriert.

Reservierte Zeichen bleiben unterscheidbar: `%2F` ist kein echter Pfadtrenner `/`,
`%26` erzeugt keine neue Pfadgrenze, und `%2A` bezeichnet einen literalen Stern
statt eines Platzhalters. Es wird nur einmal normalisiert; `%2520` ist nicht
dasselbe wie `%20`. Ein `+` im Pfad steht für Plus und nicht für ein Leerzeichen.

## Speichern und Änderungen

**Speichern** validiert und normalisiert die Listen und widerruft temporäre Inhalts- und Bedienfreigaben sowie offene Freigabeanfragen und zwischengespeicherte Exporte. Ungültige Eingaben werden nicht gespeichert. Die Regeln bleiben über Firefox-Neustarts erhalten. Das Zurücksetzen temporärer Freigaben löscht die dauerhaften Filter nicht.

Wurde inzwischen in einer anderen Einstellungsseite gespeichert, wird die veraltete Änderung abgelehnt. Die eigenen Eingaben bleiben zum Abgleichen erhalten. **Gespeicherte Regeln neu laden** fragt vor dem Verwerfen ungespeicherter Eingaben nach. Auch beim Verlassen der Seite wird eine Warnung angefordert; deren Anzeige hängt vom Browser ab.

## Exporte und eingebettete Seiten

PNG, Single-HTML und PDF können Inhalte eingebetteter Dokumente enthalten.
Sobald eine Sperrliste vorhanden ist, prüft die Erweiterung deshalb auch deren
Frame-URLs über `webNavigation`. Trifft ein eingebettetes Dokument eine Sperre,
wird der komplette Export abgebrochen. Scheitert die Frame-Prüfung, gibt es
ebenfalls keinen Export. Text-/DOM-Lesen bleibt auf den Hauptframe beschränkt.
Navigationen eingebetteter Dokumente während eines Exports oder vor dem Abruf
weiterer Export-Blöcke verwerfen den Export ebenfalls, auch bei Rückkehr zur
alten URL.

Die Firefox-Berechtigung `webNavigation` dient dieser Frame-Prüfung. Ungültige
gespeicherte Filter sperren den Inhaltszugriff bis zur Korrektur; allgemeine
Tabinformationen bleiben verfügbar.
