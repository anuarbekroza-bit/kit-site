'use strict';
// Сторож сервера «Кит». Запускается systemd-таймером каждые 2 минуты (от root), отдельно от сайта.
// Если сайт (kit-app) не отвечает 2 проверки подряд — перезапускает его; если упал nginx — перезапускает nginx.
// О каждом случае пишет в бот сервера (токен и чаты берёт из базы, только чтение).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.KIT_DATA || '/var/lib/kit';
const STATE = process.env.KIT_WATCHDOG_STATE || '/var/lib/kit-watchdog/state.json';
const APP_URL = process.env.KIT_APP_URL || 'http://127.0.0.1:3000/health';
const API = process.env.TG_API || 'https://api.telegram.org';
const RESTART_COOLDOWN = 10 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { fails: 0, lastRestart: 0, lastStillDown: 0 }; } }
function saveState(s) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); }
// события для отчёта «что было ночью» в боте сервера (последние 50)
function event(st, text) { st.events = [...(st.events || []), { at: Date.now(), text }].slice(-50); }

async function appOk() {
  try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(10000) }); return r.ok; } catch { return false; }
}
function active(unit) { try { return execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8' }).trim() === 'active'; } catch { return false; } }
function restart(unit) { try { execFileSync('systemctl', ['restart', unit], { timeout: 60000 }); return true; } catch { return false; } }
function lastLogs(unit) {
  try { return execFileSync('journalctl', ['-u', unit, '-n', '5', '--no-pager', '-o', 'cat'], { encoding: 'utf8', timeout: 10000 }).trim().slice(-600); } catch { return ''; }
}

async function alert(text) {
  let db;
  try {
    db = new DatabaseSync(path.join(DATA, 'kit.db'), { readOnly: true });
    const t = db.prepare("SELECT value FROM settings WHERE section = '_meta' AND key = 'srv_bot_token'").get();
    if (!t || !t.value) return;
    const chats = db.prepare("SELECT l.chat_id FROM srv_links l JOIN users u ON u.id = l.user_id WHERE l.alerts = 1 AND u.role IN ('owner','admin')").all();
    for (const c of chats) {
      await fetch(`${API}/bot${t.value}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ chat_id: c.chat_id, text, parse_mode: 'HTML' }),
      }).catch(() => {});
    }
  } catch (e) { console.error('watchdog alert:', e.message); }
  finally { try { db && db.close(); } catch { /* */ } }
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const st = loadState();

  // nginx
  if (!active('nginx')) {
    const ok = restart('nginx') && (await sleep(3000), active('nginx'));
    event(st, ok ? 'Nginx был остановлен — сторож перезапустил его, сайт снова открывается' : 'Nginx остановлен и не запускается');
    saveState(st);
    if (ok) await alert('🛠 <b>Nginx был остановлен</b> — сторож перезапустил его. Сайт снова открывается ✅');
    else if (Date.now() - (st.nginxAlert || 0) > 60 * 60 * 1000) {   // о неудаче — не чаще раза в час
      st.nginxAlert = Date.now(); saveState(st);
      await alert('🚨 <b>Nginx остановлен и не запускается.</b> Сайт не открывается. Нужна помощь: <code>sudo nginx -t</code>');
    }
  } else if (st.nginxAlert) { st.nginxAlert = 0; saveState(st); }

  // приложение сайта
  if (await appOk()) {
    if (st.fails) { st.fails = 0; saveState(st); }
    return;
  }
  st.fails = (st.fails || 0) + 1;
  if (st.fails < 2) { saveState(st); return; }

  const now = Date.now();
  if (now - (st.lastRestart || 0) < RESTART_COOLDOWN) {
    if (now - (st.lastStillDown || 0) > 60 * 60 * 1000) {
      st.lastStillDown = now;
      await alert('🚨 <b>Сайт всё ещё не работает</b> даже после перезапуска.\nПоследние строки журнала:\n<code>' + esc(lastLogs('kit-app')) + '</code>');
    }
    saveState(st); return;
  }
  const logs = lastLogs('kit-app');
  st.lastRestart = now;
  restart('kit-app');
  await sleep(15000);
  const ok = await appOk();
  st.fails = ok ? 0 : st.fails;
  event(st, ok ? 'Сайт не отвечал — сторож перезапустил его, после этого всё заработало' : 'Сайт не отвечал, перезапуск сторожем не помог');
  saveState(st);
  await alert(ok
    ? '🛠 <b>Сайт не отвечал</b> — сторож перезапустил его. Сейчас всё работает ✅'
    : '🚨 <b>Сайт не отвечает</b>, перезапуск не помог.\nПоследние строки журнала:\n<code>' + esc(logs) + '</code>');
}

main().catch(e => { console.error('watchdog:', e.message); process.exit(1); });
