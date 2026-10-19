'use strict';

// Run with NODE_PATH pointing to an isolated playwright installation:
//   NODE_PATH=/path/to/testdeps/node_modules node tests/map-browser.test.cjs
// The browser is restricted to an ephemeral localhost server serving dist/.
// It never visits GitHub Pages or any other external origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const DIST = path.resolve(__dirname, '../dist');
const OUTPUT = path.resolve(__dirname, '../test-results');
const TIMEOUT = 10000;
const report = { checks: [], screenshots: [], pageErrors: [], externalRequests: [] };
fs.mkdirSync(OUTPUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };

function serve(request, response) {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    let filename = path.resolve(DIST, '.' + pathname);
    if (filename === DIST) filename = path.join(DIST, 'index.html');
    if (!filename.startsWith(DIST + path.sep)) { response.writeHead(403); response.end(); return; }
    const stat = fs.statSync(filename);
    if (!stat.isFile()) { response.writeHead(404); response.end(); return; }
    const headers = { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    let start = 0, end = stat.size - 1, status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) { response.writeHead(416); response.end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        response.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); response.end(); return;
      }
      status = 206; headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    response.writeHead(status, headers);
    if (request.method === 'HEAD' || !stat.size) response.end();
    else fs.createReadStream(filename, { start, end }).on('error', () => response.destroy()).pipe(response);
  } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 400); response.end(); }
}

async function capture(page, name) {
  const filename = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '.png';
  try {
    await page.screenshot({ path: path.join(OUTPUT, filename), fullPage: false,
      animations: 'disabled', timeout: TIMEOUT });
    report.screenshots.push(filename);
  } catch (error) { report.screenshots.push({ filename, error: error.message }); }
}

async function check(page, name, callback, screenshot) {
  const started = Date.now();
  try {
    await callback();
    report.checks.push({ name, passed: true, milliseconds: Date.now() - started });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, milliseconds: Date.now() - started,
      error: error.stack || error.message });
    console.error('FAIL ' + name + '\n' + (error.stack || error.message));
  } finally { if (screenshot) await capture(page, screenshot); }
}

async function settleCamera(page) {
  await page.waitForFunction(() => document.querySelector('#map-world').style.transform.includes('scale('));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function loadMap(page, base, parameters = {}) {
  const hash = new URLSearchParams({ chart: 'renee', ...parameters }).toString();
  await page.goto(base + '/index.html#' + hash, { waitUntil: 'load' });
  const expected = parameters.chart === 'bernard' ? 56 : 22;
  await page.waitForFunction(count => document.querySelectorAll('.person-marker').length === count,
    expected, { timeout: TIMEOUT });
  assert.equal(await page.locator('#load-error').isVisible(), false, 'Map startup reported an error.');
  await settleCamera(page);
}

async function openPerson(page, query, id) {
  await page.locator('#map-search').fill(query);
  await page.locator('#panel-body .person-row[data-person-id="' + id + '"]').click();
  await page.locator('#panel-body .profile-name').waitFor({ state: 'visible' });
  await page.waitForFunction(personId => document.querySelector('.person-marker[data-person-id="' + personId + '"]')
    .classList.contains('is-selected'), id);
  await settleCamera(page);
}

async function loadedImage(page, selector, asset) {
  await page.waitForFunction(({ selector, asset }) => {
    const image = document.querySelector(selector);
    return image && image.complete && image.naturalWidth > 0 && image.currentSrc.endsWith('/' + asset);
  }, { selector, asset }, { timeout: TIMEOUT });
}

async function assertMediaFits(page, selector) {
  const geometry = await page.locator(selector).evaluate(media => {
    const box = media.getBoundingClientRect(), panel = document.querySelector('#panel-body').getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, height: box.height,
      panelLeft: panel.left, panelRight: panel.right, fit: getComputedStyle(media).objectFit };
  });
  assert.ok(geometry.width > 0 && geometry.left >= geometry.panelLeft - 1
    && geometry.right <= geometry.panelRight + 1, JSON.stringify(geometry));
  assert.ok(geometry.height <= 251, 'Profile media exceeded its maximum display height.');
  assert.equal(geometry.fit, 'contain');
}

