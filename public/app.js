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

let skills          = [];
let currentSkillId  = null;
let skillEditMode   = false;

let commands        = [];
let currentCommandId = null;
let currentCommandDir = null;
let commandEditMode = false;

let claudemdEditMode = false;
let claudemdAgentId  = null;

// Index-based todo storage for safe event delegation
let renderedTodos = [];

// Markdown output buffer (accumulates stdout per chat turn)
let mdBuffer = '';

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
  // Lucide icons
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // marked.js + highlight.js
  if (typeof marked !== 'undefined') {
    marked.use({
      breaks: true,
      gfm: true,
    });
  }

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
  await Promise.all([loadAgents(), loadProjects(), loadTodos(), loadTrash()]);
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
    const pid = p.id.toLowerCase();
    const projTodos = todos.filter(t => t.project && t.project.toLowerCase() === pid);
    const openTodos = projTodos.filter(t => t.status !== 'done');
    const doneTodos = projTodos.filter(t => t.status === 'done');
    const pct = projTodos.length > 0 ? Math.round(doneTodos.length / projTodos.length * 100) : -1;
    return `<div class="project-card" onclick="openProject('${esc(p.id)}','${esc(p.title || p.id)}')">
      <div class="card-color-bar" style="background:${color}"></div>
      <div class="card-body">
        <div class="card-title-row">
          <div class="card-title">${esc(p.title || p.id.replace(/-/g,' '))}</div>
          ${openTodos.length > 0 ? `<span class="card-open-count" title="${openTodos.length} offene Todo${openTodos.length !== 1 ? 's' : ''}">${openTodos.length}</span>` : ''}
        </div>
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
        <button class="card-new-todo-btn" title="Neues Todo anlegen"
          onclick="event.stopPropagation(); newTodoForProject('${esc(p.id)}','${esc(p.title || p.id)}','${esc(p.scope || 'privat')}')">
          + Todo
        </button>
      </div>
    </div>`;
  }).join('');
}

function newTodoForProject(projectId, projectTitle, scope) {
  const today = new Date().toISOString().split('T')[0];
  const template =
`Lege ein neues Todo für das Projekt "${projectTitle}" an.

Erstelle die Datei todos/${projectId}/[titel-als-kebab-case].md mit diesem Frontmatter:

---
title: "[TITEL DES TODOS]"
type: todo
scope: ${scope}
status: open
priority: medium
project: "[[projects/${projectId}]]"
created: ${today}
updated: ${today}
tags: []
---

Ersetze [TITEL DES TODOS] und [titel-als-kebab-case] mit dem passenden Inhalt.`;

  focusTaskInput();
  const input = document.getElementById('task-input');
  if (input) input.value = template;
}

function openProject(projectId, projectTitle) {
  setView('todos');
  renderAllTodos(projectId);
  const input = document.getElementById('task-input');
  if (input) {
    input.value = `Was ist der aktuelle Stand von Projekt "${projectTitle}"? Gibt es offene Todos oder nächste Schritte?`;
    focusTaskInput();
  }
}

// ── Todos ──────────────────────────────────────────────────────────────────
async function loadTodos() {
  try {
    const r = await fetch('/api/todos');
    todos = await r.json();
    renderKanban();
    renderAllTodos();
    renderProjects();
    const btn = document.getElementById('todos-new-btn');
    if (btn) btn.style.display = 'none';
  } catch {}
}

function renderKanban(filterProject) {
  // Keep dropdown in sync; if called from onchange, filterProject is passed directly
  const sel = document.getElementById('kanban-filter');
  if (filterProject === undefined) filterProject = sel ? sel.value : '';
  else if (sel) sel.value = filterProject;

  // Rebuild dropdown options from current todos (deduplicated)
  if (sel) {
    const projects = [...new Set(todos.map(t => t.project).filter(Boolean))].sort();
    const current = sel.value;
    sel.innerHTML = '<option value="">Alle Projekte</option>' +
      projects.map(p => `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(p.replace(/-/g,' '))}</option>`).join('');
    sel.value = filterProject || '';
  }

  renderedTodos = [];
  const inProgress = getInProgress();
  const open = [], ip = [], done = [];

  const list = filterProject
    ? todos.filter(t => t.project === filterProject)
    : todos;

  for (const t of list) {
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

  if (typeof Sortable !== 'undefined') initSortable();
}

function initSortable() {
  const colIds = ['cards-open', 'cards-inprogress', 'cards-done'];
  colIds.forEach(colId => {
    const el = document.getElementById(colId);
    if (!el) return;
    Sortable.create(el, {
      group: 'kanban',
      animation: 150,
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      onEnd(evt) {
        const toCol   = evt.to.id;
        const fromCol = evt.from.id;
        if (toCol === fromCol) return;

        const idx  = parseInt(evt.item.dataset.todoIdx, 10);
        const todo = renderedTodos[idx];
        if (!todo) return;

        const ip  = getInProgress();
        const key = todoKey(todo.file, todo.text);

        if (fromCol === 'cards-done') {
          // Reopen: call API, then optionally mark in-progress
          if (toCol === 'cards-inprogress') ip.add(key);
          saveInProgress(ip);
          toggleTodo(todo.file, todo.text, 'open');
        } else if (toCol === 'cards-done') {
          ip.delete(key);
          saveInProgress(ip);
          toggleTodo(todo.file, todo.text, 'done');
        } else {
          // open <-> inprogress (localStorage only)
          if (toCol === 'cards-inprogress') ip.add(key);
          else ip.delete(key);
          saveInProgress(ip);
          loadTodos();
        }
      },
    });
  });
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
        <select class="card-assign-select" data-file="${esc(t.file)}" data-text="${esc(t.text)}" data-status="${t.status}"
          onchange="assignTodo(this)" title="Projekt zuweisen">${projectSelectOptions(t.project)}</select>
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

let todosViewMode = 'list';

function setTodosView(mode) {
  todosViewMode = mode;
  document.getElementById('todos-view-list')?.classList.toggle('active', mode === 'list');
  document.getElementById('todos-view-kanban')?.classList.toggle('active', mode === 'kanban');
  document.getElementById('all-todos-list')?.classList.toggle('hidden', mode === 'kanban');
  document.getElementById('todos-kanban-board')?.classList.toggle('hidden', mode === 'list');
  const filter = document.getElementById('todos-filter')?.value || '';
  if (mode === 'kanban') renderTodosKanban(filter);
  else renderAllTodos(filter);
}

function renderTodosKanban(filterProject = '') {
  renderedTodos = [];
  const inProgress = getInProgress();

  // Sync project-status dropdown
  const statusLabel = document.getElementById('project-status-label');
  const statusSel   = document.getElementById('project-status-select');
  if (statusLabel && statusSel) {
    if (filterProject && filterProject !== '__inbox__') {
      const project = projects.find(p => p.id === filterProject);
      if (project) {
        statusSel.value = (project.status || 'active').toLowerCase();
        statusLabel.classList.remove('hidden');
      } else {
        statusLabel.classList.add('hidden');
      }
    } else {
      statusLabel.classList.add('hidden');
    }
  }

  let list = todos;
  if (filterProject === '__inbox__') list = todos.filter(t => !t.project);
  else if (filterProject) list = todos.filter(t => t.project === filterProject);

  const open = [], ip = [], done = [];
  for (const t of list) {
    if (t.status === 'done') done.push(t);
    else if (inProgress.has(todoKey(t.file, t.text))) ip.push(t);
    else open.push(t);
  }

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('tcount-open', open.length);
  set('tcount-inprogress', ip.length);
  set('tcount-done', done.length);

  fillColGeneric('tcards-open', open, 'open');
  fillColGeneric('tcards-inprogress', ip, 'ip');
  fillColGeneric('tcards-done', done.slice(0, 50), 'done');
  initTodosSortable(filterProject);
}

function initTodosSortable(filterProject = '') {
  if (typeof Sortable === 'undefined') return;
  const colIds = ['tcards-open', 'tcards-inprogress', 'tcards-done'];
  colIds.forEach(colId => {
    const el = document.getElementById(colId);
    if (!el) return;
    if (el._sortable) { el._sortable.destroy(); }
    el._sortable = Sortable.create(el, {
      group: 'todos-kanban',
      animation: 150,
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      onEnd(evt) {
        const toCol   = evt.to.id;
        const fromCol = evt.from.id;
        if (toCol === fromCol) return;

        const idx  = parseInt(evt.item.dataset.todoIdx, 10);
        const todo = renderedTodos[idx];
        if (!todo) return;

        const ip  = getInProgress();
        const key = todoKey(todo.file, todo.text);

        if (fromCol === 'tcards-done') {
          if (toCol === 'tcards-inprogress') ip.add(key);
          saveInProgress(ip);
          toggleTodo(todo.file, todo.text, 'open');
        } else if (toCol === 'tcards-done') {
          ip.delete(key);
          saveInProgress(ip);
          toggleTodo(todo.file, todo.text, 'done');
        } else {
          if (toCol === 'tcards-inprogress') ip.add(key);
          else ip.delete(key);
          saveInProgress(ip);
          renderTodosKanban(filterProject);
        }
      },
    });
  });
}

function onTodosFilter(projectId) {
  // Show/hide project status dropdown based on whether a specific project is selected
  const label = document.getElementById('project-status-label');
  const sel = document.getElementById('project-status-select');
  if (label && sel && projectId && projectId !== '__inbox__') {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      sel.value = (project.status || 'active').toLowerCase();
      label.classList.remove('hidden');
    }
  } else if (label) {
    label.classList.add('hidden');
  }
  if (todosViewMode === 'kanban') renderTodosKanban(projectId);
  else renderAllTodos(projectId);
}

async function updateProjectStatus(status) {
  const projectId = document.getElementById('todos-filter')?.value;
  if (!projectId || projectId === '__inbox__') return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    // Update local projects array so the card reflects the change immediately
    const p = projects.find(p => p.id === projectId);
    if (p) p.status = status;
  } catch {}
}

