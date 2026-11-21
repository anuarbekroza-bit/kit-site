'use strict';
// ИИ для ботов «Кит» и «Мой сервер»: голос и текст на русском, казахском и вперемешку (шала-қазақ).
//  • понимание команд: голосовое/текст → одна команда в JSON;
//  • генерация текстов: ответы клиентам, статистика, сводки, посты для Instagram, «что было ночью»;
//  • настройки (модели, голос, режим ответов, манера) — в админке, хранятся в базе;
//  • журнал команд и расход за месяц, месячный лимит запросов.
// Ключ: из админки, а если там пусто — OPENAI_API_KEY из /etc/kit/kit.env. Один ключ на оба бота.
// Сервисы: OpenAI (sk-…) — основной; Google Gemini (AIza…) — запасной, только понимание команд.
// Без внешних пакетов: только fetch из Node.js 22.
const store = require('./db');

const GEMINI_API = process.env.GEMINI_API || 'https://generativelanguage.googleapis.com';
const OPENAI_API = process.env.OPENAI_API || 'https://api.openai.com';
// модели пробуются по очереди: если OpenAI/Google переименует или уберёт модель, бот возьмёт следующую
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
const OPENAI_STT = ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
const OPENAI_LLM = ['gpt-6-luna', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];
const OPENAI_TTS = ['gpt-realtime-2.1-mini', 'gpt-realtime-mini', 'gpt-4o-mini-tts'];
const VOICES = ['marin', 'cedar', 'coral', 'nova', 'shimmer', 'sage', 'ash', 'echo', 'onyx', 'ballad', 'verse', 'alloy', 'fable'];

let status = 'off', lastError = '';
const working = {};   // какая модель сработала последней — чтобы не перебирать каждый раз

const providerOf = key => /^AIza[0-9A-Za-z_-]{20,}$/.test(key) ? 'gemini' : /^sk-[0-9A-Za-z_-]{20,}$/.test(key) ? 'openai' : '';
const unq = v => String(v || '').trim().replace(/^["']|["']$/g, '');
const envKey = () => unq(process.env.OPENAI_API_KEY) || unq(process.env.KIT_OPENAI_KEY) || unq(process.env.GEMINI_API_KEY);
const keyNow = () => store.meta.get('voice_key') || envKey();
const keySource = () => store.meta.get('voice_key') ? 'admin' : envKey() ? 'server' : '';
const enabled = () => !!keyNow() && !!providerOf(keyNow());
const provider = () => providerOf(keyNow());

function info() {
  const key = keyNow();
  if (!key) return { status: 'off', provider: '', lastError: '', hasKey: false, source: '' };
  if (!providerOf(key)) return { status: 'error', provider: '', lastError: 'Ключ в настройках сервера не похож на ключ OpenAI (sk-…) или Google (AIza…)', hasKey: true, source: keySource() };
  return { status: status === 'off' ? 'ok' : status, provider: providerOf(key), lastError, hasKey: true, source: keySource() };
}

const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});

