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

async function fetchTwogis(url, fetcher, { log } = {}) {
  try {
    const res = await fetcher.get(url, { retries: 1 });
    let html = res.html();
    // 2ГИС встречает JS-челленджем /museum — пробуем браузерный бустер
    if ((res.finalUrl.includes('/museum') || html.length < 60000) && (await browserAvailable())) {
      log?.('2ГИС: пробую браузерный бустер…');
      const boosted = await boostFetch(url, { log });
      if (boosted) html = boosted;
    }
    // Страница после бустера всё ещё капча/museum — честно помечаем блокировкой
    if (/captcha\.2gis|2GIS Captcha|ddos-guard|checking your browser/i.test(html)) {
      return { status: 'blocked', note: '2ГИС требует прохождения капчи даже в браузере. Добавьте сайт или Instagram компании — из них данных больше.', facts: {}, images: [], text: '' };
    }
    const page = extractPage(html, res.finalUrl);
    const byKey = (key) => {
      const out = [];
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,300})"`, 'g');
      for (const m of html.matchAll(re)) out.push(m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"'));
      return [...new Set(out)].slice(0, 6);
    };
    const facts = {
      name: page.meta['og:title']?.split('—')[0]?.trim() || byKey('name')[0] || null,
      address: byKey('address_name')[0] || byKey('address')[0] || null,
      rating: byKey('rating')[0] || null,
      schedule: byKey('work_time')[0] || byKey('schedule')[0] || null,
      description: page.description,
    };
    const photoUrls = [...new Set([
      ...html.matchAll(/https:\/\/file\.tmgis\.ru\/[A-Za-z0-9_/.-]+/g),
      ...html.matchAll(/https:\/\/file\.2gis\.ru\/[A-Za-z0-9_/.-]+/g),
    ].map((m) => m[0]))].slice(0, 14);
    const images = [
      ...(page.ogImage ? [{ url: page.ogImage, from: 'twogis', role: 'photo', caption: 'Обложка карточки' }] : []),
      ...photoUrls.map((u) => ({ url: u, from: 'twogis', role: 'photo', caption: null })),
    ];
    const text = [
      `Карточка 2ГИС: ${facts.name || ''}`,
      facts.address ? `Адрес: ${facts.address}` : '',
      facts.rating ? `Рейтинг: ${facts.rating}` : '',
      facts.schedule ? `График: ${facts.schedule}` : '',
      page.description || '',
    ].filter(Boolean).join('\n');
    return { status: facts.name ? 'ok' : 'partial', note: facts.name ? 'Карточка организации получена' : 'Страница получена, но данные ограничены', facts, images, text, name: facts.name };
  } catch (err) {
    return { status: 'failed', note: `Не удалось загрузить страницу 2ГИС: ${err.message}`, facts: {}, images: [], text: '' };
  }
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