function fillColGeneric(containerId, items, colType) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div style="padding:10px;text-align:center;color:var(--overlay0);font-size:12px">—</div>';
    return;
  }
  el.innerHTML = items.map(t => {
    const idx = renderedTodos.length;
    renderedTodos.push({ ...t, colType });
    const proj = t.project ? t.project.replace(/-/g,' ') : (t.file ? t.file.replace('.md','') : '');
    const isDone = colType === 'done';
    return `<div class="todo-card" data-todo-idx="${idx}">
      <div class="todo-text${isDone ? ' done-text' : ''}">${esc(t.text)}</div>
      <div class="todo-meta">
        <select class="card-assign-select" data-file="${esc(t.file)}" data-text="${esc(t.text)}" data-status="${t.status}"
          onchange="assignTodo(this)" title="Projekt zuweisen">${projectSelectOptions(t.project)}</select>
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

function openNewTodoModal() {
  // Pre-select current filter project
  const filterVal = document.getElementById('todos-filter')?.value || '';
  const projectIds = [...new Set(todos.map(t => t.project).filter(Boolean))].sort();
  const sel = document.getElementById('todo-project');
  if (sel) {
    sel.innerHTML = '<option value="__inbox__">📥 Inbox</option>' +
      projectIds.map(p => `<option value="${esc(p)}">${esc(p.replace(/-/g,' '))}</option>`).join('');
    sel.value = filterVal && filterVal !== '__inbox__' ? filterVal : '__inbox__';
  }
  // Set scope based on selected project
  const proj = projects.find(p => p.id === sel?.value);
  const scopeSel = document.getElementById('todo-scope');
  if (scopeSel && proj?.scope) scopeSel.value = proj.scope;

  document.getElementById('todo-title').value = '';
  document.getElementById('todo-tags').value = '';
  document.getElementById('todo-modal-err').style.display = 'none';
  document.getElementById('todo-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('todo-title').focus(), 50);
}

function onTodoProjectChange(projectId) {
  const proj = projects.find(p => p.id === projectId);
  const scopeSel = document.getElementById('todo-scope');
  if (scopeSel && proj?.scope) scopeSel.value = proj.scope;
}

function closeNewTodoModal() {
  document.getElementById('todo-overlay').classList.add('hidden');
}

async function submitNewTodo() {
  const title    = document.getElementById('todo-title').value.trim();
  const project  = document.getElementById('todo-project').value;
  const priority = document.getElementById('todo-priority').value;
  const scope    = document.getElementById('todo-scope').value;
  const tags     = document.getElementById('todo-tags').value;
  const errEl    = document.getElementById('todo-modal-err');

  if (!title) {
    errEl.textContent = 'Bitte einen Titel eingeben.';
    errEl.style.display = '';
    document.getElementById('todo-title').focus();
    return;
  }
  errEl.style.display = 'none';

  try {
    const r = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, project, priority, scope, tags }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Fehler');
    closeNewTodoModal();
    loadTodos();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  }
}

function projectSelectOptions(currentProject) {
  const projectIds = [...new Set(todos.map(t => t.project).filter(Boolean))].sort();
  return `<option value="__inbox__"${!currentProject ? ' selected' : ''}>📥 Inbox</option>` +
    projectIds.map(p =>
      `<option value="${esc(p)}"${p === currentProject ? ' selected' : ''}>${esc(p.replace(/-/g,' '))}</option>`
    ).join('');
}

async function assignTodo(selectEl) {
  const { file, text, status } = selectEl.dataset;
  const newProject = selectEl.value;
  selectEl.disabled = true;
  try {
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, text, status, newProject }),
    });
    loadTodos();
  } catch {
    selectEl.disabled = false;
  }
}

function renderAllTodos(filterProjectId = null) {
  const el = document.getElementById('all-todos-list');
  if (!el) return;

  // Sync filter dropdown — include Inbox if there are unassigned todos
  const sel = document.getElementById('todos-filter');
  if (sel) {
    const projectIds = [...new Set(todos.map(t => t.project).filter(Boolean))].sort();
    const hasInbox = todos.some(t => !t.project);
    const cur = filterProjectId !== null ? filterProjectId : (sel.value || '');
    sel.innerHTML = '<option value="">Alle Projekte</option>' +
      (hasInbox ? '<option value="__inbox__">Inbox</option>' : '') +
      projectIds.map(p => `<option value="${esc(p)}"${p === cur ? ' selected' : ''}>${esc(p.replace(/-/g,' '))}</option>`).join('');
    sel.value = cur;
    filterProjectId = cur || null;
  }

  // Sync project-status dropdown
  const statusLabel = document.getElementById('project-status-label');
  const statusSel   = document.getElementById('project-status-select');
  if (statusLabel && statusSel) {
    if (filterProjectId && filterProjectId !== '__inbox__') {
      const project = projects.find(p => p.id === filterProjectId);
      if (project) {
        statusSel.value = (project.status || 'active').toLowerCase();
        statusLabel.classList.remove('hidden');
      } else {
        statusLabel.classList.add('hidden');
      }
    } else {
      statusLabel.classList.add('hidden');
    }
  }

  let list = todos;
  if (filterProjectId === '__inbox__') {
    list = todos.filter(t => !t.project);
  } else if (filterProjectId) {
    list = todos.filter(t => t.project && t.project.toLowerCase() === filterProjectId.toLowerCase());
  }

  if (!list.length) {
    el.innerHTML = '<div class="empty-state">Keine Todos vorhanden</div>';
    return;
  }

  // Group by project (or inbox)
  const groups = {};
  for (const t of list) {
    const g = t.project || '__inbox__';
    (groups[g] = groups[g] || []).push(t);
  }

  el.innerHTML = Object.entries(groups).map(([groupKey, items]) => {
    const title = groupKey === '__inbox__' ? 'Inbox' : groupKey.replace(/-/g,' ');
    const open  = items.filter(t => t.status === 'open').length;
    return `<div class="todos-group">
      <div class="todos-group-title">${esc(title)} <span style="color:var(--overlay0);font-weight:400">${open} offen</span></div>
      ${items.map(t => {
        const isDone = t.status === 'done';
        return `<div class="todo-list-item${isDone ? ' done-item' : ''}">
          <span class="todo-check" data-file="${esc(t.file)}" data-text="${esc(t.text)}" data-status="${t.status}"
            title="${isDone ? 'Wieder öffnen' : 'Erledigt markieren'}">${isDone ? '☑' : '☐'}</span>
          <span class="todo-text-sm">${esc(t.text)}</span>
          <select class="list-assign-select" data-file="${esc(t.file)}" data-text="${esc(t.text)}" data-status="${t.status}"
            onchange="assignTodo(this)" title="Projekt zuweisen">${projectSelectOptions(t.project)}</select>
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

async function replayTask(agentId, taskId) {
  setPanelMode('chat');

  // Switch agent if needed
  if (agentId !== currentAgentId) selectAgent(agentId);

  // Always clear and reload fresh
  clearTerminal();

  try {
    const task = await fetch(`/api/tasks/${taskId}`).then(r => r.json());

    appendChatTurn(task.prompt || '—', taskId, task.startedAt);

    if (task.running) {
      // Still running — stream live
      streamOutput(agentId, taskId);
    } else {
      // Finished — render lines directly from history
      for (const line of (task.lines || [])) {
        appendLine(line.text, line.type);
      }
    }
  } catch {
    appendLine('[Fehler beim Laden der Task-Daten]', 'stderr');
  }
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
  mdBuffer = '';
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

  if (type === 'stdout' && typeof marked !== 'undefined') {
    mdBuffer += cleaned;
    let mdEl = target.querySelector('.md-output');
    if (!mdEl) {
      mdEl = document.createElement('div');
      mdEl.className = 'md-output';
      target.appendChild(mdEl);
    }
    mdEl.innerHTML = marked.parse(mdBuffer);
    if (typeof hljs !== 'undefined') {
      mdEl.querySelectorAll('pre code:not(.hljs)').forEach(el => hljs.highlightElement(el));
    }
  } else {
    const span = document.createElement('span');
    if (type === 'stderr') span.className = 'term-stderr';
    else if (type === 'system') span.className = 'term-system';
    span.textContent = cleaned;
    target.appendChild(span);
  }

  document.getElementById('terminal-output').scrollTop = 99999;
}

function clearTerminal() {
  document.getElementById('terminal-output').innerHTML =
    '<div class="terminal-empty">Warte auf Ausgabe…</div>';
  currentBlockId = null;
  mdBuffer = '';
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
  if (view === 'log')     loadTaskHistory();
  if (view === 'skills')  loadSkills();
  if (view === 'plugins') loadPlugins();
  if (view === 'claudemd') loadClaudemdView();
  if (view === 'trash')   loadTrash();
  if (view === 'wiki')    initWikiView();
  if (view === 'graph')   showGraphView();
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

  // Todos-page kanban delegation
  document.getElementById('todos-kanban-board').addEventListener('click', e => {
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
      ip.add(key); saveInProgress(ip); renderTodosKanban(document.getElementById('todos-filter')?.value || '');
    } else if (action === 'toopen') {
      ip.delete(key); saveInProgress(ip); renderTodosKanban(document.getElementById('todos-filter')?.value || '');
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

  // New-todo modal: Enter submits, Escape closes, backdrop closes
  document.getElementById('todo-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitNewTodo(); }
    if (e.key === 'Escape') closeNewTodoModal();
  });
  document.getElementById('todo-overlay').addEventListener('click', e => {
    if (e.target.id === 'todo-overlay') closeNewTodoModal();
  });

  // Run-command modal: Escape closes, backdrop closes, Enter submits
  document.getElementById('run-command-args').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); executeSlashCommand(); }
    if (e.key === 'Escape') closeRunCommandModal();
  });
  document.getElementById('run-command-overlay').addEventListener('click', e => {
    if (e.target.id === 'run-command-overlay') closeRunCommandModal();
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

// ── Trash ─────────────────────────────────────────────────────────────────
let trashItems = [];

async function loadTrash() {
  try {
    const r = await fetch('/api/trash');
    trashItems = await r.json();
    renderTrash();
    updateTrashBadge();
  } catch {}
}

function updateTrashBadge() {
  const badge = document.getElementById('trash-count-badge');
  if (!badge) return;
  if (trashItems.length > 0) {
    badge.textContent = trashItems.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderTrash() {
  const list  = document.getElementById('trash-list');
  const count = document.getElementById('trash-item-count');
  if (!list) return;
  if (count) count.textContent = `${trashItems.length} Elemente`;
  if (!trashItems.length) {
    list.innerHTML = '<div class="empty-state">Papierkorb ist leer</div>';
    return;
  }
  list.innerHTML = trashItems.map(item => {
    const icon  = item.type === 'skill' ? '🧩' : '/';
    const safe  = item.daysLeft > 7;
    const meta  = `${item.type === 'skill' ? 'Skill' : 'Slash Command'} · gelöscht ${new Date(item.deletedAt).toLocaleDateString('de-DE')}`;
    return `
    <div class="trash-item">
      <div class="trash-item-icon">${icon}</div>
      <div class="trash-item-info">
        <div class="trash-item-name">${esc(item.name)}</div>
        <div class="trash-item-meta">${esc(meta)}</div>
      </div>
      <div class="trash-item-days ${safe ? 'safe' : ''}">noch ${item.daysLeft}d</div>
      <button class="btn-secondary" style="font-size:12px;padding:4px 10px" onclick="restoreTrashItem('${esc(item.trashId)}')">↩ Wiederherstellen</button>
      <button class="icon-btn" style="color:var(--red);padding:4px 8px" title="Endgültig löschen" onclick="permanentDeleteTrashItem('${esc(item.trashId)}')">✕</button>
    </div>`;
  }).join('');
}

async function deleteSkill(id, evt) {
  if (evt) evt.stopPropagation();
  try {
    const r = await fetch(`/api/skills/${id}`, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json(); alert(d.error || 'Fehler'); return; }
    await loadSkills();
    await loadTrash();
  } catch {}
}

async function deleteCommand(id, dir, evt) {
  if (evt) evt.stopPropagation();
  try {
    const url = `/api/commands/${id}${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`;
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json(); alert(d.error || 'Fehler'); return; }
    await loadCommands();
    await loadTrash();
  } catch {}
}

async function restoreTrashItem(trashId) {
  try {
    const r = await fetch(`/api/trash/${trashId}/restore`, { method: 'POST' });
    if (!r.ok) { const d = await r.json(); alert(d.error || 'Fehler beim Wiederherstellen'); return; }
    await loadTrash();
    await loadSkills();
  } catch {}
}

async function permanentDeleteTrashItem(trashId) {
  if (!confirm('Endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.')) return;
  try {
    await fetch(`/api/trash/${trashId}`, { method: 'DELETE' });
    await loadTrash();
  } catch {}
}

function deleteSkillOrCommandFromDetail() {
  if (currentCommandId) {
    deleteCommand(currentCommandId, currentCommandDir);
    closeSkillDetail();
  } else if (currentSkillId) {
    deleteSkill(currentSkillId);
    closeSkillDetail();
  }
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

// ── Skills ─────────────────────────────────────────────────────────────────
async function loadSkills() {
  try {
    const r = await fetch('/api/skills');
    skills = await r.json();
    renderSkillCards();
  } catch {}
  loadCommands();
}

function renderSkillCards() {
  const grid  = document.getElementById('skills-grid');
  const count = document.getElementById('skills-count');
  if (!grid) return;
  if (count) count.textContent = `${skills.length} Skills`;
  if (!skills.length) {
    grid.innerHTML = '<div class="empty-state">Keine Skills gefunden. Vault-Pfad korrekt konfiguriert?</div>';
    return;
  }
  grid.innerHTML = skills.map(s => `
    <div class="skill-card" onclick="openSkill('${esc(s.id)}')">
      <div class="skill-card-accent"></div>
      <div class="skill-card-name">${esc(s.name)}</div>
      <div class="skill-card-desc">${esc(s.description || '—')}</div>
      <button class="skill-card-delete" onclick="deleteSkill('${esc(s.id)}',event)" title="In Papierkorb verschieben">🗑</button>
    </div>
  `).join('');
}

function openSkill(id) {
  const skill = skills.find(s => s.id === id);
  if (!skill) return;
  currentSkillId = id;
  skillEditMode  = false;

  document.getElementById('skills-list-section').classList.add('hidden');
  document.getElementById('commands-list-section').classList.add('hidden');
  document.getElementById('skill-detail-section').classList.remove('hidden');
  document.getElementById('skill-detail-name').textContent = skill.name;
  document.getElementById('skill-detail-editor').value = skill.content;
  document.getElementById('skill-detail-preview').innerHTML = marked.parse(stripFrontmatter(skill.content));
  document.getElementById('skill-detail-preview').classList.remove('hidden');
  document.getElementById('skill-detail-editor').classList.add('hidden');
  document.getElementById('btn-skill-mode').textContent = 'Bearbeiten';
  document.getElementById('btn-skill-save').classList.add('hidden');
  document.getElementById('btn-skill-run').classList.add('hidden');
  document.getElementById('skill-save-msg').textContent = '';
  currentCommandId = null;
}

function skillDetailToggleEdit() {
  if (currentCommandId) toggleCommandEdit(); else toggleSkillEdit();
}

function skillDetailSave() {
  if (currentCommandId) saveCommand(); else saveSkill();
}

function closeSkillDetail() {
  currentSkillId = null;
  skillEditMode  = false;
  document.getElementById('skill-detail-section').classList.add('hidden');
  document.getElementById('skills-list-section').classList.remove('hidden');
  document.getElementById('commands-list-section').classList.remove('hidden');
}

function toggleSkillEdit() {
  skillEditMode = !skillEditMode;
  const preview = document.getElementById('skill-detail-preview');
  const editor  = document.getElementById('skill-detail-editor');
  const btnMode = document.getElementById('btn-skill-mode');
  const btnSave = document.getElementById('btn-skill-save');

  if (skillEditMode) {
    preview.classList.add('hidden');
    editor.classList.remove('hidden');
    editor.focus();
    btnMode.textContent = 'Vorschau';
    btnSave.classList.remove('hidden');
  } else {
    preview.innerHTML = marked.parse(stripFrontmatter(editor.value));
    preview.classList.remove('hidden');
    editor.classList.add('hidden');
    btnMode.textContent = 'Bearbeiten';
  }
}

async function saveSkill() {
  if (!currentSkillId) return;
  const content = document.getElementById('skill-detail-editor').value;
  const msgEl   = document.getElementById('skill-save-msg');
  try {
    const r = await fetch(`/api/skills/${currentSkillId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (r.ok) {
      const skill = skills.find(s => s.id === currentSkillId);
      if (skill) skill.content = content;
      msgEl.textContent = '✓ Gespeichert';
      setTimeout(() => { msgEl.textContent = ''; }, 2500);
    } else {
      msgEl.style.color = 'var(--red)';
      msgEl.textContent = 'Fehler beim Speichern';
    }
  } catch {
    msgEl.style.color = 'var(--red)';
    msgEl.textContent = 'Netzwerkfehler';
  }
}

function openNewSkillForm() {
  document.getElementById('new-skill-form').classList.remove('hidden');
  document.getElementById('new-skill-id').focus();
}

function closeNewSkillForm() {
  document.getElementById('new-skill-form').classList.add('hidden');
  document.getElementById('new-skill-msg').textContent = '';
}

async function createSkill() {
  const id   = document.getElementById('new-skill-id').value.trim().toLowerCase().replace(/\s+/g, '-');
  const name = document.getElementById('new-skill-name').value.trim();
  const msg  = document.getElementById('new-skill-msg');
  if (!id || !name) { msg.textContent = 'ID und Name erforderlich'; return; }
  try {
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || 'Fehler'; return; }
    closeNewSkillForm();
    await loadSkills();
    openSkill(id);
  } catch { msg.textContent = 'Netzwerkfehler'; }
}

function stripFrontmatter(content) {
  return content.replace(/^---[\s\S]*?---\n?/, '').trim();
}

// ── Plugins ────────────────────────────────────────────────────────────────────
let pluginsData    = { installed: [], available: [] };
let pluginsFiltered = [];

async function loadPlugins() {
  const loadEl = document.getElementById('plugins-loading');
  const grid   = document.getElementById('plugins-grid');
  if (loadEl) { loadEl.style.display = ''; grid.innerHTML = ''; }

  try {
    const r = await fetch('/api/plugins');
    pluginsData = await r.json();
  } catch {
    pluginsData = { installed: [], available: [] };
  }

  pluginsFiltered = pluginsData.available || [];
  renderPluginCards();
}

function renderPluginCards(filtered) {
  const list     = filtered ?? pluginsFiltered;
  const grid     = document.getElementById('plugins-grid');
  const loadEl   = document.getElementById('plugins-loading');
  const instSec  = document.getElementById('plugins-installed-section');
  const instGrid = document.getElementById('plugins-installed-grid');
  const instCount = document.getElementById('plugins-installed-count');
  const availCount = document.getElementById('plugins-available-count');

  if (!grid) return;
  if (loadEl) loadEl.style.display = 'none';

  const installed  = pluginsData.installed || [];
  const installedIds = new Set(installed.map(p => p.name || p.pluginId));

  if (instCount) instCount.textContent = `${installed.length} installiert`;
  if (availCount) availCount.textContent = `${(pluginsData.available || []).length} verfügbar`;

  // Installed section
  if (instSec && instGrid) {
    if (installed.length) {
      instSec.classList.remove('hidden');
      instGrid.innerHTML = installed.map(p => pluginCardHTML(p, true)).join('');
    } else {
      instSec.classList.add('hidden');
    }
  }

  // Available grid
  if (!list.length) {
    grid.innerHTML = '<div class="empty-state">Keine Plugins gefunden.</div>';
    return;
  }
  grid.innerHTML = list.map(p => pluginCardHTML(p, installedIds.has(p.name || p.pluginId))).join('');
}

function pluginCardHTML(p, isInstalled) {
  const name    = esc(p.name || p.pluginId || '');
  const desc    = esc((p.description || '').slice(0, 120)) + ((p.description || '').length > 120 ? '…' : '');
  const count   = p.installCount != null ? fmtInstallCount(p.installCount) : '';
  const pluginId = esc(p.pluginId || p.name || '');
  const nameRaw  = p.name || p.pluginId || '';
  const accentColor = pluginCategoryColor(nameRaw);

  return `<div class="plugin-card">
    <div class="plugin-card-accent" style="background:${accentColor}"></div>
    <div class="plugin-card-body">
      <div class="plugin-card-name">${name}</div>
      <div class="plugin-card-desc">${desc || '—'}</div>
      <div class="plugin-card-footer">
        ${count ? `<span class="plugin-install-count">↓ ${count}</span>` : '<span></span>'}
        ${isInstalled
          ? `<button class="plugin-btn plugin-btn-uninstall" onclick="uninstallPlugin('${esc(nameRaw)}')">Deinstallieren</button>`
          : `<button class="plugin-btn plugin-btn-install" onclick="installPlugin('${pluginId}','${name}')">Installieren</button>`
        }
      </div>
    </div>
  </div>`;
}

function fmtInstallCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pluginCategoryColor(name) {
  const lower = name.toLowerCase();
  if (/github|gitlab|git/.test(lower))    return '#f97316';
  if (/security|auth/.test(lower))        return '#f38ba8';
  if (/browser|playwright/.test(lower))   return '#89b4fa';
  if (/firebase|database|db/.test(lower)) return '#fab387';
  if (/slack|discord|telegram|message/.test(lower)) return '#a6e3a1';
  if (/lsp|clangd|rust|java|kotlin/.test(lower)) return '#cba6f7';
  if (/linear|asana|jira/.test(lower))   return '#89dceb';
  if (/adobe|design|frontend/.test(lower)) return '#f9e2af';
  return '#94e2d5';
}

function filterPlugins(query) {
  const q = (query || '').toLowerCase().trim();
  pluginsFiltered = q
    ? (pluginsData.available || []).filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      )
    : (pluginsData.available || []);
  renderPluginCards(pluginsFiltered);
}

async function installPlugin(pluginId, displayName) {
  openPluginProgress(`Plugin installieren: ${displayName}`);
  try {
    const r = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId }),
    });
    const { taskId, error } = await r.json();
    if (error) throw new Error(error);
    streamPluginTask(taskId);
  } catch (e) {
    appendPluginOutput(`Fehler: ${e.message}`, true);
    finishPluginProgress(false);
  }
}

