// Адаптеры источников. Каждый возвращает единый формат:
// { type, status: 'ok'|'partial'|'blocked'|'failed', note, facts, images, text, name }

import { extractPage, pickSubpages } from './extract.js';
import { boostFetch, browserAvailable } from './browser.js';

const IG_APP_ID = '936619743392459'; // публичный web-app-id Instagram

// Страница похожа на JS-заглушку/стену, если в ней почти нет разметки
const looksLikeShell = (html, page) => html.length < 60000 && !page.title && !page.meta['og:title'];

export function detectSource(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'website'; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('2gis.ru') || host.endsWith('2gis.com')) return 'twogis';
  if (/^maps\.yandex\.(ru|com)$/.test(host)) return 'yandex';
  return 'website';
}

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { const u = new URL(s); u.hash = ''; return u.toString(); } catch { return null; }
}

// ---------- Instagram ----------

async function fetchInstagram(url, fetcher, { log } = {}) {
  const m = /instagram\.com\/([^/?#]+)/i.exec(url);
  const username = m?.[1] && !['p', 'reel', 'explore', 'stories', 'accounts'].includes(m[1]) ? m[1] : null;
  if (!username) return { status: 'failed', note: 'Не удалось определить имя профиля в ссылке' };

  // Основной путь: публичный endpoint профиля (без логина, отдаёт bio, аватар HD и последние посты)
  try {
    const res = await fetcher.get(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      { headers: { 'x-ig-app-id': IG_APP_ID, accept: 'application/json', referer: `https://www.instagram.com/${username}/` } }
    );
    const json = JSON.parse(res.html());
    const user = json?.data?.user;
    if (user) {
      const posts = (user.edge_owner_to_timeline_media?.edges || []).map((e) => e.node).filter(Boolean);
      const images = [];
      if (user.profile_pic_url_hd || user.profile_pic_url) {
        images.push({ url: user.profile_pic_url_hd || user.profile_pic_url, from: 'instagram', role: 'logo', caption: 'Аватар профиля' });
      }
      for (const p of posts.slice(0, 18)) {
        const caption = p.edge_media_to_caption?.edges?.[0]?.node?.text || p.accessibility_caption || null;
        images.push({ url: p.display_url || p.thumbnail_src, from: 'instagram', role: 'photo', caption: cleanIg(caption) });
      }
      const facts = {
        name: user.full_name || username,
        username: `@${username}`,
        description: cleanIg(user.biography),
        category: user.category_name || null,
        followers: user.edge_followed_by?.count ?? null,
        externalUrl: user.external_url || null,
        isBusiness: !!user.is_business,
        publicEmail: user.business_email || null,
        publicPhone: user.public_phone_number ? `+${user.public_phone_number.country_code ?? '7'}${user.public_phone_number.number}` : null,
        postsCount: user.edge_owner_to_timeline_media?.count ?? posts.length,
      };
      const text = [
        `Профиль Instagram @${username}`,
        user.full_name, cleanIg(user.biography), user.category_name ? `Категория: ${user.category_name}` : '',
        `Подписчиков: ${facts.followers ?? 'н/д'}`,
        user.external_url ? `Сайт из профиля: ${user.external_url}` : '',
        ...posts.slice(0, 12).map((p, i) => {
          const cap = cleanIg(p.edge_media_to_caption?.edges?.[0]?.node?.text || p.accessibility_caption);
          return `Пост ${i + 1} (лайков ${(p.edge_liked_by?.count ?? p.edge_media_preview_like?.count) ?? 'н/д'}): ${cap}`;
        }),
      ].filter(Boolean).join('\n');
      return {
        status: posts.length || user.biography ? 'ok' : 'partial',
        note: posts.length ? `Профиль получен: ${posts.length} публикаций` : 'Профиль получен без публикаций',
        facts, images, text, name: facts.name,
      };
    }
  } catch (err) { /* ниже пробуем страницу профиля */ }

  // Фолбэк: обычная страница профиля и её og-теги
  try {
    const res = await fetcher.get(`https://www.instagram.com/${username}/`, { retries: 1 });
    let html = res.html();
    let page = extractPage(html, res.finalUrl);
    const description = () => page.meta['og:description'] || page.description;
    let images = [];
    if (page.ogImage) images.push({ url: page.ogImage, from: 'instagram', role: 'logo', caption: 'Аватар профиля' });
    // Instagram отдал JS-заглушку — пробуем браузерный бустер, если установлен
    if (!description() && !images.length && (await browserAvailable())) {
      log?.('Instagram: пробую браузерный бустер…');
      const boosted = await boostFetch(`https://www.instagram.com/${username}/`, { log });
      if (boosted) {
        page = extractPage(boosted, `https://www.instagram.com/${username}/`);
        images = [];
        if (page.ogImage) images.push({ url: page.ogImage, from: 'instagram', role: 'logo', caption: 'Аватар профиля' });
      }
    }
    // Instagram часто отдаёт JS-заглушку без данных — честно помечаем блокировкой
    if (!description() && !images.length) {
      return {
        status: 'blocked',
        note: 'Instagram отдал страницу без данных (требуется вход). Профиль недоступен для сбора без авторизации.',
        facts: {}, images: [], text: '',
      };
    }
    // og:title стены входа — просто «Instagram», реального имени там нет
    const ogTitle = page.meta['og:title'];
    const name = ogTitle && ogTitle.toLowerCase() !== 'instagram' ? ogTitle : `@${username}`;
    return {
      status: 'partial',
      note: 'Профиль получен через публичную страницу (ограниченные данные)',
      facts: { name, username: `@${username}`, description: description() },
      images, text: `Профиль Instagram @${username}\n${description() || ''}`, name,
    };
  } catch (err) {
    return { status: 'blocked', note: 'Instagram не отдал данные профиля (возможна авторизация или лимит). Данные недоступны.', facts: {}, images: [], text: '' };
  }
}

const cleanIg = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 600);

// ---------- 2ГИС ----------
// Схема сбора: фирма берётся из двух открытых API 2ГИС (фотогалерея и витрина товаров),
// а карточка (название, адрес, телефоны, рейтинг) — со страницы в headed-браузере,
// потому что серверным запросам 2ГИС отдаёт только JS-заглушку и капчу.

const TG_PHOTO_KEY = 'gYu1s9N1wP'; // публичный ключ фотосервиса 2ГИС (виден в запросах их веб-приложения)

function twogisFirmId(url) {
  const m = /2gis\.[a-z]+\/[^/]+\/firm\/(\d+)/i.exec(url);
  return m?.[1] || null;
}

async function twogisPhotos(firmId, fetcher, log) {
  try {
    const res = await fetcher.get(
      `https://api.photo.2gis.com/3.0/objects/${firmId}/albums/all/media?key=${TG_PHOTO_KEY}&page_size=40&locale=ru_RU&preview_size=1200x900`,
      { headers: { accept: 'application/json' }, retries: 1 }
    );
    const json = JSON.parse(res.html());
    const albums = Object.fromEntries((json.albums || []).map((a) => [a.id, a.count]));
    const images = [];
    for (const item of json.items || []) {
      const url = item.photo?.preview_urls?.['1200x900'] || item.photo?.url;
      if (!url) continue;
      images.push({
        url, from: 'twogis', role: 'photo',
        caption: [item.copyright?.title, item.photo?.width ? `${item.photo.width}×${item.photo.height}` : ''].filter(Boolean).join(' · ') || null,
      });
    }
    return { images, albums };
  } catch (err) {
    log?.(`Фото-API 2ГИС недоступен: ${err.message}`);
    return { images: [], albums: {} };
  }
}

async function twogisProducts(firmId, fetcher, log) {
  try {
    const res = await fetcher.get(
      `https://market-backend.api.2gis.ru/5.0/product/items_by_branch?branch_id=${firmId}&locale=ru_RU&page=1&page_size=50`,
      { headers: { accept: 'application/json', referer: 'https://2gis.ru/' }, retries: 1 }
    );
    const json = JSON.parse(res.html());
    const items = (json.result?.items || []).map((i) => {
      const p = i.product || {};
      const price = p.price?.value != null
        ? `${p.price.value}${p.price.currency || ' ₽'}${p.price.unit ? `/${p.price.unit}` : ''}`
        : (i.price?.value != null ? String(i.price.value) : null);
      return { name: p.name, description: (p.description || '').slice(0, 800), price };
    }).filter((p) => p.name);
    return { products: items, total: json.result?.total ?? items.length };
  } catch (err) {
    log?.(`Витрина товаров 2ГИС недоступна: ${err.message}`);
    return { products: [], total: 0 };
  }
}

function parseTwogisTitle(ogTitle) {
  // «ЭкоСтройИнвест, многопрофильная строительная компания на карте, Стройматериалы, Якутск — 2ГИС»
  const clean = ogTitle.replace(/\s*—\s*2ГИС\s*$/i, '');
  const parts = clean.split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts.shift() || null;
  const rubrics = parts.filter((p) => !/на карте/i.test(p));
  const city = parts.length > rubrics.length ? parts[parts.length - 1] : rubrics.pop() || null;
  return { name, rubrics, city };
}

async function fetchTwogis(url, fetcher, { log, headed = true } = {}) {
  const firmId = twogisFirmId(url);
  if (!firmId) {
    return { status: 'failed', note: 'Не удалось определить ID организации в ссылке 2ГИС (нужен вид 2gis.ru/город/firm/12345)', facts: {}, images: [], text: '' };
  }
  const city = /2gis\.[a-z]+\/([^/]+)\/firm\//i.exec(url)?.[1] || null;

  // 1. Карточка организации — только страница в настоящем браузере
  let card = { name: null, address: null, phones: [], rating: null, schedule: null, description: null, ogImage: null };
  let cardNote = 'карточка не получена';
  try {
    const res = await fetcher.get(url, { retries: 1 });
    let html = res.html();
    if (res.finalUrl.includes('/museum') || html.length < 60000) {
      log?.('2ГИС: открываю карточку в браузере (проходит проверку автоматически)…');
      const boosted = await boostFetch(url, { headed, log });
      if (boosted) html = boosted;
    }
    const page = extractPage(html, url);
    const byKey = (key) => {
      const out = [];
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,300})"`, 'g');
      for (const m of html.matchAll(re)) out.push(m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"'));
      return [...new Set(out)].slice(0, 4);
    };
    const title = parseTwogisTitle(page.meta['og:title'] || '');
    const ogDesc = page.meta['og:description'] || '';
    const ratingMatch = /Оценка\s+([\d.,]+)/i.exec(ogDesc);
    card = {
      name: title.name || byKey('name')[0],
      rubrics: title.rubrics,
      city: title.city || city,
      address: byKey('address_name')[0] || byKey('address')[0] || null,
      // tel-ссылки содержат только настоящие телефоны; регэксп по тексту ловит и мусор
      phones: page.phones.length ? page.phones.slice(0, 4) : page.textPhones.slice(0, 4),
      rating: ratingMatch ? `${ratingMatch[1]} (${(/(\d+)\s+отзыв/i.exec(ogDesc) || [])[1] || '?'} отзывов)` : null,
      photosCount: (/(\d+)\s+фото/i.exec(ogDesc) || [])[1] || null,
      schedule: byKey('work_time')[0] || null,
      description: ogDesc,
      ogImage: page.ogImage,
    };
    cardNote = 'карточка получена';
  } catch (err) {
    log?.(`Карточка 2ГИС: ${err.message}`);
  }

  // 2. Фотогалерея и витрина товаров — прямые API, работают без браузера
  log?.('2ГИС: запрашиваю фотогалерею и витрину товаров…');
  const [{ images: photoImages, albums }, { products, total: productsTotal }] = await Promise.all([
    twogisPhotos(firmId, fetcher, log),
    twogisProducts(firmId, fetcher, log),
  ]);

  const images = [...photoImages];
  if (card.ogImage && !card.ogImage.includes('beautyshare')) images.push({ url: card.ogImage, from: 'twogis', role: 'photo', caption: 'Обложка карточки' });

  const facts = {
    name: card.name,
    category: card.rubrics?.join(', ') || null,
    city: card.city,
    address: [card.city, card.address].filter(Boolean).join(', ') || card.address,
    phones: card.phones,
    rating: card.rating,
    schedule: card.schedule,
    description: null,
    products,
    photosTotal: Object.values(albums).reduce((a, b) => Math.max(a, b), 0) || card.photosCount,
  };

  const text = [
    `Карточка 2ГИС: ${facts.name || firmId}`,
    facts.category ? `Рубрики: ${facts.category}` : '',
    facts.address ? `Адрес: ${facts.address}` : '',
    facts.phones?.length ? `Телефоны: ${facts.phones.join(', ')}` : '',
    facts.rating ? `Рейтинг: ${facts.rating}` : '',
    facts.schedule ? `График: ${facts.schedule}` : '',
    `Фото в галерее: ${facts.photosTotal || 0}`,
    products.length ? `\nВитрина товаров 2ГИС (${productsTotal} позиций):` : '',
    ...products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}\n${p.description}`.trim()),
  ].filter(Boolean).join('\n');

  const hasCard = facts.name || facts.address || facts.phones?.length;
  const status = hasCard && images.length ? 'ok'
    : (hasCard || images.length || products.length) ? 'partial' : 'blocked';
  const note = status === 'ok'
    ? `Карточка получена · ${images.length} фото · ${products.length} товаров`
    : status === 'partial'
      ? `Данные ограничены: ${[hasCard ? '' : 'карточка не получена', images.length ? '' : 'фото не получены'].filter(Boolean).join(', ')} — проверьте доступность браузера`
      : '2ГИС не отдал данные. Проверьте ссылку или установите браузерный бустер в настройках.';

  return { status, note, facts, images, text, name: facts.name };
}

// ---------- Яндекс Карты ----------

async function fetchYandex(url, fetcher, { log } = {}) {
  try {
    const res = await fetcher.get(url, { retries: 1, headers: { accept: 'text/html,application/xhtml+xml' } });
    let html = res.html();
    let page = extractPage(html, res.finalUrl);
    // Яндекс любит капчу и JS-рендер — при подозрении пробуем бустер
    const walled = /captcha|smart-captcha/i.test(html) || looksLikeShell(html, page);
    if (walled && (await browserAvailable())) {
      log?.('Яндекс: пробую браузерный бустер…');
      const boosted = await boostFetch(url, { log });
      if (boosted) { html = boosted; page = extractPage(html, url); }
    }
    if (/captcha|smart-captcha/i.test(html)) {
      return { status: 'blocked', note: 'Яндекс показал капчу. Добавьте сайт или Instagram компании — из них данных больше.', facts: {}, images: [], text: '' };
    }
    // Яндекс отдаёт пустую заглушку подозрительным клиентам
    if (html.length < 1000) {
      return { status: 'blocked', note: 'Яндекс Maps отдал пустую страницу (антибот). Добавьте сайт или Instagram компании.', facts: {}, images: [], text: '' };
    }
    const orgs = page.jsonLd.orgs;
    const ld = orgs.find((o) => o.name) || {};
    const address = ld.address?.addressLocality && ld.address?.streetAddress
      ? `${ld.address.addressLocality}, ${ld.address.streetAddress}`
      : ld.address?.streetAddress || ld.address?.addressLocality || null;
    const photoUrls = [...new Set(html.match(/https:\/\/avatars\.mds\.yandex\.net\/[A-Za-z0-9_\-/.]+/g) || [])]
      .filter((u) => !/get-\w+-logo|badge/i.test(u)).slice(0, 14);
    const facts = {
      name: ld.name || page.meta['og:title'] || null,
      address,
      phones: (ld.telephone ? [ld.telephone] : []).concat(page.textPhones).slice(0, 4),
      schedule: ld.openingHours ? (Array.isArray(ld.openingHours) ? ld.openingHours.join('; ') : String(ld.openingHours)) : null,
      rating: ld.aggregateRating?.ratingValue ? `${ld.aggregateRating.ratingValue} (${ld.aggregateRating.reviewCount ?? '?'} отзывов)` : null,
      description: page.description,
    };
    const images = [
      ...(page.ogImage ? [{ url: page.ogImage, from: 'yandex', role: 'photo', caption: 'Обложка организации' }] : []),
      ...photoUrls.map((u) => ({ url: u, from: 'yandex', role: 'photo', caption: null })),
    ];
    const text = [
      `Организация на Яндекс Картах: ${facts.name || ''}`,
      facts.address ? `Адрес: ${facts.address}` : '',
      facts.phones?.length ? `Телефон: ${facts.phones.join(', ')}` : '',
      facts.schedule ? `График: ${facts.schedule}` : '',
      facts.rating ? `Рейтинг: ${facts.rating}` : '',
      page.description || '',
    ].filter(Boolean).join('\n');
    return { status: facts.name ? 'ok' : 'partial', note: facts.name ? 'Организация получена' : 'Страница получена, данные ограничены', facts, images, text, name: facts.name };
  } catch (err) {
    return { status: 'failed', note: `Не удалось загрузить страницу Яндекс Карт: ${err.message}`, facts: {}, images: [], text: '' };
  }
}

// ---------- Произвольный сайт (+ обход ключевых подстраниц) ----------

async function fetchWebsite(url, fetcher, { maxSubpages = 4, log } = {}) {
  try {
    const res = await fetcher.get(url, { retries: 1 });
    let html = res.html();
    let page = extractPage(html, res.finalUrl);
    // Современные сайты бывают SPA без серверного HTML — рендерим браузером
    if ((page.text?.length || 0) < 500 && (await browserAvailable())) {
      log?.('Сайт похож на JS-приложение, пробую браузерный бустер…');
      const boosted = await boostFetch(res.finalUrl, { log });
      if (boosted && boosted.length > html.length) { html = boosted; page = extractPage(html, res.finalUrl); }
    }
    const subpages = pickSubpages(page.internalLinks, res.finalUrl, maxSubpages);
    const pages = [{ url: res.finalUrl, page }];
    for (const sub of subpages) {
      try {
        log?.(`Обход подстраницы: ${sub}`);
        const subRes = await fetcher.get(sub, { retries: 0, maxBytes: 6 * 1024 * 1024 });
        pages.push({ url: sub, page: extractPage(subRes.html(), subRes.finalUrl) });
      } catch { /* подстраница недоступна — не критично */ }
    }

    const ldOrg = page.jsonLd.orgs.find((o) => o.name);
    const facts = {
      name: ldOrg?.name || page.meta['og:site_name'] || page.title?.split(/[|—–-]/)[0]?.trim() || null,
      description: ldOrg?.description || page.description,
      address: ldOrg?.address ? [ldOrg.address.addressLocality, ldOrg.address.streetAddress].filter(Boolean).join(', ') || null : null,
      phones: [...(ldOrg?.telephone ? [String(ldOrg.telephone)] : []), ...page.phones, ...page.textPhones].slice(0, 5),
      emails: [...page.emails, ...page.textEmails].slice(0, 4),
      socials: page.socials,
      hours: ldOrg?.openingHours ? (Array.isArray(ldOrg.openingHours) ? ldOrg.openingHours.join('; ') : String(ldOrg.openingHours)) : null,
      priceContexts: pages.flatMap((p) => p.page.priceContexts).slice(0, 20),
    };
    const images = [];
    for (const { url: u, caption } of pages.flatMap((p) => p.page.images)) {
      const isLogo = /logo/i.test(u) || /логотип|logo/i.test(caption || '');
      images.push({ url: u, from: 'website', role: isLogo ? 'logo' : 'photo', caption });
    }
    if (page.ogImage) images.unshift({ url: page.ogImage, from: 'website', role: 'photo', caption: 'Обложка сайта' });
    for (const icon of page.icons) images.push({ url: icon, from: 'website', role: 'icon', caption: 'Иконка сайта' });
    images.push(...page.logoCandidates.map((u) => ({ url: u, from: 'website', role: 'logo', caption: 'Логотип со страницы' })));

    const text = pages.map((p, i) => {
      const head = i === 0 ? `Главная страница ${p.url}` : `Страница ${p.url}`;
      const headings = p.page.headings.slice(0, 15).map((h) => `  • ${h}`).join('\n');
      return `${head}\n${headings}\n${p.page.text.slice(0, 6000)}`;
    }).join('\n\n');

    return {
      status: 'ok',
      note: `Сайт обработан${pages.length > 1 ? `, страниц: ${pages.length}` : ''}`,
      facts, images, text, name: facts.name, pages: pages.map((p) => p.url),
    };
  } catch (err) {
    return { status: 'failed', note: `Не удалось загрузить сайт: ${err.message}`, facts: {}, images: [], text: '' };
  }
}

export async function fetchSource(url, fetcher, opts = {}) {
  const type = detectSource(url);
  if (type === 'instagram') return { type, ...(await fetchInstagram(url, fetcher, opts)) };
  if (type === 'twogis') return { type, ...(await fetchTwogis(url, fetcher, opts)) };
  if (type === 'yandex') return { type, ...(await fetchYandex(url, fetcher, opts)) };
  return { type: 'website', ...(await fetchWebsite(url, fetcher, opts)) };
}
