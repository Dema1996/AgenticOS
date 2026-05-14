'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const matter = require('gray-matter');

const app = express();
app.use(express.json());

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'task-history.json');
const TRASH_PATH = path.join(DATA_DIR, 'trash.json');
const TRASH_RETENTION_DAYS = 31;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { port: 4000, vaultPath: '', agents: [] }; }
}

function safePath(base, rel) {
  const b = path.resolve(base);
  const r = path.resolve(base, rel);
  if (r !== b && !r.startsWith(b + path.sep)) throw new Error('Path traversal');
  return r;
}

// ── Task state ────────────────────────────────────────────────────────────────
const taskMap = new Map();
let taskHistory = [];
try { taskHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); }
catch { taskHistory = []; }

function saveTasks() {
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(taskHistory.slice(0, 200), null, 2)); }
  catch {}
}

// ── Trash helpers ─────────────────────────────────────────────────────────────
function readTrash() {
  try { return JSON.parse(fs.readFileSync(TRASH_PATH, 'utf8')); }
  catch { return []; }
}
function writeTrash(items) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRASH_PATH, JSON.stringify(items, null, 2));
}
function cleanupTrash(items) {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400_000;
  return items.filter(i => new Date(i.deletedAt).getTime() > cutoff);
}
function trashId() {
  return `trash-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(ROOT, 'public')));
app.get('/lib/marked.min.js', (_req, res) =>
  res.sendFile(path.join(ROOT, 'node_modules/marked/marked.min.js')));
app.get('/lib/sortable.min.js', (_req, res) =>
  res.sendFile(path.join(ROOT, 'node_modules/sortablejs/Sortable.min.js')));

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => res.json(readConfig()));

app.post('/api/config', (req, res) => {
  const merged = { ...readConfig(), ...req.body };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  res.json(merged);
});

// ── Agents ────────────────────────────────────────────────────────────────────
app.get('/api/agents', (_req, res) => {
  const { agents = [] } = readConfig();
  res.json(agents.map(a => ({
    ...a,
    status: [...taskMap.values()].some(t => t.entry.agentId === a.id && !t.done)
      ? 'running' : 'idle',
  })));
});

app.post('/api/agents', (req, res) => {
  const cfg = readConfig();
  const agent = req.body;
  if (!agent.id || !agent.command) return res.status(400).json({ error: 'id and command required' });
  cfg.agents = cfg.agents.filter(a => a.id !== agent.id);
  cfg.agents.push(agent);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json(agent);
});

app.delete('/api/agents/:id', (req, res) => {
  const cfg = readConfig();
  cfg.agents = cfg.agents.filter(a => a.id !== req.params.id);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json({ ok: true });
});

// ── Run task ──────────────────────────────────────────────────────────────────
app.post('/api/agents/:id/task', (req, res) => {
  const { agents = [] } = readConfig();
  const agent = agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const prompt = req.body.prompt?.trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const taskId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cmdArgs = [...(agent.args || []), prompt];

  let proc;
  try {
    proc = spawn(agent.command, cmdArgs, {
      cwd: agent.workDir || ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `Spawn fehlgeschlagen: ${err.message}` });
  }

  const entry = {
    id: taskId, agentId: agent.id, agentName: agent.name, agentColor: agent.color,
    prompt, status: 'running',
    startedAt: new Date().toISOString(), completedAt: null, exitCode: null,
  };
  taskHistory.unshift(entry);

  const state = { proc, lines: [], done: false, sseClients: new Set(), entry };
  taskMap.set(taskId, state);

  const emit = (text, type) => {
    const line = { text, type, ts: Date.now() };
    state.lines.push(line);
    const msg = `data: ${JSON.stringify({ ...line, done: false })}\n\n`;
    for (const c of state.sseClients) c.write(msg);
  };

  proc.stdout.on('data', d => emit(d.toString(), 'stdout'));
  proc.stderr.on('data', d => emit(d.toString(), 'stderr'));

  proc.on('error', err => {
    emit(`\nFehler: ${err.message}\n`, 'stderr');
    state.done = true;
    entry.status = 'error';
    entry.completedAt = new Date().toISOString();
    saveTasks();
    for (const c of state.sseClients) {
      c.write(`data: ${JSON.stringify({ type: 'done', done: true })}\n\n`);
      c.end();
    }
    state.sseClients.clear();
  });

  proc.on('close', code => {
    emit(`\n[Prozess beendet · Code ${code}]\n`, 'system');
    state.done = true;
    entry.status = code === 0 ? 'done' : 'error';
    entry.exitCode = code;
    entry.completedAt = new Date().toISOString();
    entry.lines = state.lines.slice(0, 500);
    saveTasks();
    for (const c of state.sseClients) {
      c.write(`data: ${JSON.stringify({ type: 'done', done: true })}\n\n`);
      c.end();
    }
    state.sseClients.clear();
  });

  res.json({ taskId, agentId: agent.id });
});

// ── SSE stream ────────────────────────────────────────────────────────────────
app.get('/api/agents/:id/stream', (req, res) => {
  const { taskId } = req.query;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });

  const state = taskMap.get(taskId);
  if (!state) return res.status(404).json({ error: 'Task nicht gefunden' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  for (const line of state.lines) {
    res.write(`data: ${JSON.stringify({ ...line, done: false })}\n\n`);
  }

  if (state.done) {
    res.write(`data: ${JSON.stringify({ type: 'done', done: true })}\n\n`);
    return res.end();
  }

  state.sseClients.add(res);
  req.on('close', () => state.sseClients.delete(res));
});

// ── Stop task ─────────────────────────────────────────────────────────────────
app.post('/api/agents/:id/stop', (req, res) => {
  const state = taskMap.get(req.body.taskId);
  if (!state || state.done) return res.status(404).json({ error: 'Kein laufender Task' });
  state.proc?.kill('SIGTERM');
  res.json({ ok: true });
});

// ── Task history ──────────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const { agentId, status, limit = '50' } = req.query;
  let tasks = taskHistory;
  if (agentId) tasks = tasks.filter(t => t.agentId === agentId);
  if (status)  tasks = tasks.filter(t => t.status === status);
  res.json(tasks.slice(0, parseInt(limit, 10)).map(({ lines, ...t }) => t));
});

app.get('/api/tasks/:id', (req, res) => {
  const task = taskHistory.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task nicht gefunden' });
  // Prefer live lines from taskMap (running task), fall back to persisted lines
  const live = taskMap.get(task.id);
  const lines = live ? live.lines : (task.lines || []);
  res.json({ ...task, lines, running: !!(live && !live.done) });
});

// ── Projects (dual storage) ───────────────────────────────────────────────────
app.get('/api/projects', (_req, res) => {
  const { vaultPath } = readConfig();
  if (vaultPath) {
    const dir = path.join(vaultPath, 'projects');
    try {
      const projects = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const { data } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            id: f.replace('.md', ''),
            file: `projects/${f}`,
            title: data.title || f.replace(/-/g, ' ').replace('.md', ''),
            status: data.status || 'active',
            priority: data.priority || null,
            tags: data.tags || [],
            scope: data.scope || null,
            updated: data.updated || null,
          };
        });
      return res.json(projects);
    } catch { return res.json([]); }
  }
  try { res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8'))); }
  catch { res.json([]); }
});

// ── Project status update ─────────────────────────────────────────────────────
app.patch('/api/projects/:id', (req, res) => {
  const { vaultPath } = readConfig();
  const { id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  if (!vaultPath) return res.status(501).json({ error: 'Kein Vault konfiguriert' });
  try {
    const filePath = safePath(path.join(vaultPath, 'projects'), `${id}.md`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    parsed.data.status = status;
    parsed.data.updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Todos (dual storage) ──────────────────────────────────────────────────────
app.get('/api/todos', (_req, res) => {
  const { vaultPath } = readConfig();
  if (vaultPath) {
    const dir = path.join(vaultPath, 'todos');
    try {
      const todos = [];
      for (const entry of fs.readdirSync(dir)) {
        const entryPath = path.join(dir, entry);
        const stat = fs.statSync(entryPath);

        if (stat.isDirectory()) {
          // Project todos: todos/{project-id}/*.md — each file is one todo via frontmatter
          for (const f of fs.readdirSync(entryPath).filter(f => f.endsWith('.md'))) {
            try {
              const { data } = matter(fs.readFileSync(path.join(entryPath, f), 'utf8'));
              if (!data.title) continue;
              todos.push({
                file: `${entry}/${f}`,
                text: data.title,
                status: data.status || 'open',
                priority: data.priority || null,
                project: entry,
                scope: data.scope || null,
                tags: data.tags || [],
              });
            } catch {}
          }
        } else if (entry.endsWith('.md')) {
          // Flat files (inbox.md, etc.) — parse markdown checkboxes
          const { content } = matter(fs.readFileSync(entryPath, 'utf8'));
          for (const line of content.split('\n')) {
            const open = line.match(/^- \[ \] (.+)/);
            const done = line.match(/^- \[x\] (.+)/i);
            if (open) todos.push({ file: entry, text: open[1], status: 'open', project: null });
            else if (done) todos.push({ file: entry, text: done[1], status: 'done', project: null });
          }
        }
      }
      return res.json(todos);
    } catch { return res.json([]); }
  }
  try { res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'todos.json'), 'utf8'))); }
  catch { res.json([]); }
});

// ── Toggle todo ───────────────────────────────────────────────────────────────
app.post('/api/todos', (req, res) => {
  const { vaultPath } = readConfig();
  if (!vaultPath) return res.status(501).json({ error: 'Kein Vault konfiguriert' });
  const { title, project, priority = 'medium', scope = 'privat', tags = [] } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel fehlt' });
  try {
    const todosDir = path.join(vaultPath, 'todos');
    const today = new Date().toISOString().split('T')[0];
    if (!project || project === '__inbox__') {
      // Append checkbox to inbox.md
      const inboxPath = path.join(todosDir, 'inbox.md');
      let inbox = '';
      try { inbox = fs.readFileSync(inboxPath, 'utf8'); } catch {}
      inbox = inbox.trimEnd() + `\n- [ ] ${title.trim()}\n`;
      fs.writeFileSync(inboxPath, inbox);
    } else {
      const slug = title.trim().toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'todo';
      const dir = safePath(todosDir, project);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Avoid overwriting existing file
      let filename = `${slug}.md`;
      let i = 2;
      while (fs.existsSync(path.join(dir, filename))) filename = `${slug}-${i++}.md`;
      const tagList = typeof tags === 'string'
        ? tags.split(',').map(t => t.trim()).filter(Boolean)
        : tags;
      fs.writeFileSync(path.join(dir, filename), matter.stringify('', {
        title: title.trim(), type: 'todo', scope,
        status: 'open', priority,
        project: `[[projects/${project}]]`,
        created: today, updated: today,
        tags: tagList,
      }));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/todos', (req, res) => {
  const { vaultPath } = readConfig();
  const { file, text, status, newProject } = req.body;
  if (!vaultPath) return res.status(501).json({ error: 'Eigener Speicher: Todo-Updates noch nicht unterstützt' });
  try {
    const todosDir = path.join(vaultPath, 'todos');
    const fullPath = safePath(todosDir, file);
    const today = new Date().toISOString().split('T')[0];

    if (newProject !== undefined) {
      // ── Project reassignment ──────────────────────────────────────────────
      if (file.includes('/')) {
        // Source: frontmatter project todo
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = matter(raw);
        const title = parsed.data.title || text;
        if (!newProject || newProject === '__inbox__') {
          // Move to inbox.md as checkbox
          const inboxPath = path.join(todosDir, 'inbox.md');
          let inbox = '';
          try { inbox = fs.readFileSync(inboxPath, 'utf8'); } catch {}
          inbox = inbox.trimEnd() + `\n- [ ] ${title}\n`;
          fs.writeFileSync(inboxPath, inbox);
          fs.unlinkSync(fullPath);
        } else {
          // Move to different project folder
          const newDir = safePath(todosDir, newProject);
          if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
          parsed.data.project = `[[projects/${newProject}]]`;
          parsed.data.updated = today;
          const newFilePath = path.join(newDir, path.basename(file));
          fs.writeFileSync(newFilePath, matter.stringify(parsed.content, parsed.data));
          if (newFilePath !== fullPath) fs.unlinkSync(fullPath);
        }
      } else {
        // Source: inbox checkbox todo
        if (newProject && newProject !== '__inbox__') {
          const slug = text.toLowerCase()
            .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'todo';
          const newDir = safePath(todosDir, newProject);
          if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
          const newFilePath = path.join(newDir, `${slug}.md`);
          fs.writeFileSync(newFilePath, matter.stringify('', {
            title: text, type: 'todo', scope: 'privat',
            status: status || 'open', priority: 'medium',
            project: `[[projects/${newProject}]]`,
            created: today, updated: today, tags: [],
          }));
          // Remove checkbox from inbox
          const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let raw = fs.readFileSync(fullPath, 'utf8');
          raw = raw.replace(new RegExp(`^- \\[[ x]\\] ${escaped}\\r?\\n?`, 'm'), '');
          fs.writeFileSync(fullPath, raw);
        }
      }
      return res.json({ ok: true });
    }

    // ── Status update (existing logic) ────────────────────────────────────
    if (file.includes('/')) {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = matter(raw);
      parsed.data.status = status;
      parsed.data.updated = today;
      fs.writeFileSync(fullPath, matter.stringify(parsed.content, parsed.data));
    } else {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let raw = fs.readFileSync(fullPath, 'utf8');
      raw = status === 'done'
        ? raw.replace(new RegExp(`^(- )\\[ \\] (${escaped})`, 'm'), '$1[x] $2')
        : raw.replace(new RegExp(`^(- )\\[x\\] (${escaped})`, 'im'), '$1[ ] $2');
      fs.writeFileSync(fullPath, raw);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Skills ────────────────────────────────────────────────────────────────────
app.get('/api/skills', (_req, res) => {
  const { vaultPath } = readConfig();
  if (!vaultPath) return res.json([]);
  const dir = path.join(vaultPath, '.claude', 'skills');
  try {
    const skills = fs.readdirSync(dir)
      .filter(f => {
        try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; }
      })
      .map(id => {
        try {
          const raw = fs.readFileSync(path.join(dir, id, 'SKILL.md'), 'utf8');
          const { data } = matter(raw);
          return { id, name: data.name || id, description: data.description || '', content: raw };
        } catch {
          return { id, name: id, description: '', content: '' };
        }
      });
    res.json(skills);
  } catch { res.json([]); }
});

app.get('/api/skills/:id', (req, res) => {
  const { vaultPath } = readConfig();
  if (!vaultPath) return res.status(404).json({ error: 'Kein Vault konfiguriert' });
  try {
    const p = safePath(path.join(vaultPath, '.claude', 'skills'), path.join(req.params.id, 'SKILL.md'));
    res.json({ id: req.params.id, content: fs.readFileSync(p, 'utf8') });
  } catch { res.status(404).json({ error: 'Skill nicht gefunden' }); }
});

app.put('/api/skills/:id', (req, res) => {
  const { vaultPath } = readConfig();
  if (!vaultPath) return res.status(501).json({ error: 'Kein Vault konfiguriert' });
  if (!req.body.content) return res.status(400).json({ error: 'content required' });
  try {
    const p = safePath(path.join(vaultPath, '.claude', 'skills'), path.join(req.params.id, 'SKILL.md'));
    fs.writeFileSync(p, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/skills', (req, res) => {
  const { vaultPath } = readConfig();
  if (!vaultPath) return res.status(501).json({ error: 'Kein Vault konfiguriert' });
  const { id, name, description } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id und name erforderlich' });
  try {
    const dir = path.join(vaultPath, '.claude', 'skills', id);
    if (fs.existsSync(dir)) return res.status(409).json({ error: 'Skill existiert bereits' });
    fs.mkdirSync(dir, { recursive: true });
    const content = `---\nname: ${name}\ndescription: ${description || ''}\n---\n\n# ${name}\n\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/skills/:id', (req, res) => {
  const { vaultPath } = readConfig();
  if (!vaultPath) return res.status(501).json({ error: 'Kein Vault konfiguriert' });
  const skillsBase = path.join(vaultPath, '.claude', 'skills');
  try {
    const skillDir = safePath(skillsBase, req.params.id);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const content = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : '';
    const { data } = matter(content);

    const trash = cleanupTrash(readTrash());
    trash.unshift({
      trashId: trashId(),
      type: 'skill',
      id: req.params.id,
      name: data.name || req.params.id,
      content,
      originalDir: skillDir,
      deletedAt: new Date().toISOString(),
    });
    writeTrash(trash);
    fs.rmSync(skillDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CLAUDE.md (per agent workDir) ─────────────────────────────────────────────
app.get('/api/claudemd', (req, res) => {
  const { agentId } = req.query;
  const { agents = [] } = readConfig();
  const agent = agents.find(a => a.id === agentId);
  if (!agent?.workDir) return res.status(404).json({ error: 'Agent oder Arbeitsverzeichnis nicht gefunden' });
  const filePath = path.join(agent.workDir, 'CLAUDE.md');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, exists: true, agentId, workDir: agent.workDir });
  } catch {
    res.json({ content: '', exists: false, agentId, workDir: agent.workDir });
  }
});