async function uninstallPlugin(name) {
  if (!confirm(`Plugin „${name}" wirklich deinstallieren?`)) return;
  openPluginProgress(`Plugin deinstallieren: ${name}`);
  try {
    const r = await fetch('/api/plugins/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const { taskId, error } = await r.json();
    if (error) throw new Error(error);
    streamPluginTask(taskId);
  } catch (e) {
    appendPluginOutput(`Fehler: ${e.message}`, true);
    finishPluginProgress(false);
  }
}

function streamPluginTask(taskId) {
  const src = new EventSource(`/api/stream?taskId=${taskId}`);
  src.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.text) appendPluginOutput(stripAnsi(data.text), data.type === 'stderr');
    if (data.done) {
      src.close();
      finishPluginProgress(data.exitCode === 0);
    }
  };
  src.onerror = () => {
    appendPluginOutput('\n[Verbindung getrennt]', true);
    src.close();
    finishPluginProgress(false);
  };
}

function openPluginProgress(title) {
  document.getElementById('plugin-progress-title').textContent = title;
  document.getElementById('plugin-progress-output').textContent = '';
  document.getElementById('plugin-progress-status').textContent = 'Läuft…';
  document.getElementById('plugin-progress-close-btn').classList.add('hidden');
  document.getElementById('plugin-progress-overlay').classList.remove('hidden');
}

