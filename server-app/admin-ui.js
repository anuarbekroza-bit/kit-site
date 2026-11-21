'use strict';
// Страницы админки: вход и само приложение (обычный HTML + JS, без сборки).
const { esc } = require('./site');

const CSS = `
:root{--ink:#0F2A44;--muted:#5A6B80;--accent:#17739A;--line:#DCE6EE;--bg:#F4F8FB;--card:#fff;--ok:#1E7F4F;--err:#B42318;--sky:#DFF2F9}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 'Manrope',system-ui,-apple-system,sans-serif}
a{color:var(--accent)}
button,input,select,textarea{font:inherit;color:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:9px 14px;min-height:40px;cursor:pointer;font-weight:600;text-decoration:none;color:var(--ink)}
.btn:hover{border-color:#B9CAD8}
.btn-main{background:var(--accent);border-color:var(--accent);color:#fff}.btn-main:hover{filter:brightness(1.07)}
.btn-danger{color:var(--err)}
.btn-sm{padding:5px 10px;min-height:34px;font-size:14px}
.btn:disabled{opacity:.5;cursor:default}
input[type=text],input[type=password],textarea,select{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fff;min-height:42px}
textarea{min-height:96px;resize:vertical}
input:focus,textarea:focus,select:focus{outline:2px solid #8ED0E8;border-color:#8ED0E8}
label.f{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:15px}
.hint{font-weight:400;font-size:13px;color:var(--muted)}
.layout{display:flex;min-height:100vh}
.side{width:270px;flex-shrink:0;background:#fff;border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;padding:4px 8px 14px}
.brand i{width:36px;height:36px;border-radius:50%;background:#8ED0E8;display:flex;align-items:center;justify-content:center;font-style:normal}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;border:0;background:none;text-align:left;width:100%;font-weight:600}
.nav-item:hover{background:var(--bg)}.nav-item.on{background:var(--sky);color:#0F4F6B}
.nav-sep{height:1px;background:var(--line);margin:10px 4px}
.me{margin-top:auto;padding:12px 8px 0;font-size:14px;color:var(--muted);display:flex;flex-direction:column;gap:8px}
.main{flex:1;min-width:0;padding:28px 32px 120px;max-width:980px}
h1{font-size:26px;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:12px}
.card-h{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer}
.card-h .t{flex:1;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-h .t small{font-weight:500;color:var(--muted)}
.card-b{padding:4px 16px 18px;display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--line)}
.card.closed .card-b{display:none}
.thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;background:var(--sky);flex-shrink:0}
.img-f{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
.img-f img{width:120px;height:150px;object-fit:cover;border-radius:10px;background:var(--sky)}
.img-f .ph{width:120px;height:150px;border-radius:10px;background:var(--sky);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;text-align:center;padding:8px}
.img-f .acts{display:flex;flex-direction:column;gap:8px}
.check{display:flex;align-items:center;gap:10px;font-weight:600}
.check input{width:20px;height:20px}
.bar{position:fixed;left:270px;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 32px;display:flex;gap:12px;align-items:center;z-index:5}
.bar .msg{flex:1;font-size:14px;color:var(--muted)}
.bar .msg.err{color:var(--err);white-space:pre-line}.bar .msg.ok{color:var(--ok)}
.tbl{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.tbl th,.tbl td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:15px;vertical-align:top}
.tbl th{background:#F8FBFD;font-size:13px;color:var(--muted)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:var(--sky);color:#0F4F6B;font-size:13px;font-weight:700}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.box{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px;margin-bottom:16px}
.menu-btn{display:none}
.roles{display:grid;gap:8px;margin-bottom:16px}
.roles div{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 14px;font-size:14px}
@media (max-width:820px){
  .layout{display:block}
  .side{position:fixed;inset:0 auto 0 0;z-index:20;transform:translateX(-100%);transition:transform .2s;height:100%;box-shadow:0 0 40px rgba(0,0,0,.15)}
  .side.open{transform:none}
  .menu-btn{display:inline-flex;margin-bottom:14px}
  .main{padding:18px 16px 130px}
  .bar{left:0;padding:10px 16px}
  .grid2{grid-template-columns:1fr}
}
`;

function loginPage(err) {
  const msg = err === 'bad' ? 'Неверный логин или пароль' : err === 'blocked' ? 'Слишком много попыток. Подождите 15 минут.' : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход — админка «Кит»</title><meta name="robots" content="noindex"><style>${CSS}
.login{max-width:380px;margin:12vh auto;padding:0 16px}
</style></head><body><div class="login">
<div class="brand" style="justify-content:center;padding-bottom:20px"><i>🐋</i>Админка «Кит»</div>
<form method="post" action="/admin/login" class="box">
${msg ? `<div style="color:var(--err);font-weight:600">${esc(msg)}</div>` : ''}
<label class="f">Логин<input type="text" name="login" autocomplete="username" autocapitalize="none" required autofocus></label>
<label class="f">Пароль<input type="password" name="password" autocomplete="current-password" required></label>
<button class="btn btn-main" type="submit">Войти</button>
</form></div></body></html>`;
}

function setupPage({ token, err, hasOwner, login }) {
  const msgs = { pass: 'Пароль: минимум 8 символов', same: 'Пароли не совпали', login: 'Логин: 3–32 латинские буквы, цифры, точка, дефис', taken: 'Такой логин уже занят сотрудником', gone: '' };
  const msg = msgs[err] || '';
  const bad = !token;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Настройка входа — админка «Кит»</title><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><style>${CSS}
.login{max-width:420px;margin:10vh auto;padding:0 16px}.hint{color:var(--muted,#667);font-size:14px;line-height:1.45}
</style></head><body><div class="login">
<div class="brand" style="justify-content:center;padding-bottom:20px"><i>🐋</i>Админка «Кит»</div>
${bad ? `<div class="box"><b>Ссылка недействительна</b><p class="hint">Она уже использована или прошло больше 24 часов. Если логин и пароль уже заданы — <a href="/admin/login">войдите</a>.</p></div>` :
`<form method="post" action="/admin/setup" class="box">
<b style="font-size:18px">${hasOwner ? 'Новый логин и пароль владельца' : 'Придумайте логин и пароль'}</b>
<p class="hint" style="margin:0">С ними вы будете входить в админку. Ссылка одноразовая: после сохранения она перестанет работать.</p>
${msg ? `<div style="color:var(--err);font-weight:600">${esc(msg)}</div>` : ''}
<input type="hidden" name="t" value="${esc(token)}">
<label class="f">Логин (латиницей, например roza)<input type="text" name="login" value="${esc(login || '')}" autocomplete="username" autocapitalize="none" pattern="[A-Za-z0-9._\-]{3,32}" required autofocus></label>
<label class="f">Пароль (минимум 8 символов)<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
<label class="f">Пароль ещё раз<input type="password" name="password2" autocomplete="new-password" minlength="8" required></label>
<button class="btn btn-main" type="submit">Сохранить и войти</button>
</form>`}
</div></body></html>`;
}

