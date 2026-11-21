'use strict';
// Отдельный Telegram-бот для сервера «Кит» — только для владельца и администраторов.
//  • 📊 Статус: сайт, админка, nginx, процессор, память, диск, сертификат, бэкапы.
//  • 💾 Бэкап по кнопке, 📂 список копий, копия файлом (только владелец).
//  • Тревоги каждые 5 минут: сайт не открывается, диск/память, сертификат, давно нет бэкапа.
//    Когда проблема ушла — сообщение «снова в норме». Плюс ежедневный отчёт в 10:00 (по желанию).
// Если приложение совсем упало, его перезапускает внешний сторож watchdog.js и пишет сюда же.
//  • 🎤 Понимает голосовые и обычный текст по-русски и по-казахски: «как сервер?», «бэкап жаса»,
//    «выключи утренний отчёт». Тот же ключ OpenAI, что и у бота магазина.
const fs = require('fs');
const os = require('os');
const store = require('./db');
const mon = require('./monitor');
const { ROLES } = require('./schema');
const voice = require('./voice');
const MAX_VOICE_SEC = 90;

const API = process.env.TG_API || 'https://api.telegram.org';
const CHECK_EVERY = Number(process.env.KIT_MONITOR_MS) || 5 * 60 * 1000;
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

let token = '', username = '', status = 'off', lastError = '', generation = 0, offset = 0;
let monitorTimer = null, startupSent = false;
const active = new Map();   // key -> { text, since } — текущие проблемы
const strikes = new Map();  // key -> сколько проверок подряд проблема видна

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(method, params, form) {
  const opt = form ? { method: 'POST', body: form }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}) };
  const r = await fetch(`${API}/bot${token}/${method}`, { ...opt, signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 60000) });
  const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!j.ok) throw Object.assign(new Error(j.description || 'Ошибка Telegram'), { tg: j });
  return j.result;
}
const say = (chat, text, markup) => call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
const edit = (msg, text, markup) => call('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML', reply_markup: markup || { inline_keyboard: [] } });

async function downloadFile(fileId) {
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Не удалось скачать голосовое');
  return Buffer.from(await r.arrayBuffer());
}

function sendFile(chat, file, caption) {
  const f = new FormData();
  f.append('chat_id', String(chat));
  f.append('caption', caption);
  f.append('document', new Blob([fs.readFileSync(file)]), require('path').basename(file));
  return call('sendDocument', null, f);
}

// ---------- доступ ----------
const allowed = u => !!u && !!ROLES[u.role] && !!ROLES[u.role].log;     // владелец и администратор
const isOwner = u => !!u && u.role === 'owner';
function userOf(chat) { const u = store.srv.userByChat(chat); return allowed(u) ? u : null; }

// ---------- запуск ----------
async function start() {
  const my = ++generation;
  token = store.meta.get('srv_bot_token');
  username = store.meta.get('srv_bot_username');
  if (!token) { status = 'off'; lastError = ''; stopMonitor(); return info(); }
  status = 'starting';
  try {
    const me = await call('getMe');
    if (my !== generation) return info();
    if (me.username && me.username === store.meta.get('bot_username')) {
      status = 'error'; lastError = 'Это токен бота магазина. Для сервера нужен другой бот (создайте его в @BotFather).';
      return info();
    }
    username = me.username;
    store.meta.set('srv_bot_username', username);
    await call('deleteWebhook', {}).catch(() => {});
    await call('setMyCommands', { commands: [
      { command: 'status', description: 'Состояние сервера' },
      { command: 'backup', description: 'Сделать бэкап сейчас' },
      { command: 'backups', description: 'Список бэкапов' },
      { command: 'alerts', description: 'Уведомления' },
    ] }).catch(() => {});
    status = 'ok'; lastError = '';
  } catch (e) {
    if (my !== generation) return info();
    status = 'error';
    const bad = e.tg && e.tg.error_code === 401;
    lastError = bad ? 'Telegram не принял токен — проверьте, что скопировали его целиком' : 'Нет связи с Telegram: ' + e.message;
    if (!bad) setTimeout(() => { if (my === generation) start(); }, 60000).unref();
    return info();
  }
  loop(my);
  startMonitor();
  return info();
}

