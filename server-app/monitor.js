'use strict';
// Состояние сервера: сайт, процессор, память, диск, сертификаты, бэкапы.
// Используется ботом сервера и разделом «🖥 Сервер» в админке.
const os = require('os');
const fs = require('fs');
const tls = require('tls');
const { execFile } = require('child_process');
const store = require('./db');

const SITE_URL = process.env.SITE_URL || 'https://kit.r-agent.kz';
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.r-agent.kz';
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };

function memory() {
  const total = os.totalmem();
  let avail = os.freemem();
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) avail = Number(m[1]) * 1024;
  } catch { /* не Linux */ }
  return { total, used: total - avail, pct: Math.round((total - avail) / total * 100) };
}

function disk(p = '/') {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, used: total - free, pct: Math.round((total - free) / total * 100) };
  } catch { return null; }
}

function cpu() {
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  return { load1: load[0], load5: load[1], cores, pct: Math.min(100, Math.round(load[0] / cores * 100)) };
}

async function checkUrl(url) {
  const t = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual', cache: 'no-store' });
    return { ok: r.status >= 200 && r.status < 400, code: r.status, ms: Date.now() - t };
  } catch (e) { return { ok: false, code: 0, ms: Date.now() - t, error: e.cause ? e.cause.code || e.cause.message : e.message }; }
}

// сколько дней осталось сертификату (кэш на 6 часов)
const sslCache = new Map();
function certDays(host) {
  const c = sslCache.get(host);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return Promise.resolve(c.v);
  return new Promise(resolve => {
    const done = v => { sslCache.set(host, { at: Date.now(), v }); resolve(v); };
    const sock = tls.connect({ host, port: 443, ...(require('net').isIP(host) ? {} : { servername: host }), timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.valid_to) return done(null);
      const to = new Date(cert.valid_to);
      done({ days: Math.floor((to - Date.now()) / 86400000), until: to.toISOString() });
    });
    sock.on('error', () => { sock.destroy(); resolve(null); });
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

function serviceActive(name) {
  return new Promise(resolve => {
    execFile('systemctl', ['is-active', name], { timeout: 5000 }, (err, out) => resolve(String(out || '').trim() || (err ? 'unknown' : '')));
  });
}

async function snapshot() {
  const [site, admin, sslSite, sslAdmin, nginx] = await Promise.all([
    checkUrl(SITE_URL + '/health'), checkUrl(ADMIN_URL + '/health'),
    certDays(hostOf(SITE_URL)), certDays(hostOf(ADMIN_URL)), serviceActive('nginx'),
  ]);
  // systemctl может не ответить из-под ограниченной службы — тогда судим по тому, открывается ли сайт
  const nginxState = ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(nginx) ? nginx : (site.ok ? 'active' : 'unknown');
  const backups = store.backupsList();
  let dbSize = 0; try { dbSize = fs.statSync(store.dbFile).size; } catch { /* */ }
  return {
    at: Date.now(),
    site, admin, nginx: nginxState,
    ssl: { site: sslSite, admin: sslAdmin },
    cpu: cpu(), mem: memory(), disk: disk('/'),
    uptime: { server: os.uptime(), app: process.uptime() },
    backups: { count: backups.length, last: backups[0] ? { name: backups[0].name, size: backups[0].size, mtime: backups[0].mtime } : null },
    dbSize,
    orders: { new: store.orders.countNew() },
    hostname: os.hostname(),
  };
}

// ---------- проверки для тревог ----------
// Возвращает список проблем: [{ key, text }]
function problems(s) {
  const out = [];
  if (!s.site.ok) out.push({ key: 'site', text: `🌐 Сайт ${hostOf(SITE_URL)} не открывается (${s.site.code || s.site.error || 'нет ответа'})` });
  if (!s.admin.ok) out.push({ key: 'admin', text: `🔐 Админка ${hostOf(ADMIN_URL)} не открывается (${s.admin.code || s.admin.error || 'нет ответа'})` });
  if (s.disk && s.disk.pct >= 85) out.push({ key: 'disk', text: `💽 Диск заполнен на ${s.disk.pct}% — осталось ${fmtBytes(s.disk.total - s.disk.used)}` });
  if (s.mem.pct >= 92) out.push({ key: 'mem', text: `🧠 Память занята на ${s.mem.pct}%` });
  if (s.cpu.load5 > s.cpu.cores * 2) out.push({ key: 'cpu', text: `⚙️ Процессор перегружен: нагрузка ${s.cpu.load5.toFixed(2)} при ${s.cpu.cores} ядр.` });
  for (const [k, c] of Object.entries(s.ssl)) {
    if (c && c.days < 14) out.push({ key: 'ssl_' + k, text: `🔒 Сертификат ${hostOf(k === 'site' ? SITE_URL : ADMIN_URL)} истекает через ${c.days} дн.` });
  }
  const lastAge = s.backups.last ? (Date.now() - s.backups.last.mtime) / 3600000 : Infinity;
  if (lastAge > 26) out.push({ key: 'backup', text: s.backups.last ? `💾 Бэкапов не было уже ${Math.round(lastAge)} ч` : '💾 Бэкапов пока нет' });
  return out;
}

// ---------- оформление ----------
function fmtBytes(b) {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1).replace('.', ',') + ' ГБ';
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + ' МБ';
  return Math.max(1, Math.round(b / 1024)) + ' КБ';
}
function fmtDur(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d} дн. ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  return `${m} мин`;
}
function fmtTime(ms, withYear) {
  return new Date(ms).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', ...(withYear ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });
}
const mark = ok => ok ? '✅' : '❌';

