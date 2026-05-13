'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let config      = {};
let agents      = [];
let projects    = [];
let todos       = [];
let taskHistory = [];

let currentAgentId  = null;
let currentTaskId   = null;
let currentBlockId  = null;
let panelMode       = 'chat';
let sseSource       = null;
let execHistory     = [];

// Index-based todo storage for safe event delegation
let renderedTodos = [];

// ── In-progress state (localStorage) ──────────────────────────────────────
const IP_KEY = 'agenticos_inprogress';
function getInProgress() {
  try { return new Set(JSON.parse(localStorage.getItem(IP_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveInProgress(set) {
  localStorage.setItem(IP_KEY, JSON.stringify([...set]));
}
function todoKey(file, text) { return `${file}::${text}`; }

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  clearTerminal();
  restorePanelWidth();
  restoreLayoutState();
  loadAll();
  setupEventListeners();
  setupPanelResize();
  setInterval(loadAgents, 5000);
});

async function loadAll() {
  await loadConfig();
  await Promise.all([loadAgents(), loadProjects(), loadTodos()]);
}

// ── Config ─────────────────────────────────────────────────────────────────
async function loadConfig() {
  try { const r = await fetch('/api/config'); config = await r.json(); }
  catch {}
}

// ── Agents ─────────────────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const r = await fetch('/api/agents');
    agents = await r.json();
    renderAgentsSidebar();
    renderAgentSelector();
    updateTopbarStatus();
  } catch {}
}

function renderAgentsSidebar() {
  const el = document.getElementById('agents-list');
  if (!agents.length) {
    el.innerHTML = '<div style="padding:8px 16px;font-size:12px;color:var(--overlay0)">Keine Agenten konfiguriert</div>';
    return;
  }
  el.innerHTML = agents.map(a => {
    const isRunning = a.status === 'running';
    const dotColor  = isRunning ? '#a6e3a1' : (a.color || '#6c7086');
    const opacity   = isRunning ? '1' : '0.5';
    const isActive  = a.id === currentAgentId;
    return `<div class="agent-item${isActive ? ' active' : ''}" data-agent-id="${esc(a.id)}" onclick="selectAgent('${esc(a.id)}')">
      <span class="agent-dot" style="background:${dotColor};opacity:${opacity}"></span>
      <div class="agent-info">
        <span class="agent-name">${esc(a.name)}</span>
        <span class="agent-subtext">${isRunning ? '● aktiv' : 'Idle'}</span>
      </div>
    </div>`;
  }).join('');
}

function renderAgentSelector() {
  const sel = document.getElementById('agent-selector');
  if (!agents.length) {
    sel.innerHTML = '<option value="">— kein Agent konfiguriert —</option>';
    document.getElementById('btn-send').disabled = true;
    return;
  }
  sel.innerHTML = agents.map(a =>
    `<option value="${esc(a.id)}">${esc(a.name)}</option>`
  ).join('');
  if (!currentAgentId) {
    currentAgentId = agents[0].id;
    sel.value = currentAgentId;
    loadRecentTasks();
  } else {
    sel.value = currentAgentId;
  }
  document.getElementById('btn-send').disabled = false;
}

function updateTopbarStatus() {
  const running = agents.filter(a => a.status === 'running').length;
  const el = document.getElementById('agents-status');
  if (running > 0) {
    el.textContent = `● ${running} aktiv`;
    el.style.color = 'var(--green)';
  } else {
    el.textContent = `${agents.length} Agent${agents.length !== 1 ? 'en' : ''}`;
    el.style.color = 'var(--overlay0)';
  }
}

function onAgentChange(id) { selectAgent(id); }

function selectAgent(id) {
  if (id !== currentAgentId) clearTerminal();
  currentAgentId = id;
  document.getElementById('agent-selector').value = id;
  document.querySelectorAll('.agent-item').forEach(el =>
    el.classList.toggle('active', el.dataset.agentId === id)
  );
  // Show workDir in badge
  const agent = agents.find(a => a.id === id);
  const badge = document.getElementById('agent-workdir-badge');
  if (badge && agent?.workDir) {
    // Show short form: ~/FolderName
    const short = agent.workDir.replace(/^.*\/([^/]+)$/, '…/$1');
    badge.textContent = short;
    badge.title = `Arbeitsverzeichnis: ${agent.workDir}`;
  }
  loadRecentTasks();
}

// ── Projects ───────────────────────────────────────────────────────────────
async function loadProjects() {
  try {
    const r = await fetch('/api/projects');
    projects = await r.json();
    renderProjects();
  } catch {}
}

function renderProjects() {
  const active = projects.filter(p =>
    ['active', 'aktiv'].includes((p.status || '').toLowerCase())
  );
  const countEl = document.getElementById('projects-count');
  if (countEl) countEl.textContent = `${active.length} aktiv`;

  // Show vault source badge
  const srcBadge = document.getElementById('vault-source-badge');
  if (srcBadge) {
    const vault = config.vaultPath ? config.vaultPath.replace(/^.*\/([^/]+)$/, '$1') : null;
    srcBadge.textContent = vault ? `aus ${vault}` : '';
  }

  renderProjectsGrid('projects-grid', active);
  renderProjectsGrid('all-projects-grid', projects);
}

function renderProjectsGrid(id, list) {
  const grid = document.getElementById(id);
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = '<div class="empty-state">Keine Projekte vorhanden</div>';
    return;
  }
  grid.innerHTML = list.map(p => {
    const color = statusColor(p.status);
    const projTodos  = todos.filter(t => t.file && t.file.replace('.md','').toLowerCase() === p.id.toLowerCase());
    const doneTodos  = projTodos.filter(t => t.status === 'done');
    const pct = projTodos.length > 0 ? Math.round(doneTodos.length / projTodos.length * 100) : -1;
    return `<div class="project-card">
      <div class="card-color-bar" style="background:${color}"></div>
      <div class="card-body">
        <div class="card-title">${esc(p.title || p.id.replace(/-/g,' '))}</div>
        <div class="card-meta">
          <span class="status-badge" style="color:${color};border-color:${hexAlpha(color,0.6)};background:${hexAlpha(color,0.1)}">${esc(p.status || '—')}</span>
          ${p.priority ? `<span class="priority-badge">${esc(p.priority)}</span>` : ''}
          ${p.scope ? `<span class="priority-badge">${esc(p.scope)}</span>` : ''}
        </div>
        ${pct >= 0 ? `
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="progress-text">${pct}% · ${doneTodos.length}/${projTodos.length} Todos</div>
        ` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Todos ──────────────────────────────────────────────────────────────────
async function loadTodos() {
  try {
    const r = await fetch('/api/todos');
    todos = await r.json();
    renderKanban();
    renderAllTodos();
    renderProjects();
  } catch {}
}

function renderKanban() {
  renderedTodos = [];
  const inProgress = getInProgress();
  const open = [], ip = [], done = [];

  for (const t of todos) {
    if (t.status === 'done') done.push(t);
    else if (inProgress.has(todoKey(t.file, t.text))) ip.push(t);
    else open.push(t);
  }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('count-open',       open.length);
  set('count-inprogress', ip.length);
  set('count-done',       done.length);
  set('todos-count',      `${open.length + ip.length} offen`);

  fillCol('cards-open',       open,            'open');
  fillCol('cards-inprogress', ip,              'ip');
  fillCol('cards-done',       done.slice(0,25),'done');
}

function fillCol(containerId, items, colType) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div style="padding:10px;text-align:center;color:var(--overlay0);font-size:12px">—</div>';
    return;
  }
  el.innerHTML = items.map(t => {
    const idx = renderedTodos.length;
    renderedTodos.push({ ...t, colType });
    const proj = t.file ? t.file.replace('.md','').replace(/-/g,' ') : '';
    const isDone = colType === 'done';
    return `<div class="todo-card" data-todo-idx="${idx}">
      <div class="todo-text${isDone ? ' done-text' : ''}">${esc(t.text)}</div>
      <div class="todo-meta">
        <span class="todo-project">${esc(proj)}</span>
        <div class="todo-actions">
          ${colType === 'open' ? `<button class="todo-btn" data-action="toip" title="In Arbeit">→</button>` : ''}
          ${colType === 'open' ? `<button class="todo-btn done-btn" data-action="done" title="Erledigt">✓</button>` : ''}
          ${colType === 'ip'   ? `<button class="todo-btn reopen-btn" data-action="toopen" title="Zurück">←</button>` : ''}
          ${colType === 'ip'   ? `<button class="todo-btn done-btn" data-action="done" title="Erledigt">✓</button>` : ''}
          ${colType === 'done' ? `<button class="todo-btn reopen-btn" data-action="reopen" title="Wieder öffnen">↩</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderAllTodos() {
  const el = document.getElementById('all-todos-list');
  if (!el) return;
  if (!todos.length) { el.innerHTML = '<div class="empty-state">Keine Todos vorhanden</div>'; return; }

  const groups = {};
  for (const t of todos) {
    const g = t.file || 'inbox';
    (groups[g] = groups[g] || []).push(t);
  }

  el.innerHTML = Object.entries(groups).map(([file, items]) => {
    const title = file.replace('.md','').replace(/-/g,' ');
    const open  = items.filter(t => t.status === 'open').length;
    return `<div class="todos-group">
      <div class="todos-group-title">${esc(title)} <span style="color:var(--overlay0);font-weight:400">${open} offen</span></div>
      ${items.map(t => {
        const isDone = t.status === 'done';
        return `<div class="todo-list-item${isDone ? ' done-item' : ''}">
          <span class="todo-check" data-file="${esc(t.file)}" data-text="${esc(t.text)}" data-status="${t.status}"
            title="${isDone ? 'Wieder öffnen' : 'Erledigt markieren'}">${isDone ? '☑' : '☐'}</span>
          <span class="todo-text-sm">${esc(t.text)}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}

// ── Task log ───────────────────────────────────────────────────────────────
async function loadTaskHistory() {
  try {
    const r = await fetch('/api/tasks?limit=100');
    taskHistory = await r.json();
    renderTaskLog();
  } catch {}
}

function renderTaskLog() {
  const el = document.getElementById('task-log-list');
  if (!el) return;
  if (!taskHistory.length) { el.innerHTML = '<div class="empty-state">Noch keine Tasks ausgeführt</div>'; return; }
  el.innerHTML = taskHistory.map(t => {
    const icon  = t.status === 'done' ? '✓' : t.status === 'error' ? '✗' : '◌';
    const iColor = t.status === 'done' ? 'var(--green)' : t.status === 'error' ? 'var(--red)' : 'var(--yellow)';
    const color = t.agentColor || agents.find(a => a.id === t.agentId)?.color || '#6c7086';
    return `<div class="task-log-item" onclick="replayTask('${esc(t.agentId)}','${esc(t.id)}')">
      <span class="task-log-status" style="color:${iColor}">${icon}</span>
      <div class="task-log-info">
        <div class="task-log-prompt">${esc(t.prompt)}</div>
        <div class="task-log-meta">
          <span><span class="task-log-agent-dot" style="background:${color}"></span>${esc(t.agentName||t.agentId)}</span>
          <span>${formatRel(t.startedAt)}</span>
          ${t.completedAt ? `<span>${dur(t.startedAt, t.completedAt)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

async function loadRecentTasks() {
  if (!currentAgentId) return;
  try {
    const r = await fetch(`/api/tasks?agentId=${currentAgentId}&limit=5`);
    renderRecentTasks(await r.json());
  } catch {}
}

function renderRecentTasks(tasks) {
  const el = document.getElementById('recent-tasks');
  if (!tasks.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="recent-tasks-header">Letzte Tasks</div>` +
    tasks.map(t => {
      const icon   = t.status === 'done' ? '✓' : t.status === 'error' ? '✗' : t.status === 'running' ? '●' : '◌';
      const iColor = t.status === 'done' ? 'var(--green)' : t.status === 'error' ? 'var(--red)'
        : t.status === 'running' ? 'var(--yellow)' : 'var(--overlay0)';
      return `<div class="recent-task-item" onclick="replayTask('${esc(t.agentId)}','${esc(t.id)}')">
        <span class="rt-icon${t.status==='running'?' rt-running':''}" style="color:${iColor}">${icon}</span>
        <span class="rt-text">${esc(t.prompt.substring(0,40))}${t.prompt.length>40?'…':''}</span>
        <span class="rt-time">${fmtTime(t.startedAt)}</span>
      </div>`;
    }).join('');
}

function replayTask(agentId, taskId) {
  // Switch to chat mode first
  setPanelMode('chat');

  // If this task is already in the current chat, just scroll to it
  const existing = document.querySelector(`.chat-turn[data-task-id="${taskId}"]`);
  if (existing) {
    existing.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Switch agent if needed (clears terminal)
  if (agentId !== currentAgentId) selectAgent(agentId);

  // Append this historical task to the chat
  const task = taskHistory.find(t => t.id === taskId);
  appendChatTurn(task?.prompt || '—', taskId, task?.startedAt);
  streamOutput(agentId, taskId);
}

// ── Task dispatch ──────────────────────────────────────────────────────────
async function sendTask() {
  const promptText = document.getElementById('task-input').value.trim();
  if (!promptText || !currentAgentId) return;

  document.getElementById('task-input').value = '';
  document.getElementById('btn-send').disabled = true;
  setStatus('Wird gesendet…');

  try {
    const r = await fetch(`/api/agents/${currentAgentId}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText }),
    });
    if (!r.ok) {
      const err = await r.json();
      setStatus(`Fehler: ${err.error}`);
      document.getElementById('btn-send').disabled = false;
      return;
    }
    const { taskId } = await r.json();
    currentTaskId = taskId;
    appendChatTurn(promptText, taskId);
    setStatus('● Läuft…');
    streamOutput(currentAgentId, taskId);
    setTimeout(loadAgents, 400);
  } catch (e) {
    setStatus(`Fehler: ${e.message}`);
    document.getElementById('btn-send').disabled = false;
  }
}

function appendChatTurn(promptText, taskId, isoTimestamp = null) {
  const terminal = document.getElementById('terminal-output');
  const empty = terminal.querySelector('.terminal-empty');
  if (empty) empty.remove();

  const agent = agents.find(a => a.id === currentAgentId);
  const d = isoTimestamp ? new Date(isoTimestamp) : new Date();
  const now = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const turn = document.createElement('div');
  turn.className = 'chat-turn';
  turn.dataset.taskId = taskId;

  const userMsg = document.createElement('div');
  userMsg.className = 'chat-user-msg';
  userMsg.textContent = promptText;

  const hdr = document.createElement('div');
  hdr.className = 'chat-agent-header';
  hdr.innerHTML = `<span class="term-agent-label">▶ ${esc(agent?.name || currentAgentId)}</span><span class="term-task-time">${now}</span>`;

  const block = document.createElement('div');
  block.className = 'chat-output-block';
  block.id = `chat-block-${taskId}`;

  turn.appendChild(userMsg);
  turn.appendChild(hdr);
  turn.appendChild(block);
  terminal.appendChild(turn);

  currentBlockId = `chat-block-${taskId}`;
  terminal.scrollTop = terminal.scrollHeight;
}

function streamOutput(agentId, taskId) {
  if (sseSource) { sseSource.close(); sseSource = null; }

  sseSource = new EventSource(`/api/agents/${agentId}/stream?taskId=${taskId}`);

  sseSource.onmessage = e => {
    const data = JSON.parse(e.data);
    if (['stdout','stderr','system'].includes(data.type)) appendLine(data.text, data.type);
    if (data.done) {
      sseSource.close(); sseSource = null;
      document.getElementById('btn-send').disabled = false;
      setStatus('');
      loadAgents();
      loadRecentTasks();
      setTimeout(() => { loadProjects(); loadTodos(); }, 800);
    }
  };
  sseSource.onerror = () => {
    appendLine('\n[Verbindung getrennt]', 'system');
    sseSource.close(); sseSource = null;
    document.getElementById('btn-send').disabled = false;
    setStatus('');
  };
}

function appendLine(text, type) {
  const cleaned = stripAnsi(text);
  if (!cleaned) return;
  const target = (currentBlockId && document.getElementById(currentBlockId))
    || document.getElementById('terminal-output');
  const span = document.createElement('span');
  if (type === 'stderr') span.className = 'term-stderr';
  else if (type === 'system') span.className = 'term-system';
  span.textContent = cleaned;
  target.appendChild(span);
  document.getElementById('terminal-output').scrollTop = 99999;
}

function clearTerminal() {
  document.getElementById('terminal-output').innerHTML =
    '<div class="terminal-empty">Warte auf Ausgabe…</div>';
  currentBlockId = null;
}

function setStatus(msg) {
  document.getElementById('task-status-indicator').textContent = msg;
}

// ── Todo actions ───────────────────────────────────────────────────────────
async function toggleTodo(file, text, newStatus) {
  try {
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, text, status: newStatus }),
    });
    loadTodos();
  } catch {}
}

// ── View switching ─────────────────────────────────────────────────────────
function setView(view) {
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-link').forEach(el =>
    el.classList.toggle('active', el.dataset.view === view)
  );
  const target = document.getElementById(`view-${view}`);
  if (target) target.classList.remove('hidden');
  if (view === 'log') loadTaskHistory();
}

// ── Config ─────────────────────────────────────────────────────────────────
function openConfig(tab) {
  document.getElementById('cfg-vault-path').value = config.vaultPath || '';
  document.getElementById('cfg-port').value = config.port || 4000;
  document.getElementById('config-overlay').classList.remove('hidden');
  showConfigTab(tab || 'general');
}

function closeConfig() {
  document.getElementById('config-overlay').classList.add('hidden');
}

function showConfigTab(tab) {
  document.querySelectorAll('.cfg-tab-panel').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.modal-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === tab)
  );
  const p = document.getElementById(`cfg-tab-${tab}`);
  if (p) p.classList.remove('hidden');
  if (tab === 'agents') renderAgentsConfig();
}

async function saveConfig() {
  const vaultPath = document.getElementById('cfg-vault-path').value.trim();
  const port = parseInt(document.getElementById('cfg-port').value, 10);
  const msg = document.getElementById('config-msg');
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, vaultPath, port }),
    });
    config = await r.json();
    msg.className = ''; msg.textContent = 'Gespeichert ✓';
    setTimeout(() => { msg.textContent = ''; }, 2000);
    loadProjects(); loadTodos();
  } catch (e) {
    msg.className = 'error'; msg.textContent = `Fehler: ${e.message}`;
  }
}

function renderAgentsConfig() {
  const el = document.getElementById('agents-config-list');
  if (!agents.length) { el.innerHTML = '<div class="empty-state" style="padding:12px 0">Keine Agenten</div>'; return; }
  el.innerHTML = agents.map(a => `
    <div class="agent-cfg-item">
      <span class="agent-cfg-dot" style="background:${a.color||'#6c7086'}"></span>
      <div class="agent-cfg-info">
        <div class="agent-cfg-name">${esc(a.name)}</div>
        <div class="agent-cfg-cmd">${esc(a.command)} ${(a.args||[]).join(' ')}</div>
      </div>
      <button class="agent-cfg-del" onclick="deleteAgent('${esc(a.id)}')" title="Löschen">✕</button>
    </div>`).join('');
}

async function deleteAgent(id) {
  if (!confirm(`Agent „${id}" wirklich löschen?`)) return;
  await fetch(`/api/agents/${id}`, { method: 'DELETE' });
  await loadAgents();
  renderAgentsConfig();
}

function showAddAgentForm() {
  document.getElementById('add-agent-form').classList.remove('hidden');
}

async function saveNewAgent() {
  const val = id => document.getElementById(id).value.trim();
  const name = val('new-agent-name'), id = val('new-agent-id'), command = val('new-agent-command');
  const msg = document.getElementById('agent-save-msg');
  if (!name || !id || !command) { msg.textContent = 'Name, ID und Befehl sind Pflicht'; return; }
  try {
    await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, name, command,
        args: val('new-agent-args') ? val('new-agent-args').split(/\s+/) : [],
        workDir: val('new-agent-workdir') || undefined,
        color: val('new-agent-color') || '#89b4fa',
      }),
    });
    await loadAgents();
    renderAgentsConfig();
    document.getElementById('add-agent-form').classList.add('hidden');
    ['new-agent-name','new-agent-id','new-agent-command','new-agent-args','new-agent-workdir','new-agent-color']
      .forEach(id => { document.getElementById(id).value = ''; });
    msg.textContent = '';
  } catch (e) { msg.textContent = `Fehler: ${e.message}`; }
}

function focusTaskInput() {
  document.getElementById('task-input').focus();
}

// ── Event listeners ────────────────────────────────────────────────────────
function setupEventListeners() {
  document.getElementById('btn-send').addEventListener('click', sendTask);

  const input = document.getElementById('task-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      sendTask();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });

  document.getElementById('btn-exec').addEventListener('click', sendTerminalCommand);
  const termInput = document.getElementById('term-cmd-input');
  termInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendTerminalCommand(); }
  });

  // Kanban delegation
  document.getElementById('kanban-board').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('[data-todo-idx]');
    if (!card) return;
    const todo = renderedTodos[parseInt(card.dataset.todoIdx, 10)];
    if (!todo) return;

    const ip  = getInProgress();
    const key = todoKey(todo.file, todo.text);
    const action = btn.dataset.action;

    if (action === 'done') {
      ip.delete(key); saveInProgress(ip);
      toggleTodo(todo.file, todo.text, 'done');
    } else if (action === 'reopen') {
      toggleTodo(todo.file, todo.text, 'open');
    } else if (action === 'toip') {
      ip.add(key); saveInProgress(ip); renderKanban();
    } else if (action === 'toopen') {
      ip.delete(key); saveInProgress(ip); renderKanban();
    }
  });

  // All-todos list delegation
  document.getElementById('all-todos-list').addEventListener('click', e => {
    const check = e.target.closest('.todo-check');
    if (!check) return;
    const { file, text, status } = check.dataset;
    toggleTodo(file, text, status === 'done' ? 'open' : 'done');
  });

  // Config overlay backdrop
  document.getElementById('config-overlay').addEventListener('click', e => {
    if (e.target.id === 'config-overlay') closeConfig();
  });
}

// ── Layout toggles ─────────────────────────────────────────────────────────
function restoreLayoutState() {
  if (localStorage.getItem('agenticos_sidebar_hidden') === 'true') {
    document.getElementById('sidebar').classList.add('collapsed');
  } else {
    document.getElementById('btn-toggle-sidebar').classList.add('active');
  }
  if (localStorage.getItem('agenticos_panel_hidden') === 'true') {
    document.getElementById('agent-panel').classList.add('panel-hidden');
  } else {
    document.getElementById('btn-toggle-panel').classList.add('active');
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('btn-toggle-sidebar');
  sidebar.classList.toggle('collapsed');
  const hidden = sidebar.classList.contains('collapsed');
  btn.classList.toggle('active', !hidden);
  localStorage.setItem('agenticos_sidebar_hidden', hidden ? 'true' : 'false');
}

function toggleAgentPanel() {
  const panel = document.getElementById('agent-panel');
  const btn = document.getElementById('btn-toggle-panel');
  panel.classList.toggle('panel-hidden');
  const hidden = panel.classList.contains('panel-hidden');
  btn.classList.toggle('active', !hidden);
  localStorage.setItem('agenticos_panel_hidden', hidden ? 'true' : 'false');
}

function toggleMaximizeChat() {
  const layout = document.getElementById('main-layout');
  const btn = document.getElementById('btn-maximize-chat');
  const icon = document.getElementById('maximize-icon');
  layout.classList.toggle('chat-maximized');
  const isMax = layout.classList.contains('chat-maximized');
  btn.title = isMax ? 'Chat verkleinern' : 'Chat maximieren';
  icon.innerHTML = isMax
    ? `<polyline points="1,4 4,4 4,1"/><polyline points="11,4 8,4 8,1"/><polyline points="1,8 4,8 4,11"/><polyline points="11,8 8,8 8,11"/>`
    : `<polyline points="4,1 1,1 1,4"/><polyline points="8,1 11,1 11,4"/><polyline points="1,8 1,11 4,11"/><polyline points="11,8 11,11 8,11"/>`;
}

// ── Panel mode (Chat / Terminal) ────────────────────────────────────────────
function setPanelMode(mode) {
  panelMode = mode;
  document.getElementById('agent-panel').dataset.mode = mode;
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === mode));
  if (mode === 'terminal') setTimeout(() => document.getElementById('term-cmd-input')?.focus(), 50);
}

function newChat() {
  clearTerminal();
  setPanelMode('chat');
  document.getElementById('task-input')?.focus();
}

async function sendTerminalCommand() {
  const input = document.getElementById('term-cmd-input');
  const command = input.value.trim();
  if (!command) return;

  execHistory.push(command);
  input.value = '';
  input.disabled = true;
  document.getElementById('btn-exec').disabled = true;

  const terminal = document.getElementById('terminal-output');
  const empty = terminal.querySelector('.terminal-empty');
  if (empty) empty.remove();

  // Show $ command line
  const cmdLine = document.createElement('div');
  cmdLine.className = 'term-cmd-line';
  cmdLine.textContent = `$ ${command}`;
  terminal.appendChild(cmdLine);

  // Output block for this command
  const blockId = `exec-block-${Date.now()}`;
  const block = document.createElement('div');
  block.className = 'chat-output-block';
  block.id = blockId;
  terminal.appendChild(block);
  currentBlockId = blockId;
  terminal.scrollTop = terminal.scrollHeight;

  try {
    const r = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, agentId: currentAgentId }),
    });
    const { taskId, error } = await r.json();
    if (error) throw new Error(error);

    block.id = `chat-block-${taskId}`;
    currentBlockId = `chat-block-${taskId}`;

    const src = new EventSource(`/api/stream?taskId=${taskId}`);
    src.onmessage = e => {
      const data = JSON.parse(e.data);
      if (['stdout','stderr','system'].includes(data.type)) appendLine(data.text, data.type);
      if (data.done) {
        src.close();
        input.disabled = false;
        document.getElementById('btn-exec').disabled = false;
        input.focus();
      }
    };
    src.onerror = () => {
      appendLine('\n[Verbindung getrennt]\n', 'system');
      src.close();
      input.disabled = false;
      document.getElementById('btn-exec').disabled = false;
    };
  } catch (e) {
    const span = document.createElement('span');
    span.className = 'term-stderr';
    span.textContent = `Fehler: ${e.message}\n`;
    block.appendChild(span);
    input.disabled = false;
    document.getElementById('btn-exec').disabled = false;
  }
}