app.put('/api/claudemd', (req, res) => {
  const { agentId } = req.query;
  const { agents = [] } = readConfig();
  const agent = agents.find(a => a.id === agentId);
  if (!agent?.workDir) return res.status(404).json({ error: 'Agent oder Arbeitsverzeichnis nicht gefunden' });
  if (req.body.content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    const filePath = safePath(agent.workDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Plugins ───────────────────────────────────────────────────────────────────
app.get('/api/plugins', (_req, res) => {
  const proc = spawn('claude', ['plugin', 'list', '--json', '--available'], {
    env: process.env,
  });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.on('close', () => {
    try { res.json(JSON.parse(out)); }
    catch { res.json({ installed: [], available: [] }); }
  });
  proc.on('error', () => res.json({ installed: [], available: [] }));
});

function spawnPluginTask(args, res) {
  const taskId = `plugin-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  let proc;
  try {
    proc = spawn('claude', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const state = { proc, lines: [], done: false, sseClients: new Set(), entry: { id: taskId } };
  taskMap.set(taskId, state);

  const emit = (text, type) => {
    const line = { text, type, ts: Date.now() };
    state.lines.push(line);
    const msg = `data: ${JSON.stringify({ ...line, done: false })}\n\n`;
    for (const c of state.sseClients) c.write(msg);
  };
  proc.stdout.on('data', d => emit(d.toString(), 'stdout'));
  proc.stderr.on('data', d => emit(d.toString(), 'stderr'));
  proc.on('error', err => {
    emit(`Fehler: ${err.message}\n`, 'stderr');
    state.done = true;
    for (const c of state.sseClients) { c.write(`data: ${JSON.stringify({ type: 'done', done: true, exitCode: 1 })}\n\n`); c.end(); }
    state.sseClients.clear();
  });
  proc.on('close', code => {
    state.done = true;
    for (const c of state.sseClients) { c.write(`data: ${JSON.stringify({ type: 'done', done: true, exitCode: code })}\n\n`); c.end(); }
    state.sseClients.clear();
  });
  res.json({ taskId });
}

app.post('/api/plugins/install', (req, res) => {
  const { pluginId } = req.body;
  if (!pluginId) return res.status(400).json({ error: 'pluginId required' });
  spawnPluginTask(['plugin', 'install', pluginId], res);
});

app.post('/api/plugins/uninstall', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  spawnPluginTask(['plugin', 'uninstall', name, '-y'], res);
});

// ── Slash Commands ────────────────────────────────────────────────────────────
const USER_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');

function readCommandDirs() {
  const { vaultPath } = readConfig();
  const dirs = [{ dir: USER_COMMANDS_DIR, scope: 'global' }];
  if (vaultPath) dirs.push({ dir: path.join(vaultPath, '.claude', 'commands'), scope: 'vault' });
  return dirs;
}

app.get('/api/commands', (_req, res) => {
  const commands = [];
  for (const { dir, scope } of readCommandDirs()) {
    try {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf8');
          const id = f.replace(/\.md$/, '');
          commands.push({ id, name: `/${id}`, scope, content, dir });
        } catch {}
      }
    } catch {}
  }
  res.json(commands);
});

app.get('/api/commands/:id', (req, res) => {
  for (const { dir } of readCommandDirs()) {
    try {
      const p = safePath(dir, `${req.params.id}.md`);
      const content = fs.readFileSync(p, 'utf8');
      return res.json({ id: req.params.id, content, dir });
    } catch {}
  }
  res.status(404).json({ error: 'Command nicht gefunden' });
});

app.put('/api/commands/:id', (req, res) => {
  if (!req.body.content) return res.status(400).json({ error: 'content required' });
  const { dir } = req.body;
  const base = dir || USER_COMMANDS_DIR;
  try {
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    const p = safePath(base, `${req.params.id}.md`);
    fs.writeFileSync(p, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/commands', (req, res) => {
  const { id, content = '' } = req.body;
  if (!id) return res.status(400).json({ error: 'id erforderlich' });
  const safeId = id.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  try {
    if (!fs.existsSync(USER_COMMANDS_DIR)) fs.mkdirSync(USER_COMMANDS_DIR, { recursive: true });
    const p = safePath(USER_COMMANDS_DIR, `${safeId}.md`);
    if (fs.existsSync(p)) return res.status(409).json({ error: 'Command existiert bereits' });
    fs.writeFileSync(p, content || `# /${safeId}\n\n`, 'utf8');
    res.json({ ok: true, id: safeId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/commands/:id', (req, res) => {
  const { dir } = req.query;
  const base = dir || USER_COMMANDS_DIR;
  try {
    const p = safePath(base, `${req.params.id}.md`);
    const content = fs.readFileSync(p, 'utf8');

    const trash = cleanupTrash(readTrash());
    trash.unshift({
      trashId: trashId(),
      type: 'command',
      id: req.params.id,
      name: `/${req.params.id}`,
      content,
      originalPath: p,
      deletedAt: new Date().toISOString(),
    });
    writeTrash(trash);
    fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Trash ─────────────────────────────────────────────────────────────────────
app.get('/api/trash', (_req, res) => {
  const items = cleanupTrash(readTrash());
  writeTrash(items); // persist cleanup
  res.json(items.map(i => ({
    ...i,
    daysLeft: Math.ceil((new Date(i.deletedAt).getTime() + TRASH_RETENTION_DAYS * 86400_000 - Date.now()) / 86400_000),
  })));
});

app.post('/api/trash/:trashId/restore', (req, res) => {
  const trash = cleanupTrash(readTrash());
  const item = trash.find(i => i.trashId === req.params.trashId);
  if (!item) return res.status(404).json({ error: 'Nicht gefunden' });
  try {
    if (item.type === 'skill') {
      fs.mkdirSync(item.originalDir, { recursive: true });
      fs.writeFileSync(path.join(item.originalDir, 'SKILL.md'), item.content, 'utf8');
    } else {
      const dir = path.dirname(item.originalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(item.originalPath, item.content, 'utf8');
    }
    writeTrash(trash.filter(i => i.trashId !== req.params.trashId));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/trash/:trashId', (_req, res) => {
  const trash = cleanupTrash(readTrash());
  writeTrash(trash.filter(i => i.trashId !== _req.params.trashId));
  res.json({ ok: true });
});

// ── Generic SSE stream (for exec tasks) ──────────────────────────────────────
app.get('/api/stream', (req, res) => {
  const { taskId } = req.query;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  const state = taskMap.get(taskId);
  if (!state) return res.status(404).json({ error: 'Task nicht gefunden' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  for (const line of state.lines) res.write(`data: ${JSON.stringify({ ...line, done: false })}\n\n`);
  if (state.done) { res.write(`data: ${JSON.stringify({ type: 'done', done: true })}\n\n`); return res.end(); }

  state.sseClients.add(res);
  req.on('close', () => state.sseClients.delete(res));
});

// ── Execute shell command ─────────────────────────────────────────────────────
app.post('/api/exec', (req, res) => {
  const { command, agentId } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command required' });

  const { agents = [] } = readConfig();
  const agent = agents.find(a => a.id === agentId);
  const cwd = agent?.workDir || ROOT;
  const taskId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  let proc;
  try {
    proc = spawn('/bin/zsh', ['-c', command], { cwd, env: process.env });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const state = { proc, lines: [], done: false, sseClients: new Set(), entry: { id: taskId } };
  taskMap.set(taskId, state);

  const emit = (text, type) => {
    const line = { text, type, ts: Date.now() };
    state.lines.push(line);
    const msg = `data: ${JSON.stringify({ ...line, done: false })}\n\n`;
    for (const c of state.sseClients) c.write(msg);
  };

  proc.stdout.on('data', d => emit(d.toString(), 'stdout'));
  proc.stderr.on('data', d => emit(d.toString(), 'stderr'));
  proc.on('error', err => {
    emit(`Fehler: ${err.message}\n`, 'stderr');
    state.done = true;
    for (const c of state.sseClients) { c.write(`data: ${JSON.stringify({ type: 'done', done: true })}\n\n`); c.end(); }
    state.sseClients.clear();
  });
  proc.on('close', () => {
    state.done = true;
    for (const c of state.sseClients) { c.write(`data: ${JSON.stringify({ type: 'done', done: true })}\n\n`); c.end(); }
    state.sseClients.clear();
  });

  res.json({ taskId });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const { port = 4000 } = readConfig();
app.listen(port, () => {
  console.log(`\n⚡ AgenticOS → http://localhost:${port}\n`);
});
