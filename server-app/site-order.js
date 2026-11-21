(function () {
  var dlg = document.getElementById('order-dlg');
  if (!dlg || !dlg.showModal) return;
  var form = dlg.querySelector('form'), done = dlg.querySelector('.done'), err = dlg.querySelector('.err');
  var line = dlg.querySelector('.prod-line'), btn = form.querySelector('[type=submit]');
  var kk = function () { return document.documentElement.lang === 'kk'; };
  var T = {
    send: ['Отправить заявку', 'Өтінім жіберу'], sending: ['Отправляем…', 'Жіберілуде…'],
    net: ['Не удалось отправить. Проверьте интернет или напишите нам в WhatsApp.', 'Жіберу мүмкін болмады. Интернетті тексеріңіз немесе WhatsApp-қа жазыңыз.'],
    name: ['Напишите, как к вам обращаться', 'Атыңызды жазыңыз'], phone: ['Проверьте номер: +7 и 10 цифр', 'Нөмірді тексеріңіз: +7 және 10 сан']
  };
  var t = function (k) { return T[k][kk() ? 1 : 0]; };
  function open(product) {
    form.hidden = false; done.hidden = true; err.textContent = '';
    form.product.value = product || '';
    line.hidden = !product; line.textContent = product || '';
    [].forEach.call(form.querySelectorAll('.bad'), function (e) { e.classList.remove('bad'); });
    dlg.showModal();
    setTimeout(function () { form.name.focus(); }, 50);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-order]');
    if (b) { e.preventDefault(); open(b.getAttribute('data-order')); }
  });
  dlg.querySelector('.x').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  form.phone.addEventListener('focus', function () { if (!form.phone.value) form.phone.value = '+7 '; });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var digits = form.phone.value.replace(/\D/g, '');
    if (!form.name.value.trim()) { form.name.classList.add('bad'); err.textContent = t('name'); return; }
    if (!/^[78]?\d{10}$/.test(digits)) { form.phone.classList.add('bad'); err.textContent = t('phone'); return; }
    btn.disabled = true; btn.textContent = t('sending');
    fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: form.name.value, phone: form.phone.value, comment: form.comment.value, product: form.product.value, website: form.website.value
    }) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) {
        if (!r.ok) { err.textContent = r.j.error || t('net'); if (r.j.field && form[r.j.field]) form[r.j.field].classList.add('bad'); return; }
        form.hidden = true; done.hidden = false; form.reset();
      })
      .catch(function () { err.textContent = t('net'); })
      .then(function () { btn.disabled = false; btn.textContent = t('send'); });
  });
  form.addEventListener('input', function (e) { e.target.classList.remove('bad'); });
})();
