'use strict';
// Telegram-бот «Кит» для владельца и сотрудников.
//  • Заявки с сайта сразу приходят всем подключённым сотрудникам (кнопки «В работе» / «Выполнена»).
//  • Товары можно менять с телефона: цена, рост, название, фото, показать/скрыть, удалить, добавить новый.
//  • Голосом или обычным текстом на русском и казахском: «поставь цену на карго 13 500», «бомберді сайттан жасыр».
//    Любое изменение бот сначала показывает и ждёт «✅ Да» — чтобы ошибка распознавания ничего не испортила.
// Работает в том же процессе, что сайт и админка: long polling, без внешних пакетов.
// Токен бота вводится в админке (раздел «Telegram-бот») и хранится в базе.
const store = require('./db');
const images = require('./images');
const { canEdit } = require('./schema');
const voice = require('./voice');

const API = process.env.TG_API || 'https://api.telegram.org';
const SITE_URL = process.env.SITE_URL || 'https://kit.r-agent.kz';
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.r-agent.kz';

let token = '';
let username = '';
let status = 'off';          // off | starting | ok | error
let lastError = '';
let generation = 0;          // меняется при каждом перезапуске — старый цикл сам останавливается
let offset = 0;
let onChange = () => {};
const pending = new Map();   // chatId -> { step, id, field, draft }
const planned = new Map();   // chatId -> { plan, at } — голосовая команда ждёт подтверждения
const PLAN_TTL = 10 * 60 * 1000;
const MAX_VOICE_SEC = 90;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

// ---------- Telegram API ----------
async function call(method, params, form) {
  const opt = form
    ? { method: 'POST', body: form }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}) };
  const r = await fetch(`${API}/bot${token}/${method}`, { ...opt, signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 30000) });
  const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!j.ok) throw Object.assign(new Error(j.description || 'Ошибка Telegram'), { tg: j });
  return j.result;
}

const say = (chat, text, markup) => call('sendMessage', {
  chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}),
});

function sendPhoto(chat, buf, caption, markup) {
  const f = new FormData();
  f.append('chat_id', String(chat));
  f.append('caption', caption);
  f.append('parse_mode', 'HTML');
  if (markup) f.append('reply_markup', JSON.stringify(markup));
  f.append('photo', new Blob([buf]), 'photo.' + (images.kindOf(buf) || 'jpg'));
  return call('sendPhoto', null, f);
}

// изменить текст/подпись уже отправленного сообщения (у сообщения с фото — подпись)
function editMsg(msg, text, markup) {
  const base = { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: markup || { inline_keyboard: [] } };
  return msg.photo ? call('editMessageCaption', { ...base, caption: text }) : call('editMessageText', { ...base, text, disable_web_page_preview: true });
}

async function downloadFile(fileId, what) {
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Не удалось скачать ' + what);
  return Buffer.from(await r.arrayBuffer());
}

async function downloadPhoto(m) {
  let fileId = null, size = 0;
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; fileId = p.file_id; size = p.file_size || 0; }
  else if (m.document && /^image\//.test(m.document.mime_type || '')) { fileId = m.document.file_id; size = m.document.file_size || 0; }
  if (!fileId) return null;
  if (size > 10 * 1024 * 1024) throw new Error('Фото больше 10 МБ');
  return downloadFile(fileId, 'фото');
}