async function noHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({ width: innerWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    panel: document.querySelector('#panel-body').scrollWidth,
    panelClient: document.querySelector('#panel-body').clientWidth }));
  assert.ok(widths.document <= widths.width + 1 && widths.body <= widths.width + 1, JSON.stringify(widths));
  assert.ok(widths.panel <= widths.panelClient + 1, 'The family panel scrolls horizontally: ' + JSON.stringify(widths));
}

async function selectedMarkerIsClear(page) {
  await settleCamera(page);
  const boxes = await page.evaluate(() => {
    const read = selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    return { marker: read('.person-marker.is-selected'), search: read('.search-shell'),
      sheet: read('.panel-shell'), viewport: read('#map-viewport') };
  });
  assert.ok(boxes.marker.top >= boxes.search.bottom + 2, 'Selected name is covered by search: ' + JSON.stringify(boxes));
  assert.ok(boxes.marker.bottom <= boxes.sheet.top - 2, 'Selected name is covered by the sheet: ' + JSON.stringify(boxes));
  assert.ok(boxes.marker.left >= boxes.viewport.left - 1 && boxes.marker.right <= boxes.viewport.right + 1,
    'Selected name is outside the map viewport: ' + JSON.stringify(boxes));
}

async function showRoute(page, from, to) {
  await page.locator('#route-open').click();
  await page.locator('#route-from').selectOption(from);
  await page.locator('#route-to').selectOption(to);
  await page.locator('.route-form button[type="submit"]').click();
  await page.locator('.route-summary').waitFor({ state: 'visible' });
  await settleCamera(page);
}

async function highlightedGeometry(page) {
  return page.locator('#connection-lines .connection.is-highlighted').evaluateAll(paths => paths.map(line => {
    const first = line.getPointAtLength(0), last = line.getPointAtLength(line.getTotalLength());
    return { d: line.getAttribute('d'), first: { x: first.x, y: first.y }, last: { x: last.x, y: last.y },
      dashed: getComputedStyle(line).strokeDasharray !== 'none', display: getComputedStyle(line).display,
      opacity: Number(getComputedStyle(line).opacity) };
  }));
}

function closePoint(first, second) { return Math.hypot(first.x - second.x, first.y - second.y) < 0.05; }