function appPage({ user, csrf, sections, roles, siteUrl }) {
  const boot = JSON.stringify({ user, csrf, sections, roles, siteUrl }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Админка «Кит»</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body>
<div class="layout">
<aside class="side" id="side"></aside>
<main class="main"><button class="btn menu-btn" id="menuBtn">☰ Меню</button><div id="view"></div></main>
</div>
<div class="bar" id="bar" hidden><span class="msg" id="msg"></span><button class="btn btn-main" id="saveBtn">Сохранить</button></div>
<script>window.BOOT=${boot};</script>
<script>${CLIENT}</script>
</body></html>`;
}

// ---------- JS админки (выполняется в браузере) ----------
const CLIENT = String.raw`
(function(){
var B = window.BOOT, U = B.user;
var $ = function(s, r){ return (r||document).querySelector(s); };
function h(tag, attrs, kids){
  var e = document.createElement(tag);
  for (var k in (attrs||{})) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k.slice(0,2) === 'on') e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  [].concat(kids||[]).forEach(function(c){ if (c === null || c === undefined || c === false) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}
function api(method, url, body){
  return fetch('/admin/api' + url, { method: method, headers: { 'Content-Type': 'application/json', 'X-CSRF': B.csrf }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){
      if (r.status === 401) { location.href = '/admin/login'; throw new Error('Войдите заново'); }
      if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status); return j; }); });
}
var state = { view: null, data: null, dirty: false };
function setMsg(t, cls){ var m = $('#msg'); m.textContent = t || ''; m.className = 'msg' + (cls ? ' ' + cls : ''); }
function markDirty(){ state.dirty = true; setMsg('Есть несохранённые изменения'); }
window.addEventListener('beforeunload', function(e){ if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- меню ----------
function renderSide(){
  var side = $('#side'); side.innerHTML = '';
  side.appendChild(h('div', {'class':'brand'}, [h('i',{text:'🐋'}), 'Админка «Кит»']));
  B.sections.forEach(function(s){
    if (U.sections.indexOf(s.key) < 0) return;
    side.appendChild(h('button', {'class':'nav-item' + (state.view === s.key ? ' on' : ''), onclick: function(){ go(s.key); }}, [s.icon + ' ' + s.label]));
  });
  side.appendChild(h('div', {'class':'nav-sep'}));
  side.appendChild(h('button', {'class':'nav-item' + (state.view === 'orders' ? ' on' : ''), onclick: function(){ go('orders'); }}, ['📨 Заявки с сайта']));
  side.appendChild(h('button', {'class':'nav-item' + (state.view === 'bot' ? ' on' : ''), onclick: function(){ go('bot'); }}, ['🤖 Telegram-бот']));
  if (U.log) side.appendChild(h('button', {'class':'nav-item' + (state.view === 'server' ? ' on' : ''), onclick: function(){ go('server'); }}, ['🖥 Сервер']));
  if (U.users) side.appendChild(h('button', {'class':'nav-item' + (state.view === 'users' ? ' on' : ''), onclick: function(){ go('users'); }}, ['👥 Сотрудники и доступ']));
  if (U.log) side.appendChild(h('button', {'class':'nav-item' + (state.view === 'log' ? ' on' : ''), onclick: function(){ go('log'); }}, ['📜 Журнал действий']));
  side.appendChild(h('button', {'class':'nav-item' + (state.view === 'me' ? ' on' : ''), onclick: function(){ go('me'); }}, ['🔑 Мой пароль']));
  side.appendChild(h('a', {'class':'nav-item', href: B.siteUrl, target:'_blank', rel:'noopener'}, ['🌐 Открыть сайт ↗']));
  var form = h('form', {method:'post', action:'/admin/logout'}, [h('button', {'class':'btn btn-sm', type:'submit'}, ['Выйти'])]);
  side.appendChild(h('div', {'class':'me'}, [h('div', null, [h('b', {text: U.name || U.login}), ' · ', h('span', {'class':'pill', text: U.roleLabel})]), form]));
}
function go(view){
  if (state.dirty && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) return;
  state.dirty = false; state.view = view; location.hash = view;
  $('#side').classList.remove('open');
  renderSide(); setMsg('');
  var sec = B.sections.filter(function(s){ return s.key === view; })[0];
  if (sec) return openSection(sec);
  $('#bar').hidden = true;
  if (view === 'orders') return openOrders();
  if (view === 'bot') return openBot();
  if (view === 'server') return openServer();
  if (view === 'users') return openUsers();
  if (view === 'log') return openLog();
  if (view === 'me') return openMe();
}
$('#menuBtn').onclick = function(){ $('#side').classList.toggle('open'); };

// ---------- поля ----------
function resizeImage(file){
  return new Promise(function(resolve, reject){
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function(){
      var max = 1600, w = img.naturalWidth, hh = img.naturalHeight, k = Math.min(1, max / Math.max(w, hh));
      var c = document.createElement('canvas'); c.width = Math.round(w*k); c.height = Math.round(hh*k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = function(){ reject(new Error('Не получилось открыть фото')); };
    img.src = url;
  });
}
function field(f, obj, onChange){
  var v = obj[f.name];
  var hint = f.hint ? h('span', {'class':'hint', text: f.hint}) : null;
  var set = function(val){ obj[f.name] = val; markDirty(); if (onChange) onChange(); };
  if (f.type === 'boolean') {
    return h('label', {'class':'check'}, [h('input', {type:'checkbox', checked: v !== false, onchange: function(e){ set(e.target.checked); }}), f.label]);
  }
  if (f.type === 'image') {
    var wrap = h('div', {'class':'img-f'});
    var draw = function(){
      wrap.innerHTML = '';
      var cur = obj[f.name];
      wrap.appendChild(cur ? h('img', {src: cur, alt: ''}) : h('div', {'class':'ph', text:'Нет фото'}));
      var file = h('input', {type:'file', accept:'image/*', hidden: true, onchange: function(e){
        var fl = e.target.files[0]; if (!fl) return;
        setMsg('Загружаю фото…');
        resizeImage(fl).then(function(data){ return api('POST', '/upload', {data: data}); })
          .then(function(j){ set(j.path); draw(); setMsg('Фото загружено. Не забудьте нажать «Сохранить».'); })
          .catch(function(err){ setMsg(err.message, 'err'); });
      }});
      wrap.appendChild(h('div', {'class':'acts'}, [file,
        h('button', {'class':'btn btn-sm', type:'button', onclick: function(){ file.click(); }}, [cur ? 'Заменить фото' : 'Загрузить фото']),
        cur ? h('button', {'class':'btn btn-sm btn-danger', type:'button', onclick: function(){ set(''); draw(); }}, ['Убрать фото']) : null]));
    };
    draw();
    return h('div', {'class':'f', style:'display:flex;flex-direction:column;gap:6px'}, [h('b', {text: f.label, style:'font-size:15px'}), wrap, hint]);
  }
  var input = f.type === 'text'
    ? h('textarea', {oninput: function(e){ set(e.target.value); }}, [])
    : h('input', {type:'text', oninput: function(e){ set(e.target.value); }});
  input.value = v || '';
  return h('label', {'class':'f'}, [f.label + (f.required ? ' *' : ''), input, hint]);
}

// ---------- разделы ----------
function openSection(sec){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text: sec.icon + ' ' + sec.label}));
  view.appendChild(h('p', {'class':'sub', text: 'Измените и нажмите «Сохранить» — сайт обновится сразу.'}));
  var box = h('div', {text:'Загрузка…'}); view.appendChild(box);
  $('#bar').hidden = false;
  api('GET', '/section/' + sec.key).then(function(j){
    state.data = j.data; box.innerHTML = '';
    if (sec.type === 'list') drawList(sec, box); else drawSettings(sec, box);
  }).catch(function(e){ box.textContent = e.message; });
  $('#saveBtn').onclick = function(){
    var btn = $('#saveBtn'); btn.disabled = true; setMsg('Сохраняю…');
    api('PUT', '/section/' + sec.key, {data: state.data}).then(function(j){
      state.data = j.data; state.dirty = false; setMsg('Сохранено ✓ Сайт обновлён.', 'ok');
      if (sec.type === 'list') { box.innerHTML = ''; drawList(sec, box); }
    }).catch(function(e){ setMsg(e.message, 'err'); }).finally(function(){ btn.disabled = false; });
  };
}
function drawSettings(sec, box){
  var b = h('div', {'class':'box'});
  sec.fields.forEach(function(f){ b.appendChild(field(f, state.data)); });
  box.appendChild(b);
}
function summary(sec, it){
  var main = it[sec.summary[0]] || (sec.summary[0] === 'image' ? 'Фото' : '(без названия)');
  var rest = sec.summary.slice(1).map(function(k){ return it[k]; }).filter(Boolean).join(' · ');
  return [String(main), rest ? h('small', {text: ' · ' + rest}) : null, it.show === false ? h('small', {text: ' · скрыт'}) : null];
}
function drawList(sec, box){
  var items = state.data, open = {};
  var list = h('div'); box.appendChild(list);
  var imgField = sec.fields.filter(function(f){ return f.type === 'image'; })[0];
  function redraw(){
    list.innerHTML = '';
    items.forEach(function(it, i){
      var title = h('span', {'class':'t'}, summary(sec, it));
      var card = h('div', {'class':'card' + (open[i] ? '' : ' closed')});
      var head = h('div', {'class':'card-h', onclick: function(e){ if (e.target.closest('button')) return; open[i] = !open[i]; card.classList.toggle('closed'); }}, [
        imgField ? (it[imgField.name] ? h('img', {'class':'thumb', src: it[imgField.name], alt:''}) : h('span', {'class':'thumb'})) : null,
        title,
        h('button', {'class':'btn btn-sm', type:'button', title:'Выше', disabled: i === 0 ? true : null, onclick: function(){ move(i, -1); }}, ['↑']),
        h('button', {'class':'btn btn-sm', type:'button', title:'Ниже', disabled: i === items.length - 1 ? true : null, onclick: function(){ move(i, 1); }}, ['↓']),
        h('button', {'class':'btn btn-sm btn-danger', type:'button', title:'Удалить', onclick: function(){
          if (!confirm('Удалить «' + (it[sec.summary[0]] || sec.item) + '»?')) return;
          items.splice(i, 1); open = {}; markDirty(); redraw(); }}, ['🗑'])]);
      var body = h('div', {'class':'card-b'});
      sec.fields.forEach(function(f){ body.appendChild(field(f, it, function(){ title.innerHTML = ''; summary(sec, it).forEach(function(n){ if (n) title.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); }); })); });
      card.appendChild(head); card.appendChild(body); list.appendChild(card);
    });
    if (!items.length) list.appendChild(h('p', {'class':'sub', text:'Пока пусто.'}));
  }
  function move(i, d){ var t = items[i]; items[i] = items[i+d]; items[i+d] = t; open = {}; markDirty(); redraw(); }
  box.appendChild(h('button', {'class':'btn', type:'button', onclick: function(){
    var it = {}; sec.fields.forEach(function(f){ it[f.name] = f.type === 'boolean' ? (f.default !== false) : ''; });
    items.push(it); open = {}; open[items.length - 1] = true; markDirty(); redraw();
  }}, ['+ Добавить: ' + sec.item.toLowerCase()]));
  redraw();
}

// ---------- сотрудники ----------
function roleSelect(val){
  var s = h('select');
  Object.keys(B.roles).forEach(function(k){ var o = h('option', {value: k, text: B.roles[k].label}); if (k === val) o.selected = true; s.appendChild(o); });
  return s;
}
function openUsers(){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text:'👥 Сотрудники и доступ'}));
  view.appendChild(h('p', {'class':'sub', text:'Каждый входит под своим логином и видит только свои разделы. Все действия пишутся в журнал.'}));
  var roles = h('div', {'class':'roles'});
  Object.keys(B.roles).forEach(function(k){ roles.appendChild(h('div', null, [h('b', {text: B.roles[k].label}), ' — ' + B.roles[k].desc])); });
  view.appendChild(roles);
  var tableBox = h('div', {text:'Загрузка…'}); view.appendChild(tableBox);
  function load(){
    api('GET', '/users').then(function(j){
      tableBox.innerHTML = '';
      var t = h('table', {'class':'tbl'}, [h('tr', null, [h('th',{text:'Логин'}), h('th',{text:'Имя'}), h('th',{text:'Доступ'}), h('th',{text:''})])]);
      j.data.forEach(function(u){
        var sel = roleSelect(u.role);
        sel.onchange = function(){ api('PUT', '/users/' + u.id, {role: sel.value}).then(function(){ setMsg('Доступ изменён', 'ok'); load(); }).catch(function(e){ alert(e.message); load(); }); };
        var acts = h('div', {style:'display:flex;gap:6px;flex-wrap:wrap'}, [
          h('button', {'class':'btn btn-sm', type:'button', onclick: function(){
            var p = prompt('Новый пароль для ' + u.login + ' (минимум 8 символов):'); if (!p) return;
            api('PUT', '/users/' + u.id, {password: p}).then(function(){ alert('Пароль изменён'); }).catch(function(e){ alert(e.message); }); }}, ['Сменить пароль']),
          u.id === U.id ? null : h('button', {'class':'btn btn-sm btn-danger', type:'button', onclick: function(){
            if (!confirm('Удалить сотрудника ' + u.login + '?')) return;
            api('DELETE', '/users/' + u.id).then(load).catch(function(e){ alert(e.message); }); }}, ['Удалить'])]);
        t.appendChild(h('tr', null, [h('td', null, [h('b', {text: u.login})]), h('td', {text: u.name}), h('td', null, [sel]), h('td', null, [acts])]));
      });
      tableBox.appendChild(t);
    }).catch(function(e){ tableBox.textContent = e.message; });
  }
  load();
  var login = h('input', {type:'text', autocapitalize:'none', placeholder:'например: aigerim'}), name = h('input', {type:'text', placeholder:'Айгерим, менеджер'});
  var pass = h('input', {type:'text', placeholder:'минимум 8 символов'}), role = roleSelect('manager');
  var out = h('div', {'class':'hint'});
  view.appendChild(h('div', {'class':'box', style:'margin-top:18px'}, [h('b', {text:'Добавить сотрудника'}),
    h('div', {'class':'grid2'}, [h('label', {'class':'f'}, ['Логин', login]), h('label', {'class':'f'}, ['Имя', name]),
      h('label', {'class':'f'}, ['Пароль', pass]), h('label', {'class':'f'}, ['Уровень доступа', role])]),
    h('div', null, [h('button', {'class':'btn btn-main', type:'button', onclick: function(){
      api('POST', '/users', {login: login.value, name: name.value, password: pass.value, role: role.value}).then(function(){
        out.textContent = 'Готово. Передайте сотруднику: адрес ' + location.origin + '/admin, логин ' + login.value.trim().toLowerCase() + ' и пароль.';
        login.value = name.value = pass.value = ''; load(); }).catch(function(e){ out.textContent = e.message; }); }}, ['Добавить'])]), out]));
}

