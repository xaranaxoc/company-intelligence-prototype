// ИИ-анализ: Codex CLI или OpenAI-совместимый провайдер.
// Оба пути получают одинаковый «дайджест» собранных данных и обязаны вернуть строгий JSON.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TMP_DIR } from './db.js';

const SYSTEM_PROMPT = `Ты — аналитик цифрового агентства. Тебе дают сырые данные, собранные из открытых источников о компании (соцсети, карты, сайт).
Задача — собрать из них структурированный бриф с фактами о компании.

Правила:
- Используй ТОЛЬКО факты из данных. Не выдумывай цены, услуги, адреса и телефоны.
- Если данных нет — оставь пустое значение (пустая строка, пустой массив), не придумывай.
- Знач пиши на русском языке, как в источниках.
- НЕ предлагай структуру сайта, страницы, секции и дизайн — только факты о компании. Структуру придумает другой ИИ.
- Список изображений дан с индексами. В media_plan ссылайся только на существующие индексы и укажи, как использовать файл.
- Верни ТОЛЬКО валидный JSON без пояснений, без markdown-обёртки.

Схема ответа:
{
  "company": {
    "name": "", "tagline": "", "description": "", "category": "", "city": "", "address": "",
    "hours": "", "phones": [], "emails": [],
    "messengers": [{"name": "", "url": ""}],
    "socials": [{"name": "", "url": ""}]
  },
  "services": [{"name": "", "description": "", "price": "", "duration": "", "audience": ""}],
  "price_summary": "",
  "promos": [{"title": "", "details": ""}],
  "usp": [],
  "audience": "",
  "tone_of_voice": "",
  "media_plan": [{"index": 0, "use": "logo|hero|service|gallery|about", "why": ""}],
  "warnings": []
}
Условия качества: услуги с ценами если они есть в данных; в warnings — что требует ручной проверки.`;

export function buildDigest(results) {
  const parts = [];
  const images = [];
  for (const r of results) {
    const label = { instagram: 'Instagram', twogis: '2ГИС', yandex: 'Яндекс Карты', website: 'Сайт компании' }[r.type] || r.type;
    parts.push(`### Источник: ${label} (${r.url}) — статус: ${r.status}\n${r.text || '(текст не получен)'}`);
    for (const img of r.images || []) {
      images.push({ index: images.length, url: img.url, role: img.role, from: img.from, caption: img.caption });
    }
  }
  const imgList = images
    .slice(0, 60)
    .map((i) => `${i.index}. [${i.from}/${i.role}] ${i.caption ? `подпись: ${i.caption.slice(0, 120)}` : 'без подписи'}`)
    .join('\n');
  parts.push(`### Изображения (для media_plan, ссылаться по index)\n${imgList || '(нет)'}`);
  return { digest: parts.join('\n\n'), images };
}

export function parseModelJson(text) {
  if (!text) throw new Error('Пустой ответ модели');
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* ниже — поиск сбалансированного JSON */ }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
    }
  }
  throw new Error('В ответе модели нет валидного JSON');
}

// ---------- Codex CLI ----------

