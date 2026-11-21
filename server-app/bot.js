'use strict';
// Telegram-бот «Кит» для владельца и сотрудников.
//  • Заявки с сайта сразу приходят всем подключённым сотрудникам (кнопки «В работе» / «Выполнена»).
//  • Товары можно менять с телефона: цена, рост, название, фото, показать/скрыть, удалить, добавить новый.
// Работает в том же процессе, что сайт и админка: long polling, без внешних пакетов.
// Токен бота вводится в админке (раздел «Telegram-бот») и хранится в базе.
const store = require('./db');
const images = require('./images');
const { canEdit } = require('./schema');

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

async function downloadPhoto(m) {
  let fileId = null, size = 0;
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; fileId = p.file_id; size = p.file_size || 0; }
  else if (m.document && /^image\//.test(m.document.mime_type || '')) { fileId = m.document.file_id; size = m.document.file_size || 0; }
  if (!fileId) return null;
  if (size > 10 * 1024 * 1024) throw new Error('Фото больше 10 МБ');
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Не удалось скачать фото');
  return Buffer.from(await r.arrayBuffer());
}

// ---------- запуск / остановка ----------
async function start() {
  const my = ++generation;
  token = store.meta.get('bot_token');
  username = store.meta.get('bot_username');
  pending.clear();
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

  if (text === '/cancel' || text === '✖️ Отмена') { pending.delete(chat); return say(chat, 'Отменено.', MENU); }
  if (text === '/stop') {
    store.tg.unlink(chat); pending.delete(chat);
    store.log.add(user.login, 'отключил Telegram');
    return say(chat, 'Telegram отключён от админки. Заявки сюда больше не придут.', { remove_keyboard: true });
  }

  const st = pending.get(chat);
  const isMenu = ['📦 Товары', '➕ Новый товар', '📨 Заявки', '🌐 Сайт'].includes(text) || text.startsWith('/');
  if (st && !isMenu) return input(user, chat, m, text, st).catch(e => say(chat, '⚠️ ' + esc(e.message), CANCEL));
  if (st && isMenu) pending.delete(chat);

  if (text === '📦 Товары' || text === '/products') return listProducts(user, chat);
  if (text === '➕ Новый товар' || text === '/new') return newProduct(user, chat);
  if (text === '📨 Заявки' || text === '/orders') return listOrders(chat);
  if (text === '🌐 Сайт') return say(chat, `Сайт: ${SITE_URL}\nАдминка: ${ADMIN_URL}`, MENU);
  return say(chat, `Здравствуйте, ${esc(user.name || user.login)}! Выберите действие кнопками внизу.\n\n` +
    '📦 <b>Товары</b> — изменить цену, рост, фото, скрыть или удалить\n➕ <b>Новый товар</b> — добавить на сайт с телефона\n📨 <b>Заявки</b> — открытые заявки с сайта', MENU);
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
  if (field === 'name_ru') {
    if (!t || t === '-') return { error: 'Название не может быть пустым.' };
    if (t.length > 80) return { error: 'Слишком длинное название (максимум 80 символов).' };
    return { value: t };
  }
  return { error: 'Неизвестное поле' };
}

const FIELD_WORD = { price: 'цену', sizes: 'рост', name_ru: 'название', image: 'фото' };

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

module.exports = {
  start, stop, configure, info, connectLink, notifyOrder,
  setOnChange: fn => { onChange = fn; },
  _test: { parseField, orderText, cardText },
};