// ---------- заявки ----------
function localTime(at){
  try { return new Date(String(at).replace(' ', 'T') + 'Z').toLocaleString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }
  catch (e) { return at; }
}
function openOrders(){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text:'📨 Заявки с сайта'}));
  view.appendChild(h('p', {'class':'sub', text:'Клиенты оставляют их кнопкой «Заказать» на сайте. Если подключён Telegram-бот — каждая заявка сразу приходит вам в Telegram.'}));
  var box = h('div', {text:'Загрузка…'}); view.appendChild(box);
  api('GET', '/orders').then(function(j){
    box.innerHTML = '';
    if (!j.data.length) { box.appendChild(h('div', {'class':'box', text:'Заявок пока нет.'})); return; }
    var t = h('table', {'class':'tbl'}, [h('tr', null, [h('th',{text:'№'}), h('th',{text:'Когда'}), h('th',{text:'Клиент'}), h('th',{text:'Что хочет'}), h('th',{text:'Статус'})])]);
    j.data.forEach(function(o){
      var sel = h('select');
      Object.keys(j.statuses).forEach(function(k){ var op = h('option', {value:k, text:j.statuses[k]}); if (k === o.status) op.selected = true; sel.appendChild(op); });
      sel.onchange = function(){ api('PUT', '/orders/' + o.id, {status: sel.value}).then(function(){ setMsg('Статус заявки №' + o.id + ' изменён', 'ok'); }).catch(function(e){ alert(e.message); }); };
      var wa = 'https://wa.me/' + o.phone + '?text=' + encodeURIComponent('Здравствуйте! Это магазин «Кит». Вы оставили заявку на сайте' + (o.product ? ': ' + o.product : '') + '.');
      t.appendChild(h('tr', o.status === 'new' ? {style:'background:#FFF9E6'} : null, [
        h('td', null, [h('b', {text: String(o.id)})]),
        h('td', {text: localTime(o.at)}),
        h('td', null, [h('div', {text: o.name}), h('a', {href: wa, target:'_blank', rel:'noopener', text: '+' + o.phone})]),
        h('td', null, [o.product ? h('div', null, [h('b', {text: o.product})]) : null, o.comment ? h('div', {'class':'hint', style:'font-size:14px', text: o.comment}) : null]),
        h('td', null, [sel, o.handled_by && o.status !== 'new' ? h('div', {'class':'hint', text: o.handled_by}) : null])]));
    });
    box.appendChild(t);
  }).catch(function(e){ box.textContent = e.message; });
}

