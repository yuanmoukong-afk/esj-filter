'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { playwright, launchOptions } = require('../tools/runtime.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'esj-filter.user.js'), 'utf8');
const origin = 'https://www.esjzone.one';
const results = [];
const errors = [];
let browser;
const book = (n, author = '普通作者', tags = [], adult = false) => ({ id: String(1800000000 + n), title: '小说 ' + n, author, tags, adult });
const mainPages = Array.from({ length: 6 }, (_, page) => Array.from({ length: 40 }, (_, i) => book(page * 40 + i + 1,
  page === 1 ? '屏蔽作者' : '普通作者', page === 3 ? ['百合'] : [], page === 2)));
mainPages[5][0] = { ...mainPages[4][0] }; // Duplicate across a shifting page boundary.

function list(records, n, total) {
  return '<html><head><meta charset="utf-8"><style>body{font:14px system-ui;margin:20px}.row{display:flex;flex-wrap:wrap;gap:10px}.col-lg-3{width:210px}.card{border:1px solid #ddd;padding:12px}</style></head><body><div class="shop-toolbar"></div><div class="row">' + records.map(record => '<div class="col-lg-3"><div class="card"><div class="card-body">' + (record.adult ? '<div class="product-badge">18+</div>' : '') + '<h3 class="card-title"><a href="/detail/' + record.id + '.html">' + record.title + '</a></h3><div class="card-author"><a href="/tags/' + encodeURIComponent(record.author) + '/">' + record.author + '</a></div></div></div></div>').join('')
    + '</div><div id="page-selection">原始分页</div><script type="text/plain">$("#page-selection").bootpag({total:' + total + ',page:' + n + '});</script></body></html>';
}
function detail(record) {
  return '<html><body><div class="book-detail"><h2>' + record.title + '</h2></div><section class="widget widget-tags"><h3 class="widget-title">內容標籤</h3>' + record.tags.map(tag => '<a class="tag" href="/tags/' + encodeURIComponent(tag) + '/">' + tag + '</a>').join('') + '</section></body></html>';
}
function adapter(seed) {
  const prefix = 'test-gm:';
  window.GM_getValue = (key, fallback) => { const raw = localStorage.getItem(prefix + key); return raw === null ? fallback : JSON.parse(raw); };
  window.GM_setValue = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
  window.GM_deleteValue = key => localStorage.removeItem(prefix + key);
  window.GM_listValues = () => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  window.GM_addValueChangeListener = () => {};
  window.GM_registerMenuCommand = () => {};
  for (const [key, value] of Object.entries(seed)) if (GM_getValue(key, null) === null) GM_setValue(key, value);
}
function seedFor(pages, cache = true) {
  const seed = { 'esjf:v1:adult': 'exclude', ['esjf:v1:author:' + encodeURIComponent('屏蔽作者')]: { name: '屏蔽作者' } };
  for (const record of pages[0]) seed['esjf:v1:book:' + record.id] = { id: record.id, title: record.title, author: record.author };
  if (cache) for (const record of pages.flat()) seed['esjf:v1:metadata:' + record.id] = { id: record.id, tags: record.tags, updatedAt: Date.now() };
  return seed;
}
async function scenario(name, action, options = {}) {
  const pages = options.pages || mainPages;
  const seed = { ...seedFor(pages, options.cache !== false), ...options.seed };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addInitScript(adapter, seed);
  const sourceRequests = [];
  const tagRequests = [];
  let fail = options.fail || false;
  let delay = options.delay || 30;
  await context.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    const isFetch = route.request().resourceType() === 'fetch';
    if (url.pathname.startsWith('/detail/')) {
      const id = url.pathname.match(/detail\/(\d+)/)[1];
      tagRequests.push(id);
      const record = pages.flat().find(book => book.id === id);
      await route.fulfill({ contentType: 'text/html', body: detail(record) });
      return;
    }
    const n = Number(url.pathname.match(/\/(\d+)\.html$/)?.[1] || 1);
    if (isFetch) {
      sourceRequests.push(n);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (fail) { await route.fulfill({ status: 403, contentType: 'text/html', body: 'Access denied' }).catch(() => {}); return; }
    }
    const html = options.htmlPages?.[n - 1] || list(pages[n - 1] || [], n, pages.length);
    await route.fulfill({ contentType: 'text/html', body: isFetch ? html : html.replace('</body>', '<script>' + source + '</script></body>') }).catch(() => {});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({ name, error: error.message }));
  try {
    await page.goto(origin + '/list-01/' + (options.startPage || 1) + '.html');
    await page.locator('#esjf-toolbar').waitFor();
    await action(page, { sourceRequests, tagRequests, fail: value => { fail = value; }, delay: value => { delay = value; } });
    results.push({ name, status: 'passed' });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    console.error('FAIL ' + name + '\n' + error.stack);
    await page.screenshot({ path: path.join(root, 'test-results', 'progress-failure-' + results.length + '.png') }).catch(() => {});
  } finally { await context.close(); }
}
const visible = page => page.locator('.card:visible').count();
const renderedIds = page => page.locator('.card-title a').evaluateAll(links => links.map(link => link.href.match(/detail\/(\d+)/)[1]));
async function settled(page) {
  await page.waitForFunction(() => document.querySelector('#esjf-progress-back')?.hidden === false && document.querySelector('#esjf-progress-stop')?.hidden === true);
}