function appendPluginOutput(text, isErr) {
  const el = document.getElementById('plugin-progress-output');
  if (!el) return;
  const span = document.createElement('span');
  if (isErr) span.style.color = 'var(--red)';
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function finishPluginProgress(success) {
  const status = document.getElementById('plugin-progress-status');
  const btn    = document.getElementById('plugin-progress-close-btn');
  if (status) {
    status.textContent = success ? '✓ Abgeschlossen' : '✗ Fehler';
    status.style.color = success ? 'var(--green)' : 'var(--red)';
  }
  if (btn) btn.classList.remove('hidden');
}

function closePluginProgress(reload) {
  document.getElementById('plugin-progress-overlay').classList.add('hidden');
  if (reload) loadPlugins();
}

// ── CLAUDE.md editor ───────────────────────────────────────────────────────
function loadClaudemdView() {
  const sel = document.getElementById('claudemd-agent-select');
  const agentsWithDir = agents.filter(a => a.workDir);
  if (!agentsWithDir.length) {
    sel.innerHTML = '<option value="">— Kein Agent mit Arbeitsverzeichnis —</option>';
    document.getElementById('claudemd-no-agent').classList.remove('hidden');
    document.getElementById('claudemd-preview').classList.add('hidden');
    return;
  }
  sel.innerHTML = agentsWithDir.map(a =>
    `<option value="${esc(a.id)}">${esc(a.name)}</option>`
  ).join('');
  const id = claudemdAgentId && agentsWithDir.find(a => a.id === claudemdAgentId)
    ? claudemdAgentId : agentsWithDir[0].id;
  sel.value = id;
  loadClaudemd(id);
}

async function loadClaudemd(agentId) {
  if (!agentId) return;
  claudemdAgentId  = agentId;
  claudemdEditMode = false;

  const agent = agents.find(a => a.id === agentId);
  const workdirEl = document.getElementById('claudemd-workdir');
  if (workdirEl) workdirEl.textContent = agent?.workDir || '';

  const preview = document.getElementById('claudemd-preview');
  const editor  = document.getElementById('claudemd-editor');
  const noAgent = document.getElementById('claudemd-no-agent');
  const btnMode = document.getElementById('btn-claudemd-mode');
  const btnSave = document.getElementById('btn-claudemd-save');

  try {
    const r    = await fetch(`/api/claudemd?agentId=${encodeURIComponent(agentId)}`);
    const data = await r.json();
    noAgent.classList.add('hidden');
    editor.value = data.content || '';
    preview.innerHTML = data.content
      ? marked.parse(data.content)
      : '<div class="empty-state" style="padding:32px 0">Noch keine CLAUDE.md vorhanden — klicke auf „Bearbeiten" um eine zu erstellen.</div>';
    preview.classList.remove('hidden');
    editor.classList.add('hidden');
    btnMode.textContent = 'Bearbeiten';
    btnSave.classList.add('hidden');
    document.getElementById('claudemd-save-msg').textContent = '';
  } catch {
    preview.innerHTML = '<div class="empty-state">Fehler beim Laden</div>';
  }
}

function toggleClaudemdEdit() {
  claudemdEditMode = !claudemdEditMode;
  const preview = document.getElementById('claudemd-preview');
  const editor  = document.getElementById('claudemd-editor');
  const btnMode = document.getElementById('btn-claudemd-mode');
  const btnSave = document.getElementById('btn-claudemd-save');

  if (claudemdEditMode) {
    preview.classList.add('hidden');
    editor.classList.remove('hidden');
    editor.focus();
    btnMode.textContent = 'Vorschau';
    btnSave.classList.remove('hidden');
  } else {
    const val = editor.value;
    preview.innerHTML = val
      ? marked.parse(val)
      : '<div class="empty-state" style="padding:32px 0">Noch keine CLAUDE.md vorhanden.</div>';
    preview.classList.remove('hidden');
    editor.classList.add('hidden');
    btnMode.textContent = 'Bearbeiten';
  }
}

async function saveClaudemd() {
  if (!claudemdAgentId) return;
  const content = document.getElementById('claudemd-editor').value;
  const msgEl   = document.getElementById('claudemd-save-msg');
  try {
    const r = await fetch(`/api/claudemd?agentId=${encodeURIComponent(claudemdAgentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (r.ok) {
      msgEl.style.color = 'var(--green)';
      msgEl.textContent = '✓ Gespeichert';
      setTimeout(() => { msgEl.textContent = ''; }, 2500);
    } else {
      const data = await r.json();
      msgEl.style.color = 'var(--red)';
      msgEl.textContent = data.error || 'Fehler beim Speichern';
    }
  } catch {
    msgEl.style.color = 'var(--red)';
    msgEl.textContent = 'Netzwerkfehler';
  }
}

// ── Slash Commands ──────────────────────────────────────────────────────────
async function loadCommands() {
  try {
    const r = await fetch('/api/commands');
    commands = await r.json();
    renderCommandCards();
  } catch {}
}

function renderCommandCards() {
  const grid  = document.getElementById('commands-grid');
  const count = document.getElementById('commands-count');
  if (!grid) return;
  if (count) count.textContent = commands.length + ' Commands';
  if (!commands.length) {
    grid.innerHTML = '<div class="empty-state">Keine Slash Commands gefunden (~/.claude/commands/)</div>';
    return;
  }
  grid.innerHTML = commands.map(c => `
    <div class="skill-card" onclick="openCommand('${esc(c.id)}')">
      <div class="skill-card-accent" style="background:var(--mauve)"></div>
      <div class="skill-card-name">${esc(c.name)}</div>
      <div class="skill-card-desc" style="color:var(--overlay0);font-size:11px">${esc(c.scope)}</div>
      <button class="skill-card-run" onclick="openRunCommandModal('${esc(c.id)}',event)" title="Auf Agent ausführen">▶ Run</button>
      <button class="skill-card-delete" onclick="deleteCommand('${esc(c.id)}','${esc(c.dir)}',event)" title="In Papierkorb verschieben">🗑</button>
    </div>
  `).join('');
}

function openCommand(id) {
  const cmd = commands.find(c => c.id === id);
  if (!cmd) return;
  currentCommandId  = id;
  currentCommandDir = cmd.dir;
  commandEditMode   = false;

  document.getElementById('skills-list-section').classList.add('hidden');
  document.getElementById('commands-list-section').classList.add('hidden');
  document.getElementById('skill-detail-section').classList.remove('hidden');
  document.getElementById('skill-detail-name').textContent = cmd.name;
  document.getElementById('skill-detail-editor').value = cmd.content;
  document.getElementById('skill-detail-preview').innerHTML = marked.parse(cmd.content);
  document.getElementById('skill-detail-preview').classList.remove('hidden');
  document.getElementById('skill-detail-editor').classList.add('hidden');
  document.getElementById('btn-skill-mode').textContent = 'Bearbeiten';
  document.getElementById('btn-skill-save').classList.add('hidden');
  document.getElementById('btn-skill-run').classList.remove('hidden');
  document.getElementById('skill-save-msg').textContent = '';
}

function toggleCommandEdit() {
  commandEditMode = !commandEditMode;
  const preview = document.getElementById('skill-detail-preview');
  const editor  = document.getElementById('skill-detail-editor');
  const btnMode = document.getElementById('btn-skill-mode');
  const btnSave = document.getElementById('btn-skill-save');
  if (commandEditMode) {
    preview.classList.add('hidden');
    editor.classList.remove('hidden');
    editor.focus();
    btnMode.textContent = 'Vorschau';
    btnSave.classList.remove('hidden');
  } else {
    preview.innerHTML = marked.parse(editor.value);
    preview.classList.remove('hidden');
    editor.classList.add('hidden');
    btnMode.textContent = 'Bearbeiten';
  }
}

async function saveCommand() {
  if (!currentCommandId) return;
  const content = document.getElementById('skill-detail-editor').value;
  const msgEl   = document.getElementById('skill-save-msg');
  try {
    const r = await fetch(`/api/commands/${currentCommandId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, dir: currentCommandDir }),
    });
    if (r.ok) {
      const cmd = commands.find(c => c.id === currentCommandId);
      if (cmd) cmd.content = content;
      msgEl.style.color = 'var(--green)';
      msgEl.textContent = '✓ Gespeichert';
      setTimeout(() => { msgEl.textContent = ''; }, 2500);
    } else {
      msgEl.style.color = 'var(--red)';
      msgEl.textContent = 'Fehler beim Speichern';
    }
  } catch {
    msgEl.style.color = 'var(--red)';
    msgEl.textContent = 'Netzwerkfehler';
  }
}

