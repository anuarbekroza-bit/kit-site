'use strict';
// Помощник ботов: статистика, утренняя сводка, массовые правки, тексты для клиентов и Instagram,
// «что было ночью» для бота сервера. Цифры считаются здесь (точно), ИИ только формулирует.
const fs = require('fs');
const store = require('./db');
const ai = require('./voice');

const TZ = 5 * 3600 * 1000;   // Астана, UTC+5
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtPrice = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const priceNum = p => Number(String(p || '').replace(/\D/g, '')) || 0;
const utcMs = at => Date.parse(String(at).replace(' ', 'T') + 'Z');
const almaty = ms => new Date(ms + TZ);
const dayKey = ms => almaty(ms).toISOString().slice(0, 10);
const ddmm = ms => almaty(ms).toISOString().slice(5, 10).split('-').reverse().join('.');

// ---------- черновые пометки и недоделки на сайте ----------
const DRAFT_RE = /надо\s+(на)?писать|допиш|уточнить|скоро|todo|xxx|\?\?\?|заполнить|тест\b|исправить/i;
function productIssues() {
  const items = store.getSection('products');
  const shown = items.filter(p => p.show);
  const drafts = [];
  for (const p of items) for (const f of ['name_ru', 'name_kk', 'price', 'sizes']) {
    if (p[f] && DRAFT_RE.test(p[f])) drafts.push({ id: p.id, name: p.name_ru, field: f, text: p[f] });
  }
  return {
    total: items.length, shown: shown.length, hidden: items.length - shown.length,
    noPrice: shown.filter(p => !priceNum(p.price)).map(p => p.name_ru),
    noPhoto: shown.filter(p => !p.image).map(p => p.name_ru),
    noSizes: shown.filter(p => !p.sizes).map(p => p.name_ru),
    noKk: shown.filter(p => !p.name_kk).map(p => p.name_ru),
    drafts,
  };
}

