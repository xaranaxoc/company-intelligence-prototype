// SiteScope — локальный сервер. Запуск: npm start или start.bat (откроет браузер).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, MEDIA_DIR, db, reapStaleJobs, getSettings, saveSettings } from './lib/db.js';
import { listCompanies, getCompany, deleteCompany, listSources, listMedia, getJob, activeJob } from './lib/db.js';
import { startAnalysis, cancelJob } from './lib/jobs.js';
import { testCodex, testCustom } from './lib/ai.js';
import { buildBrief, briefToText, exportZip } from './lib/export.js';
import { browserAvailable, chromiumReady, installBrowser } from './lib/browser.js';

const PORT = Number(process.env.PORT || 3777);
reapStaleJobs();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('Слишком большое тело запроса')); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}); }
    catch { reject(new Error('Некорректный JSON в запросе')); }
  });
  req.on('error', reject);
});

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });

// ---------- API ----------

route('GET', 'api/health', async () => ({
  ok: true,
  provider: getSettings().provider,
  browserBooster: (await browserAvailable()) ? ((await chromiumReady()) ? 'ready' : 'no-chromium') : 'not-installed',
}));

route('GET', 'api/browser/status', async () => ({
  installed: await browserAvailable(),
  chromium: await chromiumReady(),
}));

route('POST', 'api/browser/install', () => ({ started: installBrowser() }));

route('GET', 'api/settings', (ctx) => {
  const s = getSettings();
  const masked = s.custom.apiKey ? `${s.custom.apiKey.slice(0, 4)}••••${s.custom.apiKey.slice(-4)}` : '';
  return { ...s, custom: { ...s.custom, apiKey: masked, hasKey: !!s.custom.apiKey } };
});

route('PUT', 'api/settings', async (ctx) => {
  const body = await readBody(ctx.req);
  const patch = {};
  if (body.provider === 'codex' || body.provider === 'custom') patch.provider = body.provider;
  if (body.custom && typeof body.custom === 'object') {
    const prev = getSettings().custom;
    patch.custom = {
      name: String(body.custom.name ?? prev.name).slice(0, 80),
      baseUrl: String(body.custom.baseUrl ?? prev.baseUrl).slice(0, 300),
      model: String(body.custom.model ?? prev.model).slice(0, 120),
      // пустой ключ = не менять сохранённый
      apiKey: body.custom.apiKey ? String(body.custom.apiKey).slice(0, 300) : prev.apiKey,
    };
  }
  if (body.crawl && typeof body.crawl === 'object') {
    const prev = getSettings().crawl;
    const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };
    patch.crawl = {
      delayMs: num(body.crawl.delayMs, prev.delayMs, 500, 30000),
      maxImages: num(body.crawl.maxImages, prev.maxImages, 4, 60),
      aiTimeoutSec: num(body.crawl.aiTimeoutSec, prev.aiTimeoutSec, 60, 3600),
      maxSubpages: num(body.crawl.maxSubpages, prev.maxSubpages, 0, 10),
      headed: body.crawl.headed !== undefined ? !!body.crawl.headed : prev.headed,
    };
  }
  return saveSettings(patch);
});

route('POST', 'api/settings/test', async (ctx) => {
  const body = await readBody(ctx.req);
  if (body.target === 'custom') return testCustom({ ...getSettings().custom, ...(body.custom || {}) });
  return testCodex();
});

route('GET', 'api/companies', () => listCompanies());

route('GET', 'api/companies/:id', (ctx) => {
  const company = getCompany(ctx.params.id);
  if (!company) throw Object.assign(new Error('Компания не найдена'), { status: 404 });
  const report = JSON.parse(company.report_json || 'null');
  return {
    ...company, report,
    sources: listSources(company.id),
    media: listMedia(company.id).map((m) => ({ ...m, url: `/media/${company.id}/${m.file}` })),
  };
});

route('DELETE', 'api/companies/:id', (ctx) => {
  const company = getCompany(ctx.params.id);
  if (!company) throw Object.assign(new Error('Компания не найдена'), { status: 404 });
  deleteCompany(ctx.params.id);
  fs.rmSync(path.join(MEDIA_DIR, String(company.id)), { recursive: true, force: true });
  return { ok: true };
});

route('POST', 'api/analyze', async (ctx) => {
  const body = await readBody(ctx.req);
  return startAnalysis(body); // анализы выполняются параллельно, ограничений нет
});

route('GET', 'api/jobs/active', () => {
  const jobs = db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY id DESC").all();
  return { job: jobs[0] || null, running: jobs.map((j) => ({ ...j, log: JSON.parse(j.log_json || '[]') })) };
});

route('GET', 'api/jobs/:id', (ctx) => {
  const job = getJob(ctx.params.id);
  if (!job) throw Object.assign(new Error('Задание не найдено'), { status: 404 });
  return { ...job, log: JSON.parse(job.log_json || '[]') };
});

route('POST', 'api/jobs/:id/cancel', (ctx) => ({ ok: cancelJob(ctx.params.id) }));

route('GET', 'api/companies/:id/export', async (ctx, res) => {
  const brief = buildBrief(ctx.params.id);
  const format = new URL(ctx.req.url, 'http://x').searchParams.get('format') || 'zip';
  const safeName = brief.meta.slug || 'company';
  if (format === 'json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${safeName}-brief.json"` });
    res.end(JSON.stringify(brief, null, 2));
    return;
  }
  if (format === 'txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${safeName}-brief.txt"` });
    res.end(briefToText(brief));
    return;
  }
  const zip = await exportZip(brief);
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${safeName}-landing-kit.zip"` });
  res.end(zip);
});

// ---------- сервер ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'media' && parts.length === 3) {
    // раздача скачанных медиа с защитой от выхода за пределы каталога
    const dir = path.join(MEDIA_DIR, path.basename(parts[1]));
    const file = path.join(dir, path.basename(parts[2]));
    if (file.startsWith(MEDIA_DIR) && fs.existsSync(file)) return serveFile(res, file);
    res.writeHead(404); res.end(); return;
  }

  for (const r of routes) {
    if (r.method !== req.method || r.parts.length !== parts.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < parts.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (r.parts[i] !== parts[i]) { match = false; break; }
    }
    if (!match) continue;
    try {
      const out = await r.handler({ req, res, params }, res);
      if (out !== undefined && !res.writableEnded) json(res, 200, out);
    } catch (err) {
      const status = err.status || (String(err.message).includes('не найден') ? 404 : 500);
      if (!res.writableEnded) json(res, status, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET') {
    if (url.pathname === '/') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    const staticPath = path.normalize(path.join(ROOT, 'public', url.pathname));
    if (staticPath.startsWith(path.join(ROOT, 'public')) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      return serveFile(res, staticPath);
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`SiteScope запущен: ${url}`);
  console.log('Данные: ./data (SQLite + медиа). Останов: Ctrl+C');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
  }
});
