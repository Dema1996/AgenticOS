'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const matter = require('gray-matter');

const app = express();
app.use(express.json());

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'task-history.json');

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
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(taskHistory.slice(0, 500), null, 2)); }
  catch {}
}

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(ROOT, 'public')));

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
  res.json(tasks.slice(0, parseInt(limit, 10)));
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

// ── Todos (dual storage) ──────────────────────────────────────────────────────
app.get('/api/todos', (_req, res) => {
  const { vaultPath } = readConfig();
  if (vaultPath) {
    const dir = path.join(vaultPath, 'todos');
    try {
      const todos = [];
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
        const { data, content } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const line of content.split('\n')) {
          const open = line.match(/^- \[ \] (.+)/);
          const done = line.match(/^- \[x\] (.+)/i);
          if (open) todos.push({ file: f, text: open[1], status: 'open', project: data.project || null });
          else if (done) todos.push({ file: f, text: done[1], status: 'done', project: data.project || null });
        }
      }
      return res.json(todos);
    } catch { return res.json([]); }
  }
  try { res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'todos.json'), 'utf8'))); }
  catch { res.json([]); }
});

// ── Toggle todo ───────────────────────────────────────────────────────────────
app.patch('/api/todos', (req, res) => {
  const { vaultPath } = readConfig();
  const { file, text, status } = req.body;
  if (!vaultPath) return res.status(501).json({ error: 'Eigener Speicher: Todo-Updates noch nicht unterstützt' });
  try {
    const fullPath = safePath(path.join(vaultPath, 'todos'), file);
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let raw = fs.readFileSync(fullPath, 'utf8');
    raw = status === 'done'
      ? raw.replace(new RegExp(`^(- )\\[ \\] (${escaped})`, 'm'), '$1[x] $2')
      : raw.replace(new RegExp(`^(- )\\[x\\] (${escaped})`, 'im'), '$1[ ] $2');
    fs.writeFileSync(fullPath, raw);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
