// Экспорт отчёта: JSON, текстовый бриф и ZIP-архив с медиа и готовым промптом для ИИ-агента.

import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from './db.js';
import { getCompany, listSources, listMedia } from './db.js';

export function buildBrief(companyId) {
  const company = getCompany(companyId);
  if (!company) throw new Error('Компания не найдена');
  const report = JSON.parse(company.report_json || '{}');
  const sources = listSources(companyId).map(({ type, url, status, note }) => ({ type, url, status, note }));
  const media = listMedia(companyId).map(({ kind, url, file, width, height, caption, source_type }) => ({
    kind, url, file: `media/${file}`, width, height, caption, source_type,
  }));
  return {
    meta: {
      generator: 'SiteScope',
      generated_at: company.updated_at,
      company_id: company.id,
      slug: company.slug,
    },
    company: report.company || {},
    services: report.services || [],
    price_summary: report.price_summary || '',
    promos: report.promos || [],
    usp: report.usp || [],
    audience: report.audience || '',
    tone_of_voice: report.tone_of_voice || '',
    site_structure: report.site_structure || { pages: [] },
    warnings: report.warnings || [],
    media, sources,
  };
}

const fmtMedia = (m) => `- ${m.file}${m.width ? ` (${m.width}×${m.height})` : ''}${m.caption ? ` — ${m.caption}` : ''} [источник: ${m.source_type || 'web'}]`;

// Компактный текстовый вид для экспорта в .txt
export function briefToText(brief) {
  const c = brief.company;
  const lines = [];
  lines.push(`${c.name || 'Компания'}${c.tagline ? ` — ${c.tagline}` : ''}`);
  if (c.category || c.city) lines.push([c.category, c.city].filter(Boolean).join(' · '));
  if (c.description) lines.push(`\nО компании: ${c.description}`);
  if (c.address) lines.push(`Адрес: ${c.address}`);
  if (c.hours) lines.push(`График: ${c.hours}`);
  if (c.phones?.length) lines.push(`Телефоны: ${c.phones.join(', ')}`);
  if (c.emails?.length) lines.push(`Почта: ${c.emails.join(', ')}`);
  for (const s of c.socials || []) lines.push(`${s.name}: ${s.url}`);
  if (brief.services?.length) {
    lines.push('\nУслуги:');
    for (const s of brief.services) lines.push(`- ${s.name}${s.price ? ` — ${s.price}` : ''}${s.description ? `. ${s.description}` : ''}`);
  }
  if (brief.price_summary) lines.push(`\nЦены: ${brief.price_summary}`);
  if (brief.promos?.length) {
    lines.push('\nАкции:');
    for (const p of brief.promos) lines.push(`- ${p.title}${p.details ? `. ${p.details}` : ''}`);
  }
  if (brief.usp?.length) lines.push(`\nПреимущества:\n${brief.usp.map((u) => `- ${u}`).join('\n')}`);
  if (brief.media?.length) {
    lines.push('\nМедиа:');
    for (const m of brief.media) lines.push(fmtMedia(m));
  }
  if (brief.site_structure.pages?.length) {
    lines.push('\nСтруктура сайта:');
    for (const p of brief.site_structure.pages) {
      lines.push(`\nСтраница «${p.name}» — ${p.purpose}`);
      for (const s of p.sections || []) lines.push(`  ${s.name}: ${s.content} [${s.priority}]`);
    }
  }
  if (brief.warnings?.length) lines.push(`\nПроверить вручную:\n${brief.warnings.map((w) => `- ${w}`).join('\n')}`);
  return lines.join('\n');
}

// Нейтральный структурированный документ: только данные, без инструкций дизайну.
export function dataMarkdown(brief) {
  const c = brief.company;
  const md = [];
  md.push(`# ${c.name || 'Компания'} — структурированные данные`);
  md.push('');
  md.push(`_Собрано SiteScope из открытых источников ${brief.meta.generated_at}. Список источников — в конце файла._`);
  md.push('');
  md.push('## Компания');
  md.push(`- Название: ${c.name || '—'}`);
  if (c.tagline) md.push(`- Слоган: ${c.tagline}`);
  if (c.category) md.push(`- Сфера деятельности: ${c.category}`);
  if (c.city) md.push(`- Город: ${c.city}`);
  if (c.description) md.push(`- Описание: ${c.description}`);
  if (c.address) md.push(`- Адрес: ${c.address}`);
  if (c.hours) md.push(`- График работы: ${c.hours}`);
  if (c.phones?.length) md.push(`- Телефоны: ${c.phones.join(', ')}`);
  if (c.emails?.length) md.push(`- Email: ${c.emails.join(', ')}`);
  for (const s of c.socials || []) md.push(`- ${s.name}: ${s.url}`);
  if (brief.audience) md.push(`- Целевая аудитория: ${brief.audience}`);
  if (brief.tone_of_voice) md.push(`- Тон коммуникации: ${brief.tone_of_voice}`);
  if (brief.usp?.length) md.push(`- Преимущества: ${brief.usp.join('; ')}`);
  md.push('');
  if (brief.services?.length) {
    md.push('## Услуги и цены');
    for (const s of brief.services) {
      const parts = [`**${s.name}**`];
      if (s.price) parts.push(`— ${s.price}`);
      if (s.description) parts.push(`. ${s.description}`);
      if (s.duration) parts.push(` Длительность: ${s.duration}.`);
      if (s.audience) parts.push(` Для кого: ${s.audience}.`);
      md.push(`- ${parts.join('')}`);
    }
    if (brief.price_summary) md.push(`\nСводка по ценам: ${brief.price_summary}`);
    md.push('');
  }
  if (brief.promos?.length) {
    md.push('## Акции и предложения');
    for (const p of brief.promos) md.push(`- **${p.title}**${p.details ? `. ${p.details}` : ''}`);
    md.push('');
  }
  if (brief.media?.length) {
    md.push('## Медиафайлы (папка media/)');
    for (const m of brief.media) md.push(fmtMedia(m));
    md.push('');
  }
  if (brief.site_structure.pages?.length) {
    md.push('## Рекомендуемая структура сайта');
    for (const p of brief.site_structure.pages) {
      md.push(`### ${p.name}`);
      if (p.purpose) md.push(`Назначение: ${p.purpose}`);
      for (const s of p.sections || []) md.push(`- **${s.name}** (приоритет: ${s.priority}): ${s.content}`);
      md.push('');
    }
  }
  if (brief.warnings?.length) {
    md.push('## Данные, требующие ручной проверки');
    for (const w of brief.warnings) md.push(`- ${w}`);
    md.push('');
  }
  md.push('## Источники');
  for (const s of brief.sources) md.push(`- ${s.url} (${s.status})`);
  return md.join('\n');
}

export async function exportZip(brief) {
  const zip = new JSZip();
  const root = zip.folder(`${brief.meta.slug}-brief`);
  root.file('company-data.md', dataMarkdown(brief));
  root.file('company-brief.json', JSON.stringify(brief, null, 2));
  const dir = path.join(MEDIA_DIR, String(brief.meta.company_id));
  for (const m of brief.media) {
    const p = path.join(dir, path.basename(m.file));
    if (fs.existsSync(p)) root.file(m.file, fs.readFileSync(p));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