// ── Panel resize ───────────────────────────────────────────────────────────
function restorePanelWidth() {
  const saved = localStorage.getItem('agenticos_panel_w');
  if (saved) document.getElementById('agent-panel').style.width = saved + 'px';
}

function setupPanelResize() {
  const handle = document.getElementById('panel-resize-handle');
  const panel  = document.getElementById('agent-panel');
  if (!handle || !panel) return;

  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(240, Math.min(700, startW + (startX - e.clientX)));
    panel.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    localStorage.setItem('agenticos_panel_w', panel.offsetWidth);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────
function stripAnsi(str) {
  return String(str)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[ABCDHIJKMNOPQRSTUVWXYZ\\^_`]/g, '');
}

function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function statusColor(s) {
  const m = {
    active:'#89b4fa', aktiv:'#89b4fa',
    paused:'#f9e2af', pausiert:'#f9e2af',
    completed:'#a6e3a1', abgeschlossen:'#a6e3a1', done:'#a6e3a1',
    cancelled:'#f38ba8', abgebrochen:'#f38ba8',
    planning:'#cba6f7', geplant:'#cba6f7',
  };
  return m[(s||'').toLowerCase()] || '#6c7086';
}

function hexAlpha(hex, a) {
  if (!hex.startsWith('#')) return `rgba(137,180,250,${a})`;
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
}

function formatRel(iso) {
  if (!iso) return '';
  const min = Math.floor((Date.now()-new Date(iso))/60000);
  const h=Math.floor(min/60), d=Math.floor(h/24);
  if (d>0) return `vor ${d}T`; if (h>0) return `vor ${h}h`;
  if (min>0) return `vor ${min}m`; return 'gerade';
}

function dur(start, end) {
  if (!start||!end) return '';
  const s=Math.round((new Date(end)-new Date(start))/1000);
  return s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`;
}