// ---------- Telegram-бот ----------
function openBot(){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text:'🤖 Telegram-бот'}));
  view.appendChild(h('p', {'class':'sub', text:'Заявки с сайта приходят в Telegram, а товары (цена, рост, фото, наличие) можно менять прямо с телефона.'}));
  var box = h('div', {text:'Загрузка…'}); view.appendChild(box);
  function load(){
    api('GET', '/bot').then(function(b){
      box.innerHTML = '';
      var st = b.status === 'ok' ? h('div', null, ['✅ Бот работает: ', h('a', {href:'https://t.me/' + b.username, target:'_blank', rel:'noopener', text:'@' + b.username})])
        : b.status === 'error' ? h('div', {style:'color:var(--err);font-weight:600', text:'⚠️ ' + b.lastError})
        : b.status === 'starting' ? h('div', {text:'⏳ Бот запускается… обновите страницу через несколько секунд'})
        : h('div', {text:'Бот ещё не подключён.'});
      box.appendChild(h('div', {'class':'box'}, [h('b', {text:'Состояние'}), st]));

      if (b.canConfigure) {
        var tok = h('input', {type:'password', autocomplete:'off', placeholder: b.hasToken ? 'Токен сохранён. Вставьте новый, чтобы заменить' : '1234567890:AAH…'});
        var out = h('div', {'class':'hint'});
        box.appendChild(h('div', {'class':'box'}, [h('b', {text: b.hasToken ? 'Токен бота' : 'Шаг 1. Создайте бота и вставьте токен'}),
          b.hasToken ? null : h('ol', {style:'margin:0;padding-left:20px;line-height:1.7'}, [
            h('li', null, ['Откройте в Telegram ', h('a', {href:'https://t.me/BotFather', target:'_blank', rel:'noopener', text:'@BotFather'}), ' и нажмите «Запустить».']),
            h('li', {text:'Отправьте команду /newbot.'}),
            h('li', {text:'Имя бота — например: Кит — магазин детской одежды.'}),
            h('li', {text:'Адрес бота — латиницей и в конце bot, например: kit_astana_bot.'}),
            h('li', {text:'BotFather пришлёт токен — длинную строку вида 1234567890:AAH… Скопируйте её и вставьте сюда.'})]),
          h('label', {'class':'f'}, ['Токен', tok]),
          h('div', {style:'display:flex;gap:8px;flex-wrap:wrap'}, [
            h('button', {'class':'btn btn-main', type:'button', onclick: function(){
              if (!tok.value.trim()) { out.textContent = 'Вставьте токен'; return; }
              out.textContent = 'Проверяю…';
              api('PUT', '/bot', {token: tok.value.trim()}).then(function(){ load(); }).catch(function(e){ out.textContent = e.message; }); }}, ['Сохранить и запустить']),
            b.hasToken ? h('button', {'class':'btn btn-danger', type:'button', onclick: function(){
              if (!confirm('Отключить бота? Заявки перестанут приходить в Telegram (на сайте и в админке они останутся).')) return;
              api('PUT', '/bot', {token: ''}).then(load).catch(function(e){ alert(e.message); }); }}, ['Отключить бота']) : null]),
          h('div', {'class':'hint', text:'Токен — как пароль от бота: никому его не пересылайте. Он хранится только на вашем сервере.'}), out]));
      }

      var linkOut = h('div');
      box.appendChild(h('div', {'class':'box'}, [h('b', {text: b.canConfigure && !b.hasToken ? 'Шаг 2. Подключите свой Telegram' : 'Мой Telegram'}),
        h('div', {'class':'hint', style:'font-size:15px', text:'Нажмите кнопку — откроется бот. Нажмите в нём «Запустить» (Start). После этого заявки будут приходить вам, а товары можно менять из бота. Так же подключается каждый сотрудник под своим логином.'}),
        h('div', null, [h('button', {'class':'btn btn-main', type:'button', disabled: b.status !== 'ok', onclick: function(){
          api('POST', '/bot/connect').then(function(j){
            linkOut.innerHTML = '';
            linkOut.appendChild(h('a', {'class':'btn', href: j.url, target:'_blank', rel:'noopener', text:'Открыть бота в Telegram ↗'}));
            linkOut.appendChild(h('div', {'class':'hint', style:'margin-top:6px', text:'Ссылка личная и одноразовая, действует 30 минут.'}));
          }).catch(function(e){ linkOut.textContent = e.message; }); }}, ['📲 Подключить мой Telegram'])]), linkOut]));

      // голосовое управление
      var v = b.voice || {};
      var vst = v.status === 'ok' && v.hasKey ? h('div', {text:'✅ Включено (' + (v.provider === 'gemini' ? 'Google Gemini' : 'OpenAI') + '). Отправьте боту голосовое — по-русски или по-казахски.'})
        : v.status === 'error' ? h('div', {style:'color:var(--err);font-weight:600', text:'⚠️ ' + v.lastError})
        : h('div', {text:'Выключено.'});
      var vparts = [h('b', {text:'🎤 Голосовое управление (русский и казахский)'}), vst];
      if (v.hasKey && v.lastError && v.status !== 'error') vparts.push(h('div', {'class':'hint', text:'Последняя ошибка: ' + v.lastError}));
      var ex = ['Скажите боту голосом или напишите своими словами, например:', '• «Поставь цену на брюки карго 13 500»', '• «Бомбер закончился, скрой с сайта»',
        '• «Добавь товар: шапка зимняя, 5 900, на 3–7 лет»', '• «Карго шалбардың бағасы он үш мың»', '• «Өтінімдерді көрсет» · «Заявку 12 в работу»',
        'Перед любым изменением бот показывает, что понял, и ждёт кнопку «✅ Да».'];
      vparts.push(h('div', {'class':'hint', style:'font-size:15px;line-height:1.6'}, ex.map(function(line){ return h('div', {text: line}); })));
      if (b.canConfigure) {
        var vkey = h('input', {type:'password', autocomplete:'off', placeholder: v.hasKey ? 'Ключ сохранён. Вставьте новый, чтобы заменить' : 'AIza… или sk-…'});
        var vout = h('div', {'class':'hint'});
        if (!v.hasKey) vparts.push(h('ol', {style:'margin:0;padding-left:20px;line-height:1.7'}, [
          h('li', null, ['Откройте ', h('a', {href:'https://aistudio.google.com/apikey', target:'_blank', rel:'noopener', text:'aistudio.google.com/apikey'}), ' и войдите своим Google-аккаунтом.']),
          h('li', {text:'Нажмите «Create API key» (Создать ключ) и скопируйте ключ — он начинается с AIza…'}),
          h('li', {text:'Вставьте его сюда и нажмите «Включить».'}),
          h('li', {'class':'hint', text:'Можно и ключ OpenAI (sk-…) — бот сам поймёт, какой это сервис.'})]));
        vparts.push(h('label', {'class':'f'}, ['Ключ ИИ', vkey]));
        vparts.push(h('div', {style:'display:flex;gap:8px;flex-wrap:wrap'}, [
          h('button', {'class':'btn btn-main', type:'button', onclick: function(){
            if (!vkey.value.trim()) { vout.textContent = 'Вставьте ключ'; return; }
            vout.textContent = 'Проверяю ключ…';
            api('PUT', '/bot/voice', {key: vkey.value.trim()}).then(function(){ load(); }).catch(function(e){ vout.textContent = e.message; }); }}, [v.hasKey ? 'Заменить ключ' : 'Включить']),
          v.hasKey ? h('button', {'class':'btn btn-danger', type:'button', onclick: function(){
            if (!confirm('Выключить голосовое управление? Кнопки бота продолжат работать.')) return;
            api('PUT', '/bot/voice', {key: ''}).then(load).catch(function(e){ alert(e.message); }); }}, ['Выключить']) : null]));
        vparts.push(h('div', {'class':'hint', text:'Голосовые, список товаров и открытых заявок (имя клиента и товар, без телефонов) отправляются на распознавание в выбранный сервис. Ключ хранится только на вашем сервере.'}));
        vparts.push(vout);
      }
      box.appendChild(h('div', {'class':'box'}, vparts));

      var t = h('table', {'class':'tbl'}, [h('tr', null, [h('th',{text:'Сотрудник'}), h('th',{text:'Telegram'}), h('th',{text:'С какого времени'}), h('th',{text:''})])]);
      b.links.forEach(function(l){
        t.appendChild(h('tr', null, [h('td', null, [h('b', {text: l.name || l.login}), ' ', h('span', {'class':'hint', text: l.login})]), h('td', {text: l.tg_name || '—'}), h('td', {text: localTime(l.created_at)}),
          h('td', null, [h('button', {'class':'btn btn-sm btn-danger', type:'button', onclick: function(){
            if (!confirm('Отключить этот Telegram от админки?')) return;
            api('DELETE', '/bot/links/' + l.chat_id).then(load).catch(function(e){ alert(e.message); }); }}, ['Отключить'])])]));
      });
      box.appendChild(h('div', {'class':'box'}, [h('b', {text: b.canConfigure ? 'Подключённые Telegram' : 'Подключённые Telegram (ваши)'}),
        b.links.length ? t : h('div', {'class':'hint', text:'Пока никто не подключён.'})]));
    }).catch(function(e){ box.textContent = e.message; });
  }
  load();
}

