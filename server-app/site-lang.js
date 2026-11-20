(function () {
  var root = document.documentElement;
  var texts = [].slice.call(document.querySelectorAll('[data-kk]'));
  var alts = [].slice.call(document.querySelectorAll('[data-kk-alt]'));
  var labels = [].slice.call(document.querySelectorAll('[data-kk-label]'));
  texts.forEach(function (e) { e.setAttribute('data-ru', e.textContent); });
  alts.forEach(function (e) { e.setAttribute('data-ru-alt', e.getAttribute('alt') || ''); });
  labels.forEach(function (e) { e.setAttribute('data-ru-label', e.getAttribute('aria-label') || ''); });
  var ruTitle = document.title, kkTitle = root.getAttribute('data-kk-title');
  function setLang(l) {
    var kk = l === 'kk';
    texts.forEach(function (e) { e.textContent = e.getAttribute(kk ? 'data-kk' : 'data-ru'); });
    alts.forEach(function (e) { e.setAttribute('alt', e.getAttribute(kk ? 'data-kk-alt' : 'data-ru-alt')); });
    labels.forEach(function (e) { e.setAttribute('aria-label', e.getAttribute(kk ? 'data-kk-label' : 'data-ru-label')); });
    root.lang = kk ? 'kk' : 'ru';
    document.title = kk ? kkTitle : ruTitle;
    [].forEach.call(document.querySelectorAll('.lang-switch button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-lang') === l ? 'true' : 'false');
    });
    try { localStorage.setItem('kit-lang', l); } catch (e) {}
  }
  [].forEach.call(document.querySelectorAll('.lang-switch button'), function (b) {
    b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); });
  });
  var q = (location.search.match(/[?&]lang=(ru|kk)/) || [])[1], saved = null;
  try { saved = localStorage.getItem('kit-lang'); } catch (e) {}
  var start = q || saved || ((navigator.language || '').toLowerCase().indexOf('kk') === 0 ? 'kk' : 'ru');
  if (start === 'kk') setLang('kk');
})();
