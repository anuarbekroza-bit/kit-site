'use strict';
// Голосовое управление ботом «Кит»: русский, казахский и смесь (шала-қазақ).
// Голосовое (или свободный текст) → ИИ → одна команда в JSON: что сделать и с каким товаром.
// Поддерживаются два сервиса, выбирается по ключу, который владелец вставляет в админке:
//   • Google Gemini (ключ начинается с AIza…) — слушает голос сам, одним запросом;
//   • OpenAI (ключ sk-…) — сначала расшифровка речи, потом разбор команды.
// Без внешних пакетов: только fetch из Node.js 22.
const store = require('./db');

const GEMINI_API = process.env.GEMINI_API || 'https://generativelanguage.googleapis.com';
const OPENAI_API = process.env.OPENAI_API || 'https://api.openai.com';
// модели пробуются по очереди: если Google/OpenAI переименует или уберёт модель, бот возьмёт следующую
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
const OPENAI_STT = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
const OPENAI_LLM = ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];

const ACTIONS = [
  'menu', 'list_products', 'show_product',
  'set_price', 'clear_price', 'set_sizes', 'set_name_ru', 'set_name_kk', 'set_photo',
  'hide', 'show', 'delete', 'add_product',
  'list_orders', 'order_status', 'site',
  'answer', 'skip', 'yes', 'no', 'unknown',
];

let status = 'off', lastError = '';
const working = {};   // какая модель сработала последней — чтобы не перебирать каждый раз

const providerOf = key => /^AIza[0-9A-Za-z_-]{20,}$/.test(key) ? 'gemini' : /^sk-[0-9A-Za-z_-]{20,}$/.test(key) ? 'openai' : '';
const keyNow = () => store.meta.get('voice_key');
const enabled = () => !!keyNow();

function info() {
  const key = keyNow();
  if (!key) return { status: 'off', provider: '', lastError: '', hasKey: false };
  return { status: status === 'off' ? 'ok' : status, provider: providerOf(key), lastError, hasKey: true };
}

const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});