function openNewCommandForm() {
  document.getElementById('new-command-form').classList.remove('hidden');
  document.getElementById('new-command-id').focus();
}

function closeNewCommandForm() {
  document.getElementById('new-command-form').classList.add('hidden');
  document.getElementById('new-command-msg').textContent = '';
}

async function createCommand() {
  const id  = document.getElementById('new-command-id').value.trim().toLowerCase().replace(/\s+/g, '-');
  const msg = document.getElementById('new-command-msg');
  if (!id) { msg.textContent = 'ID erforderlich'; return; }
  try {
    const r = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || 'Fehler'; return; }
    closeNewCommandForm();
    await loadCommands();
    openCommand(data.id);
  } catch { msg.textContent = 'Netzwerkfehler'; }
}

// ── Run Command modal ──────────────────────────────────────────────────────
let runCommandId = null;

function openRunCommandModal(id, evt) {
  if (evt) evt.stopPropagation();
  runCommandId = id;
  const cmd = commands.find(c => c.id === id);
  if (!cmd) return;

  document.getElementById('run-command-title').textContent = `${cmd.name} ausführen`;
  document.getElementById('run-command-args').value = '';
  document.getElementById('run-command-err').style.display = 'none';

  const select = document.getElementById('run-command-agent');
  select.innerHTML = agents.map(a =>
    `<option value="${esc(a.id)}"${a.id === currentAgentId ? ' selected' : ''}>${esc(a.name)}</option>`
  ).join('');

  document.getElementById('run-command-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('run-command-args').focus(), 50);
}

function openRunCommandModalFromDetail() {
  if (currentCommandId) openRunCommandModal(currentCommandId);
}

function closeRunCommandModal() {
  document.getElementById('run-command-overlay').classList.add('hidden');
  runCommandId = null;
}

async function executeSlashCommand() {
  if (!runCommandId) return;
  const agentId = document.getElementById('run-command-agent').value;
  const args    = document.getElementById('run-command-args').value.trim();
  const prompt  = args ? `/${runCommandId} ${args}` : `/${runCommandId}`;
  const errEl   = document.getElementById('run-command-err');

  if (!agentId) { errEl.textContent = 'Bitte einen Agenten auswählen'; errEl.style.display = ''; return; }

  closeRunCommandModal();

  selectAgent(agentId);

  try {
    const r = await fetch(`/api/agents/${agentId}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const { taskId, error } = await r.json();
    if (error) throw new Error(error);

    currentTaskId = taskId;
    setPanelMode('chat');
    appendChatTurn(prompt, taskId);
    setStatus('● Läuft…');
    streamOutput(agentId, taskId);
    setTimeout(loadAgents, 400);
  } catch (e) {
    setStatus(`Fehler: ${e.message}`);
    document.getElementById('btn-send').disabled = false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4 — WIKI / GRAPH / SEARCH
// ════════════════════════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  project:  '#89b4fa',
  todo:     '#a6e3a1',
  source:   '#fab387',
  concept:  '#cba6f7',
  entity:   '#f38ba8',
  session:  '#94e2d5',
  query:    '#f9e2af',
  overview: '#74c7ec',
};

// ── State ────────────────────────────────────────────────────────────────────
let _wikiReady       = false;
let _wikiPendingPath = null;
let _graphData       = null;
let _graphSim        = null;
let _searchTimer     = null;
let _wikiSearchTimer = null;

// ── Helper: open a wiki file from anywhere (search/graph/links) ───────────────
function openWikiFile(path) {
  _wikiPendingPath = path;
  setView('wiki');
}

// ── Wiki: view init ──────────────────────────────────────────────────────────
function initWikiView() {
  const firstTime = !_wikiReady;
  if (!_wikiReady) {
    _wikiReady = true;
    initWikiFileTree();
    setupWikiSearch();
  }
  if (_wikiPendingPath) {
    const p = _wikiPendingPath;
    _wikiPendingPath = null;
    loadAny(p);
  } else if (firstTime) {
    showWikiOverview();
  }
  // else: keep current content visible
}

// ── Wiki: overview page ──────────────────────────────────────────────────────
async function showWikiOverview() {
  setBreadcrumbWiki([{ label: 'Wiki', path: null }]);
  await loadFile('wiki/overview.md');
}

// ── Wiki: load any file (dispatch by extension) ──────────────────────────────
async function loadAny(relPath) {
  if (relPath.endsWith('.pdf')) loadPdf(relPath);
  else await loadFile(relPath);
}

async function loadFile(relPath) {
  const body = document.getElementById('wiki-body');
  if (!body) return;
  body.classList.remove('pdf-mode');
  body.innerHTML = '<div style="padding:24px;color:var(--overlay0)">Lade…</div>';

  const parts = relPath.split('/');
  setBreadcrumbWiki(parts.map((p, i) => ({
    label: p.replace(/\.md$/, '').replace(/-/g, ' '),
    path:  i === parts.length - 1 ? relPath : null,
  })));
  highlightWikiNav(relPath);

  try {
    const r = await fetch(`/api/file?path=${encodeURIComponent(relPath)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { html, frontmatter, readonly } = await r.json();

    body.innerHTML = buildFmBar(frontmatter || {}, relPath, readonly) + (html || '');

    // Wire up wikilink click handlers
    body.querySelectorAll('a.wikilink').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href) loadAny(href);
      });
    });

    const content = document.getElementById('wiki-content');
    if (content) content.scrollTop = 0;
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;color:var(--red)">Fehler: ${esc(e.message)}</div>`;
  }
}

