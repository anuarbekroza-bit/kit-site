'use strict';
// Сайт «Кит» + админка. Node.js без внешних пакетов, база SQLite.
// Сайт:   https://kit.r-agent.kz
// Админка: https://admin.r-agent.kz  (страницы /admin/...)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const { SECTIONS, ROLES, canEdit, byKey } = require('./schema');
const site = require('./site');
const ui = require('./admin-ui');
const images = require('./images');
const bot = require('./bot');

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = process.env.SITE_URL || 'https://kit.r-agent.kz';
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.r-agent.kz';
const MAX_BODY = 15 * 1024 * 1024;

// ---------- кэш сайта ----------
let siteCache = null;
function siteHtml() {
  if (!siteCache) siteCache = site.render(store.getAll(), { baseUrl: SITE_URL });
  return siteCache;
}

// ---------- помощники ----------
function send(res, code, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, code, obj, headers) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Файл слишком большой'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const t = await readBody(req, limit);
  try { return t ? JSON.parse(t) : {}; } catch { throw Object.assign(new Error('Неверные данные'), { code: 400 }); }
}
function cookies(req) {
  const o = {};
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';
const clientIp = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
function hostIsAdmin(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return h.startsWith('admin.') || h.startsWith('localhost') || h.startsWith('127.0.0.1');
}

// ---------- защита входа: 5 ошибок за 15 минут — пауза ----------
const fails = new Map();
function loginBlocked(ip) {
  const f = fails.get(ip);
  return f && f.count >= 5 && Date.now() - f.first < 15 * 60 * 1000;
}
function loginFailed(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

// ---------- картинки ----------
const IMG_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function serveImage(req, res, name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return send(res, 404, 'Not found', 'text/plain');
  const file = path.join(store.IMAGES_DIR, name);
  const type = IMG_TYPES[path.extname(name).toLowerCase()];
  if (!type) return send(res, 404, 'Not found', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  });
}
const saveUpload = images.saveDataUrl;

// ---------- проверка данных раздела ----------
function validate(sec, data) {
  const errs = [];
  const check = (f, v, where) => {
    const s = v === undefined || v === null ? '' : String(v);
    if (f.required && f.type !== 'boolean' && !s.trim()) errs.push(`${where}«${f.label}» — обязательное поле`);
    if (f.pattern && s && !new RegExp(f.pattern).test(s)) errs.push(`${where}«${f.label}»: ${f.patternMsg || 'неверный формат'}`);
    if (f.type === 'image' && s && !/^\/images\/[a-zA-Z0-9._-]+$/.test(s)) errs.push(`${where}«${f.label}»: неверный путь к фото`);
  };
  if (sec.type === 'list') {
    if (!Array.isArray(data)) return ['Неверные данные'];
    if (data.length > 500) return ['Слишком много записей'];
    data.forEach((it, i) => sec.fields.forEach(f => check(f, it && it[f.name], `${sec.item} №${i + 1}: `)));
  } else {
    if (!data || typeof data !== 'object') return ['Неверные данные'];
    sec.fields.forEach(f => check(f, data[f.name], ''));
  }
  return errs;
}

// ---------- заявка с сайта ----------
const orderHits = new Map(); // ip -> [время заявок]
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return /^7\d{10}$/.test(d) ? d : '';
}
async function siteOrder(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (orderHits.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (hits.length >= 5) return json(res, 429, { error: 'Слишком много заявок. Напишите нам в WhatsApp.' });
  const b = await readJson(req, 10 * 1024);
  if (b.website) return json(res, 200, { ok: true }); // ловушка для спам-ботов
  const name = String(b.name || '').trim().slice(0, 60);
  const phone = normPhone(b.phone);
  if (!name) return json(res, 400, { error: 'Напишите, как к вам обращаться', field: 'name' });
  if (!phone) return json(res, 400, { error: 'Проверьте номер телефона: +7 и 10 цифр', field: 'phone' });
  hits.push(now); orderHits.set(ip, hits);
  const id = store.orders.create({ name, phone, product: String(b.product || '').trim().slice(0, 120), comment: String(b.comment || '').trim().slice(0, 500) });
  store.log.add('сайт', `новая заявка №${id} (${name})`);
  bot.notifyOrder(store.orders.byId(id)).catch(e => console.error('bot notify:', e.message));
  return json(res, 200, { ok: true, id });
}

// ---------- админка ----------
function sessionCookie(req, token, maxAge) {
  return `kit_sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
function publicUser(s) {
  const r = ROLES[s.role] || {};
  return { id: s.id, login: s.login, name: s.name, role: s.role, roleLabel: r.label, users: !!r.users, log: !!r.log,
    sections: SECTIONS.filter(x => canEdit(s.role, x.key)).map(x => x.key) };
}

async function admin(req, res, url) {
  const p = url.pathname;
  const sess = store.sessions.get(cookies(req).kit_sid);

  if (p === '/admin/login' && req.method === 'GET') {
    if (sess) return redirect(res, '/admin/');
    return send(res, 200, ui.loginPage(url.searchParams.get('e')));
  }
  if (p === '/admin/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return redirect(res, '/admin/login?e=blocked');
    const form = new URLSearchParams(await readBody(req));
    const u = store.users.byLogin(form.get('login') || '');
    if (!u || !store.checkPassword(form.get('password') || '', u.pass_hash)) {
      loginFailed(ip);
      store.log.add(String(form.get('login') || '?').slice(0, 40), 'неудачная попытка входа (' + ip + ')');
      return redirect(res, '/admin/login?e=bad');
    }
    fails.delete(ip);
    const token = store.sessions.create(u.id);
    store.log.add(u.login, 'вошёл в админку');
    return redirect(res, '/admin/', { 'Set-Cookie': sessionCookie(req, token, 7 * 24 * 3600) });
  }
  if (p === '/admin/setup' && req.method === 'GET') {
    const t = url.searchParams.get('t') || '';
    const ok = store.setupLinks.valid(t);
    const owner = store.users.firstOwner();
    return send(res, 200, ui.setupPage({ token: ok ? t : '', err: url.searchParams.get('e'), hasOwner: !!owner, login: owner ? owner.login : '' }), undefined, { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  }
  if (p === '/admin/setup' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return redirect(res, '/admin/login?e=blocked');
    const form = new URLSearchParams(await readBody(req));
    const t = form.get('t') || '';
    if (!store.setupLinks.valid(t)) { loginFailed(ip); return redirect(res, '/admin/setup?e=gone'); }
    const back = e => redirect(res, '/admin/setup?t=' + encodeURIComponent(t) + '&e=' + e);
    const login = String(form.get('login') || '').trim().toLowerCase();
    const pass = String(form.get('password') || '');
    if (!/^[a-z0-9._-]{3,32}$/.test(login)) return back('login');
    if (pass.length < 8) return back('pass');
    if (pass !== String(form.get('password2') || '')) return back('same');
    const owner = store.users.firstOwner();
    const other = store.users.byLogin(login);
    if (other && (!owner || other.id !== owner.id)) return back('taken');
    if (!store.setupLinks.use(t)) return redirect(res, '/admin/setup?e=gone');
    let id;
    if (owner) { store.users.update(owner.id, { login, password: pass }); id = owner.id; }
    else id = Number(store.users.create(login, login, 'owner', pass).lastInsertRowid);
    store.log.add(login, 'задал логин и пароль владельца по одноразовой ссылке (' + ip + ')');
    const token = store.sessions.create(id);
    return redirect(res, '/admin/', { 'Set-Cookie': sessionCookie(req, token, 7 * 24 * 3600) });
  }
  if (p === '/admin/logout' && req.method === 'POST') {
    if (sess) store.sessions.remove(sess.token);
    return redirect(res, '/admin/login', { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (!sess) {
    if (p.startsWith('/admin/api/')) return json(res, 401, { error: 'Войдите заново' });
    return redirect(res, '/admin/login');
  }

  if (p === '/admin/' || p === '/admin') {
    return send(res, 200, ui.appPage({ user: publicUser(sess), csrf: sess.csrf, sections: SECTIONS, roles: ROLES, siteUrl: SITE_URL }),
      undefined, { 'Cache-Control': 'no-store' });
  }

  if (!p.startsWith('/admin/api/')) return send(res, 404, 'Not found', 'text/plain');
  // все запросы API — только из самой админки
  if (req.method !== 'GET' && req.headers['x-csrf'] !== sess.csrf) return json(res, 403, { error: 'Обновите страницу и попробуйте снова' });
  const role = ROLES[sess.role] || {};
  let m;

  if ((m = /^\/admin\/api\/section\/([a-z]+)$/.exec(p))) {
    const sec = byKey[m[1]];
    if (!sec) return json(res, 404, { error: 'Нет такого раздела' });
    if (!canEdit(sess.role, sec.key)) return json(res, 403, { error: 'Нет доступа к этому разделу' });
    if (req.method === 'GET') return json(res, 200, { data: store.getSection(sec.key) });
    if (req.method === 'PUT') {
      const body = await readJson(req);
      const errs = validate(sec, body.data);
      if (errs.length) return json(res, 400, { error: errs.slice(0, 5).join('\n') });
      store.backup();
      store.setSection(sec.key, body.data);
      siteCache = null;
      store.log.add(sess.login, 'сохранил раздел «' + sec.label + '»');
      return json(res, 200, { ok: true, data: store.getSection(sec.key) });
    }
  }

  if (p === '/admin/api/upload' && req.method === 'POST') {
    const body = await readJson(req);
    const imgPath = saveUpload(body.data);
    store.log.add(sess.login, 'загрузил фото ' + imgPath);
    return json(res, 200, { path: imgPath });
  }

  if (p === '/admin/api/me/password' && req.method === 'PUT') {
    const body = await readJson(req);
    const u = store.users.byId(sess.id);
    if (!store.checkPassword(String(body.current || ''), u.pass_hash)) return json(res, 400, { error: 'Текущий пароль неверный' });
    if (String(body.next || '').length < 8) return json(res, 400, { error: 'Новый пароль — минимум 8 символов' });
    store.users.update(sess.id, { password: String(body.next) });
    const token = store.sessions.create(sess.id);
    store.log.add(sess.login, 'сменил свой пароль');
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, 7 * 24 * 3600) });
  }

  if (p === '/admin/api/orders' && req.method === 'GET') {
    return json(res, 200, { data: store.orders.list(300), statuses: store.ORDER_STATUS });
  }
  if ((m = /^\/admin\/api\/orders\/(\d+)$/.exec(p)) && req.method === 'PUT') {
    const b = await readJson(req);
    if (!store.ORDER_STATUS[b.status]) return json(res, 400, { error: 'Неверный статус' });
    if (!store.orders.setStatus(m[1], b.status, sess.name || sess.login)) return json(res, 404, { error: 'Заявка не найдена' });
    store.log.add(sess.login, `заявка №${m[1]} → ${store.ORDER_STATUS[b.status]}`);
    return json(res, 200, { ok: true });
  }

  if (p === '/admin/api/bot' && req.method === 'GET') {
    const links = store.tg.links().filter(l => role.users || l.user_id === sess.id)
      .map(l => ({ chat_id: l.chat_id, tg_name: l.tg_name, login: l.login, name: l.name, created_at: l.created_at }));
    return json(res, 200, { ...bot.info(), canConfigure: !!role.users, links });
  }
  if (p === '/admin/api/bot' && req.method === 'PUT') {
    if (!role.users) return json(res, 403, { error: 'Токен бота меняет только владелец' });
    const b = await readJson(req);
    const inf = await bot.configure(b.token);
    store.log.add(sess.login, b.token ? 'подключил Telegram-бота' + (inf.username ? ' @' + inf.username : '') : 'отключил Telegram-бота');
    return json(res, 200, inf);
  }
  if (p === '/admin/api/bot/connect' && req.method === 'POST') {
    const url = bot.connectLink(sess.id);
    if (!url) return json(res, 400, { error: 'Бот ещё не подключён. Владелец должен вставить токен бота.' });
    return json(res, 200, { url });
  }
  if ((m = /^\/admin\/api\/bot\/links\/(-?\d+)$/.exec(p)) && req.method === 'DELETE') {
    const l = store.tg.links().find(x => x.chat_id === m[1]);
    if (!l) return json(res, 404, { error: 'Не найдено' });
    if (!role.users && l.user_id !== sess.id) return json(res, 403, { error: 'Нет доступа' });
    store.tg.unlink(m[1]);
    store.log.add(sess.login, `отключил Telegram ${l.tg_name || ''} (${l.login})`);
    return json(res, 200, { ok: true });
  }

  if (p === '/admin/api/log' && req.method === 'GET') {
    if (!role.log) return json(res, 403, { error: 'Нет доступа' });
    return json(res, 200, { data: store.log.list(300) });
  }

  if (p.startsWith('/admin/api/users')) {
    if (!role.users) return json(res, 403, { error: 'Только владелец управляет сотрудниками' });
    if (p === '/admin/api/users' && req.method === 'GET') return json(res, 200, { data: store.users.list() });
    if (p === '/admin/api/users' && req.method === 'POST') {
      const b = await readJson(req);
      const login = String(b.login || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(login)) return json(res, 400, { error: 'Логин: 3–32 латинские буквы, цифры, точка, дефис' });
      if (!ROLES[b.role]) return json(res, 400, { error: 'Выберите уровень доступа' });
      if (String(b.password || '').length < 8) return json(res, 400, { error: 'Пароль — минимум 8 символов' });
      if (store.users.byLogin(login)) return json(res, 400, { error: 'Такой логин уже есть' });
      store.users.create(login, String(b.name || '').slice(0, 80), b.role, String(b.password));
      store.log.add(sess.login, `добавил сотрудника ${login} (${ROLES[b.role].label})`);
      return json(res, 200, { ok: true });
    }
    if ((m = /^\/admin\/api\/users\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      const u = store.users.byId(id);
      if (!u) return json(res, 404, { error: 'Сотрудник не найден' });
      if (req.method === 'PUT') {
        const b = await readJson(req);
        if (b.role !== undefined && !ROLES[b.role]) return json(res, 400, { error: 'Неверный уровень доступа' });
        if (b.role && b.role !== 'owner' && u.role === 'owner' && store.users.owners() <= 1) return json(res, 400, { error: 'Нельзя убрать последнего владельца' });
        if (b.password && String(b.password).length < 8) return json(res, 400, { error: 'Пароль — минимум 8 символов' });
        store.users.update(id, { name: b.name !== undefined ? String(b.name).slice(0, 80) : undefined, role: b.role, password: b.password ? String(b.password) : undefined });
        store.log.add(sess.login, `изменил сотрудника ${u.login}` + (b.role ? ` → ${ROLES[b.role].label}` : '') + (b.password ? ' (новый пароль)' : ''));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (id === sess.id) return json(res, 400, { error: 'Нельзя удалить самого себя' });
        if (u.role === 'owner' && store.users.owners() <= 1) return json(res, 400, { error: 'Нельзя удалить последнего владельца' });
        store.users.remove(id);
        store.log.add(sess.login, `удалил сотрудника ${u.login}`);
        return json(res, 200, { ok: true });
      }
    }
  }
  return json(res, 404, { error: 'Не найдено' });
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/health') return send(res, 200, 'ok', 'text/plain');
    if (p.startsWith('/images/')) return serveImage(req, res, decodeURIComponent(p.slice(8)));
    if (hostIsAdmin(req)) {
      if ((p === '/' || p === '') && String(req.headers.host || '').toLowerCase().startsWith('admin.')) return redirect(res, '/admin/');
      if (p.startsWith('/admin')) return await admin(req, res, url);
    }
    if (p === '/api/order' && req.method === 'POST') return await siteOrder(req, res);
    if (p === '/' || p === '/index.html') {
      return send(res, 200, siteHtml(), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', 'text/plain');
    return send(res, 404, '<h1>404</h1><p><a href="/">На главную</a></p>');
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, code, { error: code === 500 ? 'Ошибка на сервере, попробуйте ещё раз' : e.message });
    else res.end();
  }
});

if (require.main === module) {
  if (store.isEmpty()) {
    store.seed(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    console.log('База заполнена начальными данными сайта');
  }
  setInterval(() => store.sessions.cleanup(), 3600 * 1000).unref();
  bot.setOnChange(() => { siteCache = null; });
  bot.start().then(i => console.log('Telegram-бот:', i.status, i.username ? '@' + i.username : '', i.lastError || ''));
  server.listen(PORT, '127.0.0.1', () => console.log(`Кит: сайт и админка на http://127.0.0.1:${PORT} (админка: ${ADMIN_URL})`));
}

module.exports = { server };