async function loop(my) {
  let backoff = 2000;
  while (my === generation) {
    try {
      const ups = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (my !== generation) return;
      status = 'ok'; lastError = ''; backoff = 2000;
      for (const u of ups) {
        offset = u.update_id + 1;
        try { await handle(u); } catch (e) { console.error('server-bot:', e.message); }
      }
    } catch (e) {
      if (my !== generation) return;
      if (e.tg && e.tg.error_code === 401) { status = 'error'; lastError = 'Telegram не принял токен'; return; }
      lastError = e.tg && e.tg.error_code === 409 ? 'Этот бот уже запущен в другом месте' : 'Нет связи с Telegram: ' + e.message;
      await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
    }
  }
}

async function configure(newToken) {
  newToken = String(newToken || '').trim();
  if (newToken && !TOKEN_RE.test(newToken)) throw Object.assign(new Error('Это не похоже на токен бота. Он выглядит так: 1234567890:AAH…'), { code: 400 });
  if (newToken && newToken === store.meta.get('bot_token')) throw Object.assign(new Error('Это токен бота магазина. Для сервера нужен отдельный бот — создайте его в @BotFather.'), { code: 400 });
  if (newToken !== store.meta.get('srv_bot_token')) { store.meta.set('srv_bot_token', newToken); store.meta.set('srv_bot_username', ''); offset = 0; }
  return start();
}
function stop() { generation++; status = 'off'; stopMonitor(); }
function info() { return { status, username, lastError, hasToken: !!store.meta.get('srv_bot_token') }; }
function connectLink(userId) {
  if (status !== 'ok' || !username) return null;
  return `https://t.me/${username}?start=${store.srv.newCode(userId)}`;
}

// ---------- меню ----------
const MENU = { keyboard: [[{ text: '📊 Статус' }, { text: '💾 Бэкап' }], [{ text: '📂 Бэкапы' }, { text: '🔔 Уведомления' }]], resize_keyboard: true, is_persistent: true };
const REFRESH = { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'status' }]] };

async function handle(up) {
  if (up.callback_query) return onCallback(up.callback_query);
  const m = up.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chat = m.chat.id;
  const text = String(m.text || '').trim();

  if (/^\/start\s+\S+/.test(text)) return connect(m, text.split(/\s+/)[1]);
  const user = userOf(chat);
  if (!user) return say(chat, '🔒 Это служебный бот сервера магазина «Кит». Доступ — только для владельца и администраторов.', { remove_keyboard: true });

  if (text === '/stop') {
    store.srv.unlink(chat); store.log.add(user.login, 'отключил Telegram от бота сервера');
    return say(chat, 'Отключено. Уведомления о сервере сюда больше не придут.', { remove_keyboard: true });
  }
  if (text === '📊 Статус' || text === '/status') return sendStatus(chat);
  if (text === '💾 Бэкап' || text === '/backup') return doBackup(user, chat);
  if (text === '📂 Бэкапы' || text === '/backups') return listBackups(user, chat);
  if (text === '🔔 Уведомления' || text === '/alerts') return alertsMenu(chat);
  if (m.voice || m.audio) return onVoice(user, chat, m).catch(e => say(chat, '⚠️ ' + esc(e.message), MENU));
  if (text && !text.startsWith('/') && voice.enabled()) return understandAndRun(user, chat, { text }, false).catch(e => say(chat, '⚠️ ' + esc(e.message), MENU));
  return sayHelp(user, chat);
}

function sayHelp(user, chat, lang) {
  const v = voice.enabled();
  if (lang === 'kk') return say(chat, `Сәлеметсіз бе, ${esc(user.name || user.login)}! Бұл «Кит» серверінің боты.\n\n` +
    '📊 <b>Статус</b> — сайт жұмыс істей ме, жад, диск, сертификат\n💾 <b>Бэкап</b> — базаның көшірмесін қазір жасау\n' +
    '📂 <b>Бэкапы</b> — соңғы көшірмелер\n🔔 <b>Уведомления</b> — дабылдар және күнделікті есеп' +
    (v ? '\n\n🎤 Дауыспен де айтуға болады: «Сервер қалай?», «Бэкап жаса», «Таңғы есепті өшір».' : ''), MENU);
  return say(chat, `Здравствуйте, ${esc(user.name || user.login)}! Это бот сервера «Кит».\n\n` +
    '📊 <b>Статус</b> — работает ли сайт, память, диск, сертификат\n💾 <b>Бэкап</b> — сделать копию базы сейчас\n' +
    '📂 <b>Бэкапы</b> — последние копии\n🔔 <b>Уведомления</b> — тревоги и ежедневный отчёт' +
    (v ? '\n\n🎤 Можно голосом или своими словами, по-русски или по-казахски: «Как сервер?», «Сделай бэкап», «Когда был последний бэкап?», «Выключи утренний отчёт».' : ''), MENU);
}