// ---------- настройки ----------
const DEFAULTS = {
  model_llm: '', model_stt: '', model_tts: '',      // пусто = автоматически (рекомендуемая)
  voice: 'marin',
  reply_mode: 'voice',      // never | voice (на голосовые) | always
  reply_lang: 'auto',       // auto (как говорю) | ru | kk
  speed: 1,
  persona: 'Говори тепло и коротко, как помощник магазина. Обращайся на «вы».',
  monthly_limit: 3000,      // запросов к ИИ в месяц, 0 — без лимита
  remind_after: 60,         // минут до напоминания о новой заявке, 0 — выключено
  summary_time: '09:30',    // утренняя сводка магазина
  alarm_voice: true,        // тревоги бота сервера — ещё и голосом
};
function settings() {
  let s = {};
  try { s = JSON.parse(store.meta.get('ai_settings') || '{}'); } catch { s = {}; }
  return { ...DEFAULTS, ...s };
}
function setSettings(patch) {
  const s = settings();
  const out = { ...s };
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  if ('model_llm' in patch) out.model_llm = str(patch.model_llm, 80);
  if ('model_stt' in patch) out.model_stt = str(patch.model_stt, 80);
  if ('model_tts' in patch) out.model_tts = str(patch.model_tts, 80);
  if ('voice' in patch && VOICES.includes(patch.voice)) out.voice = patch.voice;
  if ('reply_mode' in patch && ['never', 'voice', 'always'].includes(patch.reply_mode)) out.reply_mode = patch.reply_mode;
  if ('reply_lang' in patch && ['auto', 'ru', 'kk'].includes(patch.reply_lang)) out.reply_lang = patch.reply_lang;
  if ('speed' in patch) out.speed = Math.min(1.5, Math.max(0.7, Math.round(Number(patch.speed) * 10) / 10 || 1));
  if ('persona' in patch) out.persona = str(patch.persona, 600);
  if ('monthly_limit' in patch) out.monthly_limit = Math.max(0, Math.min(1e6, Math.round(Number(patch.monthly_limit) || 0)));
  if ('remind_after' in patch) out.remind_after = [0, 15, 30, 60, 120, 240].includes(Number(patch.remind_after)) ? Number(patch.remind_after) : s.remind_after;
  if ('summary_time' in patch && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.summary_time))) out.summary_time = patch.summary_time;
  if ('alarm_voice' in patch) out.alarm_voice = !!patch.alarm_voice;
  for (const m of ['model_llm', 'model_stt', 'model_tts']) if (out[m] !== s[m]) delete working[{ model_llm: 'openai_llm', model_stt: 'openai_stt', model_tts: 'openai_tts' }[m]];
  store.meta.set('ai_settings', JSON.stringify(out));
  return out;
}
// порядок моделей: сначала выбранная в админке, потом рекомендуемые
const chain = (chosen, list) => chosen ? [chosen, ...list.filter(x => x !== chosen)] : list;

// ---------- журнал и расход ----------
store.db.exec(`CREATE TABLE IF NOT EXISTS ai_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  bot TEXT NOT NULL DEFAULT '', user TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
  heard TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT ''
)`);
const journal = {
  add: (o) => Number(store.db.prepare('INSERT INTO ai_journal (bot, user, kind, heard, action) VALUES (?, ?, ?, ?, ?)')
    .run(o.bot || '', o.user || '', o.kind || '', String(o.heard || '').slice(0, 500), o.action || '').lastInsertRowid),
  result: (id, text) => id && store.db.prepare('UPDATE ai_journal SET result = ? WHERE id = ?').run(String(text || '').replace(/<[^>]+>/g, '').slice(0, 300), id),
  list: (limit = 100) => store.db.prepare('SELECT * FROM ai_journal ORDER BY id DESC LIMIT ?').all(limit),
  trim: () => store.db.prepare('DELETE FROM ai_journal WHERE id <= (SELECT MAX(id) FROM ai_journal) - 2000').run(),
};

const month = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 7);   // по Астане
function usage(m = month()) {
  try { return { requests: 0, voice_in_sec: 0, voice_out_sec: 0, tokens_in: 0, tokens_out: 0, ...JSON.parse(store.meta.get('ai_usage_' + m) || '{}') }; }
  catch { return { requests: 0, voice_in_sec: 0, voice_out_sec: 0, tokens_in: 0, tokens_out: 0 }; }
}
function addUsage(d) {
  const m = month(), u = usage(m);
  for (const k of Object.keys(d)) u[k] = Math.round(((u[k] || 0) + (Number(d[k]) || 0)) * 10) / 10;
  store.meta.set('ai_usage_' + m, JSON.stringify(u));
}
function checkLimit() {
  const lim = settings().monthly_limit;
  if (lim && usage().requests >= lim) throw fail(`Достигнут месячный лимит запросов к ИИ (${lim}). Владелец может поднять его в админке → «🤖 Telegram-бот» → «Голос и ИИ».`, { limit: true });
}

// ---------- HTTP ----------
async function http(url, opt, what) {
  let r;
  try { r = await fetch(url, { ...opt, signal: AbortSignal.timeout(90000) }); }
  catch (e) { throw fail(`Нет связи с ${what}: ${e.message}`); }
  const ct = r.headers.get('content-type') || '';
  if (r.ok && !/json/.test(ct) && opt.binary) return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) {
    const m = (j && j.error && (j.error.message || j.error.status)) || ('HTTP ' + r.status);
    throw fail(humanError(m, r.status, what), { http: r.status, raw: m });
  }
  return j;
}

