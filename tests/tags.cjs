'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { playwright, launchOptions } = require('../tools/runtime.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'esj-filter.user.js'), 'utf8');
const realDetail = "<html><head><meta charset=\"utf-8\"></head><body><div class=\"book-detail\"><h2>模拟详情页</h2><ul class=\"book-detail\"><li>作者: <a href=\"/tags/示例作者/\">示例作者</a></li></ul></div><section class=\"widget widget-tags\"><h3 class=\"widget-title\">內容標籤</h3><a class=\"tag\" href=\"/tags/%E5%A5%87%E5%B9%BB/\">奇幻</a><a class=\"tag\" href=\"/tags/R18/\">R18</a><a class=\"tag\" href=\"/tags/%E5%86%92%E9%99%A9/\">冒险</a><a class=\"tag\" href=\"/tags/%E6%A0%A1%E5%9B%AD/\">校园</a><a class=\"tag\" href=\"/tags/%E5%BC%82%E4%B8%96%E7%95%8C/\">异世界</a><a class=\"tag\" href=\"/tags/%E6%88%90%E9%95%BF/\">成长</a><a class=\"tag\" href=\"/tags/%E6%88%98%E6%96%97/\">战斗</a><a class=\"tag\" href=\"/tags/%E9%AD%94%E6%B3%95/\">魔法</a><a class=\"tag\" href=\"/tags/%E6%97%A5%E5%B8%B8/\">日常</a></section><section class=\"widget widget-tags\"><h3 class=\"widget-title\">熱門搜尋</h3><a href=\"/tags/百合/\">百合</a></section></body></html>";
const books = [
  { id: '1111111111', title: '小说 A', author: '作者 A', tags: ['百合'] },
  { id: '2222222222', title: '小说 B', author: '作者 B', tags: ['女性主角', '奇幻'] },
  { id: '3333333333', title: '标题含百合女性主角，但标签是奇幻', author: '百合', tags: ['奇幻'] },
  { id: '4444444444', title: '小说 D', author: '作者 D', tags: [] },
];
const link = name => '<a class="tag" href="/tags/' + encodeURIComponent(name) + '/">' + name + '</a>';
const detail = record => '<html><head><meta charset="utf-8"></head><body><div class="book-detail"><h2>' + record.title + '</h2><ul class="book-detail"><li>作者: <a href="/tags/' + encodeURIComponent(record.author) + '/">' + record.author + '</a></li></ul></div><section class="widget widget-tags"><h3 class="widget-title">內容標籤</h3>' + record.tags.map(link).join('') + '</section><section class="widget widget-tags"><h3 class="widget-title">熱門搜尋</h3>' + link('百合') + link('女性主角') + '</section></body></html>';
const list = '<html><head><meta charset="utf-8"><style>body{font:15px system-ui;margin:30px}.row{display:flex;gap:20px}.col-lg-3{width:220px}.card{border:1px solid #ddd;padding:16px}</style></head><body><div class="shop-toolbar"></div><div class="row">' + books.map(record => '<div class="col-lg-3"><div class="card"><div class="card-body"><h3 class="card-title"><a href="/detail/' + record.id + '.html">' + record.title + '</a></h3><div class="card-author"><a href="/tags/' + encodeURIComponent(record.author) + '/">' + record.author + '</a></div></div></div></div>').join('') + '</div><section class="widget widget-tags"><h3 class="widget-title">熱門搜尋</h3>' + link('百合') + link('女性主角') + '</section></body></html>';
const origin = 'https://www.esjzone.one';
const results = [];
const errors = [];
let browser;