// ---------- голосовое управление ----------
async function onVoice(user, chat, m) {
  const v = m.voice || m.audio;
  const kk = m.from && m.from.language_code === 'kk';
  if (!voice.enabled()) return say(chat, kk
    ? 'Дауыспен басқару әлі қосылмаған. Иесі оны админкада қоса алады → «🤖 Telegram-бот» → «🎤 Голосовое управление».'
    : 'Голосовое управление ещё не включено. Владелец может включить его в админке → «🤖 Telegram-бот» → «🎤 Голосовое управление».', MENU);
  if ((v.duration || 0) > MAX_VOICE_SEC || (v.file_size || 0) > 15 * 1024 * 1024)
    return say(chat, kk ? `Дауыстық хабар тым ұзын — қысқаша айтыңыз (${MAX_VOICE_SEC} секундқа дейін).` : `Слишком длинное голосовое — скажите коротко (до ${MAX_VOICE_SEC} секунд).`);
  const buf = await downloadFile(v.file_id);
  return understandAndRun(user, chat, { audio: buf, mime: (v.mime_type || 'audio/ogg').split(';')[0] }, true);
}

async function understandAndRun(user, chat, inp, isVoice) {
  call('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  const r = await voice.understandServer(inp, { flags: { alerts: !!user.alerts, daily: !!user.daily } });
  if (isVoice && r.transcript) await say(chat, `${r.lang === 'kk' ? '🎤 Естідім' : '🎤 Услышал'}: <i>${esc(r.transcript)}</i>`);
  return runCommand(user, chat, r);
}

async function setFlagSay(user, chat, flag, on, L) {
  store.srv.setFlag(chat, flag, on);
  store.log.add(user.login, `бот сервера (голосом/текстом): ${flag === 'alerts' ? 'тревоги' : 'отчёт в 10:00'} — ${on ? 'включено' : 'выключено'}`);
  const what = flag === 'alerts' ? (L === 'kk' ? 'Дабылдар' : 'Тревоги') : (L === 'kk' ? 'Сағат 10:00-дегі есеп' : 'Отчёт в 10:00');
  const st = L === 'kk' ? (on ? 'қосылды' : 'өшірілді') : (on ? (flag === 'alerts' ? 'включены' : 'включён') : (flag === 'alerts' ? 'выключены' : 'выключен'));
  return say(chat, `${on ? '🔔' : '🔕'} ${what}: <b>${st}</b>.`, alertsKb(userOf(chat)));
}

async function runCommand(user, chat, r) {
  const L = r.lang;
  switch (r.action) {
    case 'menu': return sayHelp(user, chat, L);
    case 'status': return sendStatus(chat);
    case 'backup': return doBackup(user, chat);
    case 'backups': return listBackups(user, chat);
    case 'send_backup': {
      if (!isOwner(user)) return say(chat, L === 'kk' ? 'Бэкап файлы тек иесіне жіберіледі.' : 'Файл бэкапа присылается только владельцу.', MENU);
      const b = store.backupsList()[0];
      if (!b) return say(chat, L === 'kk' ? 'Әзірге бэкап жоқ. «💾 Бэкап» басыңыз.' : 'Бэкапов пока нет. Нажмите «💾 Бэкап».', MENU);
      store.log.add(user.login, 'получил файл бэкапа в Telegram (голосом/текстом)');
      return sendFile(chat, b.path, `💾 Бэкап базы «Кит» от ${mon.fmtTime(b.mtime, true)}. Восстановить можно из него, если что-то случится с сервером.`);
    }
    case 'alerts_menu': return alertsMenu(chat);
    case 'alerts_on': return setFlagSay(user, chat, 'alerts', true, L);
    case 'alerts_off': return setFlagSay(user, chat, 'alerts', false, L);
    case 'daily_on': return setFlagSay(user, chat, 'daily', true, L);
    case 'daily_off': return setFlagSay(user, chat, 'daily', false, L);
    default:
      return say(chat, r.reply ? esc(r.reply) : (L === 'kk'
        ? 'Түсінбедім. Мысалы: «Сервер қалай?», «Бэкап жаса», «Таңғы есепті өшір».'
        : 'Не понял. Скажите, например: «Как сервер?», «Сделай бэкап», «Выключи утренний отчёт».'), MENU);
  }
}

async function connect(m, code) {
  const chat = m.chat.id;
  const uid = store.srv.useCode(code);
  const u = uid && store.users.byId(uid);
  if (!u || !allowed(u)) return say(chat, 'Ссылка устарела или уже использована. Откройте админку → «🖥 Сервер» → «Подключить мой Telegram».');
  const tgName = ([m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ') + (m.from && m.from.username ? ' @' + m.from.username : '')).trim();
  store.srv.link(chat, u.id, tgName);
  store.log.add(u.login, 'подключил Telegram к боту сервера' + (tgName ? ' (' + tgName + ')' : ''));
  await say(chat, `✅ Готово, ${esc(u.name || u.login)}! Бот сервера подключён.\nТревоги будут приходить сюда. Вот текущее состояние:`, MENU);
  return sendStatus(chat);
}

async function sendStatus(chat, msg) {
  const s = await mon.snapshot();
  const text = mon.report(s);
  if (msg) return edit(msg, text, REFRESH).catch(() => {});
  return say(chat, text, REFRESH);
}

async function doBackup(user, chat) {
  const file = store.backup();
  store.log.add(user.login, 'сделал бэкап через бота сервера');
  const st = fs.statSync(file);
  const kb = isOwner(user) ? { inline_keyboard: [[{ text: '📤 Прислать файлом', callback_data: 'send:' + require('path').basename(file) }]] } : undefined;
  return say(chat, `✅ Копия базы сделана: ${mon.fmtTime(st.mtimeMs)}, ${mon.fmtBytes(st.size)}.\nВсего копий на сервере: ${store.backupsList().length}.`, kb);
}

async function listBackups(user, chat) {
  const list = store.backupsList();
  if (!list.length) return say(chat, 'Бэкапов пока нет. Нажмите «💾 Бэкап».', MENU);
  const lines = list.slice(0, 10).map((b, i) => `${i + 1}. ${mon.fmtTime(b.mtime, true)} — ${mon.fmtBytes(b.size)}`);
  const kb = isOwner(user) ? { inline_keyboard: [[{ text: '📤 Прислать последнюю файлом', callback_data: 'send:' + list[0].name }]] } : undefined;
  return say(chat, `📂 <b>Бэкапы</b> (всего ${list.length}, хранятся последние 30; копия делается при каждом сохранении и каждую ночь):\n\n${lines.join('\n')}` +
    (isOwner(user) ? '\n\nФайл бэкапа — это вся база: товары, заявки, сотрудники. Храните его в надёжном месте.' : ''), kb);
}

function alertsKb(u) {
  return { inline_keyboard: [
    [{ text: (u.alerts ? '🔔 Тревоги: включены' : '🔕 Тревоги: выключены'), callback_data: 'flag:alerts' }],
    [{ text: (u.daily ? '📅 Отчёт в 10:00: включён' : '📅 Отчёт в 10:00: выключен'), callback_data: 'flag:daily' }],
  ] };
}
const ALERTS_TEXT = '🔔 <b>Уведомления</b>\n\nТревоги — если сайт не открывается, диск или память почти заполнены, скоро кончается сертификат, давно не было бэкапа, сервер перезагружался. Когда всё наладится — придёт «✅ снова в норме».\n\nОтчёт — каждый день в 10:00 краткое состояние сервера.';
async function alertsMenu(chat) {
  const u = userOf(chat);
  return say(chat, ALERTS_TEXT, alertsKb(u));
}

async function onCallback(cq) {
  const msg = cq.message;
  const chat = msg && msg.chat && msg.chat.id;
  const data = String(cq.data || '');
  const answer = t => call('answerCallbackQuery', { callback_query_id: cq.id, ...(t ? { text: t } : {}) }).catch(() => {});
  const user = chat && userOf(chat);
  if (!user) { await answer('Нет доступа'); return; }
  let m;
  if (data === 'status') { await answer('Обновлено'); return sendStatus(chat, msg); }
  if ((m = /^flag:(alerts|daily)$/.exec(data))) {
    store.srv.setFlag(chat, m[1], !user[m[1]]);
    const u = userOf(chat);
    await answer(u[m[1]] ? 'Включено' : 'Выключено');
    return edit(msg, ALERTS_TEXT, alertsKb(u)).catch(() => {});
  }
  if ((m = /^send:(kit-[\dT-]+\.db)$/.exec(data))) {
    if (!isOwner(user)) { await answer('Файл бэкапа присылается только владельцу'); return; }
    const b = store.backupsList().find(x => x.name === m[1]);
    if (!b) { await answer('Эта копия уже удалена'); return; }
    await answer('Отправляю…');
    store.log.add(user.login, 'получил файл бэкапа в Telegram');
    return sendFile(chat, b.path, `💾 Бэкап базы «Кит» от ${mon.fmtTime(b.mtime, true)}. Восстановить можно из него, если что-то случится с сервером.`);
  }
  await answer();
}

// ---------- мониторинг и тревоги ----------
async function broadcast(text, flag = 'alerts') {
  let n = 0;
  for (const l of store.srv.links()) {
    if (!l[flag] || !allowed(l)) continue;
    try { await say(l.chat_id, text, MENU); n++; }
    catch (e) { if (e.tg && e.tg.error_code === 403) store.srv.unlink(l.chat_id); }
  }
  return n;
}

// сайт/админка считаются упавшими только после 2 проверок подряд (чтобы не тревожить из-за секундного сбоя)
const NEEDS_TWO = new Set(['site', 'admin', 'cpu']);

async function checkNow() {
  if (status !== 'ok') return;
  const s = await mon.snapshot();
  const now = mon.problems(s);
  const seen = new Set(now.map(p => p.key));
  const fresh = [];
  for (const p of now) {
    const n = (strikes.get(p.key) || 0) + 1;
    strikes.set(p.key, n);
    if (active.has(p.key)) continue;
    if (NEEDS_TWO.has(p.key) && n < 2) continue;
    active.set(p.key, { text: p.text, since: Date.now() });
    fresh.push(p.text);
  }
  const fixed = [];
  for (const [k, v] of active) if (!seen.has(k)) { fixed.push(v.text); active.delete(k); }
  for (const k of strikes.keys()) if (!seen.has(k)) strikes.delete(k);
  if (fresh.length) await broadcast('⚠️ <b>Проблема на сервере</b>\n\n' + fresh.map(esc).join('\n') + '\n\nНажмите «📊 Статус», чтобы посмотреть подробнее.');
  if (fixed.length) await broadcast('✅ <b>Снова в норме</b>\n\n' + fixed.map(t => '<s>' + esc(t) + '</s>').join('\n'));

  // ежедневный отчёт в 10:00 по Астане
  const almaty = new Date(Date.now() + 5 * 3600 * 1000);
  const day = almaty.toISOString().slice(0, 10);
  if (almaty.getUTCHours() === 10 && store.meta.get('srv_daily_last') !== day) {
    store.meta.set('srv_daily_last', day);
    await broadcast('☀️ Доброе утро! Ежедневный отчёт.\n\n' + mon.report(s), 'daily');
  }
  return { fresh, fixed };
}

function startMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => checkNow().catch(e => console.error('monitor:', e.message)), CHECK_EVERY);
  monitorTimer.unref();
  if (!startupSent) {
    startupSent = true;
    // сообщение о запуске: через 15 секунд, когда nginx и сайт точно отвечают
    setTimeout(async () => {
      if (status !== 'ok') return;
      const reboot = os.uptime() < 600;
      await broadcast(reboot
        ? '🔄 <b>Сервер был перезагружен.</b> Сайт снова запущен ✅'
        : '🟢 <b>Сайт перезапущен</b> (обновление или восстановление после сбоя). Всё работает ✅').catch(() => {});
      checkNow().catch(() => {});
    }, Number(process.env.KIT_STARTUP_DELAY_MS) || 15000).unref();
  }
}
function stopMonitor() { if (monitorTimer) clearInterval(monitorTimer); monitorTimer = null; }

module.exports = { start, stop, configure, info, connectLink, checkNow, _test: { active, runCommand } };