function humanError(m, code, what) {
  if (/location is not supported|not available in your country|unsupported_country/i.test(m))
    return `${what} не работает из страны, где стоит сервер. Попробуйте ключ другого сервиса.`;
  if (code === 401 || code === 403 || /api key not valid|invalid api key|incorrect api key|permission/i.test(m))
    return `${what} не принял ключ — проверьте, что скопировали его целиком.`;
  if (code === 429 || /quota|rate limit|insufficient_quota|exhausted/i.test(m))
    return `${what}: закончился лимит или нужно пополнить баланс. Подробности — в кабинете ${what}.`;
  return `${what}: ${m}`;
}

// модель не найдена / недоступна / не умеет нужное — пробуем следующую
const modelMissing = e => e.http === 404 || (e.http === 400 && /model|not found|does not exist|unsupported|not supported|response_format|json_schema|image/i.test(e.raw || ''));

async function tryModels(kind, list, fn) {
  const order = working[kind] ? [working[kind], ...list.filter(x => x !== working[kind])] : list;
  let last;
  for (const model of order) {
    try { const r = await fn(model); working[kind] = model; return r; }
    catch (e) { last = e; if (!modelMissing(e) && !e.nextModel) throw e; }
  }
  throw last;
}

function track(e) {
  lastError = e.message;
  if (e.http === 401 || e.http === 403) status = 'error';   // ключ отозван — показываем в админке
}
function ok() { if (status !== 'ok') { status = 'ok'; lastError = ''; } }

