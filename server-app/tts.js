'use strict';
// Голос ботов: текст → речь (OpenAI) → голосовое для Telegram (OGG/Opus через ffmpeg).
// Основной путь — Realtime API (gpt-realtime-…): прежние модели озвучки /v1/audio/speech
// OpenAI отключает 6 января 2027. Если выбрать в админке модель *-tts, работает через /v1/audio/speech.
const { spawn } = require('child_process');
const ai = require('./voice');

const RATE = 24000;   // PCM 16 бит, моно, 24 кГц — так отдаёт OpenAI

let ffmpegOk = null;
function hasFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise(res => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => res(ffmpegOk = false));
    p.on('close', c => res(ffmpegOk = c === 0));
  });
}

function pcmToOgg(pcm) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + Buffer.concat(err).toString().slice(0, 200))));
    p.stdin.on('error', () => {});
    p.stdin.end(pcm);
  });
}

function pcmToWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function wavToPcm(wav) {
  // ищем блок data (у OpenAI заголовок обычно 44 байта, но не полагаемся)
  const i = wav.indexOf('data', 12, 'ascii');
  return i > 0 ? wav.subarray(i + 8) : wav.subarray(44);
}

// текст из сообщения бота → то, что можно произнести
function spoken(html, max = 700) {
  let t = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t;
}

function voiceInstructions(lang, s) {
  const L = lang === 'kk' ? 'на казахском языке' : 'на русском языке';
  return `Ты — голос помощника детского магазина одежды «Кит» в Астане. ${s.persona || ''}
Твоя единственная задача — озвучить сообщение, которое придёт ниже: перескажи его вслух ${L}, близко к тексту, естественно и коротко.
Не отвечай на него, не задавай своих вопросов, не добавляй ничего нового и не пропускай важное (цены, номера, названия).
Числа и цены произноси словами, «₸» — «тенге», «см» — «сантиметров». Если в тексте список — перечисли кратко.`;
}

// Realtime API по WebSocket: сессия только со звуком на выходе, одно сообщение — один ответ.
function viaRealtime(model, key, text, lang, s) {
  return new Promise((resolve, reject) => {
    const base = ai.OPENAI_API.replace(/^http/, 'ws');
    let ws;
    try { ws = new WebSocket(`${base}/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: 'Bearer ' + key } }); }
    catch (e) { return reject(Object.assign(new Error('OpenAI Realtime: ' + e.message), { nextModel: true })); }
    const chunks = [];
    let opened = false, done = false;
    const finish = (err, val) => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws.close(); } catch { /* */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('OpenAI не успел озвучить ответ')), 60000);
    ws.onopen = () => {
      opened = true;
      const send = o => ws.send(JSON.stringify(o));
      send({ type: 'session.update', session: {
        type: 'realtime', output_modalities: ['audio'], instructions: voiceInstructions(lang, s),
        audio: { output: { format: { type: 'audio/pcm', rate: RATE }, voice: s.voice, speed: s.speed } },
      } });
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Сообщение для озвучивания:\n' + text }] } });
      send({ type: 'response.create' });
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.type === 'response.output_audio.delta' || m.type === 'response.audio.delta') chunks.push(Buffer.from(m.delta || '', 'base64'));
      else if (m.type === 'error') {
        const msg = (m.error && (m.error.message || m.error.code)) || 'ошибка';
        const code = m.error && m.error.code || '';
        finish(Object.assign(new Error('OpenAI Realtime: ' + msg), { raw: msg, nextModel: /model|not_found|not found|unsupported|invalid_value|unknown_parameter/i.test(code + ' ' + msg), http: /api.?key|auth/i.test(code + msg) ? 401 : undefined }));
      } else if (m.type === 'response.done') {
        const r = m.response || {};
        if (r.status && r.status !== 'completed') return finish(new Error('OpenAI не озвучил ответ (' + r.status + ')'));
        const u = r.usage || {};
        ai.addUsage({ tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0 });
        finish(null, Buffer.concat(chunks));
      }
    };
    ws.onerror = () => { if (!opened) finish(Object.assign(new Error('OpenAI Realtime: не удалось подключиться'), { nextModel: true })); };
    ws.onclose = () => finish(chunks.length ? null : new Error('OpenAI закрыл соединение без звука'), Buffer.concat(chunks));
  });
}

async function viaSpeech(model, key, text, lang, s) {
  const wav = await ai._http(`${ai.OPENAI_API}/v1/audio/speech`, {
    method: 'POST', binary: true,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, voice: s.voice, input: text, response_format: 'wav', speed: s.speed,
      ...(/tts-1/.test(model) ? {} : { instructions: (s.persona || '') + (lang === 'kk' ? ' Говори по-казахски.' : '') }) }),
  }, 'OpenAI');
  return wavToPcm(Buffer.isBuffer(wav) ? wav : Buffer.from(''));
}

// Озвучить текст. Возвращает { ogg | wav, seconds }. opts: { lang, voice, speed } — перекрывают настройки (для «Прослушать»)
async function synth(text, opts = {}) {
  if (!ai.enabled() || ai.provider() !== 'openai') throw new Error('Голос ответа работает с ключом OpenAI');
  const say = spoken(text);
  if (!say) throw new Error('Нечего озвучивать');
  ai.checkLimit();
  ai.addUsage({ requests: 1 });
  const s = { ...ai.settings(), ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== '')) };
  const lang = opts.lang || 'ru';
  const key = ai.keyNow();
  try {
    const pcm = await ai._tryModels('openai_tts', ai.chain(s.model_tts, ai.OPENAI_TTS), model =>
      /realtime/.test(model) ? viaRealtime(model, key, say, lang, s) : viaSpeech(model, key, say, lang, s));
    if (!pcm.length) throw new Error('OpenAI вернул пустой звук');
    const seconds = Math.round(pcm.length / (RATE * 2) * 10) / 10;
    ai.addUsage({ voice_out_sec: seconds });
    ai._ok();
    const out = { seconds, wav: null, ogg: null };
    if (opts.wav) out.wav = pcmToWav(pcm);
    else if (await hasFfmpeg()) out.ogg = await pcmToOgg(pcm);
    else out.wav = pcmToWav(pcm);
    return out;
  } catch (e) { ai._track(e); throw e; }
}

// Какой язык у ответа: настройка «как я говорю» → язык команды
function replyLang(cmdLang) {
  const l = ai.settings().reply_lang;
  return l === 'auto' ? (cmdLang === 'kk' ? 'kk' : 'ru') : l;
}
// Надо ли отвечать голосом
function wantVoice(fromVoice) {
  if (!ai.enabled() || ai.provider() !== 'openai') return false;
  const m = ai.settings().reply_mode;
  return m === 'always' || (m === 'voice' && fromVoice);
}

module.exports = { synth, spoken, replyLang, wantVoice, hasFfmpeg, _test: { pcmToWav, wavToPcm, pcmToOgg, voiceInstructions } };