async function http(url, opt, what) {
  let r;
  try { r = await fetch(url, { ...opt, signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw fail(`Нет связи с ${what}: ${e.message}`); }
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
    return `${what} не работает из страны, где стоит сервер. Попробуйте ключ другого сервиса (OpenAI вместо Google или наоборот).`;
  if (code === 401 || code === 403 || /api key not valid|invalid api key|incorrect api key|permission/i.test(m))
    return `${what} не принял ключ — проверьте, что скопировали его целиком.`;
  if (code === 429 || /quota|rate limit|insufficient_quota|exhausted/i.test(m))
    return `${what}: закончился лимит или нужно пополнить баланс. Подробности — в кабинете ${what}.`;
  return `${what}: ${m}`;
}

// модель не найдена / недоступна — пробуем следующую
const modelMissing = e => e.http === 404 || (e.http === 400 && /model|not found|does not exist|unsupported/i.test(e.raw || ''));

async function tryModels(kind, list, fn) {
  const order = working[kind] ? [working[kind], ...list.filter(x => x !== working[kind])] : list;
  let last;
  for (const model of order) {
    try { const r = await fn(model); working[kind] = model; return r; }
    catch (e) { last = e; if (!modelMissing(e)) throw e; }
  }
  throw last;
}

// ---------- настройка ключа ----------
async function configure(newKey) {
  newKey = String(newKey || '').trim();
  if (!newKey) { store.meta.set('voice_key', ''); status = 'off'; lastError = ''; return info(); }
  const provider = providerOf(newKey);
  if (!provider) throw fail('Это не похоже на ключ. Ключ Google начинается с AIza…, ключ OpenAI — с sk-…', { code: 400 });
  try {
    if (provider === 'gemini') await http(`${GEMINI_API}/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': newKey } }, 'Google Gemini');
    else await http(`${OPENAI_API}/v1/models`, { headers: { Authorization: 'Bearer ' + newKey } }, 'OpenAI');
  } catch (e) { throw fail(e.message, { code: 400 }); }
  store.meta.set('voice_key', newKey);
  for (const k of Object.keys(working)) delete working[k];
  status = 'ok'; lastError = '';
  return info();
}

// ---------- что ИИ должен вернуть ----------
const FIELDS = {
  transcript: ['string', 'Что сказал человек — дословно, на его языке. Числа цифрами.'],
  lang: ['string', '"kk" если говорили в основном по-казахски, иначе "ru".', ['ru', 'kk']],
  action: ['string', 'Команда для бота.', ACTIONS],
  product_id: ['integer', 'id товара из списка, о котором речь. 0 — если товар не назван или его нет в списке.'],
  product_query: ['string', 'Как человек назвал товар (если назвал), иначе пусто.'],
  value: ['string', 'Значение: цена только цифрами без пробелов (14500); рост («110–140 см»); новое название; ответ на вопрос бота. Иначе пусто.'],
  sizes: ['string', 'Только для add_product: рост нового товара, например «110–140 см». Иначе пусто.'],
  name_ru: ['string', 'Только для add_product: название нового товара по-русски, с большой буквы. Иначе пусто.'],
  name_kk: ['string', 'Только для add_product: то же название по-казахски (грамотный перевод). Иначе пусто.'],
  order_id: ['integer', 'Номер заявки для order_status, иначе 0.'],
  order_status: ['string', 'Для order_status: work (в работе), done (выполнена), cancel (отменить). Иначе пусто.', ['', 'work', 'done', 'cancel']],
  reply: ['string', 'Для unknown: короткий уточняющий вопрос на языке человека. Иначе пусто.'],
};

function schemaGemini() {
  const properties = {};
  for (const [k, [t, d, en]] of Object.entries(FIELDS)) properties[k] = { type: t.toUpperCase(), description: d, ...(en ? { enum: en.filter(Boolean) } : {}) };
  // Gemini не любит пустую строку в enum — order_status без enum, проверим сами
  delete properties.order_status.enum;
  return { type: 'OBJECT', properties, required: Object.keys(FIELDS), propertyOrdering: Object.keys(FIELDS) };
}
function schemaOpenAI() {
  const properties = {};
  for (const [k, [t, d, en]] of Object.entries(FIELDS)) properties[k] = { type: t, description: d, ...(en ? { enum: en } : {}) };
  return { type: 'object', properties, required: Object.keys(FIELDS), additionalProperties: false };
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
- add_product — добавить новый товар: name_ru, name_kk (переведи сам), value — цена цифрами или пусто, sizes — рост или пусто.
- list_orders — показать заявки/заказы (өтінімдер, тапсырыстар).
- order_status — заявку №N в работу / выполнена / отменить.
- site — ссылка на сайт или админку.
- answer — человек просто отвечает на вопрос, который бот сейчас задал (см. «Бот ждёт»). value — ответ (цену цифрами).
- skip — «пропустить», «өткізу», «керек емес» в ответ на вопрос бота.
- yes — «да», «иә», «ия», «подтверждаю», «дұрыс», «давай». no — «нет», «жоқ», «отмена», «стоп», «керек емес» (если вопроса нет).
- unknown — не понятно; в reply задай короткий уточняющий вопрос.

Правила:
- Товар ищи по смыслу среди списка ниже: по русскому и казахскому названию, учитывай ошибки распознавания, падежи, сокращения («карго» = «Брюки карго»). Если подходит несколько — product_id 0 и action unknown с вопросом, какой именно.
- Числа словами переводи в цифры: «четырнадцать тысяч пятьсот», «он төрт мың бес жүз», «14 с половиной» → 14500.
- Не выдумывай: если чего-то нет в речи — оставь поле пустым (строка) или 0 (число).

Товары (id, название, казахское название, цена, рост, на сайте):
${ctx.products.map(p => `${p.id} | ${p.name_ru} | ${p.name_kk || '—'} | ${p.price ? p.price + ' ₸' : 'нет цены'} | ${p.sizes || '—'} | ${p.show ? 'показан' : 'скрыт'}`).join('\n') || '(товаров нет)'}

Открытые заявки (№, клиент, товар, статус):
${ctx.orders.map(o => `${o.id} | ${o.name} | ${o.product || '—'} | ${o.status}`).join('\n') || '(нет)'}

Бот ждёт: ${ctx.awaiting || 'ничего — это новая команда'}.
${ctx.confirming ? 'Бот спросил подтверждение: ' + ctx.confirming + ' — «да/иә» это yes, «нет/жоқ» это no.' : ''}`;
}

// ---------- разбор ----------
function clean(r, fallbackText) {
  const o = {};
  for (const [k, [t]] of Object.entries(FIELDS)) {
    const v = r && r[k];
    o[k] = t === 'integer' ? (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0) : String(v ?? '').trim();
  }
  if (!ACTIONS.includes(o.action)) o.action = 'unknown';
  if (!['work', 'done', 'cancel'].includes(o.order_status)) o.order_status = '';
  o.lang = o.lang === 'kk' ? 'kk' : 'ru';
  if (!o.transcript && fallbackText) o.transcript = fallbackText;
  return o;
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { throw fail('ИИ ответил непонятно, попробуйте сказать ещё раз.'); }
}

async function viaGemini(key, { audio, mime, text }, ctx) {
  const parts = [];
  if (audio) parts.push({ inlineData: { mimeType: mime || 'audio/ogg', data: audio.toString('base64') } });
  parts.push({ text: audio ? 'Голосовое сообщение сотрудника — выше. Распознай и верни команду.' : 'Сообщение сотрудника: ' + text });
  const body = {
    systemInstruction: { parts: [{ text: instructions(ctx) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schemaGemini(), temperature: 0 },
  };
  const j = await tryModels('gemini', GEMINI_MODELS, model => http(`${GEMINI_API}/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  }, 'Google Gemini'));
  const c = j && j.candidates && j.candidates[0];
  const out = c && c.content && (c.content.parts || []).map(p => p.text || '').join('');
  if (!out) throw fail(c && c.finishReason === 'SAFETY' ? 'Google не стал обрабатывать это сообщение.' : 'Не расслышал — попробуйте сказать ещё раз.');
  return clean(parseJson(out), text);
}

async function viaOpenAI(key, { audio, mime, text }, ctx) {
  let heard = text;
  if (audio) {
    const hint = 'Русский и казахский. Магазин детской одежды «Кит». Товары: ' + ctx.products.map(p => p.name_ru).join(', ');
    const j = await tryModels('openai_stt', OPENAI_STT, model => {
      const f = new FormData();
      f.append('model', model);
      f.append('prompt', hint.slice(0, 800));
      f.append('file', new Blob([audio], { type: mime || 'audio/ogg' }), 'voice.ogg');
      return http(`${OPENAI_API}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: f }, 'OpenAI');
    });
    heard = String((j && j.text) || '').trim();
    if (!heard) throw fail('Не расслышал — попробуйте сказать ещё раз.');
  }
  const j = await tryModels('openai_llm', OPENAI_LLM, model => http(`${OPENAI_API}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: instructions(ctx) }, { role: 'user', content: 'Сообщение сотрудника: ' + heard }],
      response_format: { type: 'json_schema', json_schema: { name: 'command', strict: true, schema: schemaOpenAI() } },
    }),
  }, 'OpenAI'));
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const r = clean(parseJson(out), heard);
  if (audio) r.transcript = heard;   // показываем ровно то, что расслышала модель речи
  return r;
}

// input: { audio: Buffer, mime } или { text }; ctx: { products, orders, awaiting, confirming }
async function understand(input, ctx) {
  const key = keyNow();
  if (!key) throw fail('Голосовое управление не включено');
  const provider = providerOf(key);
  try {
    const r = provider === 'gemini' ? await viaGemini(key, input, ctx) : await viaOpenAI(key, input, ctx);
    if (status !== 'ok') { status = 'ok'; lastError = ''; }
    return r;
  } catch (e) {
    lastError = e.message;
    if (e.http === 401 || e.http === 403) status = 'error';   // ключ отозван — показываем в админке
    throw e;
  }
}

module.exports = { configure, info, enabled, understand, ACTIONS, _test: { providerOf, clean, instructions, schemaGemini, schemaOpenAI } };
