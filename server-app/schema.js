'use strict';
// Описание разделов админки и таблиц базы данных.
// type: list — таблица со строками (товары, отзывы...), settings — набор отдельных полей (контакты, тексты).
// Поля: string (строка), text (абзац), image (фото), boolean (галочка).

const SECTIONS = [
  {
    key: 'products', label: 'Товары (Новинки)', icon: '🛍', type: 'list', item: 'Товар',
    summary: ['name_ru', 'price'],
    fields: [
      { name: 'name_ru', label: 'Название (на русском)', type: 'string', required: true },
      { name: 'name_kk', label: 'Атауы (қазақша)', type: 'string', hint: 'Если пусто, на казахской версии будет русское название.' },
      { name: 'price', label: 'Цена, ₸', type: 'string', hint: 'Только число, например: 14 500. Пусто — «Цену уточняйте в WhatsApp».' },
      { name: 'sizes', label: 'Рост', type: 'string', hint: 'Например: 110–140 см. Можно оставить пустым.' },
      { name: 'image', label: 'Фото товара', type: 'image', hint: 'Лучше вертикальное фото.' },
      { name: 'show', label: 'Показывать на сайте', type: 'boolean', default: true },
    ],
  },
  {
    key: 'categories', label: 'Разделы каталога', icon: '🗂', type: 'list', item: 'Раздел',
    summary: ['name_ru'],
    fields: [
      { name: 'name_ru', label: 'Название раздела (на русском)', type: 'string', required: true },
      { name: 'name_kk', label: 'Бөлім атауы (қазақша)', type: 'string' },
      { name: 'image', label: 'Фото раздела', type: 'image', hint: 'Если фото нет, на сайте будет «Фото скоро».' },
      { name: 'show', label: 'Показывать на сайте', type: 'boolean', default: true },
    ],
  },
  {
    key: 'ages', label: 'Плитки по росту', icon: '📏', type: 'list', item: 'Плитка',
    summary: ['name_ru', 'sizes'],
    fields: [
      { name: 'name_ru', label: 'Для кого (на русском)', type: 'string', required: true },
      { name: 'name_kk', label: 'Кімге (қазақша)', type: 'string' },
      { name: 'sizes', label: 'Рост, см', type: 'string', hint: 'Только цифры, например: 90–130.' },
      { name: 'image', label: 'Фото плитки', type: 'image', hint: 'Лучше горизонтальное. Пусто — цветная плитка.' },
    ],
  },
  {
    key: 'gallery', label: 'Фото в блоке Instagram', icon: '📸', type: 'list', item: 'Фото',
    summary: ['image'],
    fields: [{ name: 'image', label: 'Фото', type: 'image' }],
  },
  {
    key: 'reviews', label: 'Отзывы', icon: '⭐', type: 'list', item: 'Отзыв',
    summary: ['name', 'date_ru'],
    fields: [
      { name: 'name', label: 'Имя покупателя', type: 'string', required: true },
      { name: 'text', label: 'Текст отзыва', type: 'text', required: true },
      { name: 'date_ru', label: 'Дата (на русском)', type: 'string', hint: 'Например: 12 ноября 2026' },
      { name: 'date_kk', label: 'Күні (қазақша)', type: 'string', hint: 'Мысалы: 12 қараша 2026' },
    ],
  },
  {
    key: 'steps', label: 'Шаги «Как заказать»', icon: '🧭', type: 'list', item: 'Шаг',
    summary: ['title_ru'],
    fields: [
      { name: 'title_ru', label: 'Шаг (на русском)', type: 'string', required: true },
      { name: 'title_kk', label: 'Қадам (қазақша)', type: 'string' },
      { name: 'text_ru', label: 'Пояснение (на русском)', type: 'text' },
      { name: 'text_kk', label: 'Түсініктеме (қазақша)', type: 'text' },
    ],
  },
  {
    key: 'contacts', label: 'Телефон, адрес, часы', icon: '📞', type: 'settings',
    fields: [
      { name: 'phone', label: 'Телефон (как показывать на сайте)', type: 'string', hint: 'Например: +7 702 440 50 09' },
      { name: 'whatsapp', label: 'Номер для кнопок WhatsApp', type: 'string', pattern: '^7\\d{10}$', patternMsg: '11 цифр, начиная с 7, без пробелов и знака +', hint: 'Только цифры, начиная с 7. Например: 77024405009' },
      { name: 'hours', label: 'Часы работы', type: 'string', hint: 'Например: 10:00–20:00' },
      { name: 'address_ru', label: 'Адрес полностью (на русском)', type: 'string' },
      { name: 'address_kk', label: 'Толық мекенжай (қазақша)', type: 'string' },
      { name: 'address_short_ru', label: 'Адрес коротко для верха сайта (на русском)', type: 'string', hint: 'Например: Женис, 26А' },
      { name: 'address_short_kk', label: 'Қысқа мекенжай (қазақша)', type: 'string' },
      { name: 'delivery_ru', label: 'Доставка (на русском)', type: 'string' },
      { name: 'delivery_kk', label: 'Жеткізу (қазақша)', type: 'string' },
      { name: 'instagram', label: 'Instagram (без @)', type: 'string' },
      { name: 'twogis_url', label: 'Ссылка на магазин в 2ГИС', type: 'string' },
      { name: 'rating', label: 'Рейтинг в 2ГИС', type: 'string', hint: 'Например: 4,7' },
      { name: 'ratings_count', label: 'Сколько оценок в 2ГИС', type: 'string' },
      { name: 'reviews_count', label: 'Сколько отзывов в 2ГИС', type: 'string' },
    ],
  },
  {
    key: 'texts', label: 'Тексты и главное фото', icon: '✏️', type: 'settings',
    fields: [
      { name: 'hero_image', label: 'Главное фото (вверху сайта)', type: 'image' },
      { name: 'hero_badge_ru', label: 'Надпись над заголовком (на русском)', type: 'string' },
      { name: 'hero_badge_kk', label: 'Тақырып үстіндегі жазу (қазақша)', type: 'string' },
      { name: 'hero_title_ru', label: 'Главный заголовок (на русском)', type: 'string' },
      { name: 'hero_title_kk', label: 'Басты тақырып (қазақша)', type: 'string' },
      { name: 'hero_text_ru', label: 'Текст под заголовком (на русском)', type: 'text' },
      { name: 'hero_text_kk', label: 'Тақырып астындағы мәтін (қазақша)', type: 'text' },
      { name: 'catalog_text_ru', label: 'Подпись под «Каталог» (на русском)', type: 'string' },
      { name: 'catalog_text_kk', label: '«Каталог» астындағы жазу (қазақша)', type: 'string' },
      { name: 'instagram_text_ru', label: 'Подпись к блоку Instagram (на русском)', type: 'string' },
      { name: 'instagram_text_kk', label: 'Instagram блогының жазуы (қазақша)', type: 'string' },
      { name: 'store_photo', label: 'Фото магазина (в блоке «Контакты»)', type: 'image' },
    ],
  },
];

// Уровни доступа. sections: '*' — все разделы контента.
const ROLES = {
  owner: { label: 'Владелец', desc: 'Всё: контент, сотрудники, журнал действий', sections: '*', users: true, log: true },
  admin: { label: 'Администратор', desc: 'Весь контент сайта, журнал действий', sections: '*', users: false, log: true },
  manager: { label: 'Менеджер', desc: 'Только товары, разделы каталога и фото', sections: ['products', 'categories', 'gallery'], users: false, log: false },
};

function canEdit(role, key) {
  const r = ROLES[role];
  if (!r) return false;
  return r.sections === '*' || r.sections.includes(key);
}

module.exports = { SECTIONS, ROLES, canEdit, byKey: Object.fromEntries(SECTIONS.map(s => [s.key, s])) };
