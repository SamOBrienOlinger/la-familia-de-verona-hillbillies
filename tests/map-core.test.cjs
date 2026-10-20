'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {} };
const root = path.resolve(__dirname, '..');
for (const file of ['family-data.js', 'family-graph.js', 'map-core.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(root, 'dist', file), 'utf8'), context, { filename: file });
}
const { FAMILY_DATA: data, FAMILY_GRAPH: graph, FamilyMapCore: core } = context.window;
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function check(label, callback) {
  callback();
  passed += 1;
  console.log('PASS ' + label);
}
const chart = id => data.charts.find(item => item.id === id);
const person = (chartId, suffix) => chart(chartId).people.find(item => item.id === chartId + '-' + suffix);

check('Every original person is connected, and all returned path steps are recorded edges', () => {
  for (const [id, source] of Object.entries(graph.charts)) {
    assert.equal(source.nodes.length, chart(id).people.length);
    for (const node of source.nodes) {
      const route = core.findPath(source, source.rootId, node.id);
      assert.ok(route, node.id);
      assert.equal(route.nodes[0], source.rootId);
      assert.equal(route.nodes.at(-1), node.id);
      assert.equal(route.edges.length, route.nodes.length - 1);
      route.edges.forEach((edge, index) => {
        assert.ok(source.edges.includes(edge));
        assert.deepEqual([edge.source, edge.target].sort(),
          [route.nodes[index], route.nodes[index + 1]].sort());
      });
    }
  }
});

check('Bill and Lois are partners, with no parent edge between them', () => {
  for (const source of Object.values(graph.charts)) {
    const bill = source.id + '-william-probst-stewart';
    const lois = source.id + '-lois-madge-olinger';
    assert.deepEqual(plain(core.relatives(source, bill).partners), [lois]);
    assert.ok(!core.relatives(source, bill).parents.includes(lois));
    assert.ok(!core.relatives(source, lois).parents.includes(bill));
    const route = core.findPath(source, bill, lois);
    assert.equal(route.edges.length, 1);
    assert.equal(route.edges[0].type, 'partner');
  }
});

check('Fiachra and Gráinne share the chart parents and a shortest two-step sibling route', () => {
  const source = graph.charts.renee;
  const fia = 'renee-fiachra-kenneth-gaj-o-brien';
  const gra = 'renee-grainne-emer-marie-gaj-o-brien';
  const parents = ['renee-brian-kenneth-o-brien-olinger', 'renee-ruth-gaj-mckeever-o-brien-olinger'];
  assert.deepEqual(plain(core.relatives(source, fia).parents), parents);
  assert.deepEqual(plain(core.relatives(source, gra).parents), parents);
  assert.deepEqual(plain(core.relatives(source, fia).siblings), [gra]);
  assert.deepEqual(plain(core.relatives(source, gra).siblings), [fia]);
  const route = core.findPath(source, fia, gra);
  assert.equal(route.edges.length, 2);
  assert.ok(parents.includes(route.nodes[1]));
  assert.ok(route.edges.every(edge => edge.type === 'parent'));
  const shuffled = { ...source, edges: [...source.edges].reverse() };
  assert.deepEqual(plain(core.findPath(shuffled, fia, gra)), plain(route));
});

check('Cross-chart and disconnected routes fail safely; a same-person route has no steps', () => {
  const r = graph.charts.renee;
  assert.equal(core.findPath(r, r.rootId, graph.charts.bernard.rootId), null);
  assert.equal(core.findPath(r, 'missing', 'missing'), null);
  assert.deepEqual(plain(core.findPath(r, r.rootId, r.rootId)), { nodes: [r.rootId], edges: [] });
  assert.equal(core.findPath({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }, 'a', 'b'), null);
  assert.deepEqual(plain(core.relatives(r, 'missing')), { parents: [], partners: [], children: [], siblings: [] });
});

check('Every layout preserves IDs and generations without overlapping 240 × 82 person cards', () => {
  for (const [id, source] of Object.entries(graph.charts)) {
    const layout = core.buildLayout(chart(id), source);
    assert.equal(layout.nodes.length, chart(id).people.length);
    assert.equal(layout.generations.length, id === 'renee' ? 4 : 5);
    assert.equal(Math.min(...layout.nodes.map(node => node.y)), 180);
    layout.nodes.forEach((first, index) => {
      assert.equal(layout.byId[first.id], first);
      assert.equal(first.generation, source.nodes.find(node => node.id === first.id).generation);
      assert.ok(first.x >= 120 && first.x + 120 <= layout.width);
      assert.ok(first.y >= 45 && first.y + 45 <= layout.height);
      for (const second of layout.nodes.slice(index + 1)) {
        assert.ok(Math.abs(first.x - second.x) >= 240 || Math.abs(first.y - second.y) >= 82,
          first.id + ' overlaps ' + second.id);
      }
    });
  }
  assert.deepEqual(plain(core.bounds([])), { minX: 0, minY: 0, maxX: 0, maxY: 0,
    width: 0, height: 0, centerX: 0, centerY: 0 });
  assert.deepEqual(plain(core.bounds([{ x: 200, y: 100 }])), { minX: 80, minY: 55,
    maxX: 320, maxY: 145, width: 240, height: 90, centerX: 200, centerY: 100 });
  assert.throws(() => core.buildLayout(chart('renee'), graph.charts.bernard), /must match/);
});

check('Search handles accents, apostrophes, hyphens, aliases, empty queries, and stable sorting', () => {
  const people = chart('renee').people;
  assert.equal(core.normalise('  GRÁINNE Gaj–O’Brien  '), 'grainne gaj obrien');
  assert.equal(core.searchPeople(people, 'grainne gaj obrien')[0].id, 'renee-grainne-emer-marie-gaj-o-brien');
  assert.equal(core.searchPeople(people, 'Fiachra Gaj-O’Brien')[0].id, 'renee-fiachra-kenneth-gaj-o-brien');
  assert.equal(core.searchPeople(people, 'Uncle Bill')[0].id, 'renee-william-probst-stewart');
  assert.equal(core.searchPeople(people, 'Jenna Olinger')[0].id, 'renee-jenna-michelle-kole');
  assert.equal(core.searchPeople(people, 'no such person').length, 0);
  assert.equal(core.searchPeople(people, '').length, people.length);
  assert.deepEqual(plain(core.searchPeople([...people].reverse(), '')), plain(core.searchPeople(people, '')));
  assert.equal(core.initials("Sam Timothy O'Brien-Olinger"), 'SO');
  assert.equal(core.initials(''), '?');
});

check('Written dates are valid and timezone independent, with incomplete dates preserved', () => {
  assert.equal(core.readableLine('Birth 7/6/2014'), 'Birth 6 July 2014');
  assert.equal(core.readableLine('Marriage 2/29/2000 (30y)'), 'Marriage 29 February 2000 (30y)');
  for (const value of ['2/29/1900', '2/29/2023', '4/31/2024', '13/1/2024', '1/0/2024', '3/17/24', '6/17']) {
    assert.equal(core.readableLine('Birth ' + value), 'Birth ' + value);
  }
  assert.equal(core.birthYear(person('renee', 'elias-letzen-stewart')), '2024');
  assert.equal(core.birthYear(person('bernard', 'elias-letzen-stewart')), '');
  assert.equal(core.birthYear(person('bernard', 'bernard-egelka')), '1890');
  assert.equal(core.birthYear(person('bernard', 'george-miller')), '');
  assert.equal(core.birthYear({ lines: ['Marriage 2/8/1975'] }), '');
  assert.equal(core.birthYear({ lines: ['Birth 2/29/2023'] }), '');
});

console.log('\n' + passed + ' checks passed.');