export async function analyzeWithCodex(digest, { timeoutSec = 600, log } = {}) {
  const jobId = crypto.randomUUID().slice(0, 8);
  const workDir = path.join(TMP_DIR, `codex-${jobId}`);
  fs.mkdirSync(workDir, { recursive: true });
  const outFile = path.join(workDir, 'last-message.txt');

  const args = [
    'exec', '-',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-C', workDir,
    '--output-last-message', outFile,
  ];
  log?.(`Запуск codex exec (таймаут ${timeoutSec}с)…`);

  return await new Promise((resolve, reject) => {
    const child = spawn('codex', args, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex превысил таймаут ${timeoutSec}с`));
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Не удалось запустить Codex CLI: ${err.message}. Установлен ли codex и есть ли он в PATH?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        resolve(fs.readFileSync(outFile, 'utf-8'));
        return;
      }
      // фолбэк: последний agentMessage из JSONL-потока не просили, поэтому просто читаем stdout
      if (code !== 0) {
        reject(new Error(`Codex завершился с кодом ${code}. ${stderr.trim().slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.write(`${SYSTEM_PROMPT}\n\n=== ДАННЫЕ ===\n${digest}\n\nВерни только JSON.`);
    child.stdin.end();
  });
}

// ---------- Кастомный OpenAI-совместимый провайдер ----------

export async function analyzeWithCustom(digest, cfg, { timeoutSec = 600, signal } = {}) {
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Не задан Base URL провайдера');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutSec * 1000), ...(signal ? [signal] : [])]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `=== ДАННЫЕ ===\n${digest}\n\nВерни только JSON.` },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Провайдер вернул HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Провайдер вернул ответ без содержимого');
  return content;
}

// ---------- Проверки подключения ----------

export async function testCodex() {
  const started = Date.now();
  try {
    const answer = await analyzeWithCodex('Ответь ровно одним словом: OK', { timeoutSec: 90 });
    // модель может ответить латиницей OK или кириллицей ОК
    const ok = /(OK|ОК)/i.test(String(answer).toUpperCase()) || /(OK|ОК)/.test(String(answer));
    return { ok, detail: `Ответ получен за ${Math.round((Date.now() - started) / 1000)}с` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function testCustom(cfg) {
  try {
    const answer = await analyzeWithCustom('Ответь ровно одним словом: OK', cfg, { timeoutSec: 30 });
    const ok = /(OK|ОК)/i.test(String(answer).toUpperCase()) || /(OK|ОК)/.test(String(answer));
    return { ok, detail: 'Соединение установлено' };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// ---------- Эвристический фолбэк (ИИ не настроен или упал) ----------

export function heuristicReport(results) {
  const facts = {};
  const socials = [];
  const images = [];
  for (const r of results) {
    for (const [k, v] of Object.entries(r.facts || {})) {
      if (v == null || v === '' || v === false) continue;
      if (Array.isArray(v)) { facts[k] = [...new Set([...(facts[k] || []), ...v])]; continue; }
      if (k === 'socials') continue;
      if (!facts[k]) facts[k] = v;
    }
    for (const s of r.facts?.socials || []) socials.push(s);
    for (const img of r.images || []) images.push({ index: images.length, ...img });
  }
  const name = facts.name || 'Компания';
  const services = [];
  for (const r of results) {
    for (const p of r.facts?.products || []) {
      services.push({ name: p.name, description: (p.description || '').slice(0, 400), price: p.price || '', duration: '', audience: '' });
    }
    for (const p of r.facts?.priceContexts || []) services.push({ name: p.slice(0, 80), description: p, price: '', duration: '', audience: '' });
  }
  return {
    company: {
      name, tagline: '', description: facts.description || '', category: facts.category || '',
      city: facts.city || (typeof facts.address === 'string' ? facts.address.split(',')[0] : '') || '',
      address: facts.address || '', hours: facts.schedule || facts.hours || '',
      phones: facts.phones || (facts.publicPhone ? [facts.publicPhone] : []),
      emails: facts.emails || (facts.publicEmail ? [facts.publicEmail] : []),
      messengers: [], socials: [...new Map(socials.map((s) => [s.url, s])).values()],
    },
    services: services.slice(0, 8),
    price_summary: '',
    promos: [],
    usp: [],
    audience: '',
    tone_of_voice: '',
    media_plan: images.filter((i) => i.role === 'logo').slice(0, 1).map((i) => ({ index: i.index, use: 'logo', why: 'Аватар/логотип источника' })),
    warnings: ['Отчёт собран без ИИ-анализа (провайдер не настроен или недоступен). Данные извлечены шаблонами — проверьте вручную и повторите анализ с ИИ.'],
  };
}