// ---------- ключ ----------
async function configure(newKey) {
  newKey = String(newKey || '').trim();
  if (!newKey) { store.meta.set('voice_key', ''); status = 'off'; lastError = ''; modelsCache = null; return info(); }
  const p = providerOf(newKey);
  if (!p) throw fail('Это не похоже на ключ. Ключ OpenAI начинается с sk-…, ключ Google — с AIza…', { code: 400 });
  try {
    if (p === 'gemini') await http(`${GEMINI_API}/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': newKey } }, 'Google Gemini');
    else await http(`${OPENAI_API}/v1/models`, { headers: { Authorization: 'Bearer ' + newKey } }, 'OpenAI');
  } catch (e) { throw fail(e.message, { code: 400 }); }
  store.meta.set('voice_key', newKey);
  for (const k of Object.keys(working)) delete working[k];
  modelsCache = null;
  status = 'ok'; lastError = '';
  return info();
}

// ---------- список моделей (для выбора в админке) ----------
let modelsCache = null;
async function listModels() {
  const rec = { llm: OPENAI_LLM, stt: OPENAI_STT, tts: OPENAI_TTS };
  if (!enabled() || provider() !== 'openai') return { ...rec, recommended: rec, live: false };
  if (modelsCache && Date.now() - modelsCache.at < 3600 * 1000) return modelsCache.data;
  let ids = [];
  try {
    const j = await http(`${OPENAI_API}/v1/models`, { headers: { Authorization: 'Bearer ' + keyNow() } }, 'OpenAI');
    ids = (j && j.data || []).map(m => m.id).filter(Boolean).sort();
  } catch (e) { return { ...rec, recommended: rec, live: false, error: e.message }; }
  const has = new Set(ids);
  const llm = ids.filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/audio|realtime|tts|transcribe|whisper|image|search|embedding|moderation|dall|sora|codex|instruct|live/.test(id));
  const stt = ids.filter(id => /transcribe|whisper/.test(id) && !/diarize|live|realtime-whisper/.test(id));
  const tts = ids.filter(id => /tts|realtime/.test(id) && !/transcribe|whisper|preview-\d{4}/.test(id));
  const pick = (list, all) => [...list.filter(x => has.has(x)), ...all.filter(x => !list.includes(x))];
  const data = { llm: pick(OPENAI_LLM, llm), stt: pick(OPENAI_STT, stt), tts: pick(OPENAI_TTS, tts), recommended: rec, live: true };
  modelsCache = { at: Date.now(), data };
  return data;
}

// ---------- что ИИ должен вернуть (команды) ----------
const SHOP_ACTIONS = [
  'menu', 'list_products', 'show_product',
  'set_price', 'clear_price', 'set_sizes', 'set_name_ru', 'set_name_kk', 'set_photo',
  'hide', 'show', 'delete', 'add_product',
  'list_orders', 'order_status', 'site',
  'client_message', 'bulk', 'stats', 'summary', 'summary_on', 'summary_off', 'instagram',
  'answer', 'skip', 'yes', 'no', 'unknown',
];
const ACTIONS = SHOP_ACTIONS;
const FIELDS = {
  transcript: ['string', 'Что сказал человек — дословно, на его языке. Числа цифрами.'],
  lang: ['string', '"kk" если говорили в основном по-казахски, иначе "ru".', ['ru', 'kk']],
  action: ['string', 'Команда для бота.', SHOP_ACTIONS],
  product_id: ['integer', 'id товара из списка, о котором речь. 0 — если товар не назван или его нет в списке.'],
  product_query: ['string', 'Как человек назвал товар (если назвал), иначе пусто.'],
  product_ids: ['array', 'Только для bulk: id всех товаров, которых касается массовое изменение. Иначе пустой список.'],
  bulk_op: ['string', 'Только для bulk: hide, show, price_percent (изменить цену на value процентов: скидка 10% → -10, подорожание → 10), price_set (поставить всем цену value), sizes_set (всем рост value).', ['', 'hide', 'show', 'price_percent', 'price_set', 'sizes_set']],
  value: ['string', 'Значение: цена только цифрами без пробелов (14500); проценты (-10); рост («110–140 см»); новое название; для client_message — что передать клиенту; ответ на вопрос бота. Иначе пусто.'],
  sizes: ['string', 'Только для add_product: рост нового товара, например «110–140 см». Иначе пусто.'],
  name_ru: ['string', 'Только для add_product: название нового товара по-русски, с большой буквы. Иначе пусто.'],
  name_kk: ['string', 'Только для add_product: то же название по-казахски (грамотный перевод). Иначе пусто.'],
  order_id: ['integer', 'Номер заявки для order_status и client_message, иначе 0.'],
  order_status: ['string', 'Для order_status: work (в работе), done (выполнена), cancel (отменить). Иначе пусто.', ['', 'work', 'done', 'cancel']],
  phone: ['string', 'Для client_message: номер телефона клиента, если его назвали (только цифры), иначе пусто.'],
  message_lang: ['string', 'Для client_message и instagram: на каком языке писать, если человек сказал явно (ru или kk), иначе пусто.', ['', 'ru', 'kk']],
  reply: ['string', 'Для unknown: короткий уточняющий вопрос на языке человека. Иначе пусто.'],
};

function schemaGemini(fields) {
  const properties = {};
  for (const [k, [t, d, en]] of Object.entries(fields)) {
    if (t === 'array') { properties[k] = { type: 'ARRAY', description: d, items: { type: 'INTEGER' } }; continue; }
    // Gemini не любит пустую строку в enum — такие поля без enum, проверим сами
    properties[k] = { type: t.toUpperCase(), description: d, ...(en && !en.includes('') ? { enum: en } : {}) };
  }
  return { type: 'OBJECT', properties, required: Object.keys(fields), propertyOrdering: Object.keys(fields) };
}
function schemaOpenAI(fields) {
  const properties = {};
  for (const [k, [t, d, en]] of Object.entries(fields)) {
    if (t === 'array') { properties[k] = { type: 'array', description: d, items: { type: 'integer' } }; continue; }
    properties[k] = { type: t, description: d, ...(en ? { enum: en } : {}) };
  }
  return { type: 'object', properties, required: Object.keys(fields), additionalProperties: false };
}

function instructions(ctx) {
  return `Ты — помощник служебного Telegram-бота детского магазина одежды «Кит» (Астана).
Сотрудник даёт команду голосом или текстом: по-русски, по-казахски или вперемешку. Распознай речь точно и преврати её в ОДНУ команду для бота. Ответ — строго JSON по схеме.

Команды (action):
- menu — привет, помощь, «что ты умеешь», главное меню.
- list_products — показать все товары.
- show_product — показать один товар.
- set_price — поставить цену (value — только цифры). Если цену не назвали — value пусто.
- clear_price — убрать цену (на сайте будет «Цену уточняйте в WhatsApp»).
- set_sizes — изменить рост (value, например «110–140 см»; «на 120» → «120 см»).
- set_name_ru — новое русское название (value). set_name_kk — новое казахское название (value).
- set_photo — сменить фото товара.
- hide — скрыть товар с сайта (нет в наличии, закончился, бітті). show — снова показать на сайте.
- delete — удалить товар совсем.
- add_product — добавить новый товар: name_ru, name_kk (переведи сам), value — цена цифрами или пусто, sizes — рост или пусто.${ctx.hasPhoto ? ' Сотрудник прислал ФОТО товара: если он описывает товар — это add_product. Если название не сказали, придумай короткое по фото (например «Куртка зимняя»).' : ''}
- list_orders — показать заявки/заказы (өтінімдер, тапсырыстар).
- order_status — заявку №N в работу / выполнена / отменить.
- client_message — написать/ответить клиенту (по заявке order_id или по номеру phone); value — что передать своими словами.
- bulk — изменить сразу несколько товаров: «скидка 10% на все куртки», «скрой всё зимнее», «всем брюкам цену 9900». Выбери product_ids по смыслу из списка ниже, bulk_op и value.
- stats — вопрос про цифры: сколько заявок за день/неделю/месяц, что чаще заказывают, сколько товаров без цены и т.п.
- summary — сводка: что сейчас важно, что нужно доделать. summary_on / summary_off — включить / выключить утреннюю сводку.
- instagram — написать пост/подпись для Instagram про товар (product_id).
- site — ссылка на сайт или админку.
- answer — человек просто отвечает на вопрос, который бот сейчас задал (см. «Бот ждёт»). value — ответ (цену цифрами).
- skip — «пропустить», «өткізу», «керек емес» в ответ на вопрос бота.
- yes — «да», «иә», «ия», «подтверждаю», «дұрыс», «давай». no — «нет», «жоқ», «отмена», «стоп», «керек емес» (если вопроса нет).
- unknown — не понятно; в reply задай короткий уточняющий вопрос.

Правила:
- Товар ищи по смыслу среди списка ниже: по русскому и казахскому названию, учитывай ошибки распознавания, падежи, сокращения («карго» = «Брюки карго»). Если подходит несколько — product_id 0 и action unknown с вопросом, какой именно.
- Числа словами переводи в цифры: «четырнадцать тысяч пятьсот», «он төрт мың бес жүз», «14 с половиной» → 14500.
- Не выдумывай: если чего-то нет в речи — оставь поле пустым (строка), 0 (число) или пустой список.

Товары (id, название, казахское название, цена, рост, на сайте):
${ctx.products.map(p => `${p.id} | ${p.name_ru} | ${p.name_kk || '—'} | ${p.price ? p.price + ' ₸' : 'нет цены'} | ${p.sizes || '—'} | ${p.show ? 'показан' : 'скрыт'}`).join('\n') || '(товаров нет)'}

Открытые заявки (№, клиент, товар, статус):
${ctx.orders.map(o => `${o.id} | ${o.name} | ${o.product || '—'} | ${o.status}`).join('\n') || '(нет)'}

Бот ждёт: ${ctx.awaiting || 'ничего — это новая команда'}.
${ctx.confirming ? 'Бот спросил подтверждение: ' + ctx.confirming + ' — «да/иә» это yes, «нет/жоқ» это no.' : ''}`;
}

// ---------- разбор ----------
function clean(r, fallbackText, fields = FIELDS) {
  const o = {};
  for (const [k, [t, , en]] of Object.entries(fields)) {
    const v = r && r[k];
    if (t === 'array') { o[k] = Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 100) : []; continue; }
    o[k] = t === 'integer' ? (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0) : String(v ?? '').trim();
    if (en && !en.includes(o[k])) o[k] = k === 'action' ? 'unknown' : en.includes('') ? '' : en[0];
  }
  o.lang = o.lang === 'kk' ? 'kk' : 'ru';
  if (!o.transcript && fallbackText) o.transcript = fallbackText;
  return o;
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { throw fail('ИИ ответил непонятно, попробуйте сказать ещё раз.'); }
}

const dataUrl = (buf, mime) => `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;

async function viaGemini(key, { audio, mime, text, image }, spec) {
  const parts = [];
  if (audio) parts.push({ inlineData: { mimeType: mime || 'audio/ogg', data: audio.toString('base64') } });
  if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image.toString('base64') } });
  parts.push({ text: audio ? 'Голосовое сообщение сотрудника — выше. Распознай и верни команду.' : 'Сообщение сотрудника: ' + (text || '(без текста)') });
  const body = {
    systemInstruction: { parts: [{ text: spec.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schemaGemini(spec.fields), temperature: 0 },
  };
  const j = await tryModels('gemini', GEMINI_MODELS, model => http(`${GEMINI_API}/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  }, 'Google Gemini'));
  const c = j && j.candidates && j.candidates[0];
  const out = c && c.content && (c.content.parts || []).map(p => p.text || '').join('');
  if (!out) throw fail(c && c.finishReason === 'SAFETY' ? 'Google не стал обрабатывать это сообщение.' : 'Не расслышал — попробуйте сказать ещё раз.');
  return clean(parseJson(out), text, spec.fields);
}

async function transcribe(key, audio, mime, hint, seconds) {
  const s = settings();
  const j = await tryModels('openai_stt', chain(s.model_stt, OPENAI_STT), model => {
    const f = new FormData();
    f.append('model', model);
    f.append('prompt', String(hint || '').slice(0, 800));
    f.append('file', new Blob([audio], { type: mime || 'audio/ogg' }), 'voice.ogg');
    return http(`${OPENAI_API}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: f }, 'OpenAI');
  });
  addUsage({ voice_in_sec: seconds || 0 });
  const heard = String((j && j.text) || '').trim();
  if (!heard) throw fail('Не расслышал — попробуйте сказать ещё раз.');
  return heard;
}

