'use strict';
// Публичный сайт «Кит»: собирается из базы данных при каждом сохранении в админке.
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, 'site.css'), 'utf8');
const LANG_JS = fs.readFileSync(path.join(__dirname, 'site-lang.js'), 'utf8');
const ORDER_JS = fs.readFileSync(path.join(__dirname, 'site-order.js'), 'utf8');

const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const or = (a, b) => (a !== undefined && a !== null && String(a) !== '' ? a : b);
const has = v => v !== undefined && v !== null && String(v) !== '';

const ICON_PIN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"></path><circle cx="12" cy="9.5" r="2.5"></circle></svg>';
const ICON_STAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#E8A317" stroke="#E8A317" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"></path></svg>';

function render(d, opts = {}) {
  const c = d.contacts, t = d.texts;
  const base = opts.baseUrl || '';
  const wa = 'https://wa.me/' + c.whatsapp;
  const ig = 'https://instagram.com/' + c.instagram;
  const year = new Date().getFullYear();

  const ages = d.ages.map((a, i) => {
    const photo = has(a.image);
    const style = photo ? ` style="background-image:linear-gradient(180deg,rgba(15,42,64,0) 45%,rgba(15,42,64,.78) 100%),url('${esc(a.image)}')"` : '';
    return `<a href="#new" class="age age-${i % 3}${photo ? ' age-photo' : ''}"${style}><b data-kk="${esc(or(a.name_kk, a.name_ru))}">${esc(a.name_ru)}</b><span data-kk="бойы ${esc(a.sizes)} см →">рост ${esc(a.sizes)} см →</span></a>`;
  }).join('\n');

  const cats = d.categories.filter(x => x.show).map(cat => `<a href="#new" class="cat">
${has(cat.image)
    ? `<img src="${esc(cat.image)}" alt="${esc(cat.name_ru)}" data-kk-alt="${esc(or(cat.name_kk, cat.name_ru))}" loading="lazy">`
    : '<div class="ph" data-kk="Фото жақында">Фото скоро</div>'}
<div class="cat-name"><span data-kk="${esc(or(cat.name_kk, cat.name_ru))}">${esc(cat.name_ru)}</span><span class="muted" aria-hidden="true">→</span></div>
</a>`).join('\n');

  const prods = d.products.filter(x => x.show).map(p => {
    return `<div class="prod">
${has(p.image)
    ? `<img src="${esc(p.image)}" alt="${esc(p.name_ru)}" data-kk-alt="${esc(or(p.name_kk, p.name_ru))}" loading="lazy">`
    : '<div class="ph" data-kk="Фото жақында">Фото скоро</div>'}
<div class="prod-name" data-kk="${esc(or(p.name_kk, p.name_ru))}">${esc(p.name_ru)}</div>
${has(p.sizes) ? `<div class="muted" style="font-size:14px" data-kk="Бойы: ${esc(p.sizes)}">Рост: ${esc(p.sizes)}</div>` : ''}
<div class="prod-row">
${has(p.price)
    ? `<span class="price">${esc(p.price)} ₸</span>`
    : '<span class="price-ask" data-kk="Бағасын WhatsApp-та сұраңыз">Цену уточняйте в WhatsApp</span>'}
<button type="button" class="order-btn" data-order="${esc(p.name_ru + (p.sizes ? ' (рост ' + p.sizes + ')' : ''))}" data-kk="Тапсырыс беру">Заказать</button>
</div>
</div>`;
  }).join('\n');

  const steps = d.steps.map((s, i) => `<div class="step">
<i class="dot-${i % 4}">${i + 1}</i>
<b data-kk="${esc(or(s.title_kk, s.title_ru))}">${esc(s.title_ru)}</b>
<span data-kk="${esc(or(s.text_kk, s.text_ru))}">${esc(s.text_ru)}</span>
</div>`).join('\n');

  const reviews = d.reviews.map(r => `<figure class="rev">
<blockquote>«${esc(r.text)}»</blockquote>
<figcaption>
<span class="ava" aria-hidden="true">${esc(String(r.name || '').slice(0, 1).toUpperCase())}</span>
<span style="display:flex;flex-direction:column;gap:2px"><b>${esc(r.name)}</b><span class="muted" style="font-size:14px" data-kk="${esc(or(r.date_kk, r.date_ru))} · 2ГИС-тегі пікір">${esc(r.date_ru)} · отзыв в 2ГИС</span></span>
</figcaption>
</figure>`).join('\n');

  const gallery = d.gallery.filter(g => has(g.image)).map(g =>
    `<a href="${esc(ig)}" class="ig"><img src="${esc(g.image)}" alt="Фото из Instagram магазина «Кит»" data-kk-alt="«Кит» дүкенінің Instagram-дағы суреті" loading="lazy"></a>`).join('\n');

  const waIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z"></path></svg>';

  return `<!doctype html>
<html lang="ru" data-kk-title="Кит — балалар мен жасөспірімдер киімі, Астана">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Кит — детская и подростковая одежда в Астане</title>
<meta name="description" content="Магазин детской и подростковой одежды «Кит» в Астане, ${esc(c.address_short_ru)}. Доставка по Казахстану, подбор размера в WhatsApp.">
<meta property="og:title" content="Кит — детская и подростковая одежда в Астане">
<meta property="og:description" content="${esc(c.address_short_ru)} · ${esc(c.hours)} · Доставка по Казахстану">
${has(t.hero_image) ? `<meta property="og:image" content="${esc(base + t.hero_image)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&amp;family=Manrope:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
${CSS}</style>
</head>
<body>

<header>
<div class="wrap top">
<a href="#top" class="logo">
<span class="logo-mark"><svg width="34" height="34" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 29c0-8 8.5-14 19-14s16 6 16 12c0 3 2.5 4 5 2.5-.5 4.5-4 7.5-9 7.5H16C9.5 37 5 33.5 5 29z" fill="#FFFFFF"></path><circle cx="15" cy="26" r="2" fill="#8ED0E8"></circle><path d="M24 15c0-4-3-6.5-6-7.5M24 15c0-4 3-6.5 6-7.5" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round"></path></svg></span>
<span><b>Кит</b><small>балалар киімі · детская одежда</small></span>
</a>
<nav aria-label="Основное меню" data-kk-label="Негізгі мәзір">
<a href="#catalog" data-kk="Каталог">Каталог</a>
<a href="#new" data-kk="Жаңа түсімдер">Новинки</a>
<a href="#reviews" data-kk="Пікірлер">Отзывы</a>
<a href="#order" data-kk="Жеткізу">Доставка</a>
<a href="#contacts" data-kk="Байланыс">Контакты</a>
</nav>
<div class="top-right">
<div class="lang-switch" role="group" aria-label="Язык сайта" data-kk-label="Сайт тілі">
<button type="button" data-lang="ru" aria-pressed="true">РУС</button><button type="button" data-lang="kk" aria-pressed="false">ҚАЗ</button>
</div>
<a href="${esc(wa)}" class="btn btn-main" style="font-size:15px;padding:12px 20px">
${waIcon}
WhatsApp</a>
</div>
</div>
</header>

<main>
<section id="top" class="wrap hero">
<div class="hero-text">
<span class="badge" data-kk="${esc(or(t.hero_badge_kk, t.hero_badge_ru))}">${esc(t.hero_badge_ru)}</span>
<h1 class="h" data-kk="${esc(or(t.hero_title_kk, t.hero_title_ru))}">${esc(t.hero_title_ru)}</h1>
<p data-kk="${esc(or(t.hero_text_kk, t.hero_text_ru))}">${esc(t.hero_text_ru)}</p>
<div class="grid" style="gap:12px">
<a href="#catalog" class="btn btn-main" style="font-size:17px;padding:16px 28px" data-kk="Каталогты қарау">Смотреть каталог</a>
<a href="${esc(wa)}" class="btn btn-line" style="font-size:17px;padding:16px 28px" data-kk="Өлшем таңдау">Подобрать размер</a>
</div>
<div class="facts">
<span>${ICON_PIN}<span data-kk="${esc(or(c.address_short_kk, c.address_short_ru) + ' · ' + c.hours)}">${esc(c.address_short_ru + ' · ' + c.hours)}</span></span>
<span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"></path><path d="M3 8l9 5 9-5M12 13v8"></path></svg><span data-kk="Қазақстан бойынша жеткізу">Доставка по Казахстану</span></span>
</div>
</div>
<div class="hero-img">
${has(t.hero_image) ? `<img src="${esc(t.hero_image)}" alt="Дети в одежде из магазина «Кит»" data-kk-alt="«Кит» дүкенінің киіміндегі балалар">` : ''}
</div>
</section>

<section id="catalog" class="wrap">
<h2 class="h" style="margin-bottom:12px" data-kk="Каталог">Каталог</h2>
<p class="muted" style="margin:0 0 32px;font-size:18px" data-kk="${esc(or(t.catalog_text_kk, t.catalog_text_ru))}">${esc(t.catalog_text_ru)}</p>
<div class="grid" style="margin-bottom:20px">
${ages}
</div>
<div class="grid">
${cats}
</div>
</section>

<section id="new" class="wrap">
<div class="head">
<h2 class="h" data-kk="Жаңа түсімдер">Новинки</h2>
<a href="${esc(ig)}" style="font-weight:700" data-kk="Барлық жаңа түсімдер Instagram-да →">Все новинки в Instagram →</a>
</div>
<div class="grid">
${prods}
</div>
</section>

<section id="order" class="wrap">
<div class="steps">
<h2 class="h" data-kk="Қалай тапсырыс беруге болады">Как заказать</h2>
<div class="grid" style="gap:24px">
${steps}
</div>
<div class="grid" style="gap:12px">
<button type="button" data-order="" class="btn" style="background:#fff;color:var(--ink);font-size:17px;padding:16px 28px" data-kk="Өтінім қалдыру">Оставить заявку</button>
<a href="${esc(wa)}" class="btn" style="background:transparent;color:#fff;border:2px solid #fff;font-size:17px;padding:14px 26px" data-kk="WhatsApp-қа жазу">Написать в WhatsApp</a>
</div>
</div>
</section>

<section id="reviews" class="wrap">
<div class="head">
<div style="display:flex;flex-direction:column;gap:12px">
<h2 class="h" data-kk="Сатып алушылардың пікірлері">Отзывы покупателей</h2>
<span class="muted" style="display:inline-flex;align-items:center;gap:10px;font-size:18px">
<span class="rating">${ICON_STAR}${esc(c.rating)}</span>
<span data-kk="2ГИС-те ${esc(c.ratings_count)} баға және ${esc(c.reviews_count)} пікір">${esc(c.ratings_count)} оценок и ${esc(c.reviews_count)} отзывов в 2ГИС</span>
</span>
</div>
<a href="${esc(c.twogis_url)}/tab/reviews" style="font-weight:700" data-kk="Барлық пікірлер 2ГИС-те →">Все отзывы в 2ГИС →</a>
</div>
<div class="grid">
${reviews}
</div>
</section>

<section class="wrap">
<div class="head">
<div style="display:flex;flex-direction:column;gap:8px">
<h2 class="h" data-kk="Біз Instagram-дамыз">Мы в Instagram</h2>
<span class="muted" style="font-size:18px" data-kk="${esc(or(t.instagram_text_kk, t.instagram_text_ru))}">${esc(t.instagram_text_ru)}</span>
</div>
<a href="${esc(ig)}" class="btn btn-dark">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="0.8" fill="currentColor"></circle></svg>
@${esc(c.instagram)}</a>
</div>
<div class="grid" style="gap:12px">
${gallery}
</div>
</section>

<section id="contacts" class="wrap contacts">
<div class="c-left">
<h2 class="h" data-kk="Байланыс">Контакты</h2>
<div class="c-item"><small data-kk="Дүкен мекенжайы">Адрес магазина</small><span data-kk="${esc(or(c.address_kk, c.address_ru))}">${esc(c.address_ru)}</span></div>
<div class="c-item"><small data-kk="Жұмыс уақыты">Часы работы</small><span>${esc(c.hours)}</span></div>
<div class="c-item"><small>WhatsApp</small><a href="${esc(wa)}">${esc(c.phone)}</a></div>
<div class="c-item"><small data-kk="Жеткізу">Доставка</small><span data-kk="${esc(or(c.delivery_kk, c.delivery_ru))}">${esc(c.delivery_ru)}</span></div>
<div class="grid" style="gap:12px">
<a href="${esc(wa)}" class="btn btn-main" data-kk="WhatsApp-қа жазу">Написать в WhatsApp</a>
<a href="${esc(ig)}" class="btn btn-line">Instagram</a>
</div>
</div>
<div class="map">
${has(t.store_photo) ? `<img src="${esc(t.store_photo)}" alt="Наш магазин" data-kk-alt="Біздің дүкен" loading="lazy">` : ''}
<div class="map-body">
<span class="pin"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"></path><circle cx="12" cy="9.5" r="2.5"></circle></svg></span>
<b class="h" style="font-size:22px;color:var(--ink)" data-kk="Біз 2ГИС-теміз">Мы на 2ГИС</b>
<span style="font-weight:600" data-kk="«Кит» балалар киімі дүкені · ${esc(or(c.address_kk, c.address_ru))}">Магазин детской одежды «Кит» · ${esc(c.address_ru)}</span>
<span class="rating">${ICON_STAR}<span data-kk="${esc(c.rating)} · ${esc(c.ratings_count)} баға">${esc(c.rating)} · ${esc(c.ratings_count)} оценок</span></span>
<a href="${esc(c.twogis_url)}" class="btn btn-main" data-kk="2ГИС-те ашып, бағыт құру">Открыть в 2ГИС и построить маршрут</a>
</div>
</div>
</section>
</main>

<footer>
<div class="wrap foot">
<span data-kk="© ${year} «Кит» — балалар мен жасөспірімдер киімі, Астана">© ${year} «Кит» — детская и подростковая одежда, Астана</span>
<span style="display:flex;gap:20px"><a href="${esc(wa)}">WhatsApp</a><a href="${esc(ig)}">Instagram</a></span>
</div>
</footer>

<dialog class="dlg" id="order-dlg" aria-labelledby="order-title">
<button type="button" class="x" aria-label="Закрыть" data-kk-label="Жабу">×</button>
<form novalidate>
<h3 id="order-title" data-kk="Өтінім қалдыру">Оставить заявку</h3>
<div class="prod-line" hidden></div>
<span class="muted" style="font-size:15px" data-kk="Біз сізге хабарласып, өлшемін таңдауға көмектесеміз.">Мы перезвоним или напишем в WhatsApp и поможем с размером.</span>
<input type="hidden" name="product">
<label><span data-kk="Атыңыз">Ваше имя</span><input name="name" autocomplete="name" maxlength="60" required></label>
<label><span data-kk="Телефон (WhatsApp)">Телефон (WhatsApp)</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required></label>
<label><span data-kk="Баланың бойы немесе пікір (міндетті емес)">Рост ребёнка или комментарий (необязательно)</span><textarea name="comment" rows="2" maxlength="500"></textarea></label>
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<div class="err" role="alert"></div>
<button type="submit" class="btn btn-main" data-kk="Өтінім жіберу">Отправить заявку</button>
<div class="alt"><span data-kk="немесе">или</span> <a href="${esc(wa)}" data-kk="WhatsApp-қа жазыңыз">напишите в WhatsApp</a></div>
</form>
<div class="done" hidden>
<div class="ok">✅</div>
<h3 style="padding:0" data-kk="Рақмет! Өтінім жіберілді">Спасибо! Заявка отправлена</h3>
<span class="muted" data-kk="Жақын арада хабарласамыз.">Мы скоро свяжемся с вами.</span>
<button type="button" class="btn btn-line" onclick="this.closest('dialog').close()" data-kk="Жабу">Закрыть</button>
</div>
</dialog>

<script>
${LANG_JS}
${ORDER_JS}</script>
</body>
</html>
`;
}

module.exports = { render, esc };