function loadPdf(relPath) {
  const body = document.getElementById('wiki-body');
  if (!body) return;
  body.classList.add('pdf-mode');
  const parts = relPath.split('/');
  setBreadcrumbWiki(parts.map(p => ({ label: p.replace(/-/g, ' '), path: null })));
  highlightWikiNav(relPath);
  const url = `/api/raw?path=${encodeURIComponent(relPath)}`;
  body.innerHTML = `
    <div class="pdf-view">
      <div class="pdf-toolbar">
        <span>${esc(parts.pop())}</span>
        <a href="${url}" target="_blank" style="color:var(--blue);font-size:12px;margin-left:auto">Öffnen ↗</a>
      </div>
      <iframe class="pdf-frame" src="${url}" title="PDF"></iframe>
    </div>`;
}

// ── Wiki: frontmatter badge bar ──────────────────────────────────────────────
function buildFmBar(fm, filePath, readonly) {
  if (!fm || typeof fm !== 'object') return '';
  const tags = [];

  if (fm.type) {
    const c = TYPE_COLORS[fm.type] || '#6c7086';
    tags.push(`<span class="fm-tag" style="color:${c};border-color:${c}40;background:${c}18">${esc(fm.type)}</span>`);
  }
  if (fm.scope) {
    const cls = fm.scope === 'beruflich' ? 'scope-beruflich' : 'scope-privat';
    tags.push(`<span class="fm-tag ${cls}">${esc(fm.scope)}</span>`);
  }
  if (fm.status) {
    tags.push(`<span class="fm-tag status">${esc(fm.status)}</span>`);
  }
  if (fm.priority) {
    tags.push(`<span class="fm-tag priority-${esc(fm.priority)}">${esc(fm.priority)}</span>`);
  }
  (fm.tags || []).forEach(t => {
    tags.push(`<span class="fm-tag clickable-tag" onclick="showTagView('${esc(String(t))}')">#${esc(String(t))}</span>`);
  });
  if (fm.updated) {
    const updStr = fm.updated instanceof Date
      ? fm.updated.toISOString().slice(0, 10)
      : String(fm.updated).slice(0, 10);
    tags.push(`<span class="fm-tag" style="color:var(--overlay1)">upd ${esc(updStr)}</span>`);
  }
  if (readonly) tags.push(`<span class="readonly-badge">read-only</span>`);

  return tags.length ? `<div class="fm-bar">${tags.join('')}</div>` : '';
}