async function chat(key, messages, schema, image) {
  const s = settings();
  const send = (withImage) => tryModels('openai_llm', chain(s.model_llm, OPENAI_LLM), model => {
    const msgs = messages.map(m => ({ ...m }));
    if (withImage && image) {
      const last = msgs[msgs.length - 1];
      last.content = [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: dataUrl(image), detail: 'low' } }];
    }
    return http(`${OPENAI_API}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: msgs, ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'command', strict: true, schema } } } : {}) }),
    }, 'OpenAI');
  });
  let j;
  try { j = await send(true); }
  catch (e) { if (image && e.http === 400) j = await send(false); else throw e; }   // модель не видит фото — без фото
  const u = j && j.usage || {};
  addUsage({ tokens_in: u.prompt_tokens || u.input_tokens || 0, tokens_out: u.completion_tokens || u.output_tokens || 0 });
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw fail('ИИ не ответил, попробуйте ещё раз.');
  return out;
}

async function viaOpenAI(key, { audio, mime, text, image, seconds }, spec) {
  const heard = audio ? await transcribe(key, audio, mime, spec.hint, seconds) : text;
  const out = await chat(key, [{ role: 'system', content: spec.system }, { role: 'user', content: 'Сообщение сотрудника: ' + (heard || '(только фото, без текста)') }], schemaOpenAI(spec.fields), image);
  const r = clean(parseJson(out), heard, spec.fields);
  if (audio) r.transcript = heard;   // показываем ровно то, что расслышала модель речи
  return r;
}

async function run(input, spec) {
  const key = keyNow();
  if (!key) throw fail('Голосовое управление не включено');
  const p = providerOf(key);
  if (!p) throw fail('Ключ ИИ в настройках сервера не похож на ключ OpenAI (sk-…)');
  checkLimit();
  addUsage({ requests: 1 });
  try {
    const r = p === 'gemini' ? await viaGemini(key, input, spec) : await viaOpenAI(key, input, spec);
    ok();
    return r;
  } catch (e) { track(e); throw e; }
}

// бот магазина. input: { audio, mime, seconds } | { text } (+ image); ctx: { products, orders, awaiting, confirming }
function understand(input, ctx) {
  return run(input, {
    system: instructions({ ...ctx, hasPhoto: !!input.image }), fields: FIELDS,
    hint: 'Речь на русском и казахском, часто вперемешку. Магазин детской одежды «Кит», Астана. Команды: цена, тенге, рост, скрыть, показать, заявка, скидка, сводка, пост. Товары: ' +
      ctx.products.map(p => p.name_ru + (p.name_kk ? ' / ' + p.name_kk : '')).join(', '),
  });
}

// ---------- бот сервера ----------
const SERVER_ACTIONS = ['menu', 'status', 'backup', 'backups', 'send_backup', 'alerts_menu', 'alerts_on', 'alerts_off', 'daily_on', 'daily_off', 'night_report', 'unknown'];
const SERVER_FIELDS = {
  transcript: FIELDS.transcript,
  lang: FIELDS.lang,
  action: ['string', 'Команда для бота сервера.', SERVER_ACTIONS],
  hours: ['integer', 'Для night_report: за сколько последних часов рассказать (ночь — 12, сутки — 24, неделя — 168). Иначе 0.'],
  reply: FIELDS.reply,
};
function serverInstructions(ctx) {
  return `Ты — помощник служебного Telegram-бота СЕРВЕРА магазина «Кит» (сайт kit.r-agent.kz и админка). Им пользуются владелец и администраторы.
Человек говорит голосом или пишет по-русски, по-казахски или вперемешку. Распознай точно и верни ОДНУ команду строго JSON по схеме.

Команды (action):
- menu — привет, помощь, «что ты умеешь».
- status — как дела у сервера/сайта сейчас, работает ли сайт, память, диск, процессор, сертификат, «сервер қалай», «сайт істеп тұр ма».
- night_report — что было ночью / за сутки / пока меня не было, были ли сбои, перезапуски, кто что менял («түнде не болды»). hours — за сколько часов.
- backup — сделать бэкап / резервную копию сейчас («бэкап жаса», «көшірме жаса»).
- backups — показать список бэкапов, когда был последний бэкап.
- send_backup — прислать файл бэкапа сюда, скачать базу.
- alerts_menu — настройки уведомлений вообще.
- alerts_on / alerts_off — включить / выключить тревоги (уведомления о проблемах).
- daily_on / daily_off — включить / выключить ежедневный утренний отчёт в 10:00.
- unknown — непонятно или просьба, которую бот не умеет (перезагрузить сервер, поменять сайт и т.п.); в reply коротко скажи на языке человека, что умеет бот: статус, что было ночью, бэкап, уведомления.
${ctx && ctx.flags ? `Сейчас у этого человека: тревоги ${ctx.flags.alerts ? 'включены' : 'выключены'}, отчёт в 10:00 ${ctx.flags.daily ? 'включён' : 'выключен'}.` : ''}`;
}
function understandServer(input, ctx) {
  return run(input, {
    system: serverInstructions(ctx), fields: SERVER_FIELDS,
    hint: 'Речь на русском и казахском, часто вперемешку. Сервер сайта магазина «Кит». Слова: статус, сервер, сайт, бэкап, резервная копия, уведомления, тревоги, отчёт, ночью, диск, память, сертификат.',
  });
}

// ---------- генерация текста (ответ клиенту, статистика, сводки, посты) ----------
// task — что сделать; data — факты; lang — ru|kk. Возвращает готовый текст (без HTML).
async function generate(task, data, lang) {
  const key = keyNow();
  if (!key) throw fail('ИИ не подключён');
  checkLimit();
  addUsage({ requests: 1 });
  const s = settings();
  const system = `Ты — помощник магазина детской и подростковой одежды «Кит» (Астана). ${s.persona}
Пиши на ${lang === 'kk' ? 'казахском' : 'русском'} языке, грамотно, без markdown (без **, #, таблиц). Опирайся только на факты ниже, ничего не выдумывай — цен, размеров, наличия, дат.`;
  const user = `${task}\n\nФакты:\n${typeof data === 'string' ? data : JSON.stringify(data, null, 1)}`;
  try {
    let out;
    if (providerOf(key) === 'gemini') {
      const j = await tryModels('gemini', GEMINI_MODELS, model => http(`${GEMINI_API}/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }),
      }, 'Google Gemini'));
      const c = j && j.candidates && j.candidates[0];
      out = c && c.content && (c.content.parts || []).map(p => p.text || '').join('');
    } else {
      out = await chat(key, [{ role: 'system', content: system }, { role: 'user', content: user }]);
    }
    ok();
    return String(out || '').replace(/\*\*/g, '').trim();
  } catch (e) { track(e); throw e; }
}

module.exports = {
  configure, info, enabled, provider, keyNow, understand, understandServer, generate,
  settings, setSettings, listModels, journal, usage, addUsage, checkLimit, chain,
  ACTIONS, SERVER_ACTIONS, VOICES, OPENAI_TTS, OPENAI_API,
  _test: { providerOf, clean, instructions, serverInstructions, schemaGemini, schemaOpenAI, FIELDS, SERVER_FIELDS, working },
  _http: http, _tryModels: tryModels, _fail: fail, _track: track, _ok: ok,
};
