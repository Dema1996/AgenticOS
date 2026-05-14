# AgenticOS

Lokales KI-Agent-Dashboard zur Steuerung von CLI-basierten KI-Agenten (Claude Code, Codex u.a.) mit integrierter Projekt- und Aufgabenverwaltung — direkt aus dem Browser.

![AgenticOS Screenshot](../agenticos-screenshot.png)

---

## Inhalt

- [Features](#features)
- [Tech-Stack](#tech-stack)
- [Architektur](#architektur)
- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Datenmodell](#datenmodell)
- [API-Referenz](#api-referenz)
- [Dateistruktur](#dateistruktur)
- [Entwicklung](#entwicklung)

---

## Features

### Agenten-Steuerung
- Beliebige CLI-Agenten konfigurierbar (Befehl, Argumente, Arbeitsverzeichnis, Farbe)
- **Chat-Modus**: Prompt senden → Antwort erscheint live via SSE-Stream
- **Terminal-Modus**: Freie Shell-Befehle im Arbeitsverzeichnis des Agents ausführen
- Agenten-Status in Echtzeit (grün = aktiv, gedimmt = idle)
- Laufende Tasks abbrechen (SIGTERM)
- Chat-Panel maximierbar und per Sidebar-Toggle ein-/ausblendbar

### Projekte
- Projekte-Grid mit Fortschrittsbalken (berechnet aus offenen/erledigten Todos)
- Status-Verwaltung: `active`, `planning`, `paused`, `completed`, `cancelled`
- Direktlink zur Detailansicht mit Todo-Filterung nach Projekt

### Todos / Kanban
- Drei Spalten: **Offen · In Arbeit · Erledigt**
- Drag & Drop zwischen Spalten (SortableJS)
- Filterung nach Projekt
- Neues Todo anlegen mit Titel, Projekt, Priorität, Scope und Tags
- Todos zwischen Projekten verschieben (inkl. Inbox)
- Listen- und Kanban-Ansicht umschaltbar

### Skills
- Skills aus dem Vault (`.claude/skills/{id}/SKILL.md`) anzeigen, bearbeiten und neu erstellen
- Markdown-Editor mit Live-Vorschau

### Agent Log
- History aller ausgeführten Tasks (max. 200 Einträge, persistent)
- Filterung nach Agent und Status
- Vollständige Ausgabe pro Task abrufbar

---

## Tech-Stack

| Bereich | Technologie |
|---|---|
| Backend | Node.js v20+ · Express 4 |
| Frontend | Vanilla HTML / CSS / JavaScript (kein Build-Schritt) |
| Markdown-Parsing | [gray-matter](https://github.com/jonschlinkert/gray-matter) |
| Markdown-Rendering | [marked](https://marked.js.org/) · [highlight.js](https://highlightjs.org/) |
| Drag & Drop | [SortableJS](https://sortablejs.github.io/Sortable/) |
| Icons | [Lucide](https://lucide.dev/) |
| Design | Catppuccin Mocha (Dark Theme) |
| Streaming | Server-Sent Events (SSE) |

---

## Architektur

```
Browser (Vanilla JS)
       │
       │  REST + SSE
       ▼
Express Server (server.js)
       │
       ├── /api/config       → config.json (lesen/schreiben)
       ├── /api/agents       → Agent-Definitionen aus config.json
       ├── /api/agents/:id/task  → child_process.spawn (CLI-Agent)
       ├── /api/agents/:id/stream → SSE-Stream (live output)
       ├── /api/exec         → Shell-Befehl im Agent-workDir
       ├── /api/projects     → Vault-Markdown oder data/projects.json
       ├── /api/todos        → Vault-Markdown oder data/todos.json
       └── /api/skills       → Vault .claude/skills/
```

### Dual Storage

Alle Daten-APIs prüfen zuerst `config.vaultPath`:

- **Mit Vault**: Liest direkt aus dem Obsidian-Vault (`2ndBrain/`) — Projekte und Todos als Markdown-Dateien mit YAML-Frontmatter.
- **Ohne Vault**: Fallback auf JSON-Dateien in `data/` (standalone-Modus).

### Agent-Ausführung

Agenten werden als Kindprozesse via `child_process.spawn` gestartet. Die Ausgabe (stdout/stderr) wird über SSE live in den Browser gestreamt. Laufende Tasks leben im In-Memory `taskMap`; abgeschlossene Tasks werden in `data/task-history.json` persistiert (max. 200 Einträge).

### Sicherheit

`safePath(base, rel)` validiert bei jedem Dateizugriff, dass der resultierende Pfad innerhalb des erlaubten Basisverzeichnisses liegt (verhindert Path-Traversal-Angriffe).

---

## Voraussetzungen

- **Node.js** v20 oder neuer
- Mindestens ein CLI-Agent installiert (z.B. `claude` via Claude Code CLI)
- Optional: [Obsidian](https://obsidian.md/) Vault als Datenspeicher

---

## Installation

```bash
# Repository klonen
git clone <repo-url> AgenticOS
cd AgenticOS

# Abhängigkeiten installieren
npm install

# Server starten
npm start
```

Danach im Browser öffnen: **http://localhost:4000**

---

## Konfiguration

Die Konfiguration liegt in `config.json` (gitignored — wird beim ersten Start automatisch angelegt oder kann manuell erstellt werden):

```json
{
  "port": 4000,
  "vaultPath": "/absoluter/pfad/zum/obsidian-vault",
  "agents": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "command": "claude",
      "args": ["--print"],
      "workDir": "/pfad/zum/arbeitsverzeichnis",
      "color": "#89b4fa",
      "description": "Claude Code CLI als KI-Agent"
    }
  ]
}
```

### Felder

| Feld | Typ | Beschreibung |
|---|---|---|
| `port` | number | HTTP-Port des Servers (Standard: `4000`) |
| `vaultPath` | string | Absoluter Pfad zum Obsidian-Vault; leer = standalone JSON-Modus |
| `agents[].id` | string | Einzigartiger Bezeichner (URL-safe) |
| `agents[].name` | string | Anzeigename im Dashboard |
| `agents[].command` | string | Ausführbarer Befehl (muss im PATH sein) |
| `agents[].args` | string[] | Feste Argumente, die vor dem Prompt eingefügt werden |
| `agents[].workDir` | string | Arbeitsverzeichnis für den Prozess |
| `agents[].color` | string | Hex-Farbe für die Sidebar-Anzeige |
| `agents[].description` | string | Kurzbeschreibung (optional) |

> Konfigurationsänderungen (außer `port`) werden ohne Server-Neustart wirksam, da `config.json` bei jedem Request neu eingelesen wird.

---

## Datenmodell

### Vault-Modus (empfohlen)

**Projekte** (`{vaultPath}/projects/*.md`):
```yaml
---
title: Mein Projekt
status: active          # active | planning | paused | completed | cancelled
priority: high          # high | medium | low
tags: [tag1, tag2]
scope: privat           # privat | beruflich
updated: 2026-05-14
---
```

**Todos — Projektdateien** (`{vaultPath}/todos/{project-id}/*.md`):
```yaml
---
title: Aufgabe erledigen
type: todo
status: open            # open | in-progress | done
priority: medium
scope: privat
project: "[[projects/mein-projekt]]"
created: 2026-05-14
updated: 2026-05-14
tags: []
---
```

**Todos — Inbox** (`{vaultPath}/todos/inbox.md`):
```markdown
- [ ] Offene Aufgabe
- [x] Erledigte Aufgabe
```

**Skills** (`{vaultPath}/.claude/skills/{id}/SKILL.md`):
```yaml
---
name: Skill-Name
description: Kurze Beschreibung
---

# Skill-Name

Vollständiger Skill-Inhalt als Markdown...
```

### Standalone-Modus (kein Vault)

| Datei | Inhalt |
|---|---|
| `data/projects.json` | Array von Projekt-Objekten |
| `data/todos.json` | Array von Todo-Objekten |
| `data/task-history.json` | Array der letzten 200 ausgeführten Tasks |

---

## API-Referenz

### Konfiguration
| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/config` | Aktuelle Konfiguration lesen |
| `POST` | `/api/config` | Konfiguration teilweise aktualisieren (merge) |

### Agenten
| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/agents` | Alle Agenten mit aktuellem Status |
| `POST` | `/api/agents` | Agent anlegen oder aktualisieren |
| `DELETE` | `/api/agents/:id` | Agent entfernen |
| `POST` | `/api/agents/:id/task` | Task starten → `{ taskId }` |
| `GET` | `/api/agents/:id/stream?taskId=` | SSE-Stream für laufenden Task |
| `POST` | `/api/agents/:id/stop` | Laufenden Task abbrechen (SIGTERM) |

### Tasks
| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/tasks` | Task-History (`?agentId=`, `?status=`, `?limit=`) |
| `GET` | `/api/tasks/:id` | Einzelner Task mit Ausgabe-Zeilen |

### Shell-Ausführung
| Methode | Pfad | Beschreibung |
|---|---|---|
| `POST` | `/api/exec` | Shell-Befehl im Agent-workDir ausführen → `{ taskId }` |
| `GET` | `/api/stream?taskId=` | SSE-Stream für exec-Task |

### Projekte
| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/projects` | Alle Projekte |
| `PATCH` | `/api/projects/:id` | Projekt-Status aktualisieren |

### Todos
| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/todos` | Alle Todos |
| `POST` | `/api/todos` | Neues Todo erstellen |
| `PATCH` | `/api/todos` | Todo-Status oder Projekt ändern |

### Skills
| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/skills` | Alle Skills |
| `GET` | `/api/skills/:id` | Skill-Inhalt lesen |
| `POST` | `/api/skills` | Neuen Skill erstellen |
| `PUT` | `/api/skills/:id` | Skill-Inhalt speichern |

---

## Dateistruktur

```
AgenticOS/
├── server.js              # Express-Server, alle API-Routen (~530 Zeilen)
├── config.json            # Konfiguration (gitignored)
├── package.json
│
├── public/
│   ├── index.html         # 3-Spalten-Layout (Sidebar / Content / Agent-Panel)
│   ├── app.js             # Frontend-Logik: State, Rendering, API-Aufrufe (~1400 Zeilen)
│   └── style.css          # Catppuccin Mocha Dark Theme
│
├── data/                  # JSON-Fallbackspeicher (kein Vault)
│   ├── projects.json
│   ├── todos.json
│   └── task-history.json  # Persistierte Task-History (max. 200)
│
└── scripts/               # Playwright Debug-/Screenshot-Skripte
    ├── screenshot.js
    └── ...
```

---

## Entwicklung

```bash
# Server mit Auto-Reload starten (node --watch)
npm run dev

# Playwright-Screenshots (für Debugging)
node scripts/screenshot.js
```

### Hinweise für Änderungen

- **Backend**: `server.js` ist bewusst als Single-File gehalten. Neue Routen nach dem bestehenden Muster (`// ── Name ───`) einfügen.
- **Frontend**: `public/app.js` hält den gesamten State in Modulvariablen. Kein Build-Schritt nötig — direkt bearbeiten und Browser neu laden.
- **Styling**: `public/style.css` verwendet CSS-Custom-Properties aus dem Catppuccin-Mocha-Farbsystem (`--base`, `--surface0`, `--blue`, `--green` etc.).
- **Pfadsicherheit**: Jeden neuen Dateizugriff aus User-Input über `safePath(base, rel)` absichern.

---

## Vorkonfigurierte Agenten

| Agent | Befehl | Arbeitsverzeichnis |
|---|---|---|
| Claude Code | `claude --print` | 2ndBrain Vault |
| Codex CLI | `codex` | Desktop (separat installieren) |
