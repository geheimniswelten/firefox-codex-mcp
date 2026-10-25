# Firefox MCP-Server for AI-Chats

Clients: Codex, Claude Code (CLI / VS Code), Claude Desktop, Eigent, Gemini CLI / Code Assist, ~~Gemini Desktop~~, Hermes, LM Studio and OpenClaw

Home: <https://geheimniswelten.github.io/#firefox-codex-mcp>

Download: <https://github.com/geheimniswelten/firefox-codex-mcp/releases>

> [!NOTE]
> Verschiebe alle Youtube-Videos mit XYZ im Titel in ein neues Fenster <br/>
> Lösche doppelte Browser-Tabs <br/>
> Finde im Browser den Tab mit den Katzenvideos und erstell dafür einen Favoriten <br/>
> Suche in allen Browser-Tabs nach dem Sinn des Lebens und nenne mir die Antwort

Codex freut sich auf deine Befehle :kissing_closed_eyes:

<details>
  <summary><b>[EN] English</b></summary>

  - **Manage Firefox with AI**: tabs, windows, history, bookmarks, favorites and extensions (search/browse/close/move/...)
    - Search tabs/history by title, URL and time range. Bookmarks and folders, including those on the bookmarks toolbar (find/create/edit/move/delete)
  - Installation:
    - Local/[temporary](Install-temporarily.png): build.cmd -> install.cmd -> 1 or 2+3 -> about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> extension\manifest.json, dist\*.zip or *.xpi (remains installed until the next browser restart)
    - Manual/[permanent(xpi)](Install-XPI-manualy.png): about:addons -> [gear menu] -> Install Add-on from File... -> [*.xpi](https://github.com/geheimniswelten/firefox-codex-mcp/releases) -> Add-on Settings -> Setup -> run register.ps1
    - Online / Firefox Add-ons: currently unlisted (private) on [AMO](https://addons.mozilla.org/)
  - Desktop Firefox on Windows, Linux and macOS (a local native messaging helper is required)
  - Access to page content is blocked by default (permission is requested on first access)
  - Export web pages as PNG and single-file HTML (PDF export is also available, but only opens Firefox’s save dialog)
  - Debugging features: access page content, particularly to develop and test websites locally.

  It currently runs through a locally installed MCP server application (STDIO via Node.js),
  as Firefox extension restrictions prevent extensions from running a TCP listener.

  ```
  AI agent (e.g. Codex)
      ↕ MCP over STDIO
  Local MCP server (Node.js)
      ↕ HTTP exclusively over localhost
  Local native host (Node.js)
      ↕ Firefox Native Messaging
  Firefox extension
  ```

  TODO: Since Linux is not an option with Delphi Professional, and supporting macOS would therefore not be worth the effort either, this will take a little longer. <br/>
  I need to migrate or finish two other projects first, then use Free Pascal to package the **local MCP server as a single executable**.
</details>

---

<details open>
  <summary><b>[DE] Deutsch</b></summary>

  - **Firefox mit KI verwalten**: Tabs/Fenster/Chronic/Lesezeichen/Favoriten/Plugins (suchen/durchsuchen/schließen/verschieben/...)
    - Tabs/Chronik nach Titel, URL und Zeitraum durchsuchen. Lesezeichen und Ordner einschließlich Symbolleiste (suchen/anlegen/bearbeiten/verschieben/löschen)
  - Inststallation:
    - lokal/[temporär](Install-temporarily.png): build.cmd -> install.cmd -> 1 or 2+3 -> about:debugging#/runtime/this-firefox -> Temmporätes Add-on laden -> extension\\manifest.json, dist\\*.zip or *.xpi (hält bis zum nächsten Neustart)
    - manuell-[permanent(xpi)](Install-XPI-manualy.png): about:addons -> [Optionen] -> Add-on aus Datei installieren... -> [*.xpi](https://github.com/geheimniswelten/firefox-codex-mcp/releases) -> Add-on Einstellungen -> Einrichtung -> register.ps1 ausführen
    - online / Firefox Add-ons: aktuell im [AMO](## "addons.mozilla.org") nicht öffentlich gelistet (privat)
  - Desktop-Firefox unter Windows, Linux und macOS (ein lokaler Native-Messaging-Helfer ist erforderlich)
  - Zugriff auf Seiteninhalte standardmäßig gesperrt (bei Erstzugriff wird nach Freigabe gefragt)
  - Export von Webseiten als PNG und Single-HTML (auch als PDF -> öffnet aber nur den Speichern-Dialog des Firefox)
  - Debugfunktionen: Zugriff auf Seiteninhalte, aber vor allem auch um lokal Webseiten zu entwickeln und zu testen.

  Aktuell läuft es über eine lokal installierte MCP-Serveranwendung (STDIO via Node.js),
  da die Firefox-Einschrängungen für Extension keinen TCP-Listener innerhalb der Extension ermöglichen.
  ```
  KI-Agent (z.B. Codex)
      ↕ MCP über STDIO
  Lokaler MCP-Server (Node.js)
      ↕ HTTP ausschließlich über localhost
  Lokaler Native Host (Node.js)
      ↕ Firefox Native Messaging
  Firefox-Extension
  ```
  
  TODO: Da Linux mit Delphi (Prof) nicht möglich ist, und der Aufwand für MacOS sich daher eh nicht nicht lohnt, dauert es noch ein Weilchen. <br/>
  Vorher noch zwei andere Projekte umzustellen/fertigstellen und dann mit FreePascal den **lokalen MCP-Server als Single-EXE** bereitzustellen.
</details>

---

![status](Status-activity.png) 

Install Temporary: <br>
![temporary](Install-temporarily.png)

Install Permanent XPI: <br>
![permanent](Install-XPI-manualy.png)

Install-Permissions: <br>
![permissions](Install-Permissions.png)

Options Menu: <br>
![menu](Menu.png)

Register-Script: <br>
![register](RegisterScript.png)
