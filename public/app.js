// SiteScope — клиент. Все экраны работают через локальный API.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const views = $$('[data-view]');
  const navLinks = $$('[data-nav]');
  const tabs = $$('[data-tab]');
  const panels = $$('[data-panel]');

  const state = { settings: null, companies: [], report: null, jobId: null, pollTimer: null };

  // ---------- базовые helpers ----------

  const showToast = (message) => {
    const toast = $('#toast');
    clearTimeout(showToast._t);
    toast.textContent = message;
    toast.hidden = false;
    showToast._t = setTimeout(() => { toast.hidden = true; }, 3200);
  };

  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const fmtDate = (iso) => {
    try { return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch { return ''; }
  };

  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  };

  // ---------- навигация ----------

  const setView = (name) => {
    views.forEach((v) => { v.hidden = v.dataset.view !== name; });
    navLinks.forEach((l) => l.classList.toggle('is-active', l.dataset.nav === name || (name === 'progress' && l.dataset.nav === 'new')));
    localStorage.setItem('sitescope-view', name === 'progress' ? 'new' : name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const setTab = (name) => {
    tabs.forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
  };

  const openModal = (id) => {
    lastFocused = document.activeElement;
    $(id).hidden = false;
    requestAnimationFrame(() => $(id).querySelector('button, a')?.focus());
  };
  const closeModal = (modal) => { modal.hidden = true; lastFocused?.focus(); };
  let lastFocused = null;

  // ---------- экран «новый анализ» ----------

  $('#analysis-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const inputs = $$('.source-input');
    const filled = inputs.filter((i) => i.value.trim());
    const valid = filled.length > 0 && filled.every((i) => !i.value.trim() || i.validity.valid);
    inputs.forEach((i) => i.setAttribute('aria-invalid', String(i.value.trim() && !i.validity.valid)));
    $('#form-error').hidden = valid;
    if (!valid) return;
    const body = Object.fromEntries(filled.filter((i) => i.validity.valid).map((i) => [i.name, i.value.trim()]));
    try {
      const { jobId } = await api('/api/analyze', { method: 'POST', body });
      state.jobId = jobId;
      resetProgress();
      setView('progress');
      startPolling();
    } catch (err) {
      showToast(err.message);
    }
  });

  // ---------- прогресс ----------

  const LOG_ICONS = { run: '·', ok: '✓', warn: '!', fail: '✕', info: '·' };

  function resetProgress() {
    $('#progress-fill').style.width = '0%';
    $('#progress-number').textContent = '0%';
    $('#progress-track').setAttribute('aria-valuenow', '0');
    $('#progress-step').textContent = 'Подготовка';
    $('#progress-title').textContent = 'Проверяем источники';
    $('#progress-pill').textContent = 'Обработка';
    $('#progress-ring').hidden = false;
    $('#open-result').hidden = true;
    $('#analysis-log').innerHTML = '';
  }

  function renderJob(job) {
    $('#progress-fill').style.width = `${job.progress}%`;
    $('#progress-number').textContent = `${Math.round(job.progress)}%`;
    $('#progress-track').setAttribute('aria-valuenow', String(Math.round(job.progress)));
    $('#progress-step').textContent = job.step || '';
    $('#progress-title').textContent = job.step || 'Работаем';
    const log = $('#analysis-log');
    log.innerHTML = (job.log || []).map((row) => `
      <div class="log-row">
        <span class="log-status">${LOG_ICONS[row.state] || '·'}</span>
        <div><strong>${esc(row.title)}</strong>${row.detail ? `<p>${esc(row.detail)}</p>` : ''}</div>
        <span class="log-state">${esc(row.state)}</span>
      </div>`).join('');
    log.scrollTop = log.scrollHeight;

    if (job.status === 'running') return 'running';
    $('#progress-ring').hidden = true;
    if (job.status === 'done') {
      $('#progress-title').textContent = 'Отчёт готов';
      $('#progress-pill').textContent = 'Завершено';
      $('#open-result').hidden = false;
      $('#open-result').onclick = () => openReport(job.company_id);
      return 'done';
    }
    if (job.status === 'cancelled') {
      $('#progress-title').textContent = 'Анализ отменён';
      $('#progress-pill').textContent = 'Отменено';
      return 'cancelled';
    }
    $('#progress-title').textContent = 'Ошибка анализа';
    $('#progress-pill').textContent = 'Ошибка';
    showToast(job.error || 'Анализ завершился с ошибкой');
    return 'failed';
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!state.jobId) return stopPolling();
      try {
        const job = await api(`/api/jobs/${state.jobId}`);
        const result = renderJob(job);
        if (result !== 'running') {
          stopPolling();
          if (result === 'done') openReport(job.company_id);
          refreshCompanies();
        }
      } catch { stopPolling(); }
    }, 1200);
  }
  const stopPolling = () => { clearInterval(state.pollTimer); state.pollTimer = null; };

  $('#cancel-btn').addEventListener('click', async () => {
    if (!state.jobId) { setView('new'); return; }
    try { await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' }); showToast('Отменяем…'); }
    catch { setView('new'); }
  });

  // ---------- история ----------

  async function refreshCompanies() {
    state.companies = await api('/api/companies');
    renderHistory();
    renderSideLast();
    $('#provider-hint').textContent = state.settings?.provider === 'custom' ? 'ИИ: свой провайдер' : 'ИИ: Codex CLI';
  }

  function renderSideLast() {
    const last = state.companies.find((c) => c.status === 'ready');
    $('#side-last').hidden = !last;
    if (!last) return;
    $('#side-last-name').textContent = last.name;
    $('#side-last-note').textContent = `${fmtDate(last.updated_at)} · ${last.media_count} медиа`;
    $('#side-last-open').onclick = () => openReport(last.id);
  }

  function renderHistory() {
    const list = $('#history-list');
    const query = $('#history-search').value.trim().toLowerCase();
    const items = state.companies.filter((c) => {
      const company = (() => { try { return JSON.parse(c.report_json || '{}').company || {}; } catch { return {}; } })();
      const haystack = `${c.name} ${company.city || ''} ${company.category || ''}`.toLowerCase();
      return haystack.includes(query);
    });
    $('#history-count').textContent = `${items.length} ${plural(items.length, 'проект', 'проекта', 'проектов')}`;
    $('#history-empty').hidden = items.length !== 0;

    list.innerHTML = items.map((c) => {
      let company = {};
      let services = [];
      try { const r = JSON.parse(c.report_json || '{}'); company = r.company || {}; services = r.services || []; }
      catch { /* отчёт ещё не сформирован */ }
      const statusPill = c.status === 'ready' ? '<span class="pill">Готов</span>'
        : c.status === 'processing' ? '<span class="pill">В работе</span>'
        : '<span class="pill">Ошибка</span>';
      const sub = [company.category, company.city].filter(Boolean).join(' · ') || `${c.source_count} ${plural(c.source_count, 'источник', 'источника', 'источников')}`;
      const tags = [
        c.source_count ? `<span class="tag">${c.source_count} ${plural(c.source_count, 'источник', 'источника', 'источников')}</span>` : '',
        services.length ? `<span class="tag">${services.length} ${plural(services.length, 'услуга', 'услуги', 'услуг')}</span>` : '',
        c.media_count ? `<span class="tag">${c.media_count} медиа</span>` : '',
      ].join('');
      const logo = c.logo_file ? `<img src="/media/${c.id}/${c.logo_file}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : esc((c.name || '?').slice(0, 1).toUpperCase());
      return `
        <article class="history-row" data-id="${c.id}">
          <div class="history-logo">${logo}</div>
          <div class="history-main">
            ${statusPill}
            <h3>${esc(c.name)}</h3>
            <p>${esc(sub)}</p>
            <div class="history-tags">${tags}</div>
          </div>
          <div class="history-meta">
            <strong>${fmtDate(c.updated_at)}</strong>
            <span>${esc(c.slug)}</span>
          </div>
          <div class="history-actions">
            <button class="btn btn-secondary btn-arrow" type="button" data-open="${c.id}" ${c.status === 'ready' ? '' : 'disabled'}>Открыть отчёт</button>
            <button class="btn btn-ghost" type="button" data-delete="${c.id}" aria-label="Удалить проект">✕</button>
          </div>
        </article>`;
    }).join('');

    list.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => openReport(Number(btn.dataset.open))));
    list.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.delete);
      if (!confirm('Удалить проект вместе с медиа и отчётом?')) return;
      try { await api(`/api/companies/${id}`, { method: 'DELETE' }); showToast('Проект удалён'); refreshCompanies(); }
      catch (err) { showToast(err.message); }
    }));
  }

  $('#history-search').addEventListener('input', renderHistory);

  // ---------- отчёт ----------

  async function openReport(companyId) {
    try {
      state.report = await api(`/api/companies/${companyId}`);
    } catch (err) { showToast(err.message); return; }
    renderReport();
    setView('report');
    setTab('overview');
  }

  function renderReport() {
    const { report: r, name, updated_at, media, sources } = state.report;
    const company = r?.company || {};
    const services = r?.services || [];
    $('#report-name').textContent = name;
    $('#report-sub').textContent = [company.category, company.city].filter(Boolean).join(' · ');
    $('#report-date').textContent = `Собран ${fmtDate(updated_at)}`;
    $('#report-logo').innerHTML = state.report.logo_file
      ? `<img src="/media/${state.report.id}/${state.report.logo_file}" alt="Логотип" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
      : esc((name || '?').slice(0, 1).toUpperCase());

    // метрики (короткая цена для карточки, полный прайс остаётся в данных и экспорте)
    const shortPrice = (s) => {
      if (!s) return '—';
      if (s.length <= 42) return s;
      const m = /от\s+[\d\u00A0\s]+/i.exec(s);
      if (m) return `${m[0].replace(/\s+/g, ' ').trim()} ₽`;
      return `${s.split(/[;.]/)[0].slice(0, 38)}…`;
    };
    const pricedCount = services.filter((s) => s.price).length;
    $('#metric-services').textContent = services.length || '—';
    $('#metric-price').textContent = shortPrice(r?.price_summary || services.find((s) => s.price)?.price);
    $('#metric-price-note').textContent = pricedCount > 1
      ? `${pricedCount} позиций с ценами из открытых данных`
      : 'цены из открытых данных';
    $('#metric-media').textContent = media.length ? `${media.length} ${plural(media.length, 'файл', 'файла', 'файлов')}` : '—';

    // карточка компании
    const socialLinks = (company.socials || []).map((s) =>
      `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.url)}">${esc(s.name)}</a>`).join(' · ');
    const facts = [
      ['Позиционирование', esc(company.tagline || company.description)],
      ['Адрес', esc(company.address)],
      ['Телефон', esc((company.phones || []).join(' · '))],
      ['Почта', esc((company.emails || []).join(' · '))],
      ['Расписание', esc(company.hours)],
      ['Соцсети', socialLinks || null],
    ].filter(([, v]) => v);
    $('#report-facts').innerHTML = facts.map(([k, v]) => `<div class="fact-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');

    // готовность контента
    const readiness = [];
    if (company.description) readiness.push(['Описание компании', true]);
    if ((company.phones || []).length || (company.emails || []).length) readiness.push(['Контакты', true]);
    if (services.length) readiness.push([`${services.length} ${plural(services.length, 'услуга', 'услуги', 'услуг')}`, true]);
    if (r?.price_summary || services.some((s) => s.price)) readiness.push(['Цены', true]);
    if (media.length) readiness.push([`${media.length} медиа`, true]);
    if ((r?.promos || []).length) readiness.push(['Акции', true]);
    for (const w of r?.warnings || []) readiness.push([w, false]);
    if (!readiness.length) readiness.push(['Мало данных — проверьте источники', false]);
    $('#readiness-tags').innerHTML = readiness.map(([text, ok]) => `<span class="tag">${ok ? '' : '⚠ '}${esc(text)}</span>`).join('');
    $('#report-warnings').textContent = (r?.warnings || []).join(' ') || 'Все ключевые данные подтверждены источниками. Сервис не додумывает факты.';

    // таблица данных
    const srcLabel = (type) => ({ instagram: 'Instagram', twogis: '2ГИС', yandex: 'Яндекс Карты', website: 'Сайт' }[type] || type);
    const rows = [
      ['О компании', company.description || company.tagline || '', true],
      ['Услуги', services.map((s) => s.name).join(', '), !!services.length],
      ['Цены', r?.price_summary || services.filter((s) => s.price).map((s) => `${s.name}: ${s.price}`).join(' · '), !!(r?.price_summary || services.some((s) => s.price))],
      ['Акции', (r?.promos || []).map((p) => p.title).join(', '), !!(r?.promos || []).length],
      ['Контакты', [company.address, ...(company.phones || []), ...(company.emails || [])].filter(Boolean).join(' · '), !!(company.address || (company.phones || []).length)],
    ];
    $('#data-rows').innerHTML = rows.map(([section, value, ok]) => {
      const src = sources.find((s) => s.status === 'ok');
      return `<tr><td>${esc(section)}</td><td>${esc(value || 'не найдено')}</td><td>${esc(src ? srcLabel(src.type) : '—')}</td><td><span class="tag">${ok ? 'готово' : 'проверить'}</span></td></tr>`;
    }).join('');

    // медиа
    $('#media-empty').hidden = media.length !== 0;
    $('#media-grid').innerHTML = media.map((m) => `
      <article class="media-card">
        <a href="${m.url}" target="_blank" rel="noopener"><img src="${m.url}" alt="${esc(m.caption || '')}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--radius);border:1px solid var(--border);"></a>
        <h4>${m.kind === 'logo' ? 'Логотип' : esc(m.caption?.slice(0, 60) || 'Фотография')}</h4>
        <p>${m.width ? `${m.width}×${m.height} · ` : ''}${esc(m.source_type || '')}</p>
      </article>`).join('');

    // экспорт
    const base = `/api/companies/${state.report.id}/export`;
    $('#export-json').href = `${base}?format=zip`;
    $('#export-brief').href = `${base}?format=json`;
    $('#export-txt').href = `${base}?format=txt`;
  }

  const briefToTextLocal = () => {
    const r = state.report?.report;
    if (!r) return '';
    const c = r.company || {};
    const lines = [`${state.report.name}`, c.category, c.city].filter(Boolean).join(' · ');
    const parts = [lines];
    if (c.description) parts.push(c.description);
    if (r.price_summary) parts.push(`Цены: ${r.price_summary}`);
    if ((r.services || []).length) parts.push(`Услуги: ${r.services.map((s) => s.name).join(', ')}`);
    return parts.join('\n');
  };

  // ---------- настройки ----------

  function applySettings(s) {
    state.settings = s;
    $$('.provider-option').forEach((b) => b.classList.toggle('is-active', b.dataset.provider === s.provider));
    $$('.provider-panel').forEach((p) => { p.hidden = p.dataset.providerPanel !== s.provider; });
    $('#provider-name').value = s.custom.name || '';
    $('#provider-model').value = s.custom.model || '';
    $('#provider-url').value = s.custom.baseUrl || '';
    $('#custom-status').textContent = s.custom.baseUrl && s.custom.model ? (s.custom.hasKey ? 'Настроен' : 'Нужен API-ключ') : 'Не настроен';
    $('#crawl-delay').value = s.crawl.delayMs;
    $('#crawl-images').value = s.crawl.maxImages;
    $('#crawl-subpages').value = s.crawl.maxSubpages;
    $('#crawl-timeout').value = s.crawl.aiTimeoutSec;
    $('#crawl-headed').checked = s.crawl.headed !== false;
    $('#provider-hint').textContent = s.provider === 'custom' ? 'ИИ: свой провайдер' : 'ИИ: Codex CLI';
  }

  $$('.provider-option').forEach((btn) => btn.addEventListener('click', async () => {
    try { applySettings(await api('/api/settings', { method: 'PUT', body: { provider: btn.dataset.provider } })); }
    catch (err) { showToast(err.message); }
  }));

  $('#provider-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = [$('#provider-name'), $('#provider-model'), $('#provider-url')];
    const valid = fields.every((f) => f.value.trim() && f.validity.valid);
    fields.forEach((f) => f.setAttribute('aria-invalid', String(!f.value.trim())));
    $('#provider-error').hidden = valid;
    if (!valid) return;
    try {
      applySettings(await api('/api/settings', { method: 'PUT', body: { provider: 'custom', custom: {
        name: $('#provider-name').value.trim(),
        model: $('#provider-model').value.trim(),
        baseUrl: $('#provider-url').value.trim(),
        apiKey: $('#provider-key').value.trim(),
      } } }));
      $('#provider-key').value = '';
      showToast('Провайдер сохранён');
    } catch (err) { showToast(err.message); }
  });

  $('#crawl-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      applySettings(await api('/api/settings', { method: 'PUT', body: { crawl: {
        delayMs: Number($('#crawl-delay').value),
        maxImages: Number($('#crawl-images').value),
        maxSubpages: Number($('#crawl-subpages').value),
        aiTimeoutSec: Number($('#crawl-timeout').value),
        headed: $('#crawl-headed').checked,
      } } }));
      $('#crawl-status').textContent = 'Сохранено';
      showToast('Настройки сбора сохранены');
    } catch (err) { showToast(err.message); }
  });

  $('#toggle-key').addEventListener('click', () => {
    const key = $('#provider-key');
    const visible = key.type === 'text';
    key.type = visible ? 'password' : 'text';
    $('#toggle-key').textContent = visible ? 'Показать' : 'Скрыть';
    $('#toggle-key').setAttribute('aria-pressed', String(!visible));
  });

  $('#test-codex').addEventListener('click', async () => {
    const status = $('#codex-status');
    status.textContent = 'Проверяю…';
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: { target: 'codex' } });
      status.textContent = r.ok ? `Работает · ${r.detail}` : `Ошибка: ${r.detail}`;
    } catch (err) { status.textContent = err.message; }
  });

  $('#test-custom').addEventListener('click', async () => {
    const url = $('#provider-url').value.trim();
    const model = $('#provider-model').value.trim();
    if (!url || !model) { showToast('Заполните Base URL и ID модели'); return; }
    showToast('Проверяю подключение…');
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: { target: 'custom', custom: { baseUrl: url, model, apiKey: $('#provider-key').value.trim() || undefined } } });
      $('#custom-status').textContent = r.ok ? 'Работает' : 'Ошибка';
      showToast(r.ok ? `Подключение работает · ${r.detail}` : `Ошибка: ${r.detail}`);
    } catch (err) { showToast(err.message); }
  });

  // ---------- браузерный бустер ----------

  async function refreshBooster() {
    const badge = $('#booster-badge');
    const status = $('#booster-status');
    badge.textContent = 'проверяю…';
    try {
      const s = await api('/api/browser/status');
      if (s.chromium) {
        badge.textContent = 'готов';
        status.textContent = 'Playwright и Chromium установлены — защищённые площадки будут открываться браузером.';
      } else if (s.installed) {
        badge.textContent = 'нужен Chromium';
        status.textContent = 'Playwright есть, но Chromium не скачан. Нажмите «Установить бустер» или выполните: npx playwright install chromium';
      } else {
        badge.textContent = 'не установлен';
        status.textContent = 'Бустер не установлен. Обычные сайты работают, 2ГИС/Яндекс/Instagram могут блокировать.';
      }
    } catch (err) { badge.textContent = 'ошибка'; status.textContent = err.message; }
  }

  $('#booster-refresh').addEventListener('click', refreshBooster);
  $('#booster-install').addEventListener('click', async () => {
    try {
      await api('/api/browser/install', { method: 'POST' });
      showToast('Установка запущена (npm). Занимает несколько минут — статус можно обновлять кнопкой');
      $('#booster-status').textContent = 'Установка запущена в фоне. Обновляйте статус, пока не появится «готов».';
    } catch (err) { showToast(err.message); }
  });

  // ---------- глобальные действия ----------

  document.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'new') { stopPolling(); setView('new'); }
    if (action === 'history') { setView('history'); refreshCompanies().catch(() => {}); }
    if (action === 'settings') { setView('settings'); refreshBooster(); }
    if (action === 'help') openModal('#help-modal');
    if (action === 'export') openModal('#export-modal');
    if (action === 'close-modal') closeModal(event.target.closest('.modal'));
    if (action === 'download-media') {
      window.location.href = `/api/companies/${state.report.id}/export?format=zip`;
      showToast('Архив с медиа готовится');
    }
    if (action === 'copy-summary' || action === 'copy-data') {
      const text = action === 'copy-summary' ? briefToTextLocal()
        : (state.report?.report?.services || []).map((s) => `${s.name}${s.price ? ` — ${s.price}` : ''}${s.description ? `. ${s.description}` : ''}`).join('\n');
      await navigator.clipboard.writeText(text).catch(() => null);
      showToast('Информация скопирована');
    }
  });

  $$('.modal').forEach((modal) => modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(modal);
  }));
  document.addEventListener('keydown', (event) => {
    const open = $$('.modal').find((m) => !m.hidden);
    if (!open) return;
    if (event.key === 'Escape') closeModal(open);
    if (event.key === 'Tab') {
      const focusable = [...open.querySelectorAll('button:not([disabled]), a[href]')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  tabs.forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.tab)));

  // ---------- запуск ----------

  (async () => {
    try { applySettings(await api('/api/settings')); } catch { /* сервер недоступен */ }
    try { await refreshCompanies(); } catch { /* сервер недоступен */ }
    try {
      const { job, running } = await api('/api/jobs/active');
      if (job) {
        state.jobId = job.id;
        $('#progress-company').textContent = `Задание #${job.id}`;
        renderJob(job);
        setView('progress');
        startPolling();
        if ((running || []).length > 1) {
          showToast(`Ещё ${(running || []).length - 1} анализ(а) выполняются в фоне — статус в «Истории»`);
        }
        return;
      }
    } catch { /* нет активных заданий */ }
    setView(localStorage.getItem('sitescope-view') || 'new');
    setTab('overview');
  })();
})();