(async () => {
  browser = await playwright().chromium.launch(launchOptions());
  try {
    await scenario('连续四页被屏蔽，递进跨页补足 40 本并保留网站顺序', async (page, controls) => {
      assert.equal(await visible(page), 0);
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.equal(await visible(page), 40);
      assert.deepEqual(await renderedIds(page), mainPages[4].map(book => book.id));
      assert.deepEqual(controls.sourceRequests, [2, 3, 4, 5]);
      assert.equal(controls.tagRequests.length, 0);
      assert.equal(await page.locator('#page-selection').isVisible(), false);
      await page.screenshot({ path: path.join(root, 'test-results', 'progress-results.png') });
    });

    await scenario('继续递进与末页：重复书籍去重，不请求末页之后', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      await page.locator('#esjf-progress').click();
      await settled(page);
      const ids = await renderedIds(page);
      assert.equal(ids.length, 79);
      assert.equal(new Set(ids).size, 79);
      assert.match(await page.locator('#esjf-progress-status').textContent(), /最后一页/);
      assert.equal(await page.locator('#esjf-progress').isDisabled(), true);
      assert.deepEqual(controls.sourceRequests, [2, 3, 4, 5, 6]);
    });

    await scenario('递进结果整页屏蔽后补上后续小说，撤销恢复原顺序', async page => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      await page.locator('#esjf-block-page').click();
      await page.waitForFunction(() => document.querySelector('#esjf-progress-status').textContent.includes('最后一页'));
      assert.equal(await visible(page), 39);
      await page.locator('#esjf-undo').click();
      assert.equal(await visible(page), 40);
      assert.deepEqual(await renderedIds(page), mainPages[4].map(book => book.id));
    });

    await scenario('停止与继续：不会在后台自行重新加载，返回原页恢复分页', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await page.waitForFunction(() => !document.querySelector('#esjf-progress-stop').hidden);
      await page.locator('#esjf-progress-stop').click();
      await settled(page);
      const count = controls.sourceRequests.length;
      await page.waitForTimeout(700);
      assert.equal(controls.sourceRequests.length, count);
      controls.delay(0);
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.equal(await visible(page), 40);
      await page.locator('#esjf-progress-back').click();
      assert.equal(await page.locator('.card').count(), 40);
      assert.equal(await visible(page), 0);
      assert.equal(await page.locator('#page-selection').isVisible(), true);
      assert.equal(await page.locator('#esjf-progress-back').isVisible(), false);
    }, { delay: 500 });

    await scenario('读取失败停在当前进度，继续后重试同一页，不漏书', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.match(await page.locator('#esjf-progress-status').textContent(), /读取失败/);
      assert.deepEqual(controls.sourceRequests, [2]);
      controls.fail(false);
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.equal(await visible(page), 40);
      assert.deepEqual(controls.sourceRequests, [2, 2, 3, 4, 5]);
    }, { fail: true });

    await scenario('从后面的原始页启动，也从第一页起压缩当前分类结果', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.equal(await visible(page), 40);
      assert.deepEqual(controls.sourceRequests, [1, 2, 3, 4, 5]);
      assert.deepEqual(await renderedIds(page), mainPages[4].map(book => book.id));
    }, { startPage: 5 });

    const small = [[book(1001), book(1002)], [book(1003, '普通作者', ['奇幻']), book(1004, '普通作者', ['百合']), book(1005, '屏蔽作者'), book(1006, '普通作者', [], true)], [book(1007)]];
    await scenario('新页先核对真实标签，作者和 18+ 已排除的书不额外读取', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.deepEqual(await renderedIds(page), [small[1][0].id, small[2][0].id]);
      assert.deepEqual(controls.tagRequests, [small[1][0].id, small[1][1].id, small[2][0].id]);
      assert.deepEqual(controls.sourceRequests, [2, 3]);
    }, { pages: small, cache: false });

    await scenario('已到末页后放宽 18+ 筛选，继续核对新纳入的书籍并按原顺序补回', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      await page.locator('[data-mode="all"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 3 && document.querySelector('#esjf-progress-stop').hidden);
      assert.deepEqual(await renderedIds(page), [small[1][0].id, small[1][3].id, small[2][0].id]);
      assert.equal(controls.tagRequests.at(-1), small[1][3].id);
      assert.deepEqual(controls.sourceRequests, [2, 3]);
    }, { pages: small, cache: false });

    const ordered = [[book(2001)], [book(2002, '普通作者', ['百合']), ...Array.from({ length: 40 }, (_, i) => book(2003 + i))]];
    const cachedLater = Object.fromEntries(ordered[1].slice(1).map(book => ['esjf:v1:metadata:' + book.id, { id: book.id, tags: [], updatedAt: Date.now() }]));
    await scenario('已有 40 本缓存结果时仍核对排在前面的未知书，保证筛选顺序', async (page, controls) => {
      await page.locator('#esjf-progress').click();
      await settled(page);
      assert.equal(await visible(page), 40);
      assert.deepEqual(controls.tagRequests, [ordered[1][0].id]);
      assert.deepEqual(await renderedIds(page), ordered[1].slice(1).map(book => book.id));
    }, { pages: ordered, cache: false, seed: cachedLater });

    const demo = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await demo.goto(pathToFileURL(path.join(root, '递进试运行.html')).href);
    assert.equal(await visible(demo), 0);
    await demo.locator('#esjf-progress').click();
    await settled(demo);
    assert.equal(await visible(demo), 5);
    assert.equal(await demo.locator('#esjf-toolbar').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await demo.screenshot({ path: path.join(root, 'test-results', 'progress-mobile.png') });
    await demo.locator('[data-mode="exclude"]').click();
    assert.equal(await visible(demo), 4);
    await demo.close();
    results.push({ name: '独立五页演示和手机布局：两页空白后将后续 5 本前置，18+ 仍可筛选', status: 'passed' });
    const report = { testedAt: new Date().toISOString(), passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status === 'failed').length, pageErrors: errors, scenarios: results };
    fs.writeFileSync(path.join(root, 'test-results', 'progress-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, pageErrors: errors.length }));
    if (report.failed || errors.length) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
