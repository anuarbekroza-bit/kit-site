'use strict';
// База данных SQLite (один файл kit.db в папке данных).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { SECTIONS, byKey } = require('./schema');

const DATA_DIR = process.env.KIT_DATA || path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'kit.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

function q(name) { return '"' + name.replace(/"/g, '') + '"'; }

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      section TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (section, key)
    );
    CREATE TABLE IF NOT EXISTS setup_links (
      hash TEXT PRIMARY KEY,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      user TEXT NOT NULL,
      action TEXT NOT NULL
    );
  `);
  for (const s of SECTIONS) {
    if (s.type !== 'list') continue;
    const cols = s.fields.map(f => `${q(f.name)} ${f.type === 'boolean' ? 'INTEGER NOT NULL DEFAULT 1' : "TEXT NOT NULL DEFAULT ''"}`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${q(s.key)} (id INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER NOT NULL DEFAULT 0, ${cols.join(', ')})`);
    // если в схему добавили новое поле — добавляем колонку
    const have = db.prepare(`PRAGMA table_info(${q(s.key)})`).all().map(c => c.name);
    for (const f of s.fields) {
      if (!have.includes(f.name)) {
        db.exec(`ALTER TABLE ${q(s.key)} ADD COLUMN ${q(f.name)} ${f.type === 'boolean' ? 'INTEGER NOT NULL DEFAULT 1' : "TEXT NOT NULL DEFAULT ''"}`);
      }
    }
  }
}

function cleanValue(f, v) {
  if (f.type === 'boolean') return v === false || v === 0 || v === '0' || v === 'false' ? 0 : 1;
  if (v === null || v === undefined) return '';
  return String(v).slice(0, 5000);
}

function getList(key) {
  const s = byKey[key];
  return db.prepare(`SELECT * FROM ${q(key)} ORDER BY pos, id`).all().map(r => {
    const o = { id: r.id };
    for (const f of s.fields) o[f.name] = f.type === 'boolean' ? !!r[f.name] : r[f.name];
    return o;
  });
}

function setList(key, items) {
  const s = byKey[key];
  const names = s.fields.map(f => f.name);
  const ins = db.prepare(`INSERT INTO ${q(key)} (pos, ${names.map(q).join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM ${q(key)}`);
    items.forEach((it, i) => ins.run(i, ...s.fields.map(f => cleanValue(f, it[f.name] === undefined ? f.default : it[f.name]))));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function getSettings(key) {
  const s = byKey[key];
  const rows = db.prepare('SELECT key, value FROM settings WHERE section = ?').all(key);
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const o = {};
  for (const f of s.fields) o[f.name] = m[f.name] ?? '';
  return o;
}

function setSettings(key, values) {
  const s = byKey[key];
  const up = db.prepare('INSERT INTO settings (section, key, value) VALUES (?, ?, ?) ON CONFLICT(section, key) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN');
  try {
    for (const f of s.fields) up.run(key, f.name, cleanValue(f, values[f.name]));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function getSection(key) { return byKey[key].type === 'list' ? getList(key) : getSettings(key); }
function setSection(key, data) { return byKey[key].type === 'list' ? setList(key, data) : setSettings(key, data); }

function getAll() {
  const o = {};
  for (const s of SECTIONS) o[s.key] = getSection(s.key);
  return o;
}

function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS n FROM settings').get().n === 0;
}

function seed(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  for (const k of ['products', 'categories', 'ages', 'reviews', 'gallery']) setList(k, (d[k] && d[k].items) || []);
  const t = d.texts || {};
  setList('steps', t.steps || []);
  setSettings('contacts', d.contacts || {});
  setSettings('texts', t);
}

// Пароли: scrypt со случайной солью
function hashPassword(p) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(p, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPassword(p, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(p, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

const users = {
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  list: () => db.prepare('SELECT id, login, name, role, created_at FROM users ORDER BY id').all(),
  byLogin: login => db.prepare('SELECT * FROM users WHERE login = ?').get(String(login).trim().toLowerCase()),
  byId: id => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  create: (login, name, role, password) => db.prepare('INSERT INTO users (login, name, role, pass_hash) VALUES (?, ?, ?, ?)')
    .run(String(login).trim().toLowerCase(), name || '', role, hashPassword(password)),
  update: (id, fields) => {
    if (fields.login !== undefined) db.prepare('UPDATE users SET login = ? WHERE id = ?').run(String(fields.login).trim().toLowerCase(), id);
    if (fields.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(fields.name, id);
    if (fields.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(fields.role, id);
    if (fields.password) {
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(fields.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  },
  remove: id => db.prepare('DELETE FROM users WHERE id = ?').run(id),
  owners: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n,
  firstOwner: () => db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get(),
};

// Одноразовая ссылка, по которой владелец сам задаёт логин и пароль (действует 24 часа)
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const setupLinks = {
  create: () => {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('DELETE FROM setup_links').run();
    db.prepare('INSERT INTO setup_links (hash, expires) VALUES (?, ?)').run(sha(token), Date.now() + 24 * 3600 * 1000);
    return token;
  },
  valid: token => {
    if (!token || typeof token !== 'string') return false;
    const r = db.prepare('SELECT expires FROM setup_links WHERE hash = ?').get(sha(token));
    return !!r && r.expires > Date.now();
  },
  use: token => db.prepare('DELETE FROM setup_links WHERE hash = ?').run(sha(token)).changes > 0,
};

const sessions = {
  create: userId => {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, csrf, expires) VALUES (?, ?, ?, ?)').run(token, userId, csrf, Date.now() + 7 * 24 * 3600 * 1000);
    return token;
  },
  get: token => {
    if (!token) return null;
    const s = db.prepare('SELECT s.token, s.csrf, s.expires, u.id, u.login, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
    if (!s || s.expires < Date.now()) return null;
    return s;
  },
  remove: token => db.prepare('DELETE FROM sessions WHERE token = ?').run(token),
  cleanup: () => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()),
};

const log = {
  add: (user, action) => db.prepare('INSERT INTO log (user, action) VALUES (?, ?)').run(user, action),
  list: (limit = 200) => db.prepare('SELECT at, user, action FROM log ORDER BY id DESC LIMIT ?').all(limit),
};

function backup() {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = path.join(dir, 'kit-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.db');
  db.exec(`VACUUM INTO '${name.replace(/'/g, "''")}'`);
  // храним 30 последних копий
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(dir, f));
  return name;
}

migrate();

module.exports = { db, DATA_DIR, IMAGES_DIR, getAll, getSection, setSection, isEmpty, seed, users, sessions, setupLinks, log, backup, checkPassword };
