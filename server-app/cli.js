'use strict';
// Служебные команды (запускаются на сервере):
//   node cli.js init                 — создать базу и заполнить данными сайта (если пустая)
//   node cli.js owner                — создать/обновить владельца (логин и пароль читаются из stdin, по строке)
//   node cli.js setup-link           — одноразовая ссылка (24 ч), чтобы задать логин и пароль владельца в браузере
//   node cli.js render > index.html  — вывести HTML сайта
//   node cli.js backup               — копия базы в папку backups
const fs = require('fs');
const path = require('path');
const store = require('./db');

const cmd = process.argv[2];

if (cmd === 'init') {
  if (store.isEmpty()) {
    store.seed(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    console.log('База создана и заполнена данными сайта');
  } else console.log('База уже есть — данные не трогаю');
} else if (cmd === 'owner') {
  const lines = fs.readFileSync(0, 'utf8').split(/\r?\n/);
  const login = String(lines[0] || '').trim().toLowerCase();
  const pass = String(lines[1] || '');
  const name = String(lines[2] || '').trim() || login;
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) { console.error('Логин: 3–32 латинские буквы или цифры'); process.exit(1); }
  if (pass.length < 8) { console.error('Пароль: минимум 8 символов'); process.exit(1); }
  const u = store.users.byLogin(login);
  if (u) { store.users.update(u.id, { password: pass, role: 'owner' }); console.log('Пароль владельца обновлён: ' + login); }
  else { store.users.create(login, name, 'owner', pass); console.log('Владелец создан: ' + login); }
  store.log.add('сервер', 'владелец ' + login + ' создан/обновлён через консоль');
} else if (cmd === 'setup-link') {
  const base = (process.env.ADMIN_URL || 'https://admin.r-agent.kz').replace(/\/$/, '');
  console.log(base + '/admin/setup?t=' + store.setupLinks.create());
} else if (cmd === 'has-owner') {
  process.exit(store.users.owners() > 0 ? 0 : 1);
} else if (cmd === 'render') {
  process.stdout.write(require('./site').render(store.getAll(), { baseUrl: process.env.SITE_URL || 'https://kit.r-agent.kz' }));
} else if (cmd === 'backup') {
  console.log(store.backup());
} else {
  console.log('Команды: init | owner | setup-link | has-owner | render | backup');
}