async function run() {
  const server = http.createServer(serve);
  let browser;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  report.origin = base;
  try {
    browser = await chromium.launch({ headless: true, timeout: TIMEOUT });
    async function createContext(options) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
        reducedMotion: 'reduce', ...options });
      context.setDefaultTimeout(TIMEOUT);
      context.setDefaultNavigationTimeout(TIMEOUT);
      await context.route('**/*', async route => {
        const url = route.request().url();
        if (new URL(url).origin !== base) {
          report.externalRequests.push(url); await route.abort('blockedbyclient'); return;
        }
        await route.continue();
      });
      context.on('page', page => page.on('pageerror', error => report.pageErrors.push({ url: page.url(), error: error.message })));
      return context;
    }

    const desktop = await createContext();
    await desktop.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await desktop.newPage();
    await check(page, 'Desktop opens all 22 Renee markers and a usable family map', async () => {
      await loadMap(page, base);
      assert.equal(await page.locator('.person-marker').count(), 22);
      assert.equal(await page.locator('.generation-band').count(), 4);
      assert.ok((await page.locator('#map-subtitle').textContent()).includes('22 people'));
      await noHorizontalOverflow(page);
    }, 'desktop-map');

    await check(page, 'Bill search opens the correct photo, fitted profile, and accessible image modal', async () => {
      await loadMap(page, base);
      await openPerson(page, 'Uncle Bill', 'renee-william-probst-stewart');
      assert.equal(await page.locator('.profile-name').textContent(), 'William Probst Stewart');
      await loadedImage(page, '.profile-photo-button img', 'assets/bill-stewart.jpeg');
      await assertMediaFits(page, '.profile-photo-button img');
      await capture(page, 'desktop-bill-profile');
      await page.locator('.profile-photo-button').click();
      await loadedImage(page, '#expanded-photo', 'assets/bill-stewart.jpeg');
      assert.equal(await page.locator('#media-dialog').evaluate(dialog => dialog.open), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#media-dialog').open);
      assert.equal(await page.locator('.profile-photo-button').evaluate(button => button === document.activeElement), true);
    }, 'desktop-bill-after-modal');

    await check(page, 'Gráinne and Fiachra open the same supplied photograph', async () => {
      await loadMap(page, base);
      await openPerson(page, 'Grainne', 'renee-grainne-emer-marie-gaj-o-brien');
      await loadedImage(page, '.profile-photo-button img', 'assets/fiachra-and-grainne.jpeg');
      assert.equal(await page.locator('.profile-name').textContent(), "Gráinne Emer-Marie Gaj-O'Brien");
      const first = await page.locator('.profile-photo-button img').getAttribute('src');
      await page.locator('.profile-companions').getByRole('button', { name: 'Fiachra', exact: true }).click();
      assert.equal(await page.locator('.profile-name').textContent(), "Fiachra Kenneth Gaj-O'Brien");
      assert.equal(await page.locator('.profile-photo-button img').getAttribute('src'), first);
      await loadedImage(page, '.profile-photo-button img', 'assets/fiachra-and-grainne.jpeg');
    }, 'desktop-shared-photo');

    await check(page, 'Ruth to Gráinne highlights exactly the correct parent arm and child trunk', async () => {
      await loadMap(page, base);
      const from = 'renee-ruth-gaj-mckeever-o-brien-olinger';
      const to = 'renee-grainne-emer-marie-gaj-o-brien';
      await showRoute(page, from, to);
      assert.equal(await page.locator('.route-step').count(), 2);
      assert.equal((await page.locator('.route-link').textContent()).trim(), 'parent of ↓');
      const expected = await page.evaluate(({ from, to }) => {
        const chart = window.FAMILY_DATA.charts.find(c => c.id === 'renee');
        const graph = window.FAMILY_GRAPH.charts.renee;
        const layout = window.FamilyMapCore.buildLayout(chart, graph);
        const family = graph.families.find(f => f.parents.includes(from) && f.children.includes(to));
        const parents = family.parents.map(id => layout.byId[id]);
        const joint = { x: parents.reduce((sum, p) => sum + p.x, 0) / parents.length,
          y: parents.reduce((sum, p) => sum + p.y, 0) / parents.length };
        const parent = layout.byId[from], child = layout.byId[to];
        return { arm: { x: parent.x, y: parent.y + (parent.y < joint.y ? 41 : -41) }, joint,
          child: { x: child.x - 120, y: child.y } };
      }, { from, to });
      const lines = await highlightedGeometry(page);
      assert.equal(lines.length, 2, JSON.stringify(lines));
      assert.ok(lines.every(line => !line.dashed && line.display !== 'none'));
      assert.ok(lines.some(line => closePoint(line.first, expected.arm) && closePoint(line.last, expected.joint)));
      assert.ok(lines.some(line => closePoint(line.first, expected.joint) && closePoint(line.last, expected.child)));
      await page.locator('#layers-toggle').click();
      await page.locator('#show-partners').uncheck();
      assert.equal((await highlightedGeometry(page)).filter(line => line.display !== 'none').length, 2);
      await page.locator('#layers-toggle').click();
    }, 'desktop-parent-route');

    await check(page, 'Bill to Lois highlights two dashed arms for the recorded partner connection', async () => {
      await loadMap(page, base);
      await showRoute(page, 'renee-william-probst-stewart', 'renee-lois-madge-olinger');
      assert.equal(await page.locator('.route-step').count(), 2);
      assert.equal((await page.locator('.route-link').textContent()).trim(), 'partner of ↓');
      const lines = await highlightedGeometry(page);
      assert.equal(lines.length, 2);
      assert.ok(lines.every(line => line.dashed && line.display !== 'none'));
      assert.ok(closePoint(lines[0].last, lines[1].last), 'Both partner arms must meet at their shared junction.');
    }, 'desktop-partner-route');

    await check(page, 'A profile link copied while following a route reopens that profile', async () => {
      await loadMap(page, base);
      const id = 'renee-grainne-emer-marie-gaj-o-brien';
      await showRoute(page, 'renee-ruth-gaj-mckeever-o-brien-olinger', id);
      await page.locator('.route-steps .person-row[data-person-id="' + id + '"]').click();
      await page.getByRole('button', { name: 'Copy profile link', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.copy-link-field')
        || Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Link copied'));
      const copyField = page.locator('.copy-link-field');
      const copied = await copyField.count() ? await copyField.inputValue() : await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(new URL(copied).origin, base);
      assert.equal(new URLSearchParams(new URL(copied).hash.slice(1)).get('person'), id);
      const fresh = await desktop.newPage();
      try {
        await fresh.goto(copied, { waitUntil: 'load' });
        await fresh.locator('.profile-name').waitFor({ state: 'visible' });
        assert.equal(await fresh.locator('.profile-name').textContent(), "Gráinne Emer-Marie Gaj-O'Brien");
        await loadedImage(fresh, '.profile-photo-button img', 'assets/fiachra-and-grainne.jpeg');
        await capture(fresh, 'desktop-restored-profile-link');
      } finally { await fresh.close(); }
    }, 'desktop-profile-link');

    await check(page, 'Date layers, zoom controls, mouse dragging, and keyboard panning work', async () => {
      await loadMap(page, base);
      await page.locator('#layers-toggle').click();
      await page.locator('#show-dates').uncheck();
      assert.ok(await page.locator('.marker-date').evaluateAll(nodes => nodes.length > 0
        && nodes.every(node => getComputedStyle(node).display === 'none')));
      await page.locator('#show-dates').check();
      assert.ok(await page.locator('.marker-date').first().evaluate(node => getComputedStyle(node).display !== 'none'));
      await page.locator('#layers-toggle').click();
      const zoom = Number.parseInt(await page.locator('#zoom-value').textContent(), 10);
      await page.locator('#zoom-in').click();
      await page.waitForFunction(previous => Number.parseInt(document.querySelector('#zoom-value').textContent, 10) > previous, zoom);
      const before = await page.locator('#map-world').evaluate(node => node.style.transform);
      await page.mouse.move(1150, 700); await page.mouse.down();
      await page.mouse.move(1220, 750, { steps: 5 }); await page.mouse.up();
      await page.waitForFunction(previous => document.querySelector('#map-world').style.transform !== previous, before);
      const dragged = await page.locator('#map-world').evaluate(node => node.style.transform);
      await page.locator('#map-viewport').focus(); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(previous => document.querySelector('#map-world').style.transform !== previous, dragged);
    }, 'desktop-map-controls');

    await check(page, 'Dan video loads, opens in a modal, and pauses when Escape closes it', async () => {
      await loadMap(page, base, { person: 'renee-daniel-joseph-kole' });
      const video = page.locator('#panel-body video.profile-media');
      await page.waitForFunction(() => {
        const video = document.querySelector('#panel-body video.profile-media');
        return video && video.readyState >= 1 && video.duration > 0;
      });
      await assertMediaFits(page, '#panel-body video.profile-media');
      await video.evaluate(video => { video.muted = true; return video.play(); });
      await page.waitForFunction(() => !document.querySelector('#panel-body video.profile-media').paused);
      await page.getByRole('button', { name: 'Open larger video', exact: true }).click();
      assert.equal(await video.evaluate(video => video.paused), true);
      await page.waitForFunction(() => document.querySelector('#expanded-video').readyState >= 1);
      await page.locator('#expanded-video').evaluate(video => { video.muted = true; return video.play(); });
      await page.waitForFunction(() => {
        const video = document.querySelector('#expanded-video'); return !video.paused && video.currentTime > 0;
      });
      await capture(page, 'desktop-video-modal');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#media-dialog').open && document.querySelector('#expanded-video').paused);
      assert.equal(await page.locator('.profile-name').textContent(), 'Daniel Joseph Kole');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.person-marker.is-selected'));
      assert.ok(await page.locator('video').evaluateAll(videos => videos.every(video => video.paused)));
    }, 'desktop-video-closed');

    await check(page, 'The whole-family view has 56 markers and preserves the original-chart link', async () => {
      await loadMap(page, base);
      await page.locator('.chart-switch [data-chart="bernard"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.person-marker').length === 56);
      assert.equal(await page.locator('.generation-band').count(), 5);
      await capture(page, 'desktop-bernard-map');
      assert.equal(await page.locator('.original-link').getAttribute('href'), 'tree.html');
      await page.locator('.original-link').click();
      await page.waitForURL('**/tree.html');
      await page.waitForFunction(() => {
        const artwork = document.querySelector('#tree-artwork');
        return artwork && artwork.complete && artwork.naturalWidth > 0;
      });
      assert.equal(await page.locator('#person-hotspots button').count(), 22);
    }, 'desktop-original-chart');

    for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
      const mobileContext = await createContext({ viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      const phone = await mobileContext.newPage();
      await check(phone, size.width + '×' + size.height + ' mobile map keeps profiles visible and media inside the sheet', async () => {
        await loadMap(phone, base);
        await noHorizontalOverflow(phone);
        await capture(phone, 'mobile-' + size.width + '-map');
        await openPerson(phone, 'Bill', 'renee-william-probst-stewart');
        await loadedImage(phone, '.profile-photo-button img', 'assets/bill-stewart.jpeg');
        await selectedMarkerIsClear(phone);
        await assertMediaFits(phone, '.profile-photo-button img');
        await noHorizontalOverflow(phone);
        await capture(phone, 'mobile-' + size.width + '-bill-profile');
        await phone.locator('.profile-photo-button').click();
        await loadedImage(phone, '#expanded-photo', 'assets/bill-stewart.jpeg');
        const modal = await phone.locator('#media-dialog').boundingBox();
        assert.ok(modal.x >= 0 && modal.x + modal.width <= size.width + 1);
        await capture(phone, 'mobile-' + size.width + '-photo-modal');
        await phone.keyboard.press('Escape');
        await phone.waitForFunction(() => !document.querySelector('#media-dialog').open);
        await openPerson(phone, 'Grainne', 'renee-grainne-emer-marie-gaj-o-brien');
        await loadedImage(phone, '.profile-photo-button img', 'assets/fiachra-and-grainne.jpeg');
        await selectedMarkerIsClear(phone);
        await assertMediaFits(phone, '.profile-photo-button img');
        await noHorizontalOverflow(phone);
        await capture(phone, 'mobile-' + size.width + '-shared-profile');
        await phone.locator('#chart-select').selectOption('bernard');
        await phone.waitForFunction(() => document.querySelectorAll('.person-marker').length === 56);
        await noHorizontalOverflow(phone);
      }, 'mobile-' + size.width + '-final');
      await mobileContext.close();
    }

    await check(page, 'No uncaught page errors or attempted external-origin requests', async () => {
      assert.deepEqual(report.pageErrors, []);
      assert.deepEqual(report.externalRequests, []);
    });
    await desktop.close();
  } catch (error) {
    report.checks.push({ name: 'Browser harness', passed: false, error: error.stack || error.message });
    console.error(error);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.writeFileSync(path.join(OUTPUT, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
    const failed = report.checks.filter(check => !check.passed);
    console.log('\n' + (report.checks.length - failed.length) + '/' + report.checks.length + ' browser checks passed.');
    console.log('Screenshots and check details: test-results/');
    if (failed.length) process.exitCode = 1;
  }
}

run().catch(error => {
  report.checks.push({ name: 'Harness startup', passed: false, error: error.stack || error.message });
  fs.writeFileSync(path.join(OUTPUT, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
});
