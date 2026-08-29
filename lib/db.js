import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const dir of [DATA_DIR, MEDIA_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'sitescope.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ready',
  report_json TEXT,
  logo_file   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  url        TEXT NOT NULL,
  status     TEXT,
  note       TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  url         TEXT NOT NULL,
  file        TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER,
  hash        TEXT,
  caption     TEXT,
  source_type TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  status     TEXT NOT NULL,
  progress   REAL NOT NULL DEFAULT 0,
  step       TEXT,
  log_json   TEXT NOT NULL DEFAULT '[]',
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();

// ---------- настройки ----------

export const DEFAULT_SETTINGS = {
  provider: 'codex', // 'codex' | 'custom'
  custom: { name: '', baseUrl: '', apiKey: '', model: '' },
  crawl: { delayMs: 2500, maxImages: 16, aiTimeoutSec: 600, maxSubpages: 4, headed: true },
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    ...DEFAULT_SETTINGS,
    ...map,
    custom: { ...DEFAULT_SETTINGS.custom, ...(map.custom || {}) },
    crawl: { ...DEFAULT_SETTINGS.crawl, ...(map.crawl || {}) },
  };
}

export function saveSettings(patch) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    upsert.run(key, JSON.stringify(value));
  }
  return getSettings();
}

// ---------- компании ----------

export function createCompany(name) {
  const slug = slugify(name);
  db.prepare(
    'INSERT INTO companies (name, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, slug, 'processing', now(), now());
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export function updateCompany(id, fields) {
  const allowed = ['name', 'slug', 'status', 'report_json', 'logo_file'];
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  args.push(now(), id);
  db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function getCompany(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

export function listCompanies() {
  return db.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM sources s WHERE s.company_id = c.id) AS source_count,
       (SELECT COUNT(*) FROM media m WHERE m.company_id = c.id) AS media_count
     FROM companies c ORDER BY c.updated_at DESC`
  ).all();
}

export function deleteCompany(id) {
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
}

// ---------- источники ----------

export function addSource(companyId, type, url) {
  db.prepare('INSERT INTO sources (company_id, type, url) VALUES (?, ?, ?)').run(companyId, type, url);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export function finishSource(id, status, note) {
  db.prepare('UPDATE sources SET status = ?, note = ?, fetched_at = ? WHERE id = ?').run(status, note, now(), id);
}

export function listSources(companyId) {
  return db.prepare('SELECT * FROM sources WHERE company_id = ? ORDER BY id').all(companyId);
}

// ---------- медиа ----------

export function addMedia(companyId, rec) {
  db.prepare(
    `INSERT INTO media (company_id, kind, url, file, width, height, bytes, hash, caption, source_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, rec.kind, rec.url, rec.file, rec.width ?? null, rec.height ?? null,
        rec.bytes ?? null, rec.hash ?? null, rec.caption ?? null, rec.source_type ?? null, now());
}

export function listMedia(companyId) {
  return db.prepare('SELECT * FROM media WHERE company_id = ? ORDER BY kind DESC, id').all(companyId);
}

// ---------- задания ----------

export function createJob(companyId) {
  db.prepare(
    'INSERT INTO jobs (company_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(companyId, 'running', now(), now());
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export function updateJob(id, fields) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['status', 'progress', 'step', 'log_json', 'error', 'company_id'].includes(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  args.push(now(), id);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function activeJob() {
  return db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get();
}

// После перезапуска сервиса незавершённые задания помечаются отменёнными — данные уже в БД не теряются.
export function reapStaleJobs() {
  db.prepare("UPDATE jobs SET status = 'cancelled', error = 'Сервис был перезапущен' WHERE status = 'running'").run();
  db.prepare("UPDATE companies SET status = 'failed' WHERE status = 'processing'").run();
}

export function slugify(text) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return String(text || 'company').toLowerCase().trim()
    .split('').map((ch) => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'company';
}
