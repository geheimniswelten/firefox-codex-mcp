# Seitenfilter

Im Add-on-Popup öffnet **Seitenfilter: sperren oder dauerhaft erlauben** eine eigene Einstellungsseite. Allgemeine Tabinformationen wie Titel und URL werden von den Filtern nicht gesperrt.

## Listen und Vorrang

1. **Seiteninhalte und Bedienung verweigern** (`blocked`) sperrt Lesen, Exporte und Bedienaktionen.
2. **Seiteninhalte lesen und Seitenelemente bedienen immer erlauben** (`fullAccess`) erlaubt unterstützte Lese- und Bedienaktionen ohne weitere Inhalts- oder Bedienabfrage.
3. **Seiteninhalte immer lesen erlauben** (`readOnly`) erlaubt Lesen ohne weitere Inhaltsabfrage. Bedienaktionen benötigen weiterhin die normale Bedienfreigabe.

Die erste passende Liste entscheidet. Ohne Treffer gelten die allgemeinen Regeln. Dauerhafte Erlaubnisse gelten unabhängig vom aktiven Tab und von temporären Freigaben. Sie umgehen weder deaktiviertes MCP noch Firefox-Zugriffsbeschränkungen oder die Begrenzungen der einzelnen Werkzeuge. Entladene Tabs werden nicht automatisch aufgeweckt.

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

## Speichern und Änderungen

**Speichern** validiert und normalisiert die Listen und widerruft temporäre Inhalts- und Bedienfreigaben sowie offene Freigabeanfragen. Die Regeln bleiben über Firefox-Neustarts erhalten.

Wurde inzwischen in einer anderen Einstellungsseite gespeichert, wird die veraltete Änderung abgelehnt. Die eigenen Eingaben bleiben zum Abgleichen erhalten. **Gespeicherte Regeln neu laden** fragt vor dem Verwerfen ungespeicherter Eingaben nach. Auch beim Verlassen der Seite wird eine Warnung angefordert; deren Anzeige hängt vom Browser ab.

Bei Exporten werden zusätzlich die URLs eingebetteter Frames auf Sperrregeln geprüft. Ungültige gespeicherte Filter sperren den Inhaltszugriff bis zur Korrektur; allgemeine Tabinformationen bleiben verfügbar.
