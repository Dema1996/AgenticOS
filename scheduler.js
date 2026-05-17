'use strict';
const cron   = require('node-cron');
const { spawn } = require('child_process');

// agentId → active cron task
const activeJobs = new Map();

let _db  = null;
let _cfg = null; // () => readConfig()

// Human-readable → cron expression
const PRESETS = [
  { label: 'Täglich morgens (07:00)',    cron: '0 7 * * *' },
  { label: 'Täglich abends (20:00)',     cron: '0 20 * * *' },
  { label: 'Täglich mittags (12:00)',    cron: '0 12 * * *' },
  { label: 'Werktags morgens (07:00)',   cron: '0 7 * * 1-5' },
  { label: 'Werktags abends (18:00)',    cron: '0 18 * * 1-5' },
  { label: 'Wochentlich (Mo 09:00)',     cron: '0 9 * * 1' },
  { label: 'Stündlich',                  cron: '0 * * * *' },
  { label: 'Alle 30 Minuten',            cron: '*/30 * * * *' },
  { label: 'Benutzerdefiniert (Cron)',   cron: '' },
];

function runJobNow(job) {
  const cfg     = _cfg();
  const agents  = cfg.agents || [];
  const agent   = agents.find(a => a.id === job.agent_id);
  if (!agent) return;

  const args = [...(agent.args || []), job.prompt];
  const proc = spawn(agent.command, args, {
    cwd: agent.workDir || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '', err = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.stderr.on('data', d => { err += d.toString(); });
  proc.on('close', code => {
    const status = code === 0 ? 'ok' : 'error';
    _db.prepare(
      `UPDATE scheduler_jobs SET last_run=datetime('now'), last_status=? WHERE id=?`
    ).run(status, job.id);
    _db.prepare(
      `INSERT INTO audit_log (event_type, payload) VALUES (?, ?)`
    ).run('scheduler_run', JSON.stringify({
      jobId: job.id, name: job.name, agentId: job.agent_id, status, code,
      out: out.slice(0, 500),
    }));
  });
  proc.on('error', e => {
    _db.prepare(
      `UPDATE scheduler_jobs SET last_run=datetime('now'), last_status=? WHERE id=?`
    ).run('error', job.id);
  });
}

function scheduleJob(job) {
  if (!cron.validate(job.cron)) return false;
  const task = cron.schedule(job.cron, () => runJobNow(job), { scheduled: job.enabled === 1 });
  activeJobs.set(job.id, task);
  return true;
}

function unscheduleJob(jobId) {
  const task = activeJobs.get(jobId);
  if (task) { task.stop(); activeJobs.delete(jobId); }
}

function setupScheduler(db, getCfg) {
  _db  = db;
  _cfg = getCfg;

  const jobs = db.prepare('SELECT * FROM scheduler_jobs WHERE enabled=1').all();
  for (const job of jobs) scheduleJob(job);
  console.log(`⏰ Scheduler: ${jobs.length} Job(s) geladen`);
}

function reloadJob(jobId) {
  unscheduleJob(jobId);
  const job = _db.prepare('SELECT * FROM scheduler_jobs WHERE id=?').get(jobId);
  if (job && job.enabled) scheduleJob(job);
}

function getActiveJobIds() {
  return [...activeJobs.keys()];
}

module.exports = { setupScheduler, reloadJob, unscheduleJob, runJobNow: (id) => {
  const job = _db?.prepare('SELECT * FROM scheduler_jobs WHERE id=?').get(id);
  if (job) runJobNow(job);
}, PRESETS, getActiveJobIds };
