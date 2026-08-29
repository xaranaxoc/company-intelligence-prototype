// Универсальный разбор HTML-страницы: мета-теги, JSON-LD, контакты, картинки, текст.

import * as cheerio from 'cheerio';

const SOCIAL_DOMAINS = {
  'instagram.com': 'Instagram', 'vk.com': 'ВКонтакте', 't.me': 'Telegram', 'telegram.me': 'Telegram',
  'wa.me': 'WhatsApp', 'api.whatsapp.com': 'WhatsApp', 'facebook.com': 'Facebook', 'ok.ru': 'Одноклассники',
  'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'tiktok.com': 'TikTok', 'rutube.ru': 'Rutube',
  'dzen.ru': 'Дзен', 'max.ru': 'MAX', 'x.com': 'X', 'twitter.com': 'X',
};

const PHONE_RE = /(?:\+7|8)[\s(-]{0,2}\d{3}[\s)-]{0,2}\d{3}[\s-]{0,2}\d{2}[\s-]{0,2}\d{2}\b/g;
const EMAIL_RE = /[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;
const PRICE_RE = /((?:от\s*)?\d[\d\u00A0\s]{0,9})\s*(?:₽|руб\.?|р\.)/gi;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

function resolve(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function srcsetLargest(srcset) {
  const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
  let best = null;
  let bestW = -1;
  for (const part of parts) {
    const [url, descriptor] = part.split(/\s+/);
    const w = descriptor?.endsWith('w') ? parseInt(descriptor) : parseInt(descriptor || '0') || 0;
    if (w >= bestW) { bestW = w; best = url; }
  }
  return best || parts[0]?.[0] || null;
}

function parseJsonLd($, base) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let data = JSON.parse($(el).contents().text());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) { stack.push(...node); continue; }
        if (node['@graph']) stack.push(...node['@graph']);
        blocks.push(node);
      }
    } catch { /* битый JSON-LD пропускаем */ }
  });
  const orgs = blocks.filter((b) => /Organization|LocalBusiness|Store|Restaurant|Hotel/i.test(String(b['@type'])));
  const products = blocks.filter((b) => /Product|Service|Offer/i.test(String(b['@type'])));
  const images = blocks.flatMap((b) => (Array.isArray(b.image) ? b.image : [b.image])
    .filter(Boolean)
    .map((img) => (typeof img === 'object' ? img?.url : img)))
    .map((u) => resolve(u, base)).filter(Boolean);
  return { orgs, products, images: uniq(images) };
}

