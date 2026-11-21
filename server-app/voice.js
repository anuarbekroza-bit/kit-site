'use strict';
// Голосовое управление ботом «Кит»: русский, казахский и смесь (шала-қазақ).
// Голосовое (или свободный текст) → ИИ → одна команда в JSON: что сделать и с каким товаром.
// Сервис выбирается по ключу, который владелец вставляет в админке:
//   • OpenAI / ChatGPT (ключ sk-…) — основной: расшифровка речи (gpt-transcribe), потом разбор команды;
//   • Google Gemini (ключ AIza…) — запасной: слушает голос сам, одним запросом.
// Ключ берётся из админки, а если там пусто — из настроек сервера (переменная OPENAI_API_KEY
// в /etc/kit/kit.env или в службе kit-app). Один ключ — для обоих ботов: магазина и сервера.
// Без внешних пакетов: только fetch из Node.js 22.
const store = require('./db');

const GEMINI_API = process.env.GEMINI_API || 'https://generativelanguage.googleapis.com';
const OPENAI_API = process.env.OPENAI_API || 'https://api.openai.com';
// модели пробуются по очереди: если Google/OpenAI переименует или уберёт модель, бот возьмёт следующую
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
const OPENAI_STT = ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
const OPENAI_LLM = ['gpt-6-luna', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];

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
const unq = v => String(v || '').trim().replace(/^["']|["']$/g, '');
const envKey = () => unq(process.env.OPENAI_API_KEY) || unq(process.env.KIT_OPENAI_KEY) || unq(process.env.GEMINI_API_KEY);
const keyNow = () => store.meta.get('voice_key') || envKey();
const keySource = () => store.meta.get('voice_key') ? 'admin' : envKey() ? 'server' : '';
const enabled = () => !!keyNow() && !!providerOf(keyNow());

function info() {
  const key = keyNow();
  if (!key) return { status: 'off', provider: '', lastError: '', hasKey: false, source: '' };
  if (!providerOf(key)) return { status: 'error', provider: '', lastError: 'Ключ в настройках сервера не похож на ключ OpenAI (sk-…) или Google (AIza…)', hasKey: true, source: keySource() };
  return { status: status === 'off' ? 'ok' : status, provider: providerOf(key), lastError, hasKey: true, source: keySource() };
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
// (или модель не умеет строгий JSON-ответ — тоже берём следующую)
const modelMissing = e => e.http === 404 || (e.http === 400 && /model|not found|does not exist|unsupported|not supported|response_format|json_schema/i.test(e.raw || ''));

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

function schemaGemini(fields) {
  const properties = {};
  for (const [k, [t, d, en]] of Object.entries(fields)) {
    // Gemini не любит пустую строку в enum — такие поля без enum, проверим сами
    properties[k] = { type: t.toUpperCase(), description: d, ...(en && !en.includes('') ? { enum: en } : {}) };
  }
  return { type: 'OBJECT', properties, required: Object.keys(fields), propertyOrdering: Object.keys(fields) };
}
function schemaOpenAI(fields) {
  const properties = {};
  for (const [k, [t, d, en]] of Object.entries(fields)) properties[k] = { type: t, description: d, ...(en ? { enum: en } : {}) };
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
function clean(r, fallbackText, fields = FIELDS) {
  const o = {};
  for (const [k, [t, , en]] of Object.entries(fields)) {
    const v = r && r[k];
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

async function viaGemini(key, { audio, mime, text }, spec) {
  const parts = [];
  if (audio) parts.push({ inlineData: { mimeType: mime || 'audio/ogg', data: audio.toString('base64') } });
  parts.push({ text: audio ? 'Голосовое сообщение сотрудника — выше. Распознай и верни команду.' : 'Сообщение сотрудника: ' + text });
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

async function viaOpenAI(key, { audio, mime, text }, spec) {
  let heard = text;
  if (audio) {
    const hint = spec.hint;
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
      messages: [{ role: 'system', content: spec.system }, { role: 'user', content: 'Сообщение сотрудника: ' + heard }],
      response_format: { type: 'json_schema', json_schema: { name: 'command', strict: true, schema: schemaOpenAI(spec.fields) } },
    }),
  }, 'OpenAI'));
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const r = clean(parseJson(out), heard, spec.fields);
  if (audio) r.transcript = heard;   // показываем ровно то, что расслышала модель речи
  return r;
}

async function run(input, spec) {
  const key = keyNow();
  if (!key) throw fail('Голосовое управление не включено');
  const provider = providerOf(key);
  if (!provider) throw fail('Ключ ИИ в настройках сервера не похож на ключ OpenAI (sk-…)');
  try {
    const r = provider === 'gemini' ? await viaGemini(key, input, spec) : await viaOpenAI(key, input, spec);
    if (status !== 'ok') { status = 'ok'; lastError = ''; }
    return r;
  } catch (e) {
    lastError = e.message;
    if (e.http === 401 || e.http === 403) status = 'error';   // ключ отозван — показываем в админке
    throw e;
  }
}

// бот магазина. input: { audio: Buffer, mime } или { text }; ctx: { products, orders, awaiting, confirming }
function understand(input, ctx) {
  return run(input, {
    system: instructions(ctx), fields: FIELDS,
    hint: 'Речь на русском и казахском, часто вперемешку. Магазин детской одежды «Кит», Астана. Команды: цена, тенге, рост, скрыть, показать, заявка. Товары: ' +
      ctx.products.map(p => p.name_ru + (p.name_kk ? ' / ' + p.name_kk : '')).join(', '),
  });
}

// ---------- бот сервера ----------
const SERVER_ACTIONS = ['menu', 'status', 'backup', 'backups', 'send_backup', 'alerts_menu', 'alerts_on', 'alerts_off', 'daily_on', 'daily_off', 'unknown'];
const SERVER_FIELDS = {
  transcript: FIELDS.transcript,
  lang: FIELDS.lang,
  action: ['string', 'Команда для бота сервера.', SERVER_ACTIONS],
  reply: FIELDS.reply,
};
function serverInstructions(ctx) {
  return `Ты — помощник служебного Telegram-бота СЕРВЕРА магазина «Кит» (сайт kit.r-agent.kz и админка). Им пользуются владелец и администраторы.
Человек говорит голосом или пишет по-русски, по-казахски или вперемешку. Распознай точно и верни ОДНУ команду строго JSON по схеме.

Команды (action):
- menu — привет, помощь, «что ты умеешь».
- status — как дела у сервера/сайта, работает ли сайт, почему не открывается, память, диск, процессор, сертификат, «сервер қалай», «сайт істеп тұр ма».
- backup — сделать бэкап / резервную копию / сохранить базу сейчас («бэкап жаса», «көшірме жаса»).
- backups — показать список бэкапов, когда был последний бэкап.
- send_backup — прислать файл бэкапа сюда, скачать базу.
- alerts_menu — настройки уведомлений вообще.
- alerts_on / alerts_off — включить / выключить тревоги (уведомления о проблемах).
- daily_on / daily_off — включить / выключить ежедневный утренний отчёт в 10:00.
- unknown — непонятно или просьба, которую бот не умеет (перезагрузить сервер, поменять сайт и т.п.); в reply коротко скажи на языке человека, что умеет бот: статус, бэкап, список бэкапов, уведомления.
${ctx && ctx.flags ? `Сейчас у этого человека: тревоги ${ctx.flags.alerts ? 'включены' : 'выключены'}, отчёт в 10:00 ${ctx.flags.daily ? 'включён' : 'выключен'}.` : ''}`;
}
function understandServer(input, ctx) {
  return run(input, {
    system: serverInstructions(ctx), fields: SERVER_FIELDS,
    hint: 'Речь на русском и казахском, часто вперемешку. Сервер сайта магазина «Кит». Слова: статус, сервер, сайт, бэкап, резервная копия, уведомления, тревоги, отчёт, диск, память, сертификат.',
  });
}

module.exports = { configure, info, enabled, understand, understandServer, ACTIONS, SERVER_ACTIONS,
  _test: { providerOf, clean, instructions, serverInstructions, schemaGemini, schemaOpenAI, FIELDS, SERVER_FIELDS } };