function adapter() {
  const prefix = 'test-gm:';
  const listeners = [];
  window.GM_getValue = (key, fallback) => { const value = localStorage.getItem(prefix + key); return value === null ? fallback : JSON.parse(value); };
  window.GM_setValue = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
  window.GM_deleteValue = key => localStorage.removeItem(prefix + key);
  window.GM_listValues = () => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  window.GM_addValueChangeListener = (key, callback) => listeners.push([key, callback]);
  window.GM_registerMenuCommand = () => {};
  window.addEventListener('storage', event => {
    if (!event.key?.startsWith(prefix)) return;
    for (const [key, cb] of listeners) if (prefix + key === event.key) cb(key, undefined, undefined, true);
  });
}

async function scenario(name, action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addInitScript(adapter);
  if (options.seed) await context.addInitScript(seed => {
    for (const [key, value] of Object.entries(seed)) if (GM_getValue(key, null) === null) GM_setValue(key, value);
  }, options.seed);
  let requests = 0;
  let inflight = 0;
  let maxInflight = 0;
  let mode = options.mode || 'normal';
  await context.route(origin + '/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.resourceType() === 'fetch') {
      requests++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      try {
        await new Promise(resolve => setTimeout(resolve, 40));
        if (mode === '403') { await route.fulfill({ status: 403, contentType: 'text/html', body: 'Access denied' }); return; }
        if (mode === 'login') { await route.fulfill({ contentType: 'text/html', body: '<html><h1>登入</h1><section class="widget widget-tags"><h3 class="widget-title">熱門搜尋</h3>' + link('百合') + '</section></html>' }); return; }
        const id = url.pathname.match(/detail\/(\d+)/)[1];
        if (mode === 'redirect' && id === books[0].id) {
          await route.fulfill({ status: 302, headers: { Location: '/detail/' + books[1].id + '.html' }, body: '' }); return;
        }
        const record = books.find(book => book.id === id);
        await route.fulfill({ contentType: 'text/html', body: detail(options.freshA && id === books[0].id ? { ...record, tags: ['奇幻'] } : record) });
      } finally { inflight--; }
      return;
    }
    const html = url.pathname.startsWith('/detail/1880000001') ? realDetail : list;
    await route.fulfill({ contentType: 'text/html', body: html.replace('</body>', '<script>' + source + '</script></body>') });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({ name, error: error.message }));
  try {
    await page.goto(origin + (options.real ? '/detail/1880000001.html' : '/list-01/'));
    await page.locator('#esjf-toolbar').waitFor();
    const controls = { requests: () => requests, maxInflight: () => maxInflight, mode: next => { mode = next; } };
    await action(page, context, controls);
    results.push({ name, status: 'passed' });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    console.error('FAIL ' + name + '\n' + error.stack);
  } finally { await context.close(); }
}

async function checked(page) {
  await page.waitForFunction(() => document.querySelector('#esjf-tag-status')?.textContent === '本页标签已核对');
}
const visible = page => page.locator('.card:visible').count();
const records = (page, kind) => page.evaluate(kind => GM_listValues().filter(key => key.startsWith('esjf:v1:' + kind + ':')).map(key => GM_getValue(key)), kind);

