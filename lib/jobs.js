// Пайплайн анализа: проверка ссылок → скачивание источников → ИИ → медиа → отчёт.
// Состояние задания живёт в БД, поэтому прогресс не теряется при перезапуске (задание помечается отменённым).

import {
  db, getSettings, createCompany, updateCompany, getCompany, addSource, finishSource,
  addMedia, createJob, updateJob, slugify,
} from './db.js';
import { Fetcher } from './fetcher.js';
import { normalizeUrl, fetchSource, detectSource as detectType } from './adapters.js';
import { buildDigest, analyzeWithCodex, analyzeWithCustom, parseModelJson, heuristicReport } from './ai.js';
import { buildDownloadPlan, downloadMedia } from './media.js';
import { acquireBrowser, releaseBrowser } from './browser.js';

const running = new Map(); // jobId -> AbortController

class JobContext {
  constructor(jobId) {
    this.jobId = jobId;
    this.logEntries = [];
    this.progress = 0;
    this.step = '';
  }
  log(title, detail = '', state = 'info') {
    this.logEntries.push({ t: new Date().toISOString(), title, detail, state });
    this.flush();
  }
  patchLog(index, { title, detail, state }) {
    if (this.logEntries[index]) Object.assign(this.logEntries[index], { title, detail, state });
    this.flush();
  }
  setProgress(p, step) {
    this.progress = Math.max(this.progress, Math.min(100, Math.round(p)));
    if (step) this.step = step;
    this.flush();
  }
  flush() {
    updateJob(this.jobId, {
      progress: this.progress,
      step: this.step,
      log_json: JSON.stringify(this.logEntries.slice(-80)),
    });
  }
}

export function startAnalysis(input) {
  const settings = getSettings();
  const urls = [];
  for (const [key, raw] of Object.entries(input)) {
    const url = normalizeUrl(raw);
    if (url) urls.push({ key, url });
  }
  if (!urls.length) throw new Error('Нужна хотя бы одна корректная ссылка');

  const firstHost = new URL(urls[0].url).hostname.replace(/^www\./, '');
  const companyId = createCompany(firstHost);
  const jobId = createJob(companyId);
  for (const { url } of urls) addSource(companyId, detectType(url), url);

  const controller = new AbortController();
  running.set(jobId, controller);
  runJob(jobId, companyId, urls, settings, controller).finally(() => running.delete(jobId));
  return { jobId, companyId };
}

export function cancelJob(jobId) {
  const controller = running.get(Number(jobId));
  if (!controller) return false;
  controller.abort();
  return true;
}

