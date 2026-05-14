# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (production)
npm start          # node server.js

# Start with auto-reload on file changes
npm run dev        # node --watch server.js
```

Server runs on `http://localhost:4000` by default (configurable in `config.json`).

## Architecture

**Single-file backend** (`server.js`, ~800 lines) — Express server with no build step. Config is read from disk on every request via `readConfig()`, so changes to `config.json` take effect without restart.

**Single-file frontend** (`public/app.js`, ~2100 lines + `public/index.html`) — Vanilla JS, no framework, no bundler. State is held in module-level variables. UI polls `/api/agents` every 5 seconds for status updates.

**Dual storage model** — All data APIs (projects, todos, skills) check `config.vaultPath` first and read from the linked Obsidian vault (`2ndBrain/`) as markdown files with YAML frontmatter. If no vault is configured they fall back to flat JSON files in `data/`.

**Agent execution** — Agents are CLI commands (e.g. `claude --print`) spawned via `child_process.spawn`. Output streams to the browser via SSE (`/api/agents/:id/stream`). Live output lives in in-memory `taskMap`; completed tasks are persisted to `data/task-history.json` (capped at 200 entries).

**Slash command execution** — Any slash command (`/command-name [args]`) can be sent directly to an agent as a task prompt. The UI exposes a modal (agent selector + optional args) triggered from the Commands view.

**Trash system** — Deleted skills and slash commands are moved to `data/trash.json` instead of being permanently removed. Items are auto-purged after 31 days. The backend runs cleanup on every `GET /api/trash` call; no cron job is needed.

**Path traversal guard** — `safePath(base, rel)` validates that all file operations stay within their intended directory. Use it whenever constructing paths from user/API input.

## Key files

| File | Purpose |
|---|---|
| `server.js` | All API routes + agent process management |
| `public/app.js` | All frontend logic (state, rendering, API calls) |
| `public/index.html` | 3-column layout shell (sidebar / main / agent panel) |
| `public/style.css` | Catppuccin Mocha dark theme |
| `config.json` | Agent definitions, port, vaultPath (gitignored) |
| `data/task-history.json` | Completed task log (capped at 200 entries) |
| `data/trash.json` | Soft-deleted skills and commands (31-day retention) |
| `scripts/` | Playwright debug/screenshot scripts |

## Data model

**Vault todos** live in two forms:
- `todos/{project-id}/*.md` — one file per todo, frontmatter-only (`title`, `status`, `priority`, `project`, `scope`, `tags`)
- `todos/inbox.md` — markdown checkboxes (`- [ ] text`)

**Vault projects** live in `projects/*.md` with frontmatter: `title`, `status`, `priority`, `tags`, `scope`, `updated`.

**Skills** live in `{vaultPath}/.claude/skills/{id}/SKILL.md` with YAML frontmatter (`name`, `description`).

**Slash commands** live in `~/.claude/commands/*.md` (global scope) and optionally `{vaultPath}/.claude/commands/*.md` (vault scope). Both locations are merged and served via `GET /api/commands`.

**Trash entries** in `data/trash.json` each carry: `trashId`, `type` (`skill`|`command`), `id`, `name`, `content` (full file text), `originalDir`/`originalPath`, `deletedAt` (ISO timestamp).

## API routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Read config.json |
| POST | `/api/config` | Save config.json |
| GET | `/api/agents` | List agents with live status |
| POST | `/api/agents` | Add/update agent |
| DELETE | `/api/agents/:id` | Remove agent |
| POST | `/api/agents/:id/task` | Run a task (or slash command) on an agent |
| GET | `/api/agents/:id/stream` | SSE stream for agent task output |
| POST | `/api/agents/:id/stop` | Kill running task |
| GET | `/api/tasks` | Task history |
| GET | `/api/projects` | List vault projects |
| GET | `/api/todos` | List todos |
| POST | `/api/todos` | Create todo |
| GET | `/api/skills` | List skills |
| GET/PUT | `/api/skills/:id` | Read/write skill |
| POST | `/api/skills` | Create skill |
| DELETE | `/api/skills/:id` | Move skill to trash |
| GET | `/api/commands` | List slash commands (global + vault) |
| GET/PUT | `/api/commands/:id` | Read/write command |
| POST | `/api/commands` | Create command |
| DELETE | `/api/commands/:id` | Move command to trash |
| GET | `/api/trash` | List trash items (triggers 31-day cleanup) |
| POST | `/api/trash/:trashId/restore` | Restore item to original location |
| DELETE | `/api/trash/:trashId` | Permanently delete trash item |
| GET | `/api/claudemd` | Read CLAUDE.md for an agent's workDir |
| PUT | `/api/claudemd` | Write CLAUDE.md |
| GET | `/api/plugins` | List installed + available plugins |
| POST | `/api/plugins/install` | Install a plugin (streams output) |
| POST | `/api/plugins/uninstall` | Uninstall a plugin (streams output) |
| POST | `/api/exec` | Execute a shell command in an agent's workDir |
| GET | `/api/stream` | SSE stream for exec task output |

## Config structure

`config.json` (gitignored — copy from example if starting fresh):
```json
{
  "port": 4000,
  "vaultPath": "/absolute/path/to/obsidian-vault",
  "agents": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "command": "claude",
      "args": ["--print"],
      "workDir": "/path/to/workdir",
      "color": "#89b4fa",
      "description": "..."
    }
  ]
}
```