// ── Wiki: breadcrumb ─────────────────────────────────────────────────────────
function setBreadcrumbWiki(parts) {
  const el = document.getElementById('wiki-breadcrumb');
  if (!el) return;
  el.innerHTML = parts.map((p, i) => {
    const isLast = i === parts.length - 1;
    const label  = p.label;
    if (isLast) return `<span style="color:var(--text)">${esc(label)}</span>`;
    if (p.path)  return `<span class="bc-link" onclick="loadAny('${esc(p.path)}')">${esc(label)}</span>`;
    return `<span style="color:var(--subtext0)">${esc(label)}</span>`;
  }).join('<span class="bc-sep"> / </span>');
}

// ── Wiki: nav highlight ──────────────────────────────────────────────────────
function highlightWikiNav(filePath) {
  document.querySelectorAll('#wiki-nav .wiki-nav-list li a').forEach(a => {
    a.classList.toggle('active', a.dataset.path === filePath);
  });
}

// ── Wiki: file tree (lazy-loaded per section) ────────────────────────────────
function initWikiFileTree() {
  document.querySelectorAll('.wiki-nav-header').forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.wiki-nav-section');
      const list    = section?.querySelector('.wiki-nav-list');
      const chevron = header.querySelector('.wiki-chevron');
      if (!list) return;

      const isOpen = !list.classList.contains('hidden');
      list.classList.toggle('hidden', isOpen);
      if (chevron) chevron.classList.toggle('open', !isOpen);

      if (!isOpen && !list.dataset.loaded) {
        loadNavSection(header.dataset.section, list);
      }
    });
  });
}

async function loadNavSection(sectionId, listEl) {
  listEl.dataset.loaded = '1';
  listEl.innerHTML = '<li style="padding:4px 16px;color:var(--overlay0);font-size:11px">Lade…</li>';
  try {
    const r    = await fetch(`/api/list?dir=${encodeURIComponent(sectionId)}`);
    const tree = await r.json();
    const html = renderNavTree(tree, 0);
    listEl.innerHTML = html || '<li style="padding:4px 16px;color:var(--overlay0);font-size:11px">Leer</li>';
  } catch {
    listEl.innerHTML = '<li style="padding:4px 16px;color:var(--red);font-size:11px">Fehler</li>';
  }
}

function renderNavTree(items, depth) {
  if (!items?.length) return '';
  // Base indent: 8px per level. Dirs get their own indent, files get +14px extra for dot alignment
  return items.map(item => {
    const baseIndent = depth * 14;
    if (item.type === 'dir') {
      const childHtml = renderNavTree(item.children || [], depth + 1);
      if (!childHtml) return '';
      return `<li>
        <span style="display:flex;align-items:center;gap:4px;padding:3px 8px 3px ${baseIndent + 8}px;cursor:pointer;color:var(--overlay1);font-size:11px;user-select:none;font-weight:500"
          onclick="const ul=this.nextElementSibling;ul.classList.toggle('hidden');const c=this.querySelector('.nc');if(c)c.textContent=ul.classList.contains('hidden')?'▶':'▼'">
          <span class="nc" style="font-size:9px;flex-shrink:0">▶</span>${esc(item.name)}/
        </span>
        <ul style="list-style:none;padding:0;margin:0" class="hidden">${childHtml}</ul>
      </li>`;
    }
    const title    = item.frontmatter?.title || item.name.replace(/\.(md|pdf)$/, '').replace(/-/g, ' ');
    const dotColor = item.frontmatter?.status ? statusColor(item.frontmatter.status) : 'var(--surface2)';
    // Files: base indent + 8 padding + 14px for the dot area
    const fileIndent = baseIndent + 8;
    return `<li>
      <a href="#" data-path="${esc(item.path)}"
        style="display:flex;align-items:center;gap:6px;padding:3px 8px 3px ${fileIndent}px;font-size:12px;text-decoration:none;color:var(--subtext0);border-radius:4px;line-height:1.4"
        onclick="event.preventDefault();loadAny('${esc(item.path)}')">
        <span style="width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0;margin-top:1px"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</span>
      </a>
    </li>`;
  }).join('');
}

// ── Wiki: sidebar inline search ──────────────────────────────────────────────
function setupWikiSearch() {
  const input   = document.getElementById('wiki-search-input');
  const results = document.getElementById('wiki-search-results');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    clearTimeout(_wikiSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.classList.add('hidden'); return; }
    _wikiSearchTimer = setTimeout(async () => {
      try {
        const r    = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const hits = await r.json();
        results.innerHTML = hits.length
          ? hits.slice(0, 10).map(h =>
              `<div class="wiki-search-item"
                onclick="loadAny('${esc(h.path)}');document.getElementById('wiki-search-results').classList.add('hidden');document.getElementById('wiki-search-input').value=''">
                <div class="wiki-search-item-title">${esc(h.title)}</div>
                <div class="wiki-search-item-meta">${esc(h.path)}</div>
              </div>`
            ).join('')
          : '<div class="wiki-search-item" style="color:var(--overlay0)">Keine Treffer</div>';
        results.classList.remove('hidden');
      } catch { results.classList.add('hidden'); }
    }, 250);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#wiki-search-box')) results.classList.add('hidden');
  });
}