function report(s, html = true) {
  const b = t => html ? `<b>${t}</b>` : t;
  const ssl = c => c ? `ещё ${c.days} дн. (до ${fmtTime(Date.parse(c.until), true).slice(0, 10)})` : 'не удалось проверить';
  const minSsl = [s.ssl.site, s.ssl.admin].filter(Boolean).sort((a, z) => a.days - z.days)[0];
  const lines = [
    `🖥 ${b('Сервер «Кит»')} · ${fmtTime(s.at)}`,
    '',
    `🌐 Сайт: ${mark(s.site.ok)} ${s.site.ok ? 'работает' : 'НЕ РАБОТАЕТ'} (${s.site.ok ? (s.site.ms / 1000).toFixed(2).replace('.', ',') + ' с' : s.site.code || s.site.error})`,
    `🔐 Админка: ${mark(s.admin.ok)} ${s.admin.ok ? 'работает' : 'НЕ РАБОТАЕТ'}`,
    `🧩 Nginx: ${mark(s.nginx === 'active')} ${s.nginx === 'active' ? 'запущен' : s.nginx}`,
    '',
    `⚙️ Процессор: ${s.cpu.pct}% (нагрузка ${s.cpu.load1.toFixed(2)}, ядер: ${s.cpu.cores})`,
    `🧠 Память: ${fmtBytes(s.mem.used)} из ${fmtBytes(s.mem.total)} (${s.mem.pct}%)`,
    s.disk ? `💽 Диск: ${fmtBytes(s.disk.used)} из ${fmtBytes(s.disk.total)} (${s.disk.pct}%)` : '💽 Диск: нет данных',
    `🔒 Сертификат: ${minSsl ? ssl(minSsl) : 'не удалось проверить'}`,
    '',
    `💾 Последний бэкап: ${s.backups.last ? fmtTime(s.backups.last.mtime) : 'нет'} · копий: ${s.backups.count} · база ${fmtBytes(s.dbSize)}`,
    `⏱ Сервер работает ${fmtDur(s.uptime.server)}, сайт — ${fmtDur(s.uptime.app)}`,
    `📨 Новых заявок: ${s.orders.new}`,
  ];
  return lines.join('\n');
}

module.exports = { snapshot, problems, report, fmtBytes, fmtTime, fmtDur };