// ---------- сервер ----------
function fmtBytes(b){ if (b >= 1073741824) return (b / 1073741824).toFixed(1).replace('.', ',') + ' ГБ'; if (b >= 1048576) return Math.round(b / 1048576) + ' МБ'; return Math.max(1, Math.round(b / 1024)) + ' КБ'; }
function fmtMs(ms){ return new Date(ms).toLocaleString('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }
function fmtDur(sec){ sec = Math.floor(sec); var d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60); return d ? d + ' дн. ' + hh + ' ч' : hh ? hh + ' ч ' + mm + ' мин' : mm + ' мин'; }
function meter(label, pct, detail){
  var color = pct >= 85 ? 'var(--err)' : pct >= 70 ? '#D9A400' : 'var(--accent)';
  return h('div', {'class':'box', style:'gap:6px'}, [h('div', {style:'display:flex;justify-content:space-between'}, [h('b', {text: label}), h('b', {text: pct + '%'})]),
    h('div', {style:'height:8px;border-radius:8px;background:var(--line);overflow:hidden'}, [h('div', {style:'height:100%;width:' + Math.min(100, pct) + '%;background:' + color})]),
    h('div', {'class':'hint', text: detail})]);
}
function openServer(){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text:'🖥 Сервер'}));
  view.appendChild(h('p', {'class':'sub', text:'Состояние сервера, бэкапы и отдельный Telegram-бот для тревог. Каждые 5 минут сервер проверяет себя сам, а сторож перезапускает сайт, если тот перестал отвечать.'}));
  var box = h('div', {text:'Проверяю сервер…'}); view.appendChild(box);
  function load(){
    api('GET', '/server').then(function(d){
      box.innerHTML = '';
      var s = d.snap;
      var ok = function(x){ return x ? '✅' : '❌'; };
      var minSsl = [s.ssl.site, s.ssl.admin].filter(Boolean).sort(function(a, z){ return a.days - z.days; })[0];
      box.appendChild(h('div', {'class':'box', style: d.problems.length ? 'border-color:var(--err)' : ''}, [
        h('b', {text: d.problems.length ? '⚠️ Есть проблемы' : '✅ Всё в порядке'}),
        d.problems.length ? h('ul', {style:'margin:0;padding-left:20px'}, d.problems.map(function(p){ return h('li', {text: p.text}); })) : null,
        h('div', {style:'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 18px;font-size:15px'}, [
          h('div', {text: ok(s.site.ok) + ' Сайт' + (s.site.ok ? ' · ' + (s.site.ms / 1000).toFixed(2).replace('.', ',') + ' с' : '')}),
          h('div', {text: ok(s.admin.ok) + ' Админка'}),
          h('div', {text: ok(s.nginx === 'active') + ' Nginx'}),
          h('div', {text: '🔒 Сертификат: ' + (minSsl ? 'ещё ' + minSsl.days + ' дн.' : 'нет данных')}),
          h('div', {text: '⏱ Сервер работает ' + fmtDur(s.uptime.server)}),
          h('div', {text: '🟢 Сайт запущен ' + fmtDur(s.uptime.app) + ' назад'})]),
        h('div', null, [h('button', {'class':'btn', type:'button', onclick: load}, ['🔄 Обновить'])])]));
      box.appendChild(h('div', {style:'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px'}, [
        meter('⚙️ Процессор', s.cpu.pct, 'нагрузка ' + s.cpu.load1.toFixed(2) + ', ядер: ' + s.cpu.cores),
        meter('🧠 Память', s.mem.pct, fmtBytes(s.mem.used) + ' из ' + fmtBytes(s.mem.total)),
        s.disk ? meter('💽 Диск', s.disk.pct, fmtBytes(s.disk.used) + ' из ' + fmtBytes(s.disk.total)) : null]));

      // бэкапы
      var bmsg = h('span', {'class':'hint'});
      var bl = h('table', {'class':'tbl'}, [h('tr', null, [h('th', {text:'Когда'}), h('th', {text:'Размер'}), h('th', {text:''})])]);
      d.backups.slice(0, 10).forEach(function(b){
        bl.appendChild(h('tr', null, [h('td', {text: fmtMs(b.mtime)}), h('td', {text: fmtBytes(b.size)}),
          h('td', null, [d.canConfigure ? h('a', {'class':'btn btn-sm', href:'/admin/api/server/backups/' + b.name, download: b.name, text:'Скачать'}) : null])]));
      });
      box.appendChild(h('div', {'class':'box'}, [h('b', {text:'💾 Бэкапы базы'}),
        h('div', {'class':'hint', style:'font-size:15px', text:'Копия делается при каждом сохранении и каждую ночь; хранятся последние 30. Всего сейчас: ' + d.backups.length + '. База весит ' + fmtBytes(s.dbSize) + '.'}),
        h('div', {style:'display:flex;gap:10px;align-items:center;flex-wrap:wrap'}, [h('button', {'class':'btn btn-main', type:'button', onclick: function(){
          bmsg.textContent = 'Делаю копию…';
          api('POST', '/server/backup').then(function(){ setMsg('Бэкап сделан', 'ok'); load(); }).catch(function(e){ bmsg.textContent = e.message; }); }}, ['💾 Сделать бэкап сейчас']), bmsg]),
        d.backups.length ? bl : null]));

      // бот сервера
      var b = d.bot;
      var st = b.status === 'ok' ? h('div', null, ['✅ Бот сервера работает: ', h('a', {href:'https://t.me/' + b.username, target:'_blank', rel:'noopener', text:'@' + b.username})])
        : b.status === 'error' ? h('div', {style:'color:var(--err);font-weight:600', text:'⚠️ ' + b.lastError})
        : b.status === 'starting' ? h('div', {text:'⏳ Запускается… обновите через несколько секунд'})
        : h('div', {text:'Бот сервера ещё не подключён.'});
      var parts = [h('b', {text:'🤖 Telegram-бот сервера'}), st,
        h('div', {'class':'hint', style:'font-size:15px', text:'Отдельный бот (не тот, что для заявок): статус по кнопке, бэкап, тревоги, если с сервером что-то не так, и отчёт каждый день в 10:00.'})];
      if (d.canConfigure) {
        var tok = h('input', {type:'password', autocomplete:'off', placeholder: b.hasToken ? 'Токен сохранён. Вставьте новый, чтобы заменить' : 'Токен бота сервера: 1234567890:AAH…'});
        var out = h('div', {'class':'hint'});
        parts.push(h('label', {'class':'f'}, ['Токен бота сервера (из @BotFather)', tok]));
        parts.push(h('div', {style:'display:flex;gap:8px;flex-wrap:wrap'}, [
          h('button', {'class':'btn btn-main', type:'button', onclick: function(){
            if (!tok.value.trim()) { out.textContent = 'Вставьте токен'; return; }
            out.textContent = 'Проверяю…';
            api('PUT', '/server/bot', {token: tok.value.trim()}).then(function(){ load(); }).catch(function(e){ out.textContent = e.message; }); }}, ['Сохранить и запустить']),
          b.hasToken ? h('button', {'class':'btn btn-danger', type:'button', onclick: function(){
            if (!confirm('Отключить бота сервера? Тревоги перестанут приходить.')) return;
            api('PUT', '/server/bot', {token: ''}).then(load).catch(function(e){ alert(e.message); }); }}, ['Отключить']) : null]));
        parts.push(out);
      }
      var linkOut = h('div');
      parts.push(h('div', null, [h('button', {'class':'btn', type:'button', disabled: b.status !== 'ok', onclick: function(){
        api('POST', '/server/connect').then(function(j){
          linkOut.innerHTML = '';
          linkOut.appendChild(h('a', {'class':'btn btn-main', href: j.url, target:'_blank', rel:'noopener', text:'Открыть бота сервера в Telegram ↗'}));
          linkOut.appendChild(h('div', {'class':'hint', style:'margin-top:6px', text:'Нажмите в боте «Запустить». Ссылка личная, действует 30 минут.'}));
        }).catch(function(e){ linkOut.textContent = e.message; }); }}, ['📲 Подключить мой Telegram']), linkOut]));
      box.appendChild(h('div', {'class':'box'}, parts));

      // кто подключён
      var t = h('table', {'class':'tbl'}, [h('tr', null, [h('th',{text:'Сотрудник'}), h('th',{text:'Telegram'}), h('th',{text:'Тревоги'}), h('th',{text:'Отчёт в 10:00'}), h('th',{text:''})])]);
      d.links.forEach(function(l){
        function flag(f){ var c = h('input', {type:'checkbox'}); c.checked = l[f]; c.onchange = function(){ var b = {}; b[f] = c.checked; api('PUT', '/server/links/' + l.chat_id, b).then(function(){ setMsg('Сохранено', 'ok'); }).catch(function(e){ alert(e.message); }); }; return c; }
        t.appendChild(h('tr', null, [h('td', null, [h('b', {text: l.name || l.login})]), h('td', {text: l.tg_name || '—'}), h('td', null, [flag('alerts')]), h('td', null, [flag('daily')]),
          h('td', null, [h('button', {'class':'btn btn-sm btn-danger', type:'button', onclick: function(){
            if (!confirm('Отключить этот Telegram от бота сервера?')) return;
            api('DELETE', '/server/links/' + l.chat_id).then(load).catch(function(e){ alert(e.message); }); }}, ['Отключить'])])]));
      });
      box.appendChild(h('div', {'class':'box'}, [h('b', {text:'Кому приходят уведомления о сервере'}), d.links.length ? t : h('div', {'class':'hint', text:'Пока никто не подключён.'})]));
    }).catch(function(e){ box.textContent = e.message; });
  }
  load();
}