(async () => {
  browser = await playwright().chromium.launch(launchOptions());
  try {
    await scenario('模拟详情页：读取 9 个内容标签，作者与热门搜索不混入', async page => {
      const cached = await page.evaluate(() => GM_getValue('esjf:v1:metadata:1880000001'));
      assert.equal(cached.tags.length, 9);
      assert.ok(cached.tags.includes('奇幻'));
      assert.ok(cached.tags.includes('R18'));
      assert.ok(!cached.tags.includes('示例作者'));
      await page.getByRole('button', { name: '切换标签屏蔽：奇幻', exact: true }).first().click();
      assert.equal((await records(page, 'tag')).length, 3);
      await page.getByRole('button', { name: '切换标签屏蔽：奇幻', exact: true }).first().click();
      assert.equal((await records(page, 'tag')).length, 2);
    }, { real: true });

    await scenario('按网站标签隐藏；书名或作者含百合、女性主角不会误伤', async (page, context, controls) => {
      await checked(page);
      assert.equal(await visible(page), 2);
      assert.ok(await page.getByRole('link', { name: books[2].title, exact: true }).isVisible());
      assert.equal(controls.requests(), 4);
      assert.equal(controls.maxInflight(), 1);
      await page.reload();
      await checked(page);
      assert.equal(controls.requests(), 4);
      assert.equal(await visible(page), 2);
      await page.screenshot({ path: path.join(root, 'test-results', 'tag-filter.png') });
    });

    await scenario('旧详情窗口不会反复覆盖另一个窗口更新的标签缓存', async (page, context) => {
      const other = await context.newPage();
      await other.goto(origin + '/detail/1880000001.html');
      await other.locator('#esjf-toolbar').waitFor();
      await other.evaluate(() => {
        const section = [...document.querySelectorAll('section.widget-tags')].find(section => section.querySelector('.widget-title')?.textContent === '內容標籤');
        const link = document.createElement('a');
        link.className = 'tag'; link.href = '/tags/百合/'; link.textContent = '百合'; section.append(link);
      });
      await page.waitForFunction(() => GM_getValue('esjf:v1:metadata:1880000001').tags.includes('百合'));
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => GM_getValue('esjf:v1:metadata:1880000001').tags.length), 10);
      assert.equal(await other.evaluate(() => GM_getValue('esjf:v1:metadata:1880000001').tags.length), 10);
    }, { real: true });

    await scenario('标签名单添加、恢复、撤销和跨标签页同步', async (page, context) => {
      await checked(page);
      const other = await context.newPage();
      await other.goto(origin + '/search/');
      await checked(other);
      await page.locator('#esjf-tag-manage').click();
      const row = page.locator('.esjf-list-row').filter({ has: page.getByRole('link', { name: '女性主角', exact: true }) });
      await row.getByRole('button', { name: '取消屏蔽', exact: true }).click();
      await other.waitForFunction(() => [...document.querySelectorAll('.card')].filter(el => el.getClientRects().length).length === 3);
      await page.locator('#esjf-add-tags').fill('奇幻');
      await page.getByRole('button', { name: '添加标签', exact: true }).click();
      assert.equal(await visible(page), 1);
      await page.keyboard.press('Escape');
      await page.locator('#esjf-undo').click();
      assert.equal(await visible(page), 3);
      await page.reload();
      await checked(page);
      assert.equal((await records(page, 'tag')).length, 1);
    });

    await scenario('整页屏蔽仅处理标签过滤后剩余小说，撤销保留标签规则', async page => {
      await checked(page);
      assert.equal(await page.locator('#esjf-block-page').textContent(), '屏蔽本页（2）');
      await page.locator('#esjf-block-page').click();
      assert.equal(await visible(page), 0);
      assert.deepEqual((await records(page, 'book')).map(book => book.id).sort(), [books[2].id, books[3].id]);
      await page.locator('#esjf-undo').click();
      assert.equal(await visible(page), 2);
      assert.equal((await records(page, 'tag')).length, 2);
    });

    await scenario('请求受限后停止核对，重试成功，不把失败当作无标签', async (page, context, controls) => {
      await page.waitForFunction(() => !document.querySelector('#esjf-tag-retry').hidden);
      assert.equal(controls.requests(), 1);
      assert.equal((await records(page, 'metadata')).length, 0);
      assert.equal(await visible(page), 4);
      await page.waitForTimeout(500);
      assert.equal(controls.requests(), 1);
      controls.mode('normal');
      await page.locator('#esjf-tag-retry').click();
      await checked(page);
      assert.equal(await visible(page), 2);
      assert.equal(controls.requests(), 5);
    }, { mode: '403' });

    await scenario('登录页与热门搜索不能冒充书籍标签', async (page, context, controls) => {
      await page.waitForFunction(() => !document.querySelector('#esjf-tag-retry').hidden);
      assert.match(await page.locator('#esjf-tag-status').textContent(), /确认 ESJ 已登录/);
      assert.equal((await records(page, 'metadata')).length, 0);
      assert.equal(controls.requests(), 1);
    }, { mode: 'login' });

    await scenario('跳转到另一部小说时不把其标签缓存到原书籍 ID', async page => {
      await page.waitForFunction(() => !document.querySelector('#esjf-tag-retry').hidden);
      assert.match(await page.locator('#esjf-tag-status').textContent(), /页面发生跳转/);
      assert.equal((await records(page, 'metadata')).length, 0);
      assert.equal(await visible(page), 4);
    }, { mode: 'redirect' });

    const staleSeed = Object.fromEntries(books.map((book, i) => ['esjf:v1:metadata:' + book.id, { id: book.id, tags: book.tags, updatedAt: Date.now() - (i === 0 ? 8 * 86400000 : 1000) }]));
    await scenario('过期标签缓存重新读取，网站标签改变后重新显示小说', async (page, context, controls) => {
      await checked(page);
      assert.equal(controls.requests(), 1);
      assert.equal(await visible(page), 3);
      assert.deepEqual(await page.evaluate(id => GM_getValue('esjf:v1:metadata:' + id).tags, books[0].id), ['奇幻']);
    }, { seed: staleSeed, freshA: true });

    await scenario('清空标签规则后刷新不重新加回默认项', async page => {
      await checked(page);
      await page.locator('#esjf-tag-manage').click();
      await page.getByRole('button', { name: '全选本页', exact: true }).click();
      await page.locator('#esjf-restore-selected').click();
      await page.keyboard.press('Escape');
      assert.equal(await visible(page), 4);
      await page.reload();
      assert.equal((await records(page, 'tag')).length, 0);
      assert.equal(await visible(page), 4);
    });

    await scenario('新版备份包含标签，旧版名单升级保留原书籍及作者', async page => {
      await checked(page);
      assert.equal((await records(page, 'book')).length, 1);
      assert.equal((await records(page, 'author')).length, 1);
      await page.locator('#esjf-tag-manage').click();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出备份', exact: true }).click();
      const data = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
      assert.equal(data.version, 2);
      assert.equal(data.tags.length, 2);
      assert.equal(data.books[0].id, '5555555555');
      const corrupt = { ...data, books: [{ id: '6666666666', title: '不应部分导入' }], tags: [{ name: 123 }] };
      await page.locator('#esjf-import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(corrupt)) });
      await page.waitForFunction(() => document.querySelector('#esjf-toast').textContent.includes('导入失败'));
      assert.equal((await records(page, 'book')).length, 1);
      const valid = { ...data, tags: [...data.tags, { name: '奇幻' }] };
      await page.locator('#esjf-import-file').setInputFiles({ name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(valid)) });
      await page.waitForFunction(() => document.querySelector('#esjf-toast').textContent.includes('导入完成'));
      assert.equal((await records(page, 'tag')).length, 3);
      assert.equal(await visible(page), 1);
    }, { seed: { 'esjf:v1:book:5555555555': { id: '5555555555', title: '旧名单小说', author: '' }, 'esjf:v1:author:旧作者': { name: '旧作者' } } });

    const demo = await browser.newPage();
    await demo.goto(pathToFileURL(path.join(root, '标签试运行.html')).href);
    assert.equal(await demo.locator('.card:visible').count(), 2);
    await demo.locator('#esjf-tag-manage').click();
    await demo.screenshot({ path: path.join(root, 'test-results', 'tag-management.png') });
    await demo.close();
    results.push({ name: '独立标签演示：两本按真实标签字段隐藏，标题包含百合的另一本保留', status: 'passed' });
    const report = { testedAt: new Date().toISOString(), passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status === 'failed').length, pageErrors: errors, scenarios: results };
    fs.writeFileSync(path.join(root, 'test-results', 'tags-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, pageErrors: errors.length }));
    if (report.failed || errors.length) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
