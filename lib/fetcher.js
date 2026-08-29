// Вежливый загрузчик: минимум delayMs между запросами на один домен + джиттер,
// ретраи с бек-оффом, ограничение размера ответа, отмена через AbortSignal.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});

export class Fetcher {
  constructor({ delayMs = 2500, signal } = {}) {
    this.delayMs = Math.max(500, Number(delayMs) || 2500);
    this.signal = signal;
    this.lastByHost = new Map();
    this.requestCount = 0;
  }

  async polite(host) {
    const last = this.lastByHost.get(host) || 0;
    const wait = last + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 700), this.signal);
    this.lastByHost.set(host, Date.now());
  }

  async get(url, { headers = {}, timeoutMs = 30000, maxBytes = 10 * 1024 * 1024, retries = 2 } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Некорректный URL: ${url}`); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Поддерживаются только http(s): ${url}`);

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.polite(parsed.host);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = this.signal ? AbortSignal.any([this.signal, timeoutSignal]) : timeoutSignal;
      try {
        this.requestCount++;
        const res = await fetch(url, {
          redirect: 'follow',
          signal,
          headers: {
            'user-agent': UA,
            'accept': 'text/html,application/xhtml+xml,application/json,image/*,*/*;q=0.8',
            'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
            ...headers,
          },
        });
        if ([429, 502, 503, 520, 521, 522].includes(res.status) && attempt < retries) {
          await sleep(3000 * (attempt + 1), this.signal);
          continue;
        }
        if (!res.ok) throw new HttpError(res.status, url);
        // читаем тело с ограничением размера
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { await reader.cancel(); break; }
          chunks.push(Buffer.from(value));
        }
        return {
          status: res.status,
          finalUrl: res.url,
          buffer: Buffer.concat(chunks),
          text: null,
          contentType: res.headers.get('content-type') || '',
          html() { this.text ??= this.buffer.toString('utf-8'); return this.text; },
        };
      } catch (err) {
        if (this.signal?.aborted || err.name === 'TimeoutError' || err.name === 'AbortError') {
          if (this.signal?.aborted) throw new Error('cancelled');
        }
        lastErr = err;
        if (attempt < retries && !(err instanceof HttpError)) { await sleep(2500 * (attempt + 1), this.signal); continue; }
        throw err;
      }
    }
    throw lastErr;
  }
}

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}: ${url}`);
    this.status = status;
  }
}
