'use strict';

/*
 * DOM-event regression checks for the real static app scripts.
 * Install linkedom outside the repository, then provide it with NODE_PATH:
 *   NODE_PATH=/tmp/family-map-dom-qa/node_modules node tests/map-dom.test.cjs
 *
 * This is not a browser rendering test. Geometry, focus bookkeeping, media,
 * animation frames, native dialogs, and missing select properties are stubbed.
 * No assets are fetched; image decoding, video playback, CSS layout, native
 * keyboard defaults, and browser accessibility behavior are not verified here.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const files = ['family-data.js', 'family-graph.js', 'map-core.js', 'map.js'];
const scripts = files.map(file => [file, fs.readFileSync(path.join(root, 'dist', file), 'utf8')]);
let passed = 0;

function check(label, callback) {
  callback();
  passed += 1;
  console.log('PASS ' + label);
}

function boot({ hash = '', width = 1440, height = 900 } = {}) {
  const { window, document } = parseHTML(html);
  const $ = id => document.getElementById(id);
  const frames = new Map();
  const errors = [];
  let frameId = 0;
  let clock = 1000;
  const small = width <= 760;
  const header = small ? 64 : 76;
  const rect = (left, top, w, h) => ({ x: left, y: top, left, top, width: w, height: h, right: left + w, bottom: top + h });
  const viewport = $('map-viewport');
  const sidebar = $('sidebar');
  const expanded = () => sidebar.classList.contains('is-expanded');

  document.__qaActive = document.body;
  Object.defineProperty(document, 'activeElement', { get() { return this.__qaActive && this.__qaActive.isConnected ? this.__qaActive : this.body; } });
  window.HTMLElement.prototype.focus = function () {
    this.ownerDocument.__qaActive = this;
    this.dispatchEvent(new this.ownerDocument.defaultView.Event('focus'));
  };
  window.HTMLInputElement.prototype.select = function () { this.__qaSelected = true; };
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { const option = this.querySelector('option[selected]') || this.querySelector('option'); return option ? option.value : ''; },
    set(value) {
      const options = Array.from(this.querySelectorAll('option'));
      options.forEach(option => option.removeAttribute('selected'));
      const match = options.find(option => option.value === String(value));
      if (match) match.setAttribute('selected', '');
    }
  });
  document.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = input.hasAttribute('checked'); });

  function mediaStub(node) {
    node.currentTime = 0;
    node.__qaPaused = true;
    node.pause = function () { this.__qaPaused = true; };
    node.play = function () { this.__qaPaused = false; return Promise.resolve(); };
    return node;
  }
  document.querySelectorAll('video').forEach(mediaStub);
  const createElement = document.createElement.bind(document);
  document.createElement = function (tag, ...rest) {
    const node = createElement(tag, ...rest);
    return String(tag).toLowerCase() === 'video' ? mediaStub(node) : node;
  };
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.showModal = function () {
      this.__qaOpener = document.activeElement;
      this.setAttribute('open', '');
      this.querySelector('button').focus();
    };
    dialog.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
      if (this.__qaOpener && this.__qaOpener.isConnected) this.__qaOpener.focus();
    };
  });

  // Controlled layout fixtures, deliberately separate from any CSS rendering.
  viewport.getBoundingClientRect = () => rect(0, header, width, height - header);
  Object.defineProperty(viewport, 'clientHeight', { get: () => height - header });
  sidebar.getBoundingClientRect = () => small ? rect(0, header, width, height - header) : rect(24, header + 20, 336, height - header - 44);
  document.querySelector('.search-shell').getBoundingClientRect = () => small ? rect(12, header + 12, width - 24, 54) : rect(24, header + 20, 336, 58);
  document.querySelector('.map-toolbar').getBoundingClientRect = () => small ? rect(12, header + 78, width - 24, 106) : rect(384, header + 20, width - 408, 52);
  document.querySelector('.panel-shell').getBoundingClientRect = () => {
    if (!small) return rect(24, header + 90, 336, height - header - 114);
    const h = expanded() ? Math.min(height * 0.55, height - header - 210) : 54;
    return rect(12, height - 12 - h, width - 24, h);
  };
  $('minimap-svg').getBoundingClientRect = () => rect(width - 179, height - 125, 145, 91);
  const captures = new Set();
  viewport.setPointerCapture = id => captures.add(id);
  viewport.releasePointerCapture = id => captures.delete(id);
  viewport.hasPointerCapture = id => captures.has(id);

  const location = new URL('file://' + path.join(root, 'dist/index.html') + hash);
  const computedStyle = node => ({ visibility: node.classList.contains('map-toolbar') && small && expanded() ? 'hidden' : 'visible' });
  const requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  window.location = location;
  window.history = { replaceState(_state, _title, url) { location.href = new URL(url, location.href).href; } };
  window.matchMedia = () => ({ matches: small });
  window.getComputedStyle = computedStyle;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const context = vm.createContext({ window, document, URLSearchParams, requestAnimationFrame, getComputedStyle: computedStyle,
    navigator: {}, performance: { now: () => clock }, console: { error: (...args) => errors.push(args), log() {} } });
  for (const [file, source] of scripts) vm.runInContext(source, context, { filename: file, timeout: 1000 });

  function flush() {
    for (let count = 0; frames.size; count += 1) {
      assert.ok(count < 30, 'Animation frame queue should settle');
      const next = [...frames.values()]; frames.clear(); next.forEach(callback => callback(clock));
    }
    assert.deepEqual(errors, [], 'App must not log startup/runtime errors');
    assert.equal($('load-error').hidden, true, 'Startup error banner must remain hidden');
  }
  function event(node, type, properties = {}) {
    assert.ok(node, 'Event target exists: ' + type);
    const value = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(value, properties);
    node.dispatchEvent(value);
    flush();
    return value;
  }
  function click(node, keyboard = false) {
    node.focus();
    if (keyboard) event(node, 'keydown', { key: 'Enter' });
    else event(node, 'pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 700, clientY: 400 });
    event(node, 'pointerup', { pointerId: 1 });
    event(node, 'click', { detail: keyboard ? 0 : 1 });
  }
  function button(text, scope = document) { return Array.from(scope.querySelectorAll('button')).find(node => node.textContent.trim() === text); }
  function marker(id) { return document.querySelector('#person-markers [data-person-id="' + id + '"]'); }
  function search(query) { $('map-search').value = query; event($('map-search'), 'input'); }
  function route(from, to, keyboard = false) {
    click($('route-open'), keyboard);
    $('route-from').value = from; $('route-to').value = to;
    const submit = document.querySelector('.route-form button[type="submit"]');
    submit.focus();
    if (keyboard) event(submit, 'keydown', { key: 'Enter' });
    event(document.querySelector('.route-form'), 'submit');
  }
  function camera() {
    const values = $('map-world').style.transform.match(/^translate\(([-\d.e]+)px,([-\d.e]+)px\) scale\(([-\d.e]+)\)$/);
    assert.ok(values, 'Camera transform has numeric values');
    return { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) };
  }
  flush();
  return { window, document, $, event, click, button, marker, search, route, camera, flush,
    advance(ms) { clock += ms; }, data: window.FAMILY_DATA, graph: window.FAMILY_GRAPH, core: window.FamilyMapCore };
}

const bill = chart => chart + '-william-probst-stewart';
const fia = 'renee-fiachra-kenneth-gaj-o-brien';
const gra = 'renee-grainne-emer-marie-gaj-o-brien';
const brian = 'renee-brian-kenneth-o-brien-olinger';
const dan = 'renee-daniel-joseph-kole';

check('Startup renders 22 Renee markers; both branches open every one of their 78 source profiles', () => {
  const h = boot();
  assert.equal(h.document.querySelectorAll('.person-marker').length, 22);
  for (const chart of h.data.charts) {
    h.click(h.document.querySelector('[data-chart="' + chart.id + '"]'));
    assert.equal(h.document.querySelectorAll('.person-marker').length, chart.id === 'renee' ? 22 : 56);
    for (const person of chart.people) {
      h.click(h.marker(person.id));
      assert.equal(h.document.querySelector('.profile-name').textContent, person.name);
      assert.equal(h.document.querySelectorAll('.person-marker[aria-pressed="true"]').length, 1);
      assert.equal(h.marker(person.id).getAttribute('aria-pressed'), 'true');
    }
  }
});

check('Alias search finds Bill, Jenna, Cromwell, Dan, Fiachra, and unaccented Gráinne; clearing restores the list', () => {
  const h = boot();
  for (const [query, id] of [['Uncle Bill', bill('renee')], ['Jenna', 'renee-jenna-michelle-kole'], ['Cromwell', 'renee-david-cromwell-crom-johnson'], ['Dan Kole', dan], ['Fiachra', fia], ['Grainne', gra]]) {
    h.search(query);
    const rows = h.document.querySelectorAll('#panel-body .person-row');
    assert.equal(rows.length, 1, query);
    assert.equal(rows[0].dataset.personId, id, query);
    assert.equal(h.marker(id).classList.contains('is-search-hit'), true);
  }
  h.click(h.$('clear-search'));
  assert.equal(h.document.querySelectorAll('#panel-body .person-row').length, 22);
  assert.equal(h.document.activeElement, h.$('map-search'));
  h.search('no such family member');
  assert.equal(h.document.querySelectorAll('#panel-body .person-row').length, 0);
  assert.match(h.document.querySelector('.empty-state').textContent, /No matches/);
});

check('Both Bill records and both sibling profiles use the supplied image paths; companion buttons change profiles', () => {
  const h = boot();
  for (const chart of ['renee', 'bernard']) {
    h.click(h.document.querySelector('[data-chart="' + chart + '"]'));
    h.click(h.marker(bill(chart)));
    assert.equal(h.document.querySelector('img.profile-media').src, 'assets/bill-stewart.jpeg');
    const trigger = h.document.querySelector('.profile-photo-button');
    h.click(trigger, true);
    assert.equal(h.$('media-dialog').hasAttribute('open'), true);
    assert.equal(h.$('expanded-photo').src, 'assets/bill-stewart.jpeg');
    assert.equal(h.$('expanded-video').hidden, true);
    h.click(h.$('media-close'), true);
    assert.equal(h.document.activeElement, trigger);
  }
  h.click(h.document.querySelector('[data-chart="renee"]'));
  h.click(h.marker(fia));
  assert.equal(h.document.querySelector('img.profile-media').src, 'assets/fiachra-and-grainne.jpeg');
  h.click(h.button('Gráinne', h.$('panel-body')));
  assert.equal(h.marker(gra).getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.querySelector('img.profile-media').src, 'assets/fiachra-and-grainne.jpeg');
  h.click(h.button('Fiachra', h.$('panel-body')));
  assert.equal(h.marker(fia).getAttribute('aria-pressed'), 'true');
});

check('Dan’s profile and expanded video have correct sources; opening/closing media and changing profiles pause and reset video', () => {
  const h = boot();
  h.click(h.marker(dan));
  const inline = h.document.querySelector('video.profile-media');
  assert.equal(inline.src, 'assets/dan-kole.mp4');
  assert.equal(inline.controls, true);
  assert.equal(inline.playsInline, true);
  assert.equal(inline.hasAttribute('autoplay'), false);
  inline.play(); inline.currentTime = 12;
  const trigger = h.button('Open larger video', h.$('panel-body'));
  h.click(trigger);
  assert.equal(inline.__qaPaused, true);
  assert.equal(inline.currentTime, 0);
  const expanded = h.$('expanded-video');
  assert.equal(expanded.hidden, false);
  assert.equal(expanded.src, 'assets/dan-kole.mp4');
  assert.equal(h.$('expanded-photo').hidden, true);
  expanded.play(); expanded.currentTime = 5;
  h.click(h.$('media-close'));
  assert.equal(expanded.__qaPaused, true);
  assert.equal(expanded.currentTime, 0);
  inline.play(); inline.currentTime = 9;
  h.click(h.marker(bill('renee')));
  assert.equal(inline.__qaPaused, true);
  assert.equal(inline.currentTime, 0);
  assert.equal(h.document.querySelector('video.profile-media'), null);
});

check('Route form creates correct parent/child and sibling steps, highlights them, and handles identical endpoints', () => {
  const h = boot();
  h.route(brian, fia);
  assert.equal(h.document.querySelectorAll('.route-step').length, 2);
  assert.equal(h.document.querySelector('.route-link').textContent, 'parent of ↓');
  assert.equal(h.document.querySelectorAll('.person-marker.is-route').length, 2);
  h.route(fia, gra);
  assert.equal(h.document.querySelectorAll('.route-step').length, 3);
  assert.deepEqual(Array.from(h.document.querySelectorAll('.route-link'), node => node.textContent), ['child of ↓', 'parent of ↓']);
  assert.equal(h.document.querySelectorAll('.person-marker.is-route').length, 3);
  assert.ok(h.document.querySelectorAll('.connection.is-highlighted').length >= 2);
  h.route(fia, fia);
  assert.equal(h.document.querySelectorAll('.route-step').length, 1);
  assert.equal(h.document.querySelector('.route-summary').textContent, 'You chose the same person.');
});

check('A copied route-step profile link restores the profile while preserving its connection', () => {
  const h = boot();
  h.route(fia, gra);
  h.click(h.document.querySelector('.route-step [data-person-id="' + gra + '"]'));
  h.click(h.button('Copy profile link', h.$('panel-body')));
  const copied = new URL(h.document.querySelector('.copy-link-field').value);
  const params = new URLSearchParams(copied.hash.slice(1));
  assert.equal(params.get('person'), gra);
  assert.equal(params.get('from'), fia);
  assert.equal(params.get('to'), gra);
  const restored = boot({ hash: copied.hash });
  assert.equal(restored.marker(gra).getAttribute('aria-pressed'), 'true');
  assert.ok(restored.document.querySelector('.profile-name'));
  assert.ok(restored.button('← Back to connection', restored.$('panel-body')));
  assert.equal(restored.document.querySelectorAll('.person-marker.is-route').length, 3);
});

check('Memory/generation filters and display layers update rows, card states, bands, dates, and partner lines', () => {
  const h = boot();
  h.click(h.$('filter-memories'));
  assert.equal(h.document.querySelectorAll('#panel-body .person-row').length, 6);
  assert.equal(h.$('filter-memories').getAttribute('aria-pressed'), 'true');
  h.click(h.$('filter-all'));
  const chip = h.document.querySelector('#generation-nav button[data-generation="4"]');
  h.click(chip);
  const expected = h.graph.charts.renee.nodes.filter(node => node.generation === 4).length;
  assert.equal(h.document.querySelectorAll('#panel-body .person-row').length, expected);
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  h.click(chip);
  const partnerCount = h.document.querySelectorAll('.partner-line').length;
  assert.ok(partnerCount > 0);
  for (const id of ['show-dates', 'show-generations', 'show-partners']) {
    h.$(id).checked = false; h.event(h.$(id), 'change');
  }
  assert.equal(h.$('map-world').classList.contains('hide-dates'), true);
  assert.equal(h.$('generation-bands').hidden, true);
  assert.equal(h.document.querySelectorAll('.partner-line').length, 0);
  assert.ok(Array.from(h.document.querySelectorAll('.connection')).some(line => line.style.display !== 'none'), 'Parent/child connections remain visible');
  h.$('show-partners').checked = true; h.event(h.$('show-partners'), 'change');
  assert.equal(h.document.querySelectorAll('.partner-line').length, partnerCount);
});

check('Keyboard-driven profile/route actions and dismissals retain meaningful focus destinations', () => {
  const h = boot();
  h.click(h.marker(fia), true);
  assert.equal(h.document.activeElement, h.document.querySelector('.profile-name'));
  h.click(h.button('← Explore the family', h.$('panel-body')), true);
  assert.equal(h.document.activeElement, h.document.querySelector('#panel-body h1'));
  h.route(fia, gra, true);
  assert.equal(h.document.activeElement, h.document.querySelector('.route-summary'));
  h.event(h.document.activeElement, 'keydown', { key: 'Escape' });
  assert.equal(h.document.activeElement, h.$('map-viewport'));
  h.click(h.$('layers-toggle'), true);
  h.$('show-dates').focus();
  h.event(h.$('show-dates'), 'keydown', { key: 'Escape' });
  assert.equal(h.$('layers-panel').hidden, true);
  assert.equal(h.document.activeElement, h.$('layers-toggle'));
  h.click(h.marker(fia), true);
  h.event(h.document.activeElement, 'keydown', { key: 'Escape' });
  assert.equal(h.document.activeElement, h.marker(fia));
  h.click(h.$('help-open'), true);
  assert.equal(h.$('help-dialog').hasAttribute('open'), true);
  h.click(h.$('help-close'), true);
  assert.equal(h.document.activeElement, h.$('help-open'));
});

check('Map zoom/pan handlers change the camera; drag suppression prevents accidental profile opening', () => {
  const h = boot();
  const start = h.camera();
  h.click(h.$('zoom-in'));
  assert.ok(h.camera().scale > start.scale);
  h.click(h.$('zoom-out'));
  assert.ok(Math.abs(h.camera().scale - start.scale) < 0.000001);
  const viewport = h.$('map-viewport');
  viewport.focus();
  h.event(viewport, 'keydown', { key: 'ArrowRight' });
  assert.ok(h.camera().x < start.x);
  h.event(viewport, 'pointerdown', { button: 0, pointerType: 'mouse', pointerId: 9, clientX: 700, clientY: 400 });
  h.event(viewport, 'pointermove', { pointerId: 9, clientX: 800, clientY: 440 });
  h.event(h.window, 'pointerup', { pointerId: 9 });
  h.event(h.marker(fia), 'click', { detail: 1 });
  assert.equal(h.document.querySelector('.profile-name'), null);
  h.advance(400);
  h.click(h.marker(fia));
  assert.ok(h.document.querySelector('.profile-name'));
  h.click(h.$('fit-map'));
  const fitted = h.camera();
  assert.ok(Number.isFinite(fitted.x) && Number.isFinite(fitted.y) && fitted.scale > 0);
});

check('Mobile select switches branches and centering respects supplied short-screen panel/search geometry', () => {
  const h = boot({ width: 320, height: 568 });
  h.$('chart-select').value = 'bernard';
  h.event(h.$('chart-select'), 'change');
  assert.equal(h.document.querySelectorAll('.person-marker').length, 56);
  assert.equal(h.$('panel-toggle').getAttribute('aria-expanded'), 'false');
  h.click(h.marker(bill('bernard')));
  assert.equal(h.$('panel-toggle').getAttribute('aria-expanded'), 'true');
  const chart = h.data.charts.find(item => item.id === 'bernard');
  const node = h.core.buildLayout(chart, h.graph.charts.bernard).byId[bill('bernard')];
  const camera = h.camera();
  const y = node.y * camera.scale + camera.y + h.$('map-viewport').getBoundingClientRect().top;
  const cardHalfHeight = 41 * camera.scale;
  assert.ok(y - cardHalfHeight > h.document.querySelector('.search-shell').getBoundingClientRect().bottom);
  assert.ok(y + cardHalfHeight < h.document.querySelector('.panel-shell').getBoundingClientRect().top);
  h.click(h.$('panel-toggle'));
  assert.equal(h.$('panel-toggle').getAttribute('aria-expanded'), 'false');
});

console.log('\n' + passed + ' DOM interaction checks passed. Rendering and native browser behavior remain unverified.');
