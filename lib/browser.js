// Опциональный браузерный бустер (Playwright).
// 2ГИС и Яндекс пускают только настоящий браузер: headed-режим с реальным
// Edge/Chrome проходит их проверки, headless — получает капчу.
// Если Playwright не установлен — функции тихо возвращают «недоступно»,
// и сервис продолжает работать обычными HTTP-запросами и прямыми API.

import { spawn } from 'node:child_process';
import { ROOT } from './db.js';

let playwright = undefined; // undefined = не проверяли, null = нет, object = есть
let browser = null;
let launchedWith = null;
let users = 0; // сколько заданий сейчас могут пользоваться браузером

// Задание «занимает» браузер на время своей работы: ленивый запуск остаётся,
// но закрытие происходит только когда последний отпустил (параллельные анализы)
export function acquireBrowser() { users++; }
export async function releaseBrowser() {
  users = Math.max(0, users - 1);
  if (users === 0) await closeBrowser();
}

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

// Пытаемся запустить браузер по цепочке: настоящий Edge/Chrome в headed-режиме
// (единственный способ пройти проверки 2ГИС), затем headless-фолбэки.
// Если браузер уже запущен — переиспользуем, даже если режим отличается.
async function ensureBrowser({ headed = true } = {}) {
  if (browser) return browser;
  const attempts = [];
  if (headed) {
    attempts.push({ channel: 'msedge', headless: false }, { channel: 'chrome', headless: false });
  }
  attempts.push({ channel: 'msedge', headless: true }, {});
  for (const opts of attempts) {
    try {
      browser = await playwright.chromium.launch(opts);
      launchedWith = opts.headless === false ? 'headed' : 'headless';
      return browser;
    } catch { /* следующий вариант */ }
  }
  throw new Error('Не удалось запустить браузер');
}

export async function boostFetch(url, { timeoutMs = 40000, headed = true, scroll = false, log } = {}) {
  if (!(await chromiumReady())) return null;
  try {
    await ensureBrowser({ headed });
    const context = await browser.newContext({
      locale: 'ru-RU',
      viewport: { width: 1366, height: 900 },
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
          if (scroll) {
            for (let i = 0; i < 4; i++) {
              await page.mouse.wheel(0, 800).catch(() => {});
              await page.waitForTimeout(600);
            }
          }
          return await page.content();
        })(),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs + 30000)),
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
  if (browser) { await browser.close().catch(() => {}); browser = null; launchedWith = null; }
}

// Установка бустера: npm i playwright + загрузка Chromium. Запускается отдельным процессом.
export function installBrowser() {
  const child = spawn('cmd', ['/c', 'npm', 'run', 'browser'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return true;
}
