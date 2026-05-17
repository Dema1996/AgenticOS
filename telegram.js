'use strict';
const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const TYPING_INTERVAL_MS      = 4000;
const CLAUDE_TIMEOUT_MS       = 5 * 60 * 1000;
const TELEGRAM_MAX_LEN        = 4000;
const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const activeBots = new Map(); // agentId → bot instance

function setupTelegram(db, agents) {
  const globalChatId = process.env.TELEGRAM_CHAT_ID
    ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
    : null;

  const storeMsg = db.prepare(
    `INSERT INTO messages (chat_id, from_user, direction, text, agent_id) VALUES (?, ?, ?, ?, ?)`
  );
  const audit = db.prepare(
    `INSERT INTO audit_log (event_type, payload) VALUES (?, ?)`
  );

  if (!globalChatId || isNaN(globalChatId)) {
    console.warn('⚠  TELEGRAM_CHAT_ID nicht gesetzt — Telegram-Bots werden nicht gestartet (Sicherheitsmaßnahme).');
    return { started: 0 };
  }

  let started = 0;
  for (const agent of agents) {
    if (!agent.telegramToken) continue;
    if (activeBots.has(agent.id)) continue; // already running

    const bot = new Telegraf(agent.telegramToken);

    bot.on('text', async (ctx) => {
      const chatId  = ctx.chat.id;
      const user    = ctx.from?.username || ctx.from?.first_name || 'unknown';
      const message = ctx.message.text;

      if (chatId !== globalChatId) {
        await ctx.reply('Nicht autorisiert.');
        return;
      }

      storeMsg.run(chatId, user, 'in', message, agent.id);
      audit.run('telegram_in', JSON.stringify({ agentId: agent.id, chatId, user, text: message.slice(0, 200) }));

      const typingTimer = setInterval(
        () => ctx.sendChatAction('typing').catch(() => {}),
        TYPING_INTERVAL_MS
      );
      ctx.sendChatAction('typing').catch(() => {});

      const { text: response, files } = await runAgent(message, agent);
      clearInterval(typingTimer);

      storeMsg.run(chatId, agent.id, 'out', response, agent.id);
      audit.run('telegram_out', JSON.stringify({
        agentId: agent.id, chatId, text: response.slice(0, 200),
        files: files.map(f => path.basename(f)),
      }));

      for (const chunk of splitMessage(response)) {
        await ctx.reply(chunk, { parse_mode: 'Markdown' })
          .catch(() => ctx.reply(chunk));
      }

      for (const filePath of files) {
        const ext      = path.extname(filePath).toLowerCase();
        const filename = path.basename(filePath);
        try {
          if (IMAGE_EXTS.has(ext)) {
            await ctx.replyWithPhoto(
              { source: fs.createReadStream(filePath), filename },
              { caption: filename }
            );
          } else {
            await ctx.replyWithDocument(
              { source: fs.createReadStream(filePath), filename }
            );
          }
        } catch (e) {
          await ctx.reply(`📎 Datei konnte nicht gesendet werden: \`${filename}\`\n${e.message}`)
            .catch(() => {});
        }
      }
    });

    bot.launch().catch(err => {
      console.error(`❌ Bot für Agent "${agent.id}" konnte nicht starten: ${err.message}`);
      activeBots.delete(agent.id);
    });

    activeBots.set(agent.id, bot);
    console.log(`🤖 Telegram Bot für Agent "${agent.name}" gestartet`);
    started++;
  }

  if (!started) {
    console.log('⚠  Kein Telegram-Token an einem Agenten hinterlegt — Telegram deaktiviert.');
  }

  process.once('SIGINT',  () => activeBots.forEach(b => b.stop('SIGINT')));
  process.once('SIGTERM', () => activeBots.forEach(b => b.stop('SIGTERM')));

  return { started };
}

function getActiveBots() {
  return [...activeBots.keys()];
}

function findNewFiles(dir, sinceMs, maxDepth = 4) {
  const result = [];
  function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= sinceMs && stat.size > 0 && stat.size <= TELEGRAM_MAX_FILE_BYTES) {
            result.push(full);
          }
        } catch { /* skip */ }
      }
    }
  }
  if (dir) walk(dir, 0);
  return result;
}

function runAgent(prompt, agent) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const startMs = Date.now();

    const args = [...(agent.args || []), prompt];
    const proc = spawn(agent.command, args, {
      cwd: agent.workDir || process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const files = agent.workDir ? findNewFiles(agent.workDir, startMs) : [];
      resolve({ text: result, files });
    };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      done('⏱ Timeout — Agent hat nicht rechtzeitig geantwortet.');
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      const text = out.trim();
      done(text || (code === 0 ? '(keine Ausgabe)' : `Fehler (Code ${code}):\n${err.trim().slice(0, 500)}`));
    });
    proc.on('error', e => done(`Spawn-Fehler: ${e.message}`));
  });
}

function splitMessage(text) {
  if (text.length <= TELEGRAM_MAX_LEN) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LEN) {
    chunks.push(text.slice(i, i + TELEGRAM_MAX_LEN));
  }
  return chunks;
}

async function updateBotName(agentId, name) {
  const bot = activeBots.get(agentId);
  if (!bot) return false;
  try {
    await bot.telegram.setMyName(name);
    console.log(`🤖 Bot-Name für "${agentId}" auf "${name}" gesetzt`);
    return true;
  } catch (e) {
    console.error(`Konnte Bot-Name für "${agentId}" nicht aktualisieren: ${e.message}`);
    return false;
  }
}

module.exports = { setupTelegram, getActiveBots, updateBotName };
