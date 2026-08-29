// Опциональный браузерный бустер (Playwright + headless Chromium).
// Нужен для площадок с JS-защитой (2ГИС «museum», капча Яндекса, стена Instagram).
// Если Playwright не установлен — все функции тихо возвращают «недоступно»,
// и сервис продолжает работать обычными HTTP-запросами.

import { spawn } from 'node:child_process';
import { ROOT } from './db.js';

let playwright = undefined; // undefined = не проверяли, null = нет, object = есть
let browser = null;

export async function browserAvailable() {
  if (playwright === undefined) {
    playwright = await import('playwright').catch(() => null);
  }
  return playwright;
}

export async function chromiumReady() {
  if (!(await browserAvailable())) return false;
  try { playwright.chromium.executablePath(); return true; }
  catch { return false; }
}

export async function boostFetch(url, { timeoutMs = 30000, log } = {}) {
  if (!(await chromiumReady())) return null;
  try {
    browser ??= await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'ru-RU',
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    try {
      const page = await context.newPage();
      // жёсткий общий дедлайн: даже если страница зависла, бустер не подвешивает анализ
      const result = await Promise.race([
        (async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          // 2ГИС сначала показывает JS-челлендж /museum, ждём автоматического перехода
          if (page.url().includes('/museum')) {
            log?.('2ГИС: прохожу проверку браузера…');
            await page.waitForURL((u) => !String(u).includes('/museum'), { timeout: 20000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
          return await page.content();
        })(),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs + 45000)),
      ]);
      return result;
    } finally {
      await context.close().catch(() => {});
    }
  } catch (err) {
    log?.(`Браузерный бустер: ${err.message}`);
    return null;
  }
}

export async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

// Установка бустера: npm i playwright + загрузка Chromium. Запускается отдельным процессом.
export function installBrowser() {
  const child = spawn('cmd', ['/c', 'npm', 'run', 'browser'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return true;
}