async function runJob(jobId, companyId, urls, settings, controller) {
  const ctx = new JobContext(jobId);
  const signal = controller.signal;
  const log = (title, detail, state) => ctx.log(title, detail, state);
  const crawl = settings.crawl;

  try {
    updateCompany(companyId, { status: 'processing' });
    acquireBrowser();
    // ---- Шаг 1: проверка ссылок ----
    ctx.setProgress(4, 'Проверяем источники');
    log('Проверка ссылок', `${urls.length} шт. · валидация и определение типа площадки`, 'run');
    const sourcesMeta = urls.map(({ url }) => ({ url, type: detectType(url) }));
    log('Проверка ссылок', `${urls.length} ссылок · ${sourcesMeta.map((s) => label(s.type)).join(', ')}`, 'ok');

    // ---- Шаг 2: скачивание и разбор ----
    const fetcher = new Fetcher({ delayMs: crawl.delayMs, signal });
    const results = [];
    const sourceRows = db.prepare('SELECT id, url FROM sources WHERE company_id = ? ORDER BY id').all(companyId);
    for (let i = 0; i < sourcesMeta.length; i++) {
      const meta = sourcesMeta[i];
      const base = 8 + (30 * i) / sourcesMeta.length;
      const next = 8 + (30 * (i + 1)) / sourcesMeta.length;
      ctx.setProgress(base, `Загружаем источник: ${label(meta.type)}`);
      const row = sourceRows.find((r) => r.url === meta.url);
      log(`Источник ${i + 1}/${sourcesMeta.length}`, label(meta.type), 'run');
      const result = await fetchSource(meta.url, fetcher, { maxSubpages: crawl.maxSubpages, log, headed: crawl.headed !== false });
      results.push({ ...result, url: meta.url });
      if (row) finishSource(row.id, result.status, result.note);
      const state = result.status === 'ok' ? 'ok' : result.status === 'partial' ? 'warn' : 'fail';
      const idx = ctx.logEntries.length - 1;
      ctx.patchLog(idx, { title: `Источник ${i + 1}/${sourcesMeta.length}: ${label(meta.type)}`, detail: result.note, state });
      ctx.setProgress(next, 'Загрузка источников');
    }

    // источник считается «давшим данные», если из него вытащено хоть что-то осмысленное
    const hasData = (r) => !!(r.name || (r.text && r.text.length > 40) || (r.images && r.images.length) ||
      Object.values(r.facts || {}).some((v) => (Array.isArray(v) ? v.length : v && typeof v !== 'object')));
    const okCount = results.filter(hasData).length;
    if (!okCount) {
      throw new Error('Источники не отдали данных: площадки закрыли доступ. Попробуйте сайт компании или Instagram, либо установите браузерный бустер в настройках.');
    }

    // ---- Шаг 3: ИИ-анализ ----
    ctx.setProgress(40, 'ИИ-анализ данных');
    const { digest, images } = buildDigest(results);
    let report = null;
    let aiNote = '';
    try {
      let raw;
      if (settings.provider === 'custom' && settings.custom.baseUrl && settings.custom.apiKey) {
        log('ИИ-анализ', `Свой провайдер: ${settings.custom.model}`, 'run');
        raw = await analyzeWithCustom(digest, settings.custom, { timeoutSec: crawl.aiTimeoutSec, signal });
      } else {
        log('ИИ-анализ', 'Codex CLI', 'run');
        raw = await analyzeWithCodex(digest, { timeoutSec: crawl.aiTimeoutSec, log });
      }
      report = parseModelJson(raw);
      if (!report?.company || typeof report.company !== 'object') throw new Error('JSON без блока company');
      // модель вернула «пустой» JSON — считаем анализ неудачным, берём эвристику
      if (!report.company.name && !report.company.description && !(report.services || []).length) {
        throw new Error('Модель не нашла данных в источниках');
      }
      aiNote = settings.provider === 'custom' ? 'Свой провайдер' : 'Codex CLI';
      const idx = ctx.logEntries.length - 1;
      ctx.patchLog(idx, { title: 'ИИ-анализ', detail: `${aiNote} · структура и услуги извлечены`, state: 'ok' });
    } catch (err) {
      if (signal.aborted) throw new Error('cancelled');
      log('ИИ-анализ', `${err.message} → переключаюсь на шаблонное извлечение`, 'warn');
      report = heuristicReport(results);
    }

    // Контакты, найденные парсером напрямую, надёжнее ИИ — не теряем их
    mergeHardFacts(report, results);

    // ---- Шаг 4: медиа ----
    ctx.setProgress(72, 'Скачиваем медиа');
    const plan = buildDownloadPlan(images, report.media_plan, crawl.maxImages);
    log('Медиа', `${plan.length} кандидатов · фильтры и дедупликация`, 'run');
    const { saved } = await downloadMedia({
      companyId, plan, fetcher, maxImages: crawl.maxImages, logoWanted: true, log,
    });
    for (const rec of saved) addMedia(companyId, rec);
    const logo = saved.find((s) => s.kind === 'logo');
    if (logo) updateCompany(companyId, { logo_file: logo.file });
    const idx = ctx.logEntries.length - 1;
    ctx.patchLog(idx, { title: 'Медиа', detail: `Сохранено файлов: ${saved.length}${logo ? ' · логотип найден' : ' · логотип не найден'}`, state: saved.length ? 'ok' : 'warn' });

    // ---- Шаг 5: финализация ----
    ctx.setProgress(95, 'Сохраняем отчёт');
    const name = report.company?.name || results.find((r) => r.name)?.name || firstHost(companyId);
    updateCompany(companyId, {
      name, slug: slugify(name), status: 'ready',
      report_json: JSON.stringify(report), logo_file: logo?.file || null,
    });
    log('Отчёт готов', `${name} · ${report.services?.length ?? 0} услуг · ${saved.length} медиафайлов`, 'ok');
    ctx.setProgress(100, 'Готово');
    updateJob(jobId, { status: 'done' });
  } catch (err) {
    const cancelled = signal.aborted || err.message === 'cancelled';
    updateJob(jobId, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err.message });
    const company = getCompany(companyId);
    if (company?.status === 'processing') updateCompany(companyId, { status: cancelled ? 'cancelled' : 'failed' });
    log(cancelled ? 'Анализ отменён' : 'Ошибка', cancelled ? 'Задание остановлено пользователем' : err.message, 'fail');
  } finally {
    await releaseBrowser();
  }
}

function mergeHardFacts(report, results) {
  const c = report.company ||= {};
  for (const r of results) {
    const f = r.facts || {};
    c.phones = uniq([...(c.phones || []), ...(f.phones || []), ...(f.publicPhone ? [f.publicPhone] : [])]);
    c.emails = uniq([...(c.emails || []), ...(f.emails || []), ...(f.publicEmail ? [f.publicEmail] : [])]);
    if (f.publicPhone && !c.phones.includes(f.publicPhone)) c.phones.push(f.publicPhone);
    const socialUrls = new Set((c.socials || []).map((s) => s.url));
    for (const s of f.socials || []) if (!socialUrls.has(s.url)) { (c.socials ||= []).push(s); socialUrls.add(s.url); }
    if (!c.address && f.address) c.address = f.address;
    if (!c.category && f.category) c.category = f.category;
  }
  c.phones = normalizePhones(c.phones).slice(0, 5);
  c.emails = c.emails.filter(Boolean).slice(0, 4);
}

function normalizePhones(list) {
  const out = new Map();
  for (const p of list || []) {
    const digits = String(p).replace(/\D/g, '');
    if (digits.length < 10) continue;
    const key = digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
    if (!out.has(key)) out.set(key, p);
  }
  return [...out.values()];
}

const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];
const label = (type) => ({ instagram: 'Instagram', twogis: '2ГИС', yandex: 'Яндекс Карты', website: 'Сайт' }[type] || type);
const firstHost = (companyId) => {
  const c = getCompany(companyId);
  return c?.name || 'Компания';
};
