'use strict';
// Сохранение фото (из админки и из Telegram-бота) в папку images.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IMAGES_DIR } = require('./db');

function kindOf(buf) {
  const m = buf.subarray(0, 12);
  if (m[0] === 0xff && m[1] === 0xd8) return 'jpg';
  if (m.toString('hex', 0, 4) === '89504e47') return 'png';
  if (m.toString('ascii', 0, 4) === 'RIFF' && m.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function saveImageBuffer(buf) {
  const ext = kindOf(buf);
  if (!ext) throw Object.assign(new Error('Файл не похож на картинку (нужен JPG, PNG или WEBP)'), { code: 400 });
  if (buf.length > 10 * 1024 * 1024) throw Object.assign(new Error('Картинка больше 10 МБ'), { code: 413 });
  const name = 'u-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(5).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  return '/images/' + name;
}

function saveDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Нужна картинка JPG, PNG или WEBP'), { code: 400 });
  return saveImageBuffer(Buffer.from(m[2], 'base64'));
}

function readImage(webPath) {
  const m = /^\/images\/([a-zA-Z0-9._-]+)$/.exec(String(webPath || ''));
  if (!m) return null;
  try { return fs.readFileSync(path.join(IMAGES_DIR, m[1])); } catch { return null; }
}

module.exports = { saveImageBuffer, saveDataUrl, readImage, kindOf };
