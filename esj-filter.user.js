// ==UserScript==
// @name         ESJ 小说筛选助手
// @namespace    local.esj-filter
// @version      1.2.1
// @description  为 ESJ Zone 添加小说、作者和标签屏蔽，支持 18+ 筛选与跨页递进浏览。
// @homepageURL  https://github.com/yuanmoukong-afk/esj-filter
// @supportURL   https://github.com/yuanmoukong-afk/esj-filter/issues
// @downloadURL  https://raw.githubusercontent.com/yuanmoukong-afk/esj-filter/main/esj-filter.user.js
// @updateURL    https://raw.githubusercontent.com/yuanmoukong-afk/esj-filter/main/esj-filter.user.js
// @match        https://www.esjzone.one/*
// @match        https://esjzone.one/*
// @match        https://www.esjzone.cc/*
// @match        https://esjzone.cc/*
// @run-at       document-end
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '1.2.1';
  if (window.top !== window.self) return;
  const existingStyle = document.getElementById('esjf-style');
  if (existingStyle) {
    if (existingStyle.dataset.esjfVersion !== VERSION && !document.getElementById('esjf-version-conflict')) {
      const warning = document.createElement('div');
      warning.id = 'esjf-version-conflict';
      warning.dataset.esjfUi = '';
      warning.setAttribute('role', 'alert');
      warning.textContent = 'ESJ 筛选助手 ' + VERSION + ' 检测到旧版也在运行。请在油猴中停用重复的旧版，保留新版，然后刷新页面。';
      warning.style.cssText = 'position:fixed;top:12px;left:12px;right:12px;z-index:2147483647;padding:14px 18px;border:1px solid #d29e38;border-radius:8px;background:#fff4d6;color:#61440e;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 3px 16px #0002';
      (document.body || document.documentElement).append(warning);
    }
    return;
  }

  const PREFIX = 'esjf:v1:';
  const CHANGE = PREFIX + 'change';
  const MODE = PREFIX + 'adult';
  const UNDO = PREFIX + 'undo';
  const TAGS_INIT = PREFIX + 'tags-initialized';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const networkAllowed = hostsForNetwork();
  const MODES = ['all', 'only', 'exclude'];
  const PAGE_SIZE = 50;
  const hosts = ['esjzone.one', 'www.esjzone.one', 'esjzone.cc', 'www.esjzone.cc'];
  const siteOrigin = hosts.includes(location.hostname) ? location.origin : 'https://www.esjzone.one';
  const nativeGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
    && typeof GM_deleteValue === 'function' && typeof GM_listValues === 'function';
  const storage = nativeGM ? {
    get: (key, fallback) => GM_getValue(key, fallback),
    set: (key, value) => GM_setValue(key, value),
    delete: key => GM_deleteValue(key),
    keys: () => GM_listValues(),
  } : {
    // Used by the included offline trial. Installed userscripts use GM storage.
    get(key, fallback) {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
    delete: key => localStorage.removeItem(key),
    keys: () => Object.keys(localStorage),
  };

  let books = new Map();
  let authors = new Map();
  let tags = new Map();
  const metadata = new Map();
  const pageTagSnapshots = new Map();
  const failedLookups = new Set();
  let lookupRunning = false;
  let lookupPaused = '';
  let progress = null;
  let progressDemo = null;
  if (!networkAllowed) {
    try { progressDemo = JSON.parse(document.getElementById('esjf-progress-demo-data')?.textContent || 'null'); } catch { /* Invalid demo data never enables requests. */ }
  }
  let adultMode = 'all';
  let reveal = false;
  let cards = [];
  let toolbar = null;
  let dialog = null;
  let dialogTab = 'books';
  let dialogQuery = '';
  let dialogPage = 0;
  let selection = new Set();
  let focusBeforeDialog = null;
  let toastTimer = null;
  let scanTimer = null;
  let lastUndo = null;
  const cardStates = new WeakMap();
  const normalName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const bookKey = id => PREFIX + 'book:' + id;
  const authorKey = name => PREFIX + 'author:' + encodeURIComponent(normalName(name));
  const tagKey = name => PREFIX + 'tag:' + encodeURIComponent(normalName(name));
  const metadataKey = id => PREFIX + 'metadata:' + id;
  const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function hostsForNetwork() {
    return location.protocol === 'https:' && /^(?:www\.)?esjzone\.(?:one|cc)$/.test(location.hostname);
  }

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function button(text, action, className) {
    const el = node('button', text, className);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  }

  function readState() {
    const nextBooks = new Map();
    const nextAuthors = new Map();
    const nextTags = new Map();
    for (const key of storage.keys()) {
      if (key.startsWith(PREFIX + 'book:')) {
        const record = storage.get(key, null);
        if (record && /^\d{1,30}$/.test(record.id) && typeof record.title === 'string') {
          nextBooks.set(record.id, record);
        }
      } else if (key.startsWith(PREFIX + 'author:')) {
        const record = storage.get(key, null);
        if (record && typeof record.name === 'string' && normalName(record.name)) {
          nextAuthors.set(normalName(record.name), record);
        }
      } else if (key.startsWith(PREFIX + 'tag:')) {
        const record = storage.get(key, null);
        if (record && typeof record.name === 'string' && normalName(record.name)) nextTags.set(normalName(record.name), record);
      }
    }
    books = nextBooks;
    authors = nextAuthors;
    tags = nextTags;
    const mode = storage.get(MODE, 'all');
    adultMode = MODES.includes(mode) ? mode : 'all';
    const undo = storage.get(UNDO, null);
    lastUndo = undo && Array.isArray(undo.added) ? undo : null;
  }

  function publish() {
    // Separate per-item keys prevent concurrent pages overwriting the whole list.
    storage.set(CHANGE, Date.now() + ':' + Math.random());
    readState();
    scan();
    if (dialog) renderDialog();
  }

  function addRecords(entries, message) {
    const added = [];
    for (const [key, value] of entries) {
      if (storage.get(key, null) !== null) continue;
      storage.set(key, value);
      added.push({ key, value });
    }
    if (!added.length) {
      toast('这些内容已经在屏蔽名单中。');
      return;
    }
    storage.set(UNDO, { added });
    publish();
    toast(message.replace('{n}', String(added.length)), true);
  }

  function undoLast() {
    const undo = storage.get(UNDO, null);
    if (!undo || !Array.isArray(undo.added)) return;
    let restored = 0;
    for (const item of undo.added) {
      if (!item || typeof item.key !== 'string'
        || !['book:', 'author:', 'tag:'].some(kind => item.key.startsWith(PREFIX + kind))) continue;
      // Never remove a record independently replaced after this action.
      if (sameRecord(storage.get(item.key, null), item.value)) {
        storage.delete(item.key);
        restored++;
      }
    }
    storage.delete(UNDO);
    publish();
    toast('已撤销，恢复 ' + restored + ' 项。');
  }

  function restore(keys) {
    for (const key of keys) storage.delete(key);
    storage.delete(UNDO);
    selection.clear();
    publish();
    toast('已取消屏蔽。');
  }

  function bookId(href, includeChapter = false) {
    try {
      const url = new URL(href, siteOrigin);
      if (!hosts.includes(url.hostname)) return null;
      const match = url.pathname.match(includeChapter ? /^\/(?:detail|forum)\/(\d{1,30})(?:\.html|\/)/ : /^\/detail\/(\d{1,30})\.html$/);
      return match ? match[1] : null;
    } catch { return null; }
  }

  function authorName(link) {
    if (!link) return '';
    try {
      const url = new URL(link.getAttribute('href'), siteOrigin);
      const match = url.pathname.match(/^\/tags\/([^/]+)\/?$/);
      if (hosts.includes(url.hostname) && match) return decodeURIComponent(match[1]).trim();
    } catch { /* Fall back to the actual author field text. */ }
    return link.textContent.trim();
  }

  function isAdult(container) {
    return [...container.querySelectorAll('.product-badge')].some(badge => /18\s*\+|\bR\s*-?\s*18\b/i.test(badge.textContent));
  }

  function baseFiltered(info) {
    return books.has(info.id) || (info.author && authors.has(normalName(info.author)))
      || (adultMode === 'only' && !info.adult) || (adultMode === 'exclude' && info.adult);
  }

  function filtered(info) {
    return baseFiltered(info) || (metadata.get(info.id)?.tags || []).some(name => tags.has(normalName(name)));
  }

  function contentTagSections(doc) {
    return [...doc.querySelectorAll('section.widget-tags, .widget.widget-tags')].filter(section => {
      const heading = section.querySelector('.widget-title, h3, h4');
      return heading && /^(?:內容標籤|内容标签)[:：]?$/.test(heading.textContent.replace(/\s+/g, ''));
    });
  }

  function parseContentTags(doc) {
    // Only explicitly labelled book content tags; never title, author or hot searches.
    if (!doc.querySelector('.book-detail h2, h2.book-title')) return null;
    const sections = contentTagSections(doc);
    if (!sections.length) return null;
    const names = new Map();
    for (const section of sections) {
      for (const link of section.querySelectorAll('a.tag[href]')) {
        const name = authorName(link);
        if (name && name.length <= 200) names.set(normalName(name), name);
      }
    }
    return [...names.values()];
  }

  function rememberTags(id, names) {
    const record = { id, tags: names, updatedAt: Date.now() };
    metadata.set(id, record);
    storage.set(metadataKey(id), record);
    storage.set(CHANGE, Date.now() + ':' + Math.random());
  }

  function refreshMetadata(id) {
    const record = storage.get(metadataKey(id), null);
    if (record && record.id === id && Array.isArray(record.tags)
      && record.tags.every(name => typeof name === 'string') && Number.isFinite(record.updatedAt)) metadata.set(id, record);
    else metadata.delete(id);
  }

  function freshMetadata(id) {
    const record = metadata.get(id);
    return record && Date.now() - record.updatedAt < CACHE_TTL;
  }

  function unknownCandidates() {
    return cards.filter(info => !baseFiltered(info) && !freshMetadata(info.id));
  }

  async function fetchBookTags(info, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 12000);
    try {
      const response = await fetch(location.origin + '/detail/' + info.id + '.html', {
        credentials: 'same-origin', signal: controller.signal, redirect: 'follow',
      });
      if (!response.ok) throw new Error(response.status === 429 ? '网站限制了请求，请稍后重试' : '网站未能返回书籍信息，请稍后重试');
      if (!/^text\/html\b/i.test(response.headers.get('content-type') || '')) throw new Error('未收到正常书籍页面，请重试核对');
      if (bookId(response.url, true) !== info.id) throw new Error('书籍页面发生跳转，请确认登录后重试');
      const html = await response.text();
      if (html.length > 4 * 1024 * 1024) throw new Error('书籍页面过大，暂时无法核对');
      const names = parseContentTags(parseInertHTML(html));
      if (names === null) throw new Error('标签未能读取，请确认 ESJ 已登录后重试');
      rememberTags(info.id, names);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function parseInertHTML(html) {
    return new DOMParser().parseFromString(html.replace(/<(?:img|iframe|link|object|embed)\b[^>]*>/gi, ''), 'text/html');
  }

  async function lookupTags() {
    if (lookupRunning || lookupPaused || !networkAllowed || !tags.size || progress?.active) return;
    if (!unknownCandidates().some(info => !failedLookups.has(info.id))) return;
    lookupRunning = true;
    scan();
    try {
      while (tags.size && !lookupPaused && !progress?.active) {
        const next = unknownCandidates().find(info => !failedLookups.has(info.id));
        if (!next) break;
        try {
          await fetchBookTags(next);
          scan();
        } catch (error) {
          failedLookups.add(next.id);
          // Stop after one failure, rather than repeatedly hitting login/challenge pages.
          lookupPaused = error.name === 'AbortError' ? '标签核对超时，请稍后重试' : error.message;
        }
        if (!lookupPaused && tags.size && unknownCandidates().some(info => !failedLookups.has(info.id))) {
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      }
    } finally { lookupRunning = false; scan(); }
  }

  function cardInfos(doc) {
    const result = [];
    const visited = new Set();
    for (const link of doc.querySelectorAll('.card-title a[href], .product-title a[href]')) {
      const id = bookId(link.getAttribute('href'));
      const card = link.closest('.card, .product-item');
      if (!id || !card || visited.has(card) || card.closest('[data-esjf-ui]')) continue;
      visited.add(card);
      const info = { id, title: link.textContent.trim() || card.getAttribute('title') || id,
        author: authorName(card.querySelector('.card-author a, .book-author a, .product-author a')),
        adult: isAdult(card), card, container: card };
      const parent = card.parentElement;
      if (parent && [...parent.classList].some(name => /^col-(?:xs|sm|md|lg|xl)-\d+$/.test(name)) && parent.querySelectorAll('.card, .product-item').length === 1) info.container = parent;
      result.push(info);
    }
    return result;
  }

  function sourcePagination(doc, href) {
    const url = new URL(href, siteOrigin);
    if (!hosts.includes(url.hostname)) return null;
    const match = url.pathname.match(/^(\/list-\d+\/|\/tags(?:-\d+)?\/[^/]+\/)(?:(\d+)\.html)?$/);
    if (!match) return null;
    const current = Number(match[2] || 1);
    let total = null;
    for (const li of doc.querySelectorAll('#page-selection li[data-lp], .pagination li[data-lp]')) {
      if (li.classList.contains('last')) total = Number(li.getAttribute('data-lp'));
    }
    // ESJ initializes bootpag from inline numeric configuration. Read those
    // numbers without executing fetched scripts, even if links are not yet built.
    for (const script of doc.querySelectorAll('script:not([src])')) {
      if (!script.textContent.includes('bootpag') || !script.textContent.includes('page-selection')) continue;
      const number = script.textContent.match(/\btotal\s*:\s*(\d+)/);
      if (number) total = Number(number[1]);
    }
    const make = page => { const next = new URL(url); next.pathname = match[1] + page + '.html'; next.hash = ''; return next.href; };
    return { current, total, prefix: match[1], first: make(1), next: total !== null && current >= total ? null : make(current + 1) };
  }

  function progressEntries(state) {
    return state.entries.filter(info => {
      refreshMetadata(info.id);
      return !baseFiltered(info) && (!tags.size || freshMetadata(info.id)) && !filtered(info);
    });
  }

  function pendingProgressMetadata(state) {
    return tags.size ? state.entries.find(info => !baseFiltered(info) && !freshMetadata(info.id)) : null;
  }

  function cloneProgressCard(info) {
    const template = document.createElement('template');
    template.innerHTML = info.html;
    const wrapper = template.content.firstElementChild;
    wrapper.querySelectorAll('script, iframe, object, embed, style, link, .esjf-actions').forEach(el => el.remove());
    for (const el of [wrapper, ...wrapper.querySelectorAll('*')]) {
      el.removeAttribute('data-esjf-hidden');
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      for (const name of ['href', 'src']) {
        if (!el.hasAttribute(name)) continue;
        try {
          const value = new URL(el.getAttribute(name), info.source);
          if (!['https:', 'http:'].includes(value.protocol)) el.removeAttribute(name);
          else el.setAttribute(name, value.href);
        } catch { el.removeAttribute(name); }
      }
    }
    for (const cover of wrapper.querySelectorAll('.lazyload[data-src]')) {
      try {
        const url = new URL(cover.getAttribute('data-src'), info.source);
        if (['https:', 'http:'].includes(url.protocol)) cover.style.backgroundImage = 'url(' + JSON.stringify(url.href) + ')';
      } catch { /* A missing cover does not affect filtering. */ }
    }
    wrapper.dataset.esjfProgress = '';
    return wrapper;
  }

  function renderProgress() {
    if (!progress?.active) return;
    const visible = progressEntries(progress).slice(0, progress.target);
    const signature = visible.map(info => info.id).join(',');
    if (signature !== progress.signature) {
      progress.signature = signature;
      progress.grid.replaceChildren(...visible.map(cloneProgressCard));
    }
  }

  function appendSourcePage(state, doc, url) {
    for (const info of cardInfos(doc)) {
      if (state.seen.has(info.id)) continue;
      state.seen.add(info.id);
      state.entries.push({ id: info.id, title: info.title, author: info.author, adult: info.adult,
        html: info.container.outerHTML, source: url });
    }
  }

  async function requestSourcePage(url, signal) {
    if (progressDemo) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const html = progressDemo.pages?.[new URL(url).pathname];
      if (typeof html !== 'string') throw new Error('演示页不存在');
      return { doc: parseInertHTML(html), url };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, 12000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(response.status === 429 ? '网站限制了请求，请稍后继续递进' : '列表读取失败，请稍后继续递进');
      if (!/^text\/html\b/i.test(response.headers.get('content-type') || '')) throw new Error('未收到正常小说列表');
      const expected = sourcePagination(document, url);
      const actual = sourcePagination(document, response.url);
      if (!actual || actual.prefix !== expected?.prefix || actual.current !== expected.current) throw new Error('列表发生跳转，请确认 ESJ 已登录后继续');
      const html = await response.text();
      if (html.length > 4 * 1024 * 1024) throw new Error('列表页面过大，暂时无法读取');
      const doc = parseInertHTML(html);
      if (!doc.querySelector('.shop-toolbar') && !cardInfos(doc).length) throw new Error('未能识别小说列表，请确认登录后继续');
      return { doc, url: response.url };
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }

  async function fillProgress() {
    const state = progress;
    if (!state?.active || state.loading || state.paused || state.error) return;
    state.loading = true;
    state.controller = new AbortController();
    scan();
    try {
      while (lookupRunning && state.active && !state.controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 50));
      while (state.active && !state.controller.signal.aborted) {
        const ready = progressEntries(state);
        const unknown = pendingProgressMetadata(state);
        if (!unknown && ready.length >= state.target) break;
        if (unknown) {
          if (!networkAllowed) throw new Error('这份演示未收录该书标签');
          state.phase = '核对小说标签';
          scan();
          await fetchBookTags(unknown, state.controller.signal);
          scan();
        } else {
          if (!state.next) { state.exhausted = true; break; }
          if (state.visited.has(state.next)) throw new Error('分页重复，已停止递进');
          const next = state.next;
          state.phase = '读取后续列表';
          scan();
          const loaded = await requestSourcePage(next, state.controller.signal);
          if (!state.active || state.controller.signal.aborted) break;
          const paging = sourcePagination(loaded.doc, loaded.url);
          if (!paging) throw new Error('未能识别下一页');
          state.visited.add(next);
          state.lastPage = paging.current;
          appendSourcePage(state, loaded.doc, loaded.url);
          state.next = cardInfos(loaded.doc).length ? paging.next : null;
          scan();
        }
        if (progressEntries(state).length < state.target) await new Promise(resolve => setTimeout(resolve, progressDemo ? 20 : 350));
      }
    } catch (error) {
      if (state.active && !state.paused) state.error = error.name === 'AbortError' ? '读取超时，可继续递进重试' : error.message;
    } finally {
      state.loading = false;
      if (progress === state && state.active) scan();
    }
  }

  function startProgress() {
    if (progress?.active) {
      if (progress.loading) return;
      const more = progressEntries(progress).length >= progress.target;
      if (more) progress.target += 40;
      progress.error = '';
      progress.paused = false;
      lookupPaused = '';
      fillProgress();
      return;
    }
    const href = progressDemo?.startUrl || location.href;
    const paging = sourcePagination(document, href);
    if (!paging || (!networkAllowed && !progressDemo)) return;
    const first = cards.find(info => info.container.parentElement && info.container.parentElement.querySelector('.card-title, .product-title'));
    if (!first) { toast('当前页面没有可用于递进的小说列表。'); return; }
    const grid = first.container.parentElement;
    const pager = document.querySelector('#page-selection') || document.querySelector('.pagination');
    progress = { active: true, entries: [], seen: new Set(), visited: new Set(), grid, original: [...grid.childNodes],
      pager, target: 40, signature: null, loading: false, paused: false, error: '', exhausted: false,
      next: paging.current === 1 ? paging.next : paging.first, lastPage: paging.current === 1 ? 1 : 0, phase: '' };
    if (paging.current === 1) { appendSourcePage(progress, document, href); progress.visited.add(paging.first); }
    if (pager) pager.setAttribute('data-esjf-progress-pagination', 'true');
    reveal = false;
    lookupPaused = '';
    scan();
    fillProgress();
  }

  function stopProgress() {
    if (!progress) return;
    progress.paused = true;
    progress.controller?.abort();
    scan();
  }

  function leaveProgress() {
    if (!progress) return;
    const state = progress;
    state.active = false;
    state.controller?.abort();
    progress = null;
    state.grid.replaceChildren(...state.original);
    state.pager?.removeAttribute('data-esjf-progress-pagination');
    scan();
  }

  function addTagNames(value) {
    const names = [...new Map(value.split(/[\n,，、;；]+/).map(name => name.trim()).filter(Boolean).map(name => [normalName(name), name])).values()];
    if (!names.length || names.some(name => name.length > 200)) { toast('请输入有效的网站标签，每行一个。'); return; }
    addRecords(names.map(name => [tagKey(name), { name }]), '已添加 {n} 个屏蔽标签。');
    if (dialog) dialog.querySelector('#esjf-add-tags').value = '';
  }

  function observePageTags() {
    const match = location.pathname.match(/^\/(?:detail\/(\d{1,30})\.html|forum\/(\d{1,30})\/\d+\.html)$/);
    if (!match || !networkAllowed) return;
    const names = parseContentTags(document);
    if (names === null) return;
    const id = match[1] || match[2];
    refreshMetadata(id);
    const snapshot = JSON.stringify(names);
    // Learn this document once, or when its tag DOM actually changes. A remote
    // cache update must not make an older open detail page overwrite it repeatedly.
    if (pageTagSnapshots.get(id) !== snapshot) {
      pageTagSnapshots.set(id, snapshot);
      rememberTags(id, names);
    }
    for (const section of contentTagSections(document)) {
      for (const link of section.querySelectorAll('a.tag[href]')) {
        const name = authorName(link);
        let action = link.nextElementSibling;
        if (!action?.classList.contains('esjf-tag-action')) {
          action = button('', () => {
            if (tags.has(normalName(name))) restore([tagKey(name)]);
            else addTagNames(name);
          }, 'esjf-tag-action');
          action.dataset.esjfUi = '';
          action.setAttribute('aria-label', '切换标签屏蔽：' + name);
          link.after(action);
        }
        action.textContent = tags.has(normalName(name)) ? '恢复' : '屏蔽';
      }
    }
  }

  function markHidden(el, hidden) {
    if (hidden) el.setAttribute('data-esjf-hidden', 'true');
    else el.removeAttribute('data-esjf-hidden');
  }

  function blockBook(info) {
    addRecords([[bookKey(info.id), { id: info.id, title: info.title, author: info.author }]], '已隐藏这本小说。');
  }

  function blockAuthor(info) {
    if (!info.author) return;
    addRecords([[authorKey(info.author), { name: info.author }]], '已屏蔽作者「' + info.author + '」。');
  }

  function pageCandidates() {
    const unique = new Map();
    for (const info of cards) {
      if ((reveal || !filtered(info)) && !books.has(info.id)) unique.set(info.id, info);
    }
    return [...unique.values()];
  }

  function blockPage() {
    if (tags.size && lookupRunning && unknownCandidates().length) return;
    const current = pageCandidates();
    if (!current.length) return;
    addRecords(current.map(info => [bookKey(info.id), { id: info.id, title: info.title, author: info.author }]), '已屏蔽本页 {n} 本小说，可一键撤销。');
  }

  function createActions(card) {
    const actions = node('div', undefined, 'esjf-actions');
    actions.dataset.esjfUi = '';
    const hide = button('隐藏此书', () => {
      const info = cardStates.get(card);
      if (!info) return;
      if (books.has(info.id)) restore([bookKey(info.id)]);
      else blockBook(info);
    });
    hide.dataset.action = 'book';
    const author = button('屏蔽作者', () => {
      const info = cardStates.get(card);
      if (!info || !info.author) return;
      if (authors.has(normalName(info.author))) restore([authorKey(info.author)]);
      else blockAuthor(info);
    });
    author.dataset.action = 'author';
    actions.append(hide, author);
    (card.querySelector('.card-body') || card).append(actions);
    return actions;
  }

  function refreshActions(info, actions) {
    const hide = actions.querySelector('[data-action="book"]');
    const author = actions.querySelector('[data-action="author"]');
    hide.textContent = books.has(info.id) ? '恢复此书' : '隐藏此书';
    author.textContent = authors.has(normalName(info.author)) ? '恢复作者' : '屏蔽作者';
    author.disabled = !info.author;
    author.title = info.author ? info.author : '当前条目没有作者信息';
  }

  function ensureToolbar(anchor) {
    if (toolbar && toolbar.isConnected) return;
    toolbar = node('section', undefined, 'esjf-toolbar');
    toolbar.id = 'esjf-toolbar';
    toolbar.dataset.esjfUi = '';
    toolbar.setAttribute('aria-label', '小说筛选');
    const first = node('div', undefined, 'esjf-toolbar-row');
    first.append(node('strong', '小说筛选', 'esjf-toolbar-title'));
    first.append(node('small', 'v' + VERSION, 'esjf-version'));
    const modes = node('div', undefined, 'esjf-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '18+ 筛选');
    for (const [mode, text] of [['all', '全部'], ['only', '只看 18+'], ['exclude', '隐藏 18+']]) {
      const control = button(text, () => {
        reveal = false;
        storage.set(MODE, mode);
        publish();
      });
      control.dataset.mode = mode;
      modes.append(control);
    }
    first.append(modes, button('屏蔽名单', openDialog, 'esjf-manage-button'));
    const tagRow = node('div', undefined, 'esjf-toolbar-row esjf-tag-row');
    const tagManage = button('屏蔽标签', () => openDialog('tags'));
    tagManage.id = 'esjf-tag-manage';
    const tagStatus = node('span', '', 'esjf-tag-status');
    tagStatus.id = 'esjf-tag-status';
    tagStatus.setAttribute('aria-live', 'polite');
    const retry = button('重试核对', () => { lookupPaused = ''; failedLookups.clear(); lookupTags(); });
    retry.id = 'esjf-tag-retry';
    tagRow.append(tagManage, tagStatus, retry);
    const second = node('div', undefined, 'esjf-toolbar-row');
    const stats = node('span', '', 'esjf-stats');
    stats.id = 'esjf-stats';
    stats.setAttribute('aria-live', 'polite');
    const pageButton = button('屏蔽本页', blockPage);
    pageButton.id = 'esjf-block-page';
    pageButton.title = '只屏蔽本页当前显示的小说，不屏蔽作者；可撤销。';
    const revealButton = button('临时显示隐藏', () => { reveal = !reveal; scan(); });
    revealButton.id = 'esjf-reveal';
    const undoButton = button('撤销上次屏蔽', undoLast);
    undoButton.id = 'esjf-undo';
    second.append(stats, pageButton, revealButton, undoButton);
    const progressRow = node('div', undefined, 'esjf-toolbar-row');
    const progressButton = button('递进浏览', startProgress);
    progressButton.id = 'esjf-progress';
    const progressStatus = node('span', '', 'esjf-tag-status');
    progressStatus.id = 'esjf-progress-status';
    progressStatus.setAttribute('aria-live', 'polite');
    const stop = button('停止加载', stopProgress);
    stop.id = 'esjf-progress-stop';
    const back = button('返回原页', leaveProgress);
    back.id = 'esjf-progress-back';
    progressRow.append(progressButton, progressStatus, stop, back);
    toolbar.append(first, tagRow, progressRow, second);
    anchor.before(toolbar);
  }

  function detailInfo() {
    const match = location.pathname.match(/^\/detail\/(\d{1,30})\.html$/);
    if (!match) return null;
    const title = document.querySelector('.book-detail h2, h2.book-title');
    if (!title) return null;
    let author = '';
    for (const li of document.querySelectorAll('ul.book-detail li')) {
      if (/^\s*作者\s*[:：]/.test(li.textContent)) {
        author = authorName(li.querySelector('a'));
        break;
      }
    }
    return { id: match[1], title: title.textContent.trim(), author, adult: isAdult(title.closest('.book-detail') || title.parentElement), anchor: title };
  }

  function scan() {
    observePageTags();
    renderProgress();
    cards = [];
    for (const info of cardInfos(document)) {
      const { id, card } = info;
      refreshMetadata(id);
      cardStates.set(card, info);
      let actions = card.querySelector('.esjf-actions');
      if (!actions) actions = createActions(card);
      refreshActions(info, actions);
      markHidden(info.container, !reveal && filtered(info));
      cards.push(info);
    }

    const detail = detailInfo();
    const anchor = detail?.anchor || document.querySelector('.shop-toolbar') || cards[0]?.container.parentElement;
    if (anchor) ensureToolbar(anchor);
    if (toolbar && toolbar.isConnected) {
      for (const control of toolbar.querySelectorAll('[data-mode]')) control.setAttribute('aria-pressed', String(control.dataset.mode === adultMode));
      const hidden = cards.filter(filtered).length;
      toolbar.querySelector('#esjf-stats').textContent = progress?.active ? '递进结果 ' + cards.length + ' 本' : cards.length ? '本页 ' + cards.length + ' 本 · 显示 ' + (reveal ? cards.length : cards.length - hidden) + ' 本 · 已隐藏 ' + hidden + ' 本' : '';
      const pageButton = toolbar.querySelector('#esjf-block-page');
      const count = pageCandidates().length;
      pageButton.textContent = '屏蔽本页（' + count + '）';
      pageButton.disabled = count === 0 || (tags.size > 0 && lookupRunning && unknownCandidates().length > 0) || !!progress?.loading;
      pageButton.title = pageButton.disabled && count ? '先完成本页标签核对，再屏蔽剩余小说。' : '只屏蔽本页当前显示的小说，不屏蔽作者；可撤销。';
      pageButton.hidden = !cards.length;
      const revealButton = toolbar.querySelector('#esjf-reveal');
      revealButton.textContent = reveal ? '结束临时显示' : '临时显示隐藏';
      revealButton.setAttribute('aria-pressed', String(reveal));
      revealButton.hidden = !cards.length || !!progress?.active;
      toolbar.querySelector('#esjf-undo').hidden = !lastUndo;
      toolbar.querySelector('#esjf-tag-manage').textContent = '屏蔽标签（' + tags.size + '）';
      const unchecked = unknownCandidates().length;
      toolbar.querySelector('#esjf-tag-status').textContent = !tags.size ? '未设置屏蔽标签' : !cards.length ? ''
        : !unchecked ? '本页标签已核对' : lookupPaused ? lookupPaused + ' · ' + unchecked + ' 本尚未核对'
        : lookupRunning ? '正在核对标签 · 剩余 ' + unchecked + ' 本' : networkAllowed ? '等待核对标签'
        : '保存的列表未包含标签 · ' + unchecked + ' 本尚未核对';
      toolbar.querySelector('#esjf-tag-retry').hidden = !lookupPaused || !tags.size;
      const progressButton = toolbar.querySelector('#esjf-progress');
      const canProgress = (networkAllowed || progressDemo) && sourcePagination(document, progressDemo?.startUrl || location.href);
      progressButton.textContent = progress?.active ? progress.error || progress.paused ? '继续递进' : '继续递进（再补40本）' : '递进浏览';
      progressButton.disabled = !canProgress || !!progress?.loading || (!!progress?.exhausted && progressEntries(progress).length <= progress.target && !pendingProgressMetadata(progress));
      progressButton.title = canProgress ? '从当前分类和排序的第一页起，跨页补足未屏蔽的小说。' : '请在在线 ESJ 小说列表中使用跨页递进。';
      toolbar.querySelector('#esjf-progress-stop').hidden = !progress?.loading;
      toolbar.querySelector('#esjf-progress-back').hidden = !progress?.active;
      toolbar.querySelector('#esjf-progress-status').textContent = !progress?.active ? '跳过空页，把未屏蔽的小说补到前面'
        : progress.error ? progress.error : progress.paused ? '已停止加载，可继续递进'
        : progress.loading ? (progress.phase || '准备递进') + ' · 已查到第 ' + progress.lastPage + ' 页'
        : progress.exhausted ? '已到最后一页 · 共 ' + cards.length + ' 本可见小说'
        : '已查到第 ' + progress.lastPage + ' 页 · 可继续向后递进';
      let details = toolbar.querySelector('.esjf-detail-actions');
      if (detail) {
        if (!details) {
          details = node('div', undefined, 'esjf-detail-actions esjf-actions');
          details.dataset.esjfUi = '';
          details.append(button('', () => { const current = detailInfo(); if (!current) return; if (books.has(current.id)) restore([bookKey(current.id)]); else blockBook(current); }),
            button('', () => { const current = detailInfo(); if (!current?.author) return; if (authors.has(normalName(current.author))) restore([authorKey(current.author)]); else blockAuthor(current); }));
          details.children[0].dataset.action = 'book';
          details.children[1].dataset.action = 'author';
          toolbar.append(details);
        }
        refreshActions(detail, details);
      } else if (details) details.remove();
    }

    const byId = new Map(cards.map(info => [info.id, info]));
    for (const link of document.querySelectorAll('.widget-categories li a[href]')) {
      const id = bookId(link.getAttribute('href'), true);
      if (!id) continue;
      const item = link.closest('li');
      const info = byId.get(id);
      markHidden(item, !reveal && (books.has(id) || (info && filtered(info))));
    }
    if (progress?.active && !progress.loading && !progress.paused && !progress.error
      && (pendingProgressMetadata(progress) || (!progress.exhausted && progressEntries(progress).length < progress.target))) setTimeout(fillProgress, 0);
    if (tags.size && networkAllowed && !lookupRunning && !lookupPaused && !progress?.active) setTimeout(lookupTags, 0);
  }

  function toast(message, allowUndo = false) {
    let el = document.getElementById('esjf-toast');
    if (!el) {
      el = node('div', undefined, 'esjf-toast');
      el.id = 'esjf-toast';
      el.dataset.esjfUi = '';
      el.setAttribute('role', 'status');
      (dialog || document.body).append(el);
    }
    if (dialog && !dialog.contains(el)) dialog.append(el);
    clearTimeout(toastTimer);
    el.replaceChildren(node('span', message));
    if (allowUndo) el.append(button('撤销', undoLast));
    el.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; }, 10000);
  }

  function openDialog(initialTab = 'books') {
    if (dialog) return;
    focusBeforeDialog = document.activeElement;
    dialogTab = initialTab === 'tags' ? 'tags' : 'books';
    dialogQuery = '';
    dialogPage = 0;
    selection.clear();
    dialog = node('dialog', undefined, 'esjf-dialog');
    dialog.id = 'esjf-dialog';
    dialog.dataset.esjfUi = '';
    dialog.setAttribute('aria-labelledby', 'esjf-dialog-title');
    dialog.addEventListener('close', () => {
      dialog.remove();
      dialog = null;
      if (focusBeforeDialog?.isConnected && !focusBeforeDialog.closest('[data-esjf-hidden="true"]')) focusBeforeDialog.focus();
      else toolbar?.querySelector('.esjf-manage-button')?.focus();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    const header = node('div', undefined, 'esjf-dialog-header');
    const title = node('h2', '屏蔽名单');
    title.id = 'esjf-dialog-title';
    const close = button('关闭', () => dialog.close());
    close.setAttribute('aria-label', '关闭屏蔽名单');
    header.append(title, close);
    const tabs = node('div', undefined, 'esjf-tabs');
    for (const [tab, text] of [['books', '小说'], ['authors', '作者'], ['tags', '标签']]) {
      const control = button(text, () => {
        dialogTab = tab;
        dialogQuery = '';
        dialogPage = 0;
        selection.clear();
        dialog.querySelector('#esjf-search').value = '';
        renderDialog();
      });
      control.dataset.tab = tab;
      tabs.append(control);
    }
    const search = node('input');
    search.id = 'esjf-search';
    search.type = 'search';
    search.placeholder = '搜索书名、小说 ID、作者或标签';
    search.setAttribute('aria-label', '搜索屏蔽名单');
    search.addEventListener('input', () => { dialogQuery = search.value; dialogPage = 0; selection.clear(); renderDialog(); });
    const tools = node('div', undefined, 'esjf-dialog-tools');
    const selected = button('取消所选屏蔽', () => restore([...selection]));
    selected.id = 'esjf-restore-selected';
    const selectPage = button('全选本页', () => {
      for (const row of dialog.querySelectorAll('input[data-key]')) selection.add(row.dataset.key);
      renderDialog();
    });
    const file = node('input');
    file.id = 'esjf-import-file';
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', async () => {
      const chosen = file.files[0];
      file.value = '';
      if (!chosen) return;
      try {
        if (chosen.size > 5 * 1024 * 1024) throw new Error('备份文件超过 5 MB。');
        importBackup(JSON.parse(await chosen.text()));
      } catch (error) { toast('导入失败：' + error.message); }
    });
    tools.append(selectPage, selected, button('导出备份', exportBackup), button('导入备份', () => file.click()), file);
    const list = node('div', undefined, 'esjf-list');
    list.id = 'esjf-list';
    const pager = node('div', undefined, 'esjf-pager');
    pager.id = 'esjf-pager';
    const addTags = node('div', undefined, 'esjf-add-tags-row');
    addTags.id = 'esjf-add-tags-row';
    const tagInput = node('textarea');
    tagInput.id = 'esjf-add-tags';
    tagInput.rows = 2;
    tagInput.placeholder = '输入网站内容标签，每行一个，例如：百合、女性主角';
    tagInput.setAttribute('aria-label', '添加屏蔽标签');
    addTags.append(tagInput, button('添加标签', () => addTagNames(tagInput.value)), node('small', '匹配网站的内容标签；命中任意一个就隐藏。'));
    dialog.append(header, tabs, search, addTags, tools, list, pager);
    document.body.append(dialog);
    renderDialog();
    dialog.showModal();
    search.focus();
  }

  function renderDialog() {
    if (!dialog) return;
    for (const tab of dialog.querySelectorAll('[data-tab]')) {
      tab.textContent = (tab.dataset.tab === 'books' ? '小说（' + books.size : tab.dataset.tab === 'authors' ? '作者（' + authors.size : '标签（' + tags.size) + '）';
      tab.setAttribute('aria-pressed', String(tab.dataset.tab === dialogTab));
    }
    const query = normalName(dialogQuery);
    dialog.querySelector('#esjf-add-tags-row').hidden = dialogTab !== 'tags';
    const items = dialogTab === 'books' ? [...books.values()].map(record => ({ key: bookKey(record.id), title: record.title, note: 'ID ' + record.id + (record.author ? ' · ' + record.author : ''), href: siteOrigin + '/detail/' + record.id + '.html' }))
      : dialogTab === 'authors' ? [...authors.values()].map(record => ({ key: authorKey(record.name), title: record.name, note: '', href: siteOrigin + '/tags/' + encodeURIComponent(record.name) + '/' }))
      : [...tags.values()].map(record => ({ key: tagKey(record.name), title: record.name, note: '', href: siteOrigin + '/tags/' + encodeURIComponent(record.name) + '/' }));
    const matches = items.filter(item => normalName(item.title + ' ' + item.note).includes(query)).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
    const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    dialogPage = Math.min(dialogPage, totalPages - 1);
    const list = dialog.querySelector('#esjf-list');
    list.replaceChildren();
    for (const item of matches.slice(dialogPage * PAGE_SIZE, (dialogPage + 1) * PAGE_SIZE)) {
      const row = node('div', undefined, 'esjf-list-row');
      const check = node('input');
      check.type = 'checkbox';
      check.dataset.key = item.key;
      check.checked = selection.has(item.key);
      check.setAttribute('aria-label', '选择 ' + item.title);
      check.addEventListener('change', () => {
        if (check.checked) selection.add(item.key); else selection.delete(item.key);
        updateSelection();
      });
      const text = node('div', undefined, 'esjf-list-text');
      const link = node('a', item.title);
      link.href = item.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      text.append(link);
      if (item.note) text.append(node('small', item.note));
      row.append(check, text, button('取消屏蔽', () => restore([item.key])));
      list.append(row);
    }
    if (!matches.length) list.append(node('p', query ? '没有匹配的记录。' : '名单为空。', 'esjf-empty'));
    const pager = dialog.querySelector('#esjf-pager');
    const prev = button('上一页', () => { dialogPage--; renderDialog(); });
    prev.disabled = dialogPage === 0;
    const next = button('下一页', () => { dialogPage++; renderDialog(); });
    next.disabled = dialogPage >= totalPages - 1;
    pager.replaceChildren(prev, node('span', '第 ' + (dialogPage + 1) + ' / ' + totalPages + ' 页 · 共 ' + matches.length + ' 项'), next);
    updateSelection();
  }

  function updateSelection() {
    if (!dialog) return;
    const control = dialog.querySelector('#esjf-restore-selected');
    control.disabled = selection.size === 0;
    control.textContent = selection.size ? '取消所选屏蔽（' + selection.size + '）' : '取消所选屏蔽';
  }

  function exportBackup() {
    readState();
    const data = { format: 'esj-filter', version: 2, exportedAt: new Date().toISOString(),
      books: [...books.values()], authors: [...authors.values()], tags: [...tags.values()], adultMode };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = node('a');
    link.href = url;
    link.download = 'ESJ屏蔽名单-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出屏蔽名单。');
  }

  function importBackup(data) {
    if (!data || data.format !== 'esj-filter' || ![1, 2].includes(data.version) || !Array.isArray(data.books)
      || !Array.isArray(data.authors) || (data.version === 2 && !Array.isArray(data.tags))
      || !MODES.includes(data.adultMode)) throw new Error('不是有效的 ESJ 筛选助手备份。');
    if (data.books.length + data.authors.length + (data.tags?.length || 0) > 100000) throw new Error('记录数量过多。');
    const entries = new Map();
    // Validate the complete file first. Invalid files never partially modify lists.
    for (const record of data.books) {
      if (!record || typeof record.id !== 'string' || !/^\d{1,30}$/.test(record.id)
        || typeof record.title !== 'string' || !record.title.trim() || record.title.length > 500
        || (record.author !== undefined && (typeof record.author !== 'string' || record.author.length > 200))) throw new Error('小说记录格式有误。');
      const safe = { id: record.id, title: record.title.trim(), author: record.author || '' };
      entries.set(bookKey(safe.id), safe);
    }
    for (const record of data.authors) {
      if (!record || typeof record.name !== 'string' || !normalName(record.name) || record.name.length > 200) throw new Error('作者记录格式有误。');
      const safe = { name: record.name.trim() };
      entries.set(authorKey(safe.name), safe);
    }
    for (const record of data.version === 2 ? data.tags : []) {
      if (!record || typeof record.name !== 'string' || !normalName(record.name) || record.name.length > 200) throw new Error('标签记录格式有误。');
      const safe = { name: record.name.trim() };
      entries.set(tagKey(safe.name), safe);
    }
    let count = 0;
    for (const [key, value] of entries) {
      if (storage.get(key, null) === null) { storage.set(key, value); count++; }
    }
    storage.set(MODE, data.adultMode);
    storage.delete(UNDO);
    selection.clear();
    publish();
    toast('导入完成，新增 ' + count + ' 项；已有名单已保留。');
  }

  const style = node('style');
  style.id = 'esjf-style';
  style.dataset.esjfVersion = VERSION;
  style.dataset.esjfUi = '';
  style.textContent = `
    [data-esjf-hidden="true"] { display: none !important; }
    [data-esjf-progress-pagination="true"] { display: none !important; }
    .esjf-toolbar, .esjf-actions, .esjf-dialog, .esjf-toast { font-family: system-ui, "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.5; color: #253448; box-sizing: border-box; }
    .esjf-toolbar *, .esjf-dialog * { box-sizing: border-box; }
    .esjf-toolbar { display: flow-root; clear: both; padding: 14px 16px; margin-bottom: 22px; border: 1px solid #dce5ed; border-radius: 10px; background: #f7f9fc; }
    .esjf-toolbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; min-width: 0; }
    .esjf-toolbar-row + .esjf-toolbar-row { margin-top: 12px; }
    .esjf-toolbar-title { margin-right: 6px; font-size: 15px; flex-shrink: 0; }
    .esjf-version { color: #64758a; font-size: 11px; }
    .esjf-toolbar button, .esjf-actions button, .esjf-dialog button, .esjf-toast button { appearance: none; font: inherit; line-height: 1.45; cursor: pointer; border: 1px solid #cbd7e3; border-radius: 6px; padding: 6px 10px; color: #355576; background: #fff; white-space: nowrap; }
    .esjf-toolbar button:hover, .esjf-actions button:hover, .esjf-dialog button:hover { background: #edf3fa; border-color: #91acc7; }
    .esjf-toolbar button:disabled, .esjf-actions button:disabled, .esjf-dialog button:disabled { cursor: default; opacity: .45; }
    .esjf-toolbar button:focus-visible, .esjf-actions button:focus-visible, .esjf-dialog button:focus-visible, .esjf-dialog input:focus-visible, .esjf-toast button:focus-visible { outline: 2px solid #1d74b8; outline-offset: 2px; }
    .esjf-modes { display: inline-flex; gap: 0; }
    .esjf-modes button { border-radius: 0; }
    .esjf-modes button + button { margin-left: -1px; }
    .esjf-modes button:first-child { border-radius: 6px 0 0 6px; }
    .esjf-modes button:last-child { border-radius: 0 6px 6px 0; }
    .esjf-toolbar button[aria-pressed="true"], .esjf-tabs button[aria-pressed="true"] { background: #e1edfa; color: #195e99; border-color: #91acc7; position: relative; }
    .esjf-manage-button { margin-left: auto; }
    .esjf-stats { margin-right: auto; font-size: 12px; color: #64758a; }
    .esjf-tag-status { font-size: 12px; color: #64758a; flex: 1; min-width: 120px; }
    .esjf-tag-action { font: 11px/1.5 system-ui; border: 1px solid #cbd7e3; border-radius: 4px; background: #fff; color: #355576; padding: 2px 5px; margin: 0 7px 8px 2px; cursor: pointer; }
    .esjf-add-tags-row { margin-bottom: 14px; }
    #esjf-add-tags { width: 100%; resize: vertical; display: block; margin-bottom: 7px; padding: 8px 10px; font: inherit; color: inherit; border: 1px solid #cbd7e3; border-radius: 6px; }
    .esjf-add-tags-row small { display: block; color: #64758a; margin-top: 5px; }
    .esjf-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .esjf-actions button { font-size: 12px; padding: 4px 8px; }
    .esjf-dialog { width: min(700px, calc(100vw - 24px)); max-height: 85vh; padding: 20px; border: 1px solid #d6e1ec; border-radius: 12px; background: #fff; box-shadow: 0 16px 60px #172d4f33; }
    .esjf-dialog::backdrop { background: #172d4f66; }
    .esjf-dialog-header, .esjf-tabs, .esjf-dialog-tools, .esjf-pager { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .esjf-dialog-header { justify-content: space-between; margin-bottom: 14px; }
    .esjf-dialog h2 { margin: 0; font-size: 20px; font-weight: 600; color: inherit; }
    .esjf-tabs { margin-bottom: 12px; }
    #esjf-search { display: block; width: 100%; padding: 9px 11px; margin-bottom: 12px; font: inherit; color: inherit; border: 1px solid #cbd7e3; border-radius: 6px; background: #fff; }
    .esjf-dialog-tools { margin-bottom: 12px; }
    .esjf-dialog-tools button { font-size: 12px; }
    .esjf-list { max-height: 45vh; overflow-y: auto; overscroll-behavior: contain; }
    .esjf-list-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #e8edf3; }
    .esjf-list-row input { flex-shrink: 0; width: 16px; height: 16px; }
    .esjf-list-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .esjf-list-text a { color: #246594; text-decoration: none; }
    .esjf-list-text a:hover { text-decoration: underline; }
    .esjf-list-text small { display: block; color: #7b8798; margin-top: 3px; }
    .esjf-list-row button { flex-shrink: 0; font-size: 12px; }
    .esjf-pager { justify-content: center; margin-top: 14px; font-size: 12px; }
    .esjf-empty { margin: 30px 0; text-align: center; color: #7b8798; }
    .esjf-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 24px); padding: 12px 16px; background: #253448; color: #fff; border-radius: 9px; box-shadow: 0 4px 24px #172d4f33; z-index: 2147483646; }
    .esjf-toast button { background: transparent; color: #fff; border-color: #8fabc7; }
    .esjf-toolbar [hidden], .esjf-dialog [hidden], .esjf-toast[hidden] { display: none !important; }
    @media (max-width: 600px) { .esjf-toolbar { padding: 12px; } .esjf-toolbar-row { gap: 7px; } .esjf-stats { flex-basis: 100%; } .esjf-dialog { padding: 14px; } .esjf-toolbar button { font-size: 12px; } }
  `;
  (document.head || document.documentElement).append(style);

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 80);
  }

  try {
    if (!storage.get(TAGS_INIT, false)) {
      for (const name of ['百合', '女性主角']) if (!storage.get(tagKey(name), null)) storage.set(tagKey(name), { name });
      storage.set(TAGS_INIT, true);
    }
    readState();
    scan();
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (target?.closest('[data-esjf-ui]')) return false;
        if (record.type === 'characterData') return true;
        const changed = [...record.addedNodes, ...record.removedNodes];
        return changed.some(item => item.nodeType !== Node.ELEMENT_NODE || (!item.hasAttribute('data-esjf-ui') && !item.hasAttribute('data-esjf-progress')));
      });
      if (relevant) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (nativeGM && typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(CHANGE, (_key, _before, _after, remote) => {
        if (remote) { readState(); scan(); if (dialog) renderDialog(); }
      });
    } else {
      window.addEventListener('storage', event => {
        if (event.key === CHANGE || event.key === null) { readState(); scan(); if (dialog) renderDialog(); }
      });
    }
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('管理 ESJ 屏蔽名单', openDialog);
    window.addEventListener('pageshow', () => { readState(); scan(); });
    window.addEventListener('popstate', () => { reveal = false; readState(); scan(); });
  } catch (error) {
    console.error('[ESJ 小说筛选助手]', error);
    toast('筛选助手未能启动，请检查脚本存储权限。');
  }
})();