// ---------- статистика заявок ----------
function shopStats() {
  const now = Date.now();
  const all = store.orders.list(100000).map(o => ({ ...o, ms: utcMs(o.at) }));
  const today = dayKey(now), yesterday = dayKey(now - 86400000), month = today.slice(0, 7);
  const since = d => all.filter(o => now - o.ms <= d * 86400000);
  const byStatus = list => list.reduce((a, o) => (a[store.ORDER_STATUS[o.status] || o.status] = (a[store.ORDER_STATUS[o.status] || o.status] || 0) + 1, a), {});
  const top = list => Object.entries(list.reduce((a, o) => { const k = (o.product || 'без товара').trim(); a[k] = (a[k] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ товар: name, заявок: n }));
  const open = all.filter(o => o.status === 'new' || o.status === 'work');
  const oldestNew = all.filter(o => o.status === 'new').sort((a, b) => a.ms - b.ms)[0];
  const byDay = {};
  for (const o of since(14)) byDay[dayKey(o.ms)] = (byDay[dayKey(o.ms)] || 0) + 1;
  const iss = productIssues();
  return {
    'сейчас (Астана)': almaty(now).toISOString().slice(0, 16).replace('T', ' '),
    'заявок сегодня': all.filter(o => dayKey(o.ms) === today).length,
    'заявок вчера': all.filter(o => dayKey(o.ms) === yesterday).length,
    'заявок за 7 дней': since(7).length,
    'заявок за 30 дней': since(30).length,
    'заявок в этом месяце': all.filter(o => dayKey(o.ms).startsWith(month)).length,
    'заявок всего': all.length,
    'по дням за 14 дней': byDay,
    'статусы за 30 дней': byStatus(since(30)),
    'открытые сейчас': { новые: open.filter(o => o.status === 'new').length, 'в работе': open.filter(o => o.status === 'work').length },
    'самая старая новая заявка, часов назад': oldestNew ? Math.round((now - oldestNew.ms) / 360000) / 10 : null,
    'чаще всего заказывают (30 дней)': top(since(30)),
    'чаще всего заказывают (всё время)': top(all),
    товары: { всего: iss.total, 'на сайте': iss.shown, скрыто: iss.hidden, 'без цены': iss.noPrice.length, 'без фото': iss.noPhoto.length, 'без роста': iss.noSizes.length },
  };
}

async function answerStats(question, lang) {
  const text = await ai.generate(`Сотрудник спросил: «${question}». Ответь коротко (1–4 предложения), с точными цифрами из фактов. Если в фактах нет ответа — так и скажи.`, shopStats(), lang);
  return '📊 ' + esc(text);
}

// ---------- утренняя сводка (без ИИ: точно и бесплатно) ----------
function summaryHtml(lang) {
  const kk = lang === 'kk';
  const s = shopStats(), iss = productIssues();
  const list = (arr, n = 5) => arr.slice(0, n).map(esc).join(', ') + (arr.length > n ? (kk ? ` және тағы ${arr.length - n}` : ` и ещё ${arr.length - n}`) : '');
  const L = [];
  L.push(kk ? `☀️ <b>«Кит» таңғы есебі</b> · ${ddmm(Date.now())}` : `☀️ <b>Сводка «Кит»</b> · ${ddmm(Date.now())}`);
  L.push('');
  const o = s['открытые сейчас'];
  L.push((kk ? '📨 Жаңа өтінімдер: ' : '📨 Новые заявки: ') + `<b>${o.новые}</b>` + (o['в работе'] ? (kk ? `, жұмыста: ${o['в работе']}` : `, в работе: ${o['в работе']}`) : '') +
    (s['самая старая новая заявка, часов назад'] >= 1 ? (kk ? ` (ең ескісі ${Math.round(s['самая старая новая заявка, часов назад'])} сағ. күтіп тұр)` : ` (самая старая ждёт ${Math.round(s['самая старая новая заявка, часов назад'])} ч)`) : ''));
  L.push((kk ? '📈 Кеше: ' : '📈 Вчера заявок: ') + s['заявок вчера'] + (kk ? ` · 7 күнде: ${s['заявок за 7 дней']}` : ` · за 7 дней: ${s['заявок за 7 дней']}`));
  const todo = [];
  for (const d of iss.drafts) todo.push(`📝 «${esc(d.name)}» — ${kk ? 'черновик мәтін' : 'черновая пометка'}: <i>${esc(d.text)}</i>`);
  if (iss.noPrice.length) todo.push(`💰 ${kk ? 'Бағасы жоқ' : 'Без цены'} (${iss.noPrice.length}): ${list(iss.noPrice)}`);
  if (iss.noSizes.length) todo.push(`📏 ${kk ? 'Бойы жоқ' : 'Без роста'} (${iss.noSizes.length}): ${list(iss.noSizes)}`);
  if (iss.noPhoto.length) todo.push(`🖼 ${kk ? 'Суреті жоқ' : 'Без фото'} (${iss.noPhoto.length}): ${list(iss.noPhoto)}`);
  if (iss.noKk.length) todo.push(`🇰🇿 ${kk ? 'Қазақша атауы жоқ' : 'Без казахского названия'} (${iss.noKk.length}): ${list(iss.noKk)}`);
  if (iss.hidden) todo.push(`🙈 ${kk ? 'Сайттан жасырылған' : 'Скрыто с сайта'}: ${iss.hidden}`);
  L.push('');
  if (todo.length) { L.push(kk ? '⚠️ <b>Сайтта жөндеу керек:</b>' : '⚠️ <b>Доделать на сайте:</b>'); L.push(...todo); }
  else L.push(kk ? '✅ Сайтта бәрі толтырылған.' : '✅ На сайте всё заполнено.');
  if (todo.length) L.push('', kk ? '🎤 Дауыспен түзетуге болады: «Бомбердің бағасы 15 000».' : '🎤 Можно исправить голосом: «Бомберу цену 15 000».');
  return L.join('\n');
}

// ---------- массовые правки ----------
function bulkChanges(ids, op, value) {
  const items = store.getSection('products').filter(p => ids.includes(p.id));
  if (!items.length) return { error: 'none' };
  const changes = [], skipped = [];
  if (op === 'hide' || op === 'show') {
    for (const p of items) if (!!p.show !== (op === 'show')) changes.push({ id: p.id, name: p.name_ru, fields: { show: op === 'show' }, before: p.show ? 'на сайте' : 'скрыт', after: op === 'show' ? 'на сайте' : 'скрыт' });
    else skipped.push(p.name_ru);
  } else if (op === 'price_percent') {
    const pct = Number(String(value).replace(',', '.').replace(/[^\d.+-]/g, ''));
    if (!Number.isFinite(pct) || pct === 0 || pct < -90 || pct > 200) return { error: 'percent' };
    for (const p of items) {
      const old = priceNum(p.price);
      if (!old) { skipped.push(p.name_ru); continue; }
      const nv = Math.max(100, Math.round(old * (1 + pct / 100) / 100) * 100);   // округляем до 100 ₸
      changes.push({ id: p.id, name: p.name_ru, fields: { price: fmtPrice(nv) }, before: fmtPrice(old) + ' ₸', after: fmtPrice(nv) + ' ₸' });
    }
  } else if (op === 'price_set') {
    const v = priceNum(value);
    if (!v || v > 1e8) return { error: 'price' };
    for (const p of items) changes.push({ id: p.id, name: p.name_ru, fields: { price: fmtPrice(v) }, before: p.price ? p.price + ' ₸' : 'без цены', after: fmtPrice(v) + ' ₸' });
  } else if (op === 'sizes_set') {
    let v = String(value || '').trim();
    if (!v || v.length > 40) return { error: 'sizes' };
    if (/^\d+([–-]\d+)?$/.test(v)) v = v.replace('-', '–') + ' см';
    for (const p of items) changes.push({ id: p.id, name: p.name_ru, fields: { sizes: v }, before: p.sizes || '—', after: v });
  } else return { error: 'op' };
  return { changes, skipped };
}

// ---------- тексты ----------
function contacts() { return store.getSection('contacts') || {}; }

async function clientMessage(order, gist, lang) {
  const c = contacts();
  return ai.generate(
    `Напиши сообщение клиенту в WhatsApp от магазина «Кит». Что нужно передать (слова сотрудника): «${gist}». ` +
    'Поздоровайся и обратись по имени, если оно есть. 1–3 коротких предложения, вежливо и тепло, можно один эмодзи. Не подписывайся именем сотрудника. Верни только текст сообщения.',
    { клиент: order.name || '', 'товар из заявки': order.product || '', 'комментарий клиента': order.comment || '',
      магазин: { адрес: lang === 'kk' ? (c.address_kk || c.address_ru) : c.address_ru, 'часы работы': c.hours, доставка: lang === 'kk' ? (c.delivery_kk || c.delivery_ru) : c.delivery_ru, сайт: process.env.SITE_URL || 'https://kit.r-agent.kz' } },
    lang);
}

async function instagramPost(p, lang) {
  const c = contacts();
  const which = lang === 'kk' ? 'только по-казахски' : lang === 'ru' ? 'только по-русски' : 'двумя блоками: сначала по-русски, потом по-казахски (между ними пустая строка)';
  return ai.generate(
    `Напиши подпись для поста/Reels в Instagram детского магазина одежды «Кит» про этот товар, ${which}. ` +
    'Цепляющая первая строка, 2–4 коротких предложения о товаре, цена и рост (если есть), призыв написать в WhatsApp или прийти в магазин, адрес. ' +
    'В самом конце одна строка из 6–10 хештегов (например #астана #детскаяодежда #детскаяодеждаастана #балаларкиімі). Эмодзи умеренно. Верни только текст поста.',
    { товар: p.name_ru, 'по-казахски': p.name_kk || '', цена: p.price ? p.price + ' ₸' : 'уточнять в WhatsApp', рост: p.sizes || 'не указан',
      магазин: { адрес: c.address_ru, 'адрес по-казахски': c.address_kk, часы: c.hours, whatsapp: c.whatsapp ? '+' + c.whatsapp : '', instagram: c.instagram ? '@' + c.instagram : '', доставка: c.delivery_ru } },
    lang === 'kk' ? 'kk' : 'ru');
}

// ---------- «что было ночью» (бот сервера) ----------
store.db.exec(`CREATE TABLE IF NOT EXISTS srv_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), kind TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT ''
)`);
const events = {
  add: (kind, text) => { store.db.prepare('INSERT INTO srv_events (kind, text) VALUES (?, ?)').run(kind, String(text).replace(/<[^>]+>/g, '').slice(0, 500)); store.db.prepare('DELETE FROM srv_events WHERE id <= (SELECT MAX(id) FROM srv_events) - 1000').run(); },
  since: hours => store.db.prepare("SELECT at, kind, text FROM srv_events WHERE at >= datetime('now', ?) ORDER BY id").all(`-${hours} hours`),
};
function watchdogEvents(hours) {
  try {
    const st = JSON.parse(fs.readFileSync(process.env.KIT_WATCHDOG_STATE || '/var/lib/kit-watchdog/state.json', 'utf8'));
    return (st.events || []).filter(e => Date.now() - e.at <= hours * 3600000).map(e => ({ когда: almaty(e.at).toISOString().slice(0, 16).replace('T', ' '), что: e.text }));
  } catch { return []; }
}

async function nightReport(hours, lang, snapshot, problemsNow) {
  hours = Math.min(168, Math.max(1, hours || 12));
  const t = at => almaty(utcMs(at)).toISOString().slice(0, 16).replace('T', ' ');
  const data = {
    'период': `последние ${hours} ч (время — Астана)`,
    'события сервера': events.since(hours).map(e => ({ когда: t(e.at), что: e.text })),
    'сторож (перезапуски сайта/nginx)': watchdogEvents(hours),
    'действия людей в админке и ботах': store.log.list(400).filter(l => Date.now() - utcMs(l.at) <= hours * 3600000).slice(0, 60).map(l => ({ когда: t(l.at), кто: l.user, что: l.action })),
    'бэкапов сделано за период': store.backupsList().filter(b => Date.now() - b.mtime <= hours * 3600000).length,
    'заявок с сайта за период': store.orders.list(100000).filter(o => Date.now() - utcMs(o.at) <= hours * 3600000).length,
    'сейчас': { проблемы: problemsNow.map(p => p.text), 'сервер работает часов': Math.round(snapshot.uptime.server / 360) / 10, 'сайт работает часов': Math.round(snapshot.uptime.app / 360) / 10 },
  };
  const text = await ai.generate(
    `Владелец спрашивает, что происходило с сервером и сайтом за ${hours} ч. Расскажи простыми словами, без технического жаргона, 3–7 коротких строк: ` +
    'были ли сбои и перезапуски (когда и чем закончились), кто что менял на сайте, сколько пришло заявок, есть ли проблемы сейчас. Если всё спокойно — так и скажи одной-двумя фразами.',
    data, lang);
  return '🌙 ' + esc(text);
}

module.exports = { shopStats, answerStats, summaryHtml, productIssues, bulkChanges, clientMessage, instagramPost, nightReport, events, dayKey, almaty, priceNum, fmtPrice };
