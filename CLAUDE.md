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

**Single-file backend** (`server.js`, ~530 lines) — Express server with no build step. Config is read from disk on every request via `readConfig()`, so changes to `config.json` take effect without restart.

**Single-file frontend** (`public/app.js`, ~1400 lines + `public/index.html`) — Vanilla JS, no framework, no bundler. State is held in module-level variables. UI polls `/api/agents` every 5 seconds for status updates.

**Dual storage model** — All data APIs (projects, todos, skills) check `config.vaultPath` first and read from the linked Obsidian vault (`2ndBrain/`) as markdown files with YAML frontmatter. If no vault is configured they fall back to flat JSON files in `data/`.

**Agent execution** — Agents are CLI commands (e.g. `claude --print`) spawned via `child_process.spawn`. Output streams to the browser via SSE (`/api/agents/:id/stream`). Live output lives in in-memory `taskMap`; completed tasks are persisted to `data/task-history.json` (capped at 200 entries).

**Path traversal guard** — `safePath(base, rel)` validates that all file operations stay within their intended directory. Use it whenever constructing paths from user/API input.

## Key files

| File | Purpose |
|---|---|
| `server.js` | All API routes + agent process management |
| `public/app.js` | All frontend logic (state, rendering, API calls) |
| `public/index.html` | 3-column layout shell (sidebar / main / agent panel) |
| `public/style.css` | Catppuccin Mocha dark theme |
| `config.json` | Agent definitions, port, vaultPath (gitignored) |
| `data/` | Fallback JSON storage when no vault is configured |
| `scripts/` | Playwright debug/screenshot scripts |

## Data model

**Vault todos** live in two forms:
- `todos/{project-id}/*.md` — one file per todo, frontmatter-only (`title`, `status`, `priority`, `project`, `scope`, `tags`)
- `todos/inbox.md` — markdown checkboxes (`- [ ] text`)

**Vault projects** live in `projects/*.md` with frontmatter: `title`, `status`, `priority`, `tags`, `scope`, `updated`.

**Skills** live in `{vaultPath}/.claude/skills/{id}/SKILL.md` with YAML frontmatter (`name`, `description`).

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