// ---------- журнал ----------
function openLog(){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text:'📜 Журнал действий'}));
  view.appendChild(h('p', {'class':'sub', text:'Кто, что и когда менял. Время — по серверу (UTC).'}));
  var box = h('div', {text:'Загрузка…'}); view.appendChild(box);
  api('GET', '/log').then(function(j){
    box.innerHTML = '';
    var t = h('table', {'class':'tbl'}, [h('tr', null, [h('th',{text:'Когда'}), h('th',{text:'Кто'}), h('th',{text:'Что сделал'})])]);
    j.data.forEach(function(r){ t.appendChild(h('tr', null, [h('td', {text: r.at}), h('td', {text: r.user}), h('td', {text: r.action})])); });
    box.appendChild(t);
  }).catch(function(e){ box.textContent = e.message; });
}

// ---------- мой пароль ----------
function openMe(){
  var view = $('#view'); view.innerHTML = '';
  view.appendChild(h('h1', {text:'🔑 Мой пароль'}));
  var cur = h('input', {type:'password', autocomplete:'current-password'}), nw = h('input', {type:'password', autocomplete:'new-password'}), nw2 = h('input', {type:'password', autocomplete:'new-password'});
  var out = h('div', {'class':'hint'});
  view.appendChild(h('div', {'class':'box', style:'max-width:420px'}, [
    h('label', {'class':'f'}, ['Текущий пароль', cur]), h('label', {'class':'f'}, ['Новый пароль (минимум 8 символов)', nw]), h('label', {'class':'f'}, ['Новый пароль ещё раз', nw2]),
    h('button', {'class':'btn btn-main', type:'button', onclick: function(){
      if (nw.value !== nw2.value) { out.textContent = 'Пароли не совпадают'; return; }
      api('PUT', '/me/password', {current: cur.value, next: nw.value}).then(function(){ out.textContent = 'Пароль изменён ✓'; cur.value = nw.value = nw2.value = ''; })
        .catch(function(e){ out.textContent = e.message; }); }}, ['Сменить пароль']), out]));
}

var start = (location.hash || '').slice(1);
var allowed = U.sections.concat(['orders', 'bot'], U.users ? ['users'] : [], U.log ? ['log', 'server'] : [], ['me']);
go(allowed.indexOf(start) >= 0 ? start : (U.sections[0] || 'me'));
})();
`;

module.exports = { setupPage, loginPage, appPage };
