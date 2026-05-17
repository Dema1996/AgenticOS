# CLAUDE.md
## by DMH

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm start          # node server.js (production)
npm run dev        # node --watch server.js (auto-reload)
```

Server runs on `http://127.0.0.1:4000` (localhost only — bound to 127.0.0.1, not 0.0.0.0).

## Architecture

**Backend** — `server.js` (~1250 lines), Express, no build step. `db.js` initializes SQLite (`data/agenticos.db`). `telegram.js` manages Telegraf bot instances. `config.json` is read on every request, so agent changes take effect immediately.

**Frontend** — `public/app.js` (~2400 lines) + `public/index.html`. Vanilla JS, no framework. Polls `/api/agents` every 5s for status.

**Dual storage** — APIs check `config.vaultPath` first (Obsidian vault markdown files), fall back to `data/*.json`.

**SQLite** (`data/agenticos.db`) — operative layer for Telegram messages and audit log. Tables: `messages` (chat history with `agent_id`), `audit_log` (append-only event log).

**Telegram Bridge** — `telegram.js` creates one Telegraf bot per agent that has `telegramToken` set. Auth via `TELEGRAM_CHAT_ID` env var. Messages are stored in SQLite and streamed back to the agent's CLI subprocess. Bot names sync automatically when an agent is renamed.

**Agent execution** — Agents are CLI commands spawned via `child_process.spawn`. Output streams to the browser via SSE. Live output lives in in-memory `taskMap`; completed tasks persist to `data/task-history.json` (capped at 200 entries).

**Path traversal guard** — `safePath(base, rel)` validates all file operations stay within their directory. Always use it for paths from API input.

## Key files

| File | Purpose |
|---|---|
| `server.js` | All API routes + agent process management |
| `db.js` | SQLite init (messages, audit_log tables) |
| `telegram.js` | Telegraf bot setup, multi-agent routing, bot-name sync |
| `public/app.js` | All frontend logic |
| `public/index.html` | 3-column layout shell |
| `public/style.css` | Catppuccin Mocha dark theme |
| `config.json` | Agent definitions, port, vaultPath (gitignored) |
| `.env` | TELEGRAM_CHAT_ID (gitignored) |
| `data/agenticos.db` | SQLite: Telegram messages + audit log |
| `data/task-history.json` | Agent run history (capped at 200) |
| `data/trash.json` | Soft-deleted skills/commands (31-day retention) |

## Agent config fields

```json
{
  "id": "main-agent",
  "name": "Main Agent",
  "command": "claude",
  "args": ["--print"],
  "workDir": "/path/to/vault",
  "color": "#89b4fa",
  "description": "...",
  "telegramToken": "123:abc..."
}
```

`telegramToken` is optional. When set, a Telegraf bot is started for this agent on server startup. Changing the token or adding one requires a server restart.

## Agent Templates (frontend)

Defined in `AGENT_TEMPLATES` (top of `app.js`):
- **Claude Code** — `claude --print [--model <id>]`; models: Sonnet 4.6 (default), Opus 4.7, Opus 4.6, Haiku 4.5
- **Codex CLI** — `codex exec --skip-git-repo-check [-c model="..."]`; models: Auto, o4-mini, o3
- **Andere** — free-form

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `TELEGRAM_CHAT_ID` | Only this chat ID may use the bots (auth guard) |

## API routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Read config.json |
| POST | `/api/config` | Save config.json |
| GET | `/api/agents` | List agents with live status |
| POST | `/api/agents` | Add/update agent (triggers bot-name sync if renamed) |
| DELETE | `/api/agents/:id` | Remove agent |
| POST | `/api/agents/:id/task` | Run task on agent |
| GET | `/api/agents/:id/stream` | SSE stream for task output |
| POST | `/api/agents/:id/stop` | Kill running task |
| GET | `/api/tasks` | Task history (`?agentId=`, `?status=`, `?limit=`) |
| GET | `/api/tasks/:id` | Single task with lines |
| GET | `/api/projects` | Vault projects |
| PATCH | `/api/projects/:id` | Update project status |
| GET | `/api/todos` | All todos (vault + inbox) |
| POST | `/api/todos` | Create todo |
| PATCH | `/api/todos` | Update todo status or reassign project |
| GET | `/api/skills` | List skills |
| GET/PUT | `/api/skills/:id` | Read/write skill |
| POST | `/api/skills` | Create skill |
| DELETE | `/api/skills/:id` | Move to trash |
| GET | `/api/commands` | Slash commands (global + vault) |
| GET/PUT | `/api/commands/:id` | Read/write command |
| POST | `/api/commands` | Create command |
| DELETE | `/api/commands/:id` | Move to trash |
| GET | `/api/claudemd` | CLAUDE.md for agent workDir |
| PUT | `/api/claudemd` | Write CLAUDE.md |
| GET | `/api/plugins` | Installed + available plugins |
| POST | `/api/plugins/install` | Install plugin (SSE stream) |
| POST | `/api/plugins/uninstall` | Uninstall plugin (SSE stream) |
| POST | `/api/exec` | Shell command in agent workDir (SSE via `/api/stream`) |
| GET | `/api/file` | Render vault markdown file as HTML |
| GET | `/api/list` | File tree for vault directory |
| GET | `/api/graph` | Wikilink graph (nodes + edges) |
| GET | `/api/search` | Full-text search over vault |
| GET | `/api/kanban` | Kanban cards for a vault directory |
| GET | `/api/trash` | List trash (triggers cleanup) |
| POST | `/api/trash/:id/restore` | Restore item |
| DELETE | `/api/trash/:id` | Permanently delete |
| GET | `/api/telegram/messages` | Chat history (`?agent_id=`, `?limit=`) |
| GET | `/api/telegram/status` | Active bots + message count |

## Planned next phases

| Phase | Focus |
|---|---|
| 2 | Mission Control Kanban — SQLite task queue, Queued→Running→Done, Auto-Assign |
| 3 | Scheduler — node-cron, UI, morgen/abend automatisieren |
| 4 | Hive Mind Views — hive_mind_log, 2D Graph, Memory Tab |
| 5 | War Room — /standup, /discuss, Multi-Agent-Konsolidierung |
