// Скачивание медиа: логотип + фотографии. Фильтрация по размеру, дедупликация по хэшу.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEDIA_DIR } from './db.js';
import { imageSize, extFor } from './imagesize.js';

// Собирает финальный список кандидатов: план ИИ → логотипы → фото по приоритету источника
export function buildDownloadPlan(digestImages, mediaPlan, maxImages) {
  const planMap = new Map();
  for (const p of mediaPlan || []) {
    const img = digestImages.find((i) => i.index === p.index);
    if (!img || planMap.has(img.url)) continue;
    planMap.set(img.url, { ...img, use: p.use, why: p.why });
  }
  const rest = digestImages
    .filter((i) => !planMap.has(i.url))
    .sort((a, b) => rank(b) - rank(a));
  const plan = [...planMap.values()];
  for (const img of rest) {
    if (plan.length >= maxImages + 4) break; // небольшой запас на отбраковку
    plan.push(img);
  }
  return plan;
}

function rank(img) {
  let r = 0;
  if (img.role === 'logo') r += 100;
  if (img.from === 'instagram') r += 50;
  if (img.from === 'website') r += 30;
  if (img.from === 'twogis') r += 20;
  if (img.from === 'yandex') r += 15;
  if (img.role === 'icon') r -= 40;
  if (img.caption) r += 5;
  return r;
}

export async function downloadMedia({ companyId, plan, fetcher, maxImages, logoWanted, log }) {
  const dir = path.join(MEDIA_DIR, String(companyId));
  fs.mkdirSync(dir, { recursive: true });
  const seenHashes = new Set();
  const saved = [];
  let logoSaved = false;

  for (const item of plan) {
    if (saved.length >= maxImages + (logoWanted && !logoSaved ? 1 : 0)) break;
    if (logoSaved && item.use === 'logo') continue;
    try {
      const res = await fetcher.get(item.url, { maxBytes: 15 * 1024 * 1024, timeoutMs: 25000, retries: 1 });
      const buf = res.buffer;
      if (buf.length < 2048) continue; // пиксели-маячки и прочий мусор
      const info = imageSize(buf);
      if (!info || !info.width || !info.height) continue;

      const isLogo = !logoSaved && (item.use === 'logo' || item.role === 'logo');
      if (!isLogo) {
        // фото: слишком маленькие и вытянутые баннеры отбрасываем
        if (info.width < 400 || info.height < 260) continue;
        if (info.width / info.height > 3.5 || info.height / info.width > 3.5) continue;
      } else if (info.width < 64 || info.height < 64) {
        continue;
      }

      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      const kind = isLogo ? 'logo' : 'photo';
      const file = isLogo ? `logo.${extFor(info.type)}` : `photo-${String(saved.filter((s) => s.kind === 'photo').length + 1).padStart(2, '0')}.${extFor(info.type)}`;
      fs.writeFileSync(path.join(dir, file), buf);
      if (isLogo) logoSaved = true;
      const rec = {
        kind, url: item.url, file, width: info.width, height: info.height,
        bytes: buf.length, hash, caption: item.caption || item.why || null, source_type: item.from,
      };
      saved.push(rec);
      log?.(`Сохранено: ${file} (${info.width}×${info.height}, ${(buf.length / 1024).toFixed(0)} КБ)`);
    } catch (err) {
      if (String(err.message) === 'cancelled') throw err;
      log?.(`Пропущено изображение: ${err.message}`);
    }
  }
  return { saved, logoSaved, dir };
}