// ── Wiki: tag view ───────────────────────────────────────────────────────────
async function showTagView(tag) {
  setView('wiki');
  const body = document.getElementById('wiki-body');
  if (!body) return;
  setBreadcrumbWiki([{ label: 'Wiki', path: null }, { label: `#${tag}`, path: null }]);
  body.innerHTML = '<div style="padding:24px;color:var(--overlay0)">Lade…</div>';
  try {
    const r     = await fetch(`/api/tag?tag=${encodeURIComponent(tag)}`);
    const items = await r.json();
    if (!items.length) {
      body.innerHTML = `<div style="padding:24px;color:var(--overlay0)">Keine Einträge mit Tag #${esc(tag)}</div>`;
      return;
    }
    body.innerHTML = `<h2 style="font-size:1.3em;font-weight:600;margin:0 0 16px;color:var(--text)">#${esc(tag)}</h2>
      <div style="display:flex;flex-direction:column;gap:6px">` +
      items.map(it => {
        const c = TYPE_COLORS[it.type] || '#6c7086';
        return `<div style="display:flex;gap:10px;align-items:center;padding:10px 14px;background:var(--surface0);border-radius:6px;cursor:pointer;border:1px solid transparent"
            onmouseover="this.style.borderColor='var(--blue)'" onmouseout="this.style.borderColor='transparent'"
            onclick="loadAny('${esc(it.path)}')">
          <span style="width:8px;height:8px;border-radius:50%;background:${c};flex-shrink:0"></span>
          <div>
            <div style="font-size:13px;font-weight:500">${esc(it.title)}</div>
            <div style="font-size:11px;color:var(--overlay0)">${esc(it.path)}</div>
          </div>
        </div>`;
      }).join('') + '</div>';
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;color:var(--red)">Fehler: ${esc(e.message)}</div>`;
  }
}

// ── Graph: view ──────────────────────────────────────────────────────────────
async function showGraphView() {
  const svg      = document.getElementById('graph-svg');
  const legendEl = document.getElementById('graph-legend');
  if (!svg) return;

  if (legendEl && !legendEl.dataset.built) {
    legendEl.dataset.built = '1';
    legendEl.innerHTML = Object.entries(TYPE_COLORS).map(([t, c]) =>
      `<span class="graph-legend-item">
        <span class="graph-legend-dot" style="background:${c}"></span>${t}
      </span>`
    ).join('');
  }

  if (!_graphData) {
    svg.innerHTML = '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="var(--overlay0)" font-size="14">Lade Graph…</text>';
    try {
      const r = await fetch('/api/graph');
      _graphData = await r.json();
    } catch (e) {
      svg.innerHTML = `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="var(--red)" font-size="14">Fehler: ${esc(e.message)}</text>`;
      return;
    }
    requestAnimationFrame(() => renderGraph(_graphData));
  } else {
    requestAnimationFrame(() => renderGraph(_graphData));
  }

  const filterInput = document.getElementById('graph-filter');
  if (filterInput && !filterInput.dataset.bound) {
    filterInput.dataset.bound = '1';
    filterInput.addEventListener('input', () => {
      if (!_graphData) return;
      const q = filterInput.value.toLowerCase().trim();
      if (!q) { renderGraph(_graphData); return; }
      const nodeIds = new Set();
      const filteredNodes = _graphData.nodes.filter(n => {
        const hit = n.label.toLowerCase().includes(q) ||
          (n.type || '').includes(q) || (n.path || '').includes(q);
        if (hit) nodeIds.add(n.id);
        return hit;
      });
      renderGraph({
        nodes: filteredNodes,
        edges: _graphData.edges.filter(e => {
          const s = typeof e.source === 'object' ? e.source.id : e.source;
          const t = typeof e.target === 'object' ? e.target.id : e.target;
          return nodeIds.has(s) && nodeIds.has(t);
        }),
      });
    });
  }
}

function renderGraph(data) {
  const container = document.getElementById('view-graph');
  const svg       = document.getElementById('graph-svg');
  if (!svg || !data || typeof d3 === 'undefined') return;

  // Get dimensions from the container (forces layout reflow)
  const W = container?.offsetWidth  || 0;
  const H = (container?.offsetHeight || 0) - 52; // subtract toolbar height

  // If layout hasn't happened yet, retry next frame
  if (W < 50 || H < 100) {
    requestAnimationFrame(() => renderGraph(data));
    return;
  }

  svg.setAttribute('width',  W);
  svg.setAttribute('height', H);
  svg.innerHTML = '';

  const root = d3.select(svg);
  const g    = root.append('g');
  const zoom = d3.zoom().scaleExtent([0.05, 5])
    .on('zoom', e => g.attr('transform', e.transform));
  root.call(zoom);

  const nodes = data.nodes.map(n => ({ ...n }));
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = (data.edges || [])
    .map(e => ({
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target,
    }))
    .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

  if (_graphSim) _graphSim.stop();
  const linkForce = d3.forceLink(links).id(d => d.id).distance(60);
  _graphSim = d3.forceSimulation(nodes)
    .force('link',    linkForce)
    .force('charge',  d3.forceManyBody().strength(-300))
    .force('center',  d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide(20))
    .alphaDecay(0.03); // slower decay → more time to spread

  const link = g.append('g')
    .attr('stroke', 'var(--surface1)').attr('stroke-opacity', 0.5)
    .selectAll('line').data(links).join('line').attr('stroke-width', 1);

  const node = g.append('g').selectAll('g').data(nodes).join('g')
    .attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) _graphSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) _graphSim.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on('click', (e, d) => { e.stopPropagation(); openWikiFile(d.path); })
    .on('mouseover', (e, d) => {
      const tip = document.getElementById('graph-tooltip');
      if (!tip) return;
      tip.innerHTML = `<strong>${esc(d.label)}</strong><br>
        <span style="color:var(--overlay0)">${esc(d.type || '')} · ${esc(d.path || '')}</span>`;
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY - 10) + 'px';
      tip.classList.remove('hidden');
    })
    .on('mouseout', () => {
      document.getElementById('graph-tooltip')?.classList.add('hidden');
    });

  node.append('circle')
    .attr('r', 7)
    .attr('fill', d => TYPE_COLORS[d.type] || '#6c7086')
    .attr('stroke', 'var(--base)')
    .attr('stroke-width', 1.5);

  node.append('text')
    .attr('x', 10).attr('dy', '0.35em')
    .attr('fill', 'var(--subtext0)').attr('font-size', 10)
    .attr('pointer-events', 'none')
    .text(d => d.label.length > 22 ? d.label.slice(0, 20) + '…' : d.label);

  _graphSim.on('tick', () => {
    link
      .attr('x1', d => d.source.x || 0).attr('y1', d => d.source.y || 0)
      .attr('x2', d => d.target.x || 0).attr('y2', d => d.target.y || 0);
    node.attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);
  });

  // Auto-fit the viewport once the simulation has settled
  _graphSim.on('end', () => {
    if (!nodes.length) return;
    const xs = nodes.map(d => d.x), ys = nodes.map(d => d.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const gW   = maxX - minX || 1;
    const gH   = maxY - minY || 1;
    const pad  = 60;
    const scale = Math.min((W - pad * 2) / gW, (H - pad * 2) / gH, 2);
    const tx    = W / 2 - scale * (minX + gW / 2);
    const ty    = H / 2 - scale * (minY + gH / 2);
    root.transition().duration(600)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  });
}

// ── Search: main view ────────────────────────────────────────────────────────
function onSearchInput(value) {
  clearTimeout(_searchTimer);
  const q       = (value || '').trim();
  const results = document.getElementById('search-results-main');
  if (!results) return;

  if (q.length < 2) {
    results.innerHTML = '<div style="color:var(--overlay0);padding:12px 0">Mindestens 2 Zeichen eingeben…</div>';
    return;
  }
  results.innerHTML = '<div style="color:var(--overlay0);padding:12px 0">Suche…</div>';

  _searchTimer = setTimeout(async () => {
    try {
      const r    = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const hits = await r.json();
      if (!hits.length) {
        results.innerHTML = `<div style="color:var(--overlay0);padding:12px 0">Keine Treffer für „${esc(q)}"</div>`;
        return;
      }
      results.innerHTML = hits.map(h => {
        const c = TYPE_COLORS[h.type] || '#6c7086';
        return `<div class="search-result-item" onclick="openWikiFile('${esc(h.path)}')">
          <div class="search-result-title">${esc(h.title)}</div>
          <div class="search-result-meta">
            <span style="color:${c}">${esc(h.type || '—')}</span>
            · <span>${esc(h.path)}</span>
            ${h.scope ? ` · <span style="color:var(--overlay0)">${esc(h.scope)}</span>` : ''}
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      results.innerHTML = `<div style="color:var(--red);padding:12px 0">Fehler: ${esc(e.message)}</div>`;
    }
  }, 300);
}