export function extractPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = { url: baseUrl };

  out.title = clean($('title').first().text()) || null;
  out.h1 = clean($('h1').first().text()) || null;

  const meta = {};
  $('meta').each((_, el) => {
    const key = $(el).attr('property') || $(el).attr('name');
    if (key) meta[key.toLowerCase()] = clean($(el).attr('content'));
  });
  out.meta = meta;
  out.ogImage = meta['og:image'] || meta['twitter:image'] || null;
  out.description = meta.description || meta['og:description'] || null;

  // иконки и логотипы
  out.icons = uniq($('link[rel]').toArray().flatMap((el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon|mask-icon)(\s|$)/.test(rel)) return [];
    return [resolve($(el).attr('href'), baseUrl)].filter(Boolean);
  }));
  out.logoCandidates = uniq($('img[src*="logo" i], img[data-src*="logo" i], img[alt*="логотип" i], img[alt*="logo" i], [itemprop="logo"] img, .logo img, header img[class*="logo" i]').toArray().flatMap((el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    return src ? [resolve(src, baseUrl)] : [];
  }).filter(Boolean));

  // картинки со страницы
  const imgs = [];
  $('img').each((_, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original') || '';
    if (!src) {
      const ss = $(el).attr('srcset') || $(el).attr('data-srcset');
      if (ss) src = srcsetLargest(ss);
    }
    if (!src || src.startsWith('data:')) return;
    const url = resolve(src, baseUrl);
    if (!url) return;
    const alt = clean($(el).attr('alt'));
    // пропускаем явные пиксели-маячки и иконки интерфейса
    if (/sprite|1x1|pixel|blank|spacer|avatar-default/i.test(url) && !/logo/i.test(url)) return;
    imgs.push({ url, caption: alt || null });
  });
  out.images = uniq(imgs.map((i) => i.url)).slice(0, 80).map((url) => ({ url, caption: imgs.find((i) => i.url === url).caption }));

  // ссылки: телефоны, почты, соцсети, внутренняя навигация
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = clean($(el).text());
    if (href.startsWith('tel:')) out.phones = out.phones || [];
    links.push({ href, text });
  });
  out.phones = uniq(links.filter((l) => l.href.startsWith('tel:')).map((l) => clean(l.href.replace(/^tel:/, ''))));
  out.emails = uniq(links.filter((l) => l.href.startsWith('mailto:')).map((l) => clean(l.href.replace(/^mailto:/, '').split('?')[0])));

  const socials = [];
  for (const [dom, name] of Object.entries(SOCIAL_DOMAINS)) {
    const link = links.find((l) => {
      try { return new URL(l.href, baseUrl).hostname.replace(/^www\./, '').endsWith(dom); } catch { return false; }
    });
    if (link) socials.push({ name, url: resolve(link.href, baseUrl) });
  }
  out.socials = uniq(socials.map((s) => s.url)).map((url) => ({ name: socials.find((s) => s.url === url).name, url }));

  // внутренние ссылки для обхода (услуги/цены/о компании…)
  const sameHost = new URL(baseUrl).hostname.replace(/^www\./, '');
  const navLinks = uniq(links.map((l) => resolve(l.href, baseUrl)).filter((u) => {
    try { return new URL(u).hostname.replace(/^www\./, '') === sameHost; } catch { return false; }
  }));
  out.internalLinks = navLinks;

  // полный текст до удаления навигации/подвала — контакты живут именно там
  const fullText = clean($('body').text());

  // текст для ИИ — без навигации и повторяющейся обвязки
  $('script, style, noscript, template, svg, iframe, nav, footer, form').remove();
  const bodyText = clean($('body').text());
  out.text = bodyText.length > 40000 ? bodyText.slice(0, 40000) : bodyText;
  out.headings = $('h1, h2, h3').toArray().map((el) => clean($(el).text())).filter((t) => t.length > 2 && t.length < 140).slice(0, 40);

  // телефоны/почты/цены из текста
  out.textPhones = uniq((fullText.match(PHONE_RE) || []).map(clean)).slice(0, 12);
  out.textEmails = uniq(fullText.match(EMAIL_RE) || []).filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/i.test(e)).slice(0, 8);
  const prices = [];
  for (const m of fullText.matchAll(PRICE_RE)) {
    const start = Math.max(0, m.index - 60);
    prices.push(clean(fullText.slice(start, m.index + m[0].length + 20)));
    if (prices.length >= 25) break;
  }
  out.priceContexts = prices;

  const ld = parseJsonLd(cheerio.load(html), baseUrl);
  out.jsonLd = { orgs: ld.orgs, products: ld.products.slice(0, 30) };
  out.images = uniq([...out.images.map((i) => i.url), ...ld.images]).slice(0, 90)
    .map((url) => ({ url, caption: out.images.find((i) => i.url === url)?.caption || null }));

  return out;
}

// Оценка ссылки как «интересной подстраницы» (услуги, цены, о компании, контакты, галерея)
const SUBPAGE_HINT = /(услуг|service|цен|price|прайс|тариф|about|компани|kontakt|контакт|связ|галере|gallery|фото|photo|портфоли|portfolio|отзыв|review|меню|menu|каталог|catalog|наши-|работы|works|masters|мастера|команда|team)/i;

export function pickSubpages(internalLinks, baseUrl, limit) {
  const base = new URL(baseUrl);
  const scored = [];
  const seen = new Set([base.pathname.replace(/\/$/, '')]);
  for (const url of internalLinks) {
    let u;
    try { u = new URL(url); } catch { continue; }
    if (u.pathname.replace(/\/$/, '') === '' || seen.has(u.pathname.replace(/\/$/, ''))) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|rar|docx?|xlsx?|mp4|webm)$/i.test(u.pathname)) continue;
    const text = `${u.pathname} ${decodeURIComponent(u.hash || '')}`;
    if (!SUBPAGE_HINT.test(text)) continue;
    seen.add(u.pathname.replace(/\/$/, ''));
    scored.push(url);
    if (scored.length >= limit) break;
  }
  return scored;
}