// ---------- запуск / остановка ----------
async function start() {
  const my = ++generation;
  token = store.meta.get('bot_token');
  username = store.meta.get('bot_username');
  pending.clear();
  planned.clear();
  if (!token) { status = 'off'; lastError = ''; return info(); }
  status = 'starting';
  try {
    const me = await call('getMe');
    if (my !== generation) return info();
    username = me.username;
    store.meta.set('bot_username', username);
    await call('deleteWebhook', {}).catch(() => {});
    await call('setMyCommands', { commands: [
      { command: 'start', description: 'Главное меню' },
      { command: 'products', description: 'Товары' },
      { command: 'new', description: 'Добавить товар' },
      { command: 'orders', description: 'Открытые заявки' },
      { command: 'cancel', description: 'Отменить действие' },
    ] }).catch(() => {});
    status = 'ok'; lastError = '';
  } catch (e) {
    if (my !== generation) return info();
    status = 'error';
    lastError = e.tg && e.tg.error_code === 401 ? 'Telegram не принял токен — проверьте, что скопировали его целиком' : 'Нет связи с Telegram: ' + e.message;
    if (!(e.tg && e.tg.error_code === 401)) setTimeout(() => { if (my === generation) start(); }, 60000).unref();
    return info();
  }
  loop(my);
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
        try { await handle(u); } catch (e) { console.error('bot:', e.message); }
      }
    } catch (e) {
      if (my !== generation) return;
      if (e.tg && e.tg.error_code === 401) { status = 'error'; lastError = 'Telegram не принял токен'; return; }
      lastError = e.tg && e.tg.error_code === 409 ? 'Этот бот уже запущен в другом месте' : 'Нет связи с Telegram: ' + e.message;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

async function configure(newToken) {
  newToken = String(newToken || '').trim();
  if (newToken && !TOKEN_RE.test(newToken)) throw Object.assign(new Error('Это не похоже на токен бота. Он выглядит так: 1234567890:AAH…'), { code: 400 });
  if (newToken && newToken === store.meta.get('srv_bot_token')) throw Object.assign(new Error('Это токен бота сервера. Для магазина нужен другой бот.'), { code: 400 });
  if (newToken !== store.meta.get('bot_token')) { store.meta.set('bot_token', newToken); store.meta.set('bot_username', ''); offset = 0; }
  return start();
}

function stop() { generation++; status = 'off'; }

function info() { return { status, username, lastError, hasToken: !!store.meta.get('bot_token') }; }

function connectLink(userId) {
  if (status !== 'ok' || !username) return null;
  return `https://t.me/${username}?start=${store.tg.newCode(userId)}`;
}

// ---------- клавиатуры и тексты ----------
const MENU = { keyboard: [[{ text: '📦 Товары' }, { text: '➕ Новый товар' }], [{ text: '📨 Заявки' }, { text: '🌐 Сайт' }]], resize_keyboard: true, is_persistent: true };
const CANCEL = { inline_keyboard: [[{ text: '✖️ Отмена', callback_data: 'cancel' }]] };
const SKIP = { inline_keyboard: [[{ text: '⏭ Пропустить', callback_data: 'skip' }, { text: '✖️ Отмена', callback_data: 'cancel' }]] };

const fmtPrice = digits => String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function cardText(p) {
  return `<b>${esc(p.name_ru)}</b>` + (p.name_kk ? `\n<i>${esc(p.name_kk)}</i>` : '') +
    `\n\n💰 Цена: ${p.price ? esc(p.price) + ' ₸' : 'не указана (на сайте «Цену уточняйте в WhatsApp»)'}` +
    `\n📏 Рост: ${p.sizes ? esc(p.sizes) : '—'}` +
    `\n${p.show ? '✅ Показан на сайте' : '🙈 Скрыт с сайта'}`;
}
function cardKb(p) {
  return { inline_keyboard: [
    [{ text: '💰 Цена', callback_data: `e:${p.id}:price` }, { text: '📏 Рост', callback_data: `e:${p.id}:sizes` }],
    [{ text: '✏️ Название', callback_data: `e:${p.id}:name_ru` }, { text: '🖼 Фото', callback_data: `e:${p.id}:image` }],
    [{ text: p.show ? '🙈 Скрыть с сайта' : '👁 Показать на сайте', callback_data: `t:${p.id}` }, { text: '🗑 Удалить', callback_data: `d:${p.id}` }],
    [{ text: '⬅️ Все товары', callback_data: 'list' }],
  ] };
}

function localTime(at) {
  try { return new Date(String(at).replace(' ', 'T') + 'Z').toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return at; }
}
function orderText(o) {
  const st = { new: '🔴 Новая', work: '🟡 В работе', done: '✅ Выполнена', cancel: '⚪️ Отменена' }[o.status] || o.status;
  return `🛍 <b>Заявка №${o.id}</b> · ${st}\n\n` +
    `👤 ${esc(o.name)}\n📞 +${esc(o.phone)}\n` +
    (o.product ? `👕 ${esc(o.product)}\n` : '') +
    (o.comment ? `💬 ${esc(o.comment)}\n` : '') +
    `🕒 ${esc(localTime(o.at))}` +
    (o.handled_by && o.status !== 'new' ? `\n\nОтметил(а): ${esc(o.handled_by)}` : '');
}
function orderKb(o) {
  const row = [];
  if (o.status !== 'work' && o.status !== 'done') row.push({ text: '🟡 В работе', callback_data: `o:${o.id}:work` });
  if (o.status !== 'done') row.push({ text: '✅ Выполнена', callback_data: `o:${o.id}:done` });
  const msg = 'Здравствуйте! Это магазин «Кит». Вы оставили заявку на сайте' + (o.product ? ': ' + o.product : '') + '.';
  const kb = [];
  if (row.length) kb.push(row);
  kb.push([{ text: '💬 Написать в WhatsApp', url: `https://wa.me/${o.phone}?text=${encodeURIComponent(msg)}` }]);
  if (o.status === 'new' || o.status === 'work') kb.push([{ text: '✖️ Отменить заявку', callback_data: `o:${o.id}:cancel` }]);
  return { inline_keyboard: kb };
}

// ---------- обработка сообщений ----------
async function handle(up) {
  if (up.callback_query) return onCallback(up.callback_query);
  const m = up.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chat = m.chat.id;
  const text = String(m.text || m.caption || '').trim();

  if (/^\/start\s+\S+/.test(text)) return connect(m, text.split(/\s+/)[1]);

  const user = store.tg.userByChat(chat);
  if (!user) return guest(chat);

  if (text === '/cancel' || text === '✖️ Отмена') { pending.delete(chat); planned.delete(chat); return say(chat, 'Отменено.', MENU); }
  if (text === '/stop') {
    store.tg.unlink(chat); pending.delete(chat);
    store.log.add(user.login, 'отключил Telegram');
    return say(chat, 'Telegram отключён от админки. Заявки сюда больше не придут.', { remove_keyboard: true });
  }

  // голосовое сообщение (или аудиофайл) — распознаём и выполняем
  if (m.voice || m.audio) return onVoice(user, chat, m).catch(e => say(chat, '⚠️ ' + esc(e.message)));

  const st = pending.get(chat);
  const isMenu = ['📦 Товары', '➕ Новый товар', '📨 Заявки', '🌐 Сайт'].includes(text) || text.startsWith('/');
  if (isMenu) planned.delete(chat);
  if (st && !isMenu) return input(user, chat, m, text, st).catch(e => say(chat, '⚠️ ' + esc(e.message), CANCEL));
  if (st && isMenu) pending.delete(chat);

  if (text === '📦 Товары' || text === '/products') return listProducts(user, chat);
  if (text === '➕ Новый товар' || text === '/new') return newProduct(user, chat);
  if (text === '📨 Заявки' || text === '/orders') return listOrders(chat);
  if (text === '🌐 Сайт') return say(chat, `Сайт: ${SITE_URL}\nАдминка: ${ADMIN_URL}`, MENU);
  // обычный текст своими словами — тоже понимаем, если включено голосовое управление
  if (text && !text.startsWith('/') && voice.enabled()) {
    return understandAndRun(user, chat, { text }, false).catch(e => say(chat, '⚠️ ' + esc(e.message), MENU));
  }
  return sayHelp(user, chat);
}

function sayHelp(user, chat, lang) {
  if (lang === 'kk') return say(chat, `Сәлеметсіз бе, ${esc(user.name || user.login)}! Төмендегі батырмаларды басыңыз` +
    (voice.enabled() ? ' немесе дауыстық хабар жіберіңіз 🎤' : '') + '.\n\n' +
    '📦 <b>Товары</b> — баға, бой, сурет, жасыру не өшіру\n➕ <b>Новый товар</b> — сайтқа жаңа тауар қосу\n📨 <b>Заявки</b> — сайттан келген өтінімдер' +
    (voice.enabled() ? '\n\n🎤 Мысалы: «Карго шалбардың бағасы он үш мың бес жүз», «Бомберді сайттан жасыр», «Өтінімдерді көрсет».' : ''), MENU);
  return say(chat, `Здравствуйте, ${esc(user.name || user.login)}! Выберите действие кнопками внизу` +
    (voice.enabled() ? ' или просто скажите голосом 🎤 (по-русски или по-казахски)' : '') + '.\n\n' +
    '📦 <b>Товары</b> — изменить цену, рост, фото, скрыть или удалить\n➕ <b>Новый товар</b> — добавить на сайт с телефона\n📨 <b>Заявки</b> — открытые заявки с сайта' +
    (voice.enabled() ? '\n\n🎤 Например: «Поставь цену на брюки карго 13 500», «Бомбер закончился, скрой с сайта», «Добавь товар: шапка зимняя, 5 900, на 3–7 лет», «Заявку 12 в работу», «Покажи заявки».' : ''), MENU);
}

async function guest(chat) {
  const c = store.getSection('contacts');
  return say(chat, 'Здравствуйте! Это служебный бот магазина детской одежды «Кит».\n\n' +
    `Чтобы сделать заказ, напишите нам в WhatsApp: https://wa.me/${esc(c.whatsapp)}\nСайт: ${SITE_URL}`, { remove_keyboard: true });
}

async function connect(m, code) {
  const chat = m.chat.id;
  const uid = store.tg.useCode(code);
  const u = uid && store.users.byId(uid);
  if (!u) return say(chat, 'Ссылка для подключения устарела или уже использована.\nОткройте админку → «Telegram-бот» → «Подключить мой Telegram» и нажмите новую ссылку.');
  const tgName = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ') + (m.from && m.from.username ? ' @' + m.from.username : '');
  store.tg.link(chat, u.id, tgName.trim());
  store.log.add(u.login, 'подключил Telegram' + (tgName ? ' (' + tgName.trim() + ')' : ''));
  return say(chat, `✅ Готово, ${esc(u.name || u.login)}! Telegram подключён к админке «Кит».\n\n` +
    'Сюда будут приходить заявки с сайта. А товары можно менять кнопками внизу.\nОтключить: /stop', MENU);
}

// ---------- товары ----------
function mayEditProducts(user) { return canEdit(user.role, 'products'); }

async function listProducts(user, chat, msg) {
  if (!mayEditProducts(user)) return say(chat, 'У вас нет доступа к товарам.');
  const items = store.getSection('products');
  const kb = items.map(p => [{ text: (p.show ? '' : '🙈 ') + p.name_ru + (p.price ? ' — ' + p.price + ' ₸' : ''), callback_data: 'p:' + p.id }]);
  kb.push([{ text: '➕ Новый товар', callback_data: 'new' }]);
  const text = items.length ? `📦 Товары на сайте: ${items.length}. Выберите товар:` : 'Товаров пока нет.';
  if (msg && !msg.photo) return editMsg(msg, text, { inline_keyboard: kb });
  return say(chat, text, { inline_keyboard: kb });
}

async function showProduct(chat, id) {
  const p = store.getItem('products', id);
  if (!p) return say(chat, 'Этого товара уже нет.');
  const img = p.image && images.readImage(p.image);
  if (img) {
    try { return await sendPhoto(chat, img, cardText(p), cardKb(p)); } catch (e) { /* если фото не ушло — покажем текстом */ }
  }
  return say(chat, cardText(p), cardKb(p));
}

function save(user, id, fields, what) {
  const p = store.getItem('products', id);
  if (!p) return null;
  store.backup();
  store.updateItem('products', id, fields);
  onChange();
  store.log.add(user.login, `через Telegram: ${what} «${p.name_ru}»`);
  return store.getItem('products', id);
}

const ASK = {
  price: 'Напишите новую цену числом, например <b>14 500</b>.\nЧтобы убрать цену (на сайте будет «Цену уточняйте в WhatsApp»), отправьте «-».',
  sizes: 'Напишите рост, например <b>110–140 см</b>.\nЧтобы убрать — отправьте «-».',
  name_ru: 'Напишите новое название товара (на русском).',
  image: 'Пришлите фото товара 📷 (лучше вертикальное).',
};

// проверка того, что прислал сотрудник; возвращает { value } или { error }
function parseField(field, text) {
  const t = String(text || '').trim();
  if (field === 'price') {
    if (t === '-' ) return { value: '' };
    const d = t.replace(/[\s.,₸тгTtenge]/gi, '');
    if (!/^\d{1,9}$/.test(d)) return { error: 'Цена — только число, например 14 500. Или «-», чтобы убрать.' };
    return { value: fmtPrice(Number(d)) };
  }
  if (field === 'sizes') {
    if (t === '-') return { value: '' };
    if (!t || t.length > 40) return { error: 'Напишите рост коротко, например 110–140 см.' };
    return { value: t };
  }
  if (field === 'name_ru' || field === 'name_kk') {
    if (!t || t === '-') return { error: 'Название не может быть пустым.' };
    if (t.length > 80) return { error: 'Слишком длинное название (максимум 80 символов).' };
    return { value: t };
  }
  return { error: 'Неизвестное поле' };
}

const FIELD_WORD = { price: 'цену', sizes: 'рост', name_ru: 'название', name_kk: 'казахское название', image: 'фото' };

async function input(user, chat, m, text, st) {
  if (!mayEditProducts(user)) { pending.delete(chat); return say(chat, 'У вас нет доступа к товарам.', MENU); }

  // изменение одного поля товара
  if (st.step === 'edit') {
    let value;
    if (st.field === 'image') {
      const buf = await downloadPhoto(m).catch(e => { throw e; });
      if (!buf) return say(chat, 'Жду фото 📷. Или нажмите «Отмена».', CANCEL);
      value = images.saveImageBuffer(buf);
    } else {
      const r = parseField(st.field, text);
      if (r.error) return say(chat, r.error, CANCEL);
      value = r.value;
    }
    pending.delete(chat);
    const before = store.getItem('products', st.id);
    const p = save(user, st.id, { [st.field]: value }, `изменил(а) ${FIELD_WORD[st.field]}` +
      (st.field === 'price' && before ? ` (${before.price || '—'} → ${value || '—'})` : '') + ' у товара');
    if (!p) return say(chat, 'Этого товара уже нет.', MENU);
    await say(chat, '✅ Сохранено — уже на сайте.', MENU);
    return showProduct(chat, st.id);
  }

  // мастер нового товара: название → цена → рост → фото
  const d = st.draft;
  if (st.step === 'new_name') {
    const r = parseField('name_ru', text);
    if (r.error) return say(chat, r.error, CANCEL);
    d.name_ru = r.value; st.step = 'new_price';
    return say(chat, `Шаг 2 из 4. Цена для «${esc(d.name_ru)}»?\nНапишите число, например <b>14 500</b>, или нажмите «Пропустить».`, SKIP);
  }
  if (st.step === 'new_price') {
    const r = parseField('price', text);
    if (r.error) return say(chat, r.error, SKIP);
    d.price = r.value; st.step = 'new_sizes';
    return say(chat, 'Шаг 3 из 4. На какой рост? Например <b>110–140 см</b>, или «Пропустить».', SKIP);
  }
  if (st.step === 'new_sizes') {
    const r = parseField('sizes', text);
    if (r.error) return say(chat, r.error, SKIP);
    d.sizes = r.value; st.step = 'new_photo';
    return say(chat, 'Шаг 4 из 4. Пришлите фото товара 📷 или нажмите «Пропустить».', SKIP);
  }
  if (st.step === 'new_photo') {
    if (text !== '-') {
      const buf = await downloadPhoto(m);
      if (!buf) return say(chat, 'Жду фото 📷 или нажмите «Пропустить».', SKIP);
      d.image = images.saveImageBuffer(buf);
    }
    pending.delete(chat);
    store.backup();
    const id = store.insertItem('products', { ...d, show: true }, true);
    onChange();
    store.log.add(user.login, `через Telegram: добавил(а) товар «${d.name_ru}»`);
    await say(chat, '✅ Товар добавлен в «Новинки» — уже на сайте.', MENU);
    return showProduct(chat, id);
  }
}

async function newProduct(user, chat) {
  if (!mayEditProducts(user)) return say(chat, 'У вас нет доступа к товарам.');
  pending.set(chat, { step: 'new_name', draft: {} });
  return say(chat, '➕ Новый товар.\nШаг 1 из 4. Напишите название (на русском), например <b>Куртка зимняя</b>.', CANCEL);
}

// ---------- заявки ----------
async function listOrders(chat) {
  const list = store.orders.list(10, true).reverse();
  if (!list.length) return say(chat, 'Открытых заявок нет 🎉', MENU);
  await say(chat, `📨 Открытые заявки: ${list.length}${list.length === 10 ? ' (последние 10)' : ''}`, MENU);
  for (const o of list) await say(chat, orderText(o), orderKb(o));
}

async function notifyOrder(o) {
  if (status !== 'ok') return 0;
  let n = 0;
  for (const l of store.tg.links()) {
    try { await say(l.chat_id, orderText(o), orderKb(o)); n++; }
    catch (e) { if (e.tg && e.tg.error_code === 403) store.tg.unlink(l.chat_id); }
  }
  return n;
}

// ---------- нажатия на кнопки ----------
async function onCallback(cq) {
  const msg = cq.message;
  const chat = msg && msg.chat && msg.chat.id;
  const data = String(cq.data || '');
  const answer = text => call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
  const user = chat && store.tg.userByChat(chat);
  if (!user) { await answer('Сначала подключите Telegram в админке'); return; }
  let m;

  if (data === 'cancel') { pending.delete(chat); await answer('Отменено'); return say(chat, 'Отменено.', MENU); }
  if (data === 'skip') {
    const st = pending.get(chat);
    await answer();
    if (st && st.step && st.step.startsWith('new_')) return input(user, chat, {}, '-', st);
    return;
  }
  if (data === 'vy' || data === 'vn') {
    const pl = planned.get(chat);
    planned.delete(chat);
    if (!pl || Date.now() - pl.at > PLAN_TTL) {
      await answer('Устарело');
      return editMsg(msg, '⌛️ Это подтверждение устарело. Скажите команду ещё раз.').catch(() => {});
    }
    await answer(data === 'vy' ? 'Выполняю' : 'Отменено');
    await editMsg(msg, describe(pl.plan, pl.lang) + '\n\n' + (data === 'vy' ? '✅' : '✖️ ' + T(pl.lang, 'nothing'))).catch(() => {});
    if (data === 'vy') return execPlan(user, chat, pl.plan, pl.lang);
    return;
  }
  if (data === 'list') { await answer(); return listProducts(user, chat, msg); }
  if (data === 'new') { await answer(); return newProduct(user, chat); }

  if ((m = /^o:(\d+):(work|done|cancel)$/.exec(data))) {
    const o = store.orders.byId(m[1]);
    if (!o) { await answer('Заявка не найдена'); return; }
    store.orders.setStatus(o.id, m[2], user.name || user.login);
    store.log.add(user.login, `через Telegram: заявка №${o.id} → ${store.ORDER_STATUS[m[2]]}`);
    await answer(store.ORDER_STATUS[m[2]]);
    const upd = store.orders.byId(o.id);
    return editMsg(msg, orderText(upd), orderKb(upd)).catch(() => {});
  }

  if (!mayEditProducts(user)) { await answer('Нет доступа к товарам'); return; }

  if ((m = /^p:(\d+)$/.exec(data))) { await answer(); return showProduct(chat, m[1]); }

  if ((m = /^e:(\d+):(price|sizes|name_ru|image)$/.exec(data))) {
    const p = store.getItem('products', m[1]);
    if (!p) { await answer('Этого товара уже нет'); return; }
    pending.set(chat, { step: 'edit', id: p.id, field: m[2] });
    await answer();
    return say(chat, `«${esc(p.name_ru)}»\n${ASK[m[2]]}`, CANCEL);
  }

  if ((m = /^t:(\d+)$/.exec(data))) {
    const p = store.getItem('products', m[1]);
    if (!p) { await answer('Этого товара уже нет'); return; }
    const np = save(user, p.id, { show: !p.show }, p.show ? 'скрыл(а) с сайта товар' : 'вернул(а) на сайт товар');
    await answer(np.show ? 'Показан на сайте' : 'Скрыт с сайта');
    return editMsg(msg, cardText(np), cardKb(np)).catch(() => {});
  }

  if ((m = /^d:(\d+)$/.exec(data))) {
    const p = store.getItem('products', m[1]);
    if (!p) { await answer('Этого товара уже нет'); return; }
    await answer();
    return editMsg(msg, cardText(p) + '\n\n<b>Удалить этот товар с сайта?</b>', { inline_keyboard: [
      [{ text: '🗑 Да, удалить', callback_data: `dd:${p.id}` }, { text: 'Нет', callback_data: `back:${p.id}` }],
    ] }).catch(() => {});
  }
  if ((m = /^back:(\d+)$/.exec(data))) {
    const p = store.getItem('products', m[1]);
    await answer();
    if (p) return editMsg(msg, cardText(p), cardKb(p)).catch(() => {});
    return;
  }
  if ((m = /^dd:(\d+)$/.exec(data))) {
    const p = store.getItem('products', m[1]);
    if (!p) { await answer('Уже удалён'); return; }
    store.backup();
    store.deleteItem('products', p.id);
    onChange();
    store.log.add(user.login, `через Telegram: удалил(а) товар «${p.name_ru}»`);
    await answer('Удалено');
    return editMsg(msg, `🗑 Товар «${esc(p.name_ru)}» удалён с сайта.`).catch(() => {});
  }
  await answer();
}

// ---------- голосовое управление (русский / казахский) ----------
const TEXTS = {
  ru: {
    heard: '🎤 Услышал', confirm: 'Подтвердить?', yes: '✅ Да', no: '✖️ Нет', nothing: 'Хорошо, ничего не меняю.',
    saved: '✅ Сохранено — уже на сайте.', added: '✅ Товар добавлен в «Новинки» — уже на сайте.',
    photo: 'Пришлите фото товара 📷 (лучше вертикальное). Или нажмите «Отмена» — фото можно добавить позже.',
    which: 'Какой товар? Выберите в списке или скажите название.',
    notFound: q => `Не нашёл товар «${q}». Выберите в списке:`,
    noOrder: 'Не понял, какая заявка. Скажите номер, например «заявку 12 в работу».',
    orderMissing: n => `Заявки №${n} нет.`,
    noAccess: 'У вас нет доступа к товарам.',
    askPrice: 'Какую цену поставить? Скажите или напишите число, например 14 500.',
    askSizes: 'Какой рост? Например «110–140 см».', askName: 'Какое название поставить?',
    unknown: 'Не понял команду. Скажите, например: «Поставь цену на брюки карго 13 500» или «Покажи заявки».',
    waitPhoto: 'Жду фото 📷 — голосом его не передать. Или нажмите «Отмена».',
    tooLong: `Слишком длинное голосовое. Скажите команду коротко (до ${MAX_VOICE_SEC} секунд).`,
    off: 'Голосовое управление ещё не включено. Владелец может включить его в админке → «Telegram-бот» → «Голосовое управление».',
    expired: 'Это подтверждение устарело. Скажите команду ещё раз.',
    nothingToConfirm: 'Подтверждать нечего — скажите команду.',
    price: (n, p) => `💰 Поставить цену <b>${p} ₸</b> для «${n}»`,
    clearPrice: n => `💰 Убрать цену у «${n}» (на сайте будет «Цену уточняйте в WhatsApp»)`,
    sizes: (n, v) => `📏 Поставить рост <b>${v}</b> для «${n}»`,
    nameRu: (n, v) => `✏️ Переименовать «${n}» → <b>${v}</b>`,
    nameKk: (n, v) => `✏️ Казахское название «${n}» → <b>${v}</b>`,
    hide: n => `🙈 Скрыть с сайта «${n}»`, show: n => `👁 Показать на сайте «${n}»`,
    del: n => `🗑 Удалить с сайта «${n}» насовсем`,
    add: d => `➕ Добавить новый товар:\n<b>${d.name_ru}</b>` + (d.name_kk ? `\n<i>${d.name_kk}</i>` : '') +
      `\n💰 ${d.price ? d.price + ' ₸' : 'без цены'}\n📏 ${d.sizes || 'рост не указан'}`,
    order: (id, s) => `📨 Заявка №${id} → <b>${s}</b>`,
    st: { work: 'В работе', done: 'Выполнена', cancel: 'Отменена' },
  },
  kk: {
    heard: '🎤 Естідім', confirm: 'Растайсыз ба?', yes: '✅ Иә', no: '✖️ Жоқ', nothing: 'Жақсы, ештеңе өзгертпеймін.',
    saved: '✅ Сақталды — сайтта жаңарды.', added: '✅ Тауар «Жаңалықтар» бөліміне қосылды — сайтта бар.',
    photo: 'Тауардың суретін жіберіңіз 📷 (тік сурет жақсы). Немесе «Отмена» батырмасын басыңыз — суретті кейін қосуға болады.',
    which: 'Қай тауар? Тізімнен таңдаңыз немесе атын айтыңыз.',
    notFound: q => `«${q}» тауарын таппадым. Тізімнен таңдаңыз:`,
    noOrder: 'Қай өтінім екенін түсінбедім. Нөмірін айтыңыз, мысалы «12-өтінімді жұмысқа ал».',
    orderMissing: n => `№${n} өтінім жоқ.`,
    noAccess: 'Сізде тауарларға рұқсат жоқ.',
    askPrice: 'Қандай баға қоямыз? Санын айтыңыз не жазыңыз, мысалы 14 500.',
    askSizes: 'Қандай бой? Мысалы «110–140 см».', askName: 'Қандай атау қоямыз?',
    unknown: 'Түсінбедім. Мысалы: «Карго шалбардың бағасы 13 500» немесе «Өтінімдерді көрсет» деп айтыңыз.',
    waitPhoto: 'Сурет күтіп тұрмын 📷 — оны дауыспен жіберу мүмкін емес. Немесе «Отмена» басыңыз.',
    tooLong: `Дауыстық хабар тым ұзын. Командаңызды қысқаша айтыңыз (${MAX_VOICE_SEC} секундқа дейін).`,
    off: 'Дауыспен басқару әлі қосылмаған. Иесі оны админкада қоса алады → «Telegram-бот» → «Голосовое управление».',
    expired: 'Бұл растау ескірді. Командаңызды қайта айтыңыз.',
    nothingToConfirm: 'Растайтын ештеңе жоқ — командаңызды айтыңыз.',
    price: (n, p) => `💰 «${n}» бағасын <b>${p} ₸</b> қою`,
    clearPrice: n => `💰 «${n}» бағасын алып тастау (сайтта «бағасын WhatsApp арқылы нақтылаңыз» деп шығады)`,
    sizes: (n, v) => `📏 «${n}» үшін бой: <b>${v}</b>`,
    nameRu: (n, v) => `✏️ «${n}» атауын <b>${v}</b> деп өзгерту`,
    nameKk: (n, v) => `✏️ «${n}» қазақша атауын <b>${v}</b> деп өзгерту`,
    hide: n => `🙈 «${n}» сайттан жасыру`, show: n => `👁 «${n}» сайтта қайта көрсету`,
    del: n => `🗑 «${n}» сайттан біржола өшіру`,
    add: d => `➕ Жаңа тауар қосу:\n<b>${d.name_ru}</b>` + (d.name_kk ? `\n<i>${d.name_kk}</i>` : '') +
      `\n💰 ${d.price ? d.price + ' ₸' : 'бағасыз'}\n📏 ${d.sizes || 'бойы көрсетілмеген'}`,
    order: (id, s) => `📨 №${id} өтінім → <b>${s}</b>`,
    st: { work: 'Жұмыста', done: 'Орындалды', cancel: 'Жойылды' },
  },
};
function T(lang, key, ...a) { const t = (TEXTS[lang] || TEXTS.ru)[key]; return typeof t === 'function' ? t(...a) : t; }

// что бот сейчас спрашивает — чтобы ИИ понял короткий ответ вроде «пятнадцать тысяч»
function awaitingText(st) {
  if (!st) return '';
  const p = st.id && store.getItem('products', st.id);
  const n = p ? ` для товара «${p.name_ru}» (id ${p.id})` : '';
  return {
    edit: { price: 'новую цену' + n, sizes: 'рост' + n, name_ru: 'новое русское название' + n, name_kk: 'новое казахское название' + n, image: 'фото' + n }[st.field],
    new_name: 'название нового товара', new_price: 'цену нового товара (можно пропустить)',
    new_sizes: 'рост нового товара (можно пропустить)', new_photo: 'фото нового товара (можно пропустить)',
  }[st.step] || '';
}

async function onVoice(user, chat, m) {
  const v = m.voice || m.audio;
  const lang = m.from && m.from.language_code === 'kk' ? 'kk' : 'ru';
  if (!voice.enabled()) return say(chat, T(lang, 'off'), MENU);
  if ((v.duration || 0) > MAX_VOICE_SEC) return say(chat, T(lang, 'tooLong'));
  if ((v.file_size || 0) > 15 * 1024 * 1024) return say(chat, T(lang, 'tooLong'));
  call('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  const buf = await downloadFile(v.file_id, 'голосовое');
  const mime = (v.mime_type || 'audio/ogg').split(';')[0];
  return understandAndRun(user, chat, { audio: buf, mime }, true);
}

async function understandAndRun(user, chat, inp, isVoice) {
  if (!isVoice) call('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  const st = pending.get(chat);
  const pl = planned.get(chat);
  const products = store.getSection('products');
  const orders = store.orders.list(15, true).map(o => ({ id: o.id, name: o.name, product: o.product, status: store.ORDER_STATUS[o.status] || o.status }));
  const r = await voice.understand(inp, {
    products, orders, awaiting: awaitingText(st),
    confirming: pl && Date.now() - pl.at < PLAN_TTL ? describe(pl.plan, 'ru').replace(/<[^>]+>/g, '') : '',
  });
  if (isVoice && r.transcript) await say(chat, `${T(r.lang, 'heard')}: <i>${esc(r.transcript)}</i>`);
  return runCommand(user, chat, r, isVoice);
}

const PRODUCT_ACTIONS = new Set(['list_products', 'show_product', 'set_price', 'clear_price', 'set_sizes', 'set_name_ru', 'set_name_kk', 'set_photo', 'hide', 'show', 'delete', 'add_product']);

async function runCommand(user, chat, r, isVoice) {
  const L = r.lang;
  const st = pending.get(chat);
  const pl = planned.get(chat);
  const via = isVoice ? 'голосом' : 'текстом';

  // подтверждение / отказ
  if (r.action === 'yes') {
    planned.delete(chat);
    if (!pl) return say(chat, T(L, 'nothingToConfirm'), MENU);
    if (Date.now() - pl.at > PLAN_TTL) return say(chat, T(L, 'expired'), MENU);
    return execPlan(user, chat, pl.plan, L);
  }
  if (r.action === 'no') {
    const had = pending.has(chat) || planned.has(chat);
    pending.delete(chat); planned.delete(chat);
    return say(chat, had ? T(L, 'nothing') : T(L, 'unknown'), MENU);
  }

  // ответ на вопрос, который бот задал (цена, рост, название…)
  if (st && (r.action === 'answer' || r.action === 'skip' || r.action === 'unknown')) {
    if (st.field === 'image' || st.step === 'new_photo') {
      if (r.action === 'skip' && st.step === 'new_photo') return input(user, chat, {}, '-', st);
      return say(chat, T(L, 'waitPhoto'), st.step === 'new_photo' ? SKIP : CANCEL);
    }
    if (r.action === 'skip') {
      if (st.step && st.step.startsWith('new_')) return input(user, chat, {}, '-', st);
      pending.delete(chat); return say(chat, T(L, 'nothing'), MENU);
    }
    const val = r.value || r.transcript;
    return input(user, chat, {}, val, st).catch(e => say(chat, '⚠️ ' + esc(e.message), CANCEL));
  }
  if (st) pending.delete(chat);   // сказали новую команду — старый вопрос забываем
  planned.delete(chat);

  if (PRODUCT_ACTIONS.has(r.action) && !mayEditProducts(user)) return say(chat, T(L, 'noAccess'), MENU);

  const findProduct = async () => {
    const p = r.product_id ? store.getItem('products', r.product_id) : null;
    if (p) return p;
    await say(chat, r.product_query ? T(L, 'notFound', esc(r.product_query)) : T(L, 'which'));
    await listProducts(user, chat);
    return null;
  };
  const ask = (plan) => askConfirm(chat, plan, L);
  let p, v;

  switch (r.action) {
    case 'menu': return sayHelp(user, chat, L);
    case 'site': return say(chat, `Сайт: ${SITE_URL}\nАдминка: ${ADMIN_URL}`, MENU);
    case 'list_products': return listProducts(user, chat);
    case 'list_orders': return listOrders(chat);
    case 'show_product': if (!(p = await findProduct())) return; return showProduct(chat, p.id);

    case 'set_price':
      if (!(p = await findProduct())) return;
      if (!r.value) { pending.set(chat, { step: 'edit', id: p.id, field: 'price' }); return say(chat, `«${esc(p.name_ru)}»\n${T(L, 'askPrice')}`, CANCEL); }
      v = parseField('price', r.value);
      if (v.error || !v.value) { pending.set(chat, { step: 'edit', id: p.id, field: 'price' }); return say(chat, `«${esc(p.name_ru)}»\n${T(L, 'askPrice')}`, CANCEL); }
      return ask({ kind: 'field', id: p.id, field: 'price', value: v.value, via });
    case 'clear_price':
      if (!(p = await findProduct())) return;
      return ask({ kind: 'field', id: p.id, field: 'price', value: '', via });
    case 'set_sizes':
    case 'set_name_ru':
    case 'set_name_kk': {
      const field = { set_sizes: 'sizes', set_name_ru: 'name_ru', set_name_kk: 'name_kk' }[r.action];
      if (!(p = await findProduct())) return;
      v = r.value ? parseField(field, r.value) : { error: true };
      if (v.error) {
        pending.set(chat, { step: 'edit', id: p.id, field });
        return say(chat, `«${esc(p.name_ru)}»\n${T(L, field === 'sizes' ? 'askSizes' : 'askName')}`, CANCEL);
      }
      if (field === 'sizes' && /^\d+([–-]\d+)?$/.test(v.value)) v.value = v.value.replace('-', '–') + ' см';
      return ask({ kind: 'field', id: p.id, field, value: v.value, via });
    }
    case 'set_photo':
      if (!(p = await findProduct())) return;
      pending.set(chat, { step: 'edit', id: p.id, field: 'image' });
      return say(chat, `«${esc(p.name_ru)}»\n${T(L, 'photo')}`, CANCEL);
    case 'hide':
    case 'show':
      if (!(p = await findProduct())) return;
      return ask({ kind: 'show', id: p.id, value: r.action === 'show', via });
    case 'delete':
      if (!(p = await findProduct())) return;
      return ask({ kind: 'delete', id: p.id, via });
    case 'add_product': {
      const n = parseField('name_ru', r.name_ru || r.value);
      if (n.error) return newProduct(user, chat);   // название не расслышали — обычный пошаговый мастер
      const pr = r.value && r.value !== r.name_ru ? parseField('price', r.value) : { value: '' };
      const sz = r.sizes ? parseField('sizes', r.sizes) : { value: '' };
      const kk = r.name_kk ? parseField('name_kk', r.name_kk) : { value: '' };
      return ask({ kind: 'add', draft: { name_ru: n.value, name_kk: kk.error ? '' : kk.value, price: pr.error ? '' : pr.value, sizes: sz.error ? '' : sz.value }, via });
    }
    case 'order_status': {
      if (!r.order_id || !r.order_status) return say(chat, T(L, 'noOrder'), MENU);
      const o = store.orders.byId(r.order_id);
      if (!o) return say(chat, T(L, 'orderMissing', r.order_id), MENU);
      return ask({ kind: 'order', id: o.id, value: r.order_status, via });
    }
    default:
      return say(chat, r.reply ? esc(r.reply) : T(L, 'unknown'), MENU);
  }
}

function describe(plan, L) {
  if (plan.kind === 'add') return T(L, 'add', { ...plan.draft, name_ru: esc(plan.draft.name_ru), name_kk: esc(plan.draft.name_kk) });
  if (plan.kind === 'order') return T(L, 'order', plan.id, T(L, 'st')[plan.value]);
  const p = store.getItem('products', plan.id);
  const n = esc(p ? p.name_ru : '?');
  if (plan.kind === 'show') return plan.value ? T(L, 'show', n) : T(L, 'hide', n);
  if (plan.kind === 'delete') return T(L, 'del', n);
  const val = esc(plan.value);
  return { price: plan.value ? T(L, 'price', n, val) : T(L, 'clearPrice', n), sizes: T(L, 'sizes', n, val), name_ru: T(L, 'nameRu', n, val), name_kk: T(L, 'nameKk', n, val) }[plan.field];
}

function askConfirm(chat, plan, L) {
  planned.set(chat, { plan, lang: L, at: Date.now() });
  return say(chat, describe(plan, L) + '\n\n' + T(L, 'confirm'), { inline_keyboard: [[{ text: T(L, 'yes'), callback_data: 'vy' }, { text: T(L, 'no'), callback_data: 'vn' }]] });
}

async function execPlan(user, chat, plan, L) {
  if (plan.kind === 'order') {
    const o = store.orders.byId(plan.id);
    if (!o) return say(chat, T(L, 'orderMissing', plan.id), MENU);
    store.orders.setStatus(o.id, plan.value, user.name || user.login);
    store.log.add(user.login, `через Telegram (${plan.via}): заявка №${o.id} → ${store.ORDER_STATUS[plan.value]}`);
    const upd = store.orders.byId(o.id);
    return say(chat, orderText(upd), orderKb(upd));
  }
  if (!mayEditProducts(user)) return say(chat, T(L, 'noAccess'), MENU);
  if (plan.kind === 'add') {
    store.backup();
    const id = store.insertItem('products', { ...plan.draft, show: true }, true);
    onChange();
    store.log.add(user.login, `через Telegram (${plan.via}): добавил(а) товар «${plan.draft.name_ru}»`);
    pending.set(chat, { step: 'edit', id, field: 'image' });
    await say(chat, T(L, 'added'), MENU);
    return say(chat, T(L, 'photo'), CANCEL);
  }
  const p = store.getItem('products', plan.id);
  if (!p) return say(chat, 'Этого товара уже нет.', MENU);
  if (plan.kind === 'delete') {
    store.backup();
    store.deleteItem('products', p.id);
    onChange();
    store.log.add(user.login, `через Telegram (${plan.via}): удалил(а) товар «${p.name_ru}»`);
    return say(chat, `🗑 «${esc(p.name_ru)}» ✅`, MENU);
  }
  if (plan.kind === 'show') save(user, p.id, { show: plan.value }, `(${plan.via}) ` + (plan.value ? 'вернул(а) на сайт товар' : 'скрыл(а) с сайта товар'));
  else save(user, p.id, { [plan.field]: plan.value }, `(${plan.via}) изменил(а) ${FIELD_WORD[plan.field]}` +
    (plan.field === 'price' ? ` (${p.price || '—'} → ${plan.value || '—'})` : '') + ' у товара');
  await say(chat, T(L, 'saved'), MENU);
  return showProduct(chat, p.id);
}

module.exports = {
  start, stop, configure, info, connectLink, notifyOrder,
  setOnChange: fn => { onChange = fn; },
  _test: { parseField, orderText, cardText, runCommand, describe },
};
