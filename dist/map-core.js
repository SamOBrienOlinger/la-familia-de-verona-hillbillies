/* Pure graph, search, and layout helpers for Family Map. No DOM dependencies. */
(function (global) {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function normalise(value) {
    return String(value == null ? '' : value).normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/['’‘ʼ]/g, '').replace(/[-‐‑‒–—−]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function compareStrings(first, second) {
    return first < second ? -1 : first > second ? 1 : 0;
  }

  function initials(name) {
    var parts = String(name || '').replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }

  function searchPeople(people, query) {
    var terms = normalise(query).split(' ').filter(Boolean);
    return people.filter(function (person) {
      var text = normalise([person.name].concat(person.aliases || []).join(' '));
      return terms.every(function (term) { return text.indexOf(term) !== -1; });
    }).sort(function (first, second) {
      return compareStrings(normalise(first.name), normalise(second.name))
        || compareStrings(first.id, second.id);
    });
  }

  function bounds(nodes) {
    if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0,
      width: 0, height: 0, centerX: 0, centerY: 0 };
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (node) {
      minX = Math.min(minX, node.x - 120);
      minY = Math.min(minY, node.y - 45);
      maxX = Math.max(maxX, node.x + 120);
      maxY = Math.max(maxY, node.y + 45);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY,
      width: maxX - minX, height: maxY - minY,
      centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
  }

  function buildLayout(chart, graph) {
    if (chart.id !== graph.id) throw new Error('The graph and source chart must match.');
    var sourceColumns = Object.create(null);
    graph.generations.forEach(function (generation) { sourceColumns[generation.index] = generation.x; });
    var sourceIds = new Set(chart.people.map(function (person) { return person.id; }));
    var minSourceY = graph.nodes.length
      ? Math.min.apply(null, graph.nodes.map(function (node) { return node.y; })) : 0;
    var byId = Object.create(null);
    var nodes = graph.nodes.map(function (source) {
      if (!sourceIds.has(source.id)) throw new Error('The graph contains a person absent from its source chart.');
      var spouseOffset = source.x - sourceColumns[source.generation];
      var node = { id: source.id, generation: source.generation,
        x: 280 + (source.generation - 1) * 520 + spouseOffset * 0.8,
        y: (source.y - minSourceY) * 1.95 + 180 };
      byId[node.id] = node;
      return node;
    });
    var area = bounds(nodes);
    return { nodes: nodes, byId: byId,
      width: Math.max(560, area.maxX + 160),
      height: Math.max(360, area.maxY + 135),
      generations: graph.generations.map(function (generation) {
        return { index: generation.index, label: generation.label,
          x: 280 + (generation.index - 1) * 520, count: generation.count };
      }),
      families: graph.families,
      edges: graph.edges };
  }

  function findPath(graph, fromId, toId) {
    var ids = new Set(graph.nodes.map(function (node) { return node.id; }));
    if (!ids.has(fromId) || !ids.has(toId)) return null;
    if (fromId === toId) return { nodes: [fromId], edges: [] };
    var adjacent = Object.create(null);
    ids.forEach(function (id) { adjacent[id] = []; });
    graph.edges.forEach(function (edge) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) return;
      adjacent[edge.source].push({ id: edge.target, edge: edge });
      adjacent[edge.target].push({ id: edge.source, edge: edge });
    });
    Object.keys(adjacent).forEach(function (id) {
      adjacent[id].sort(function (first, second) {
        return compareStrings(first.id, second.id) || compareStrings(first.edge.id, second.edge.id);
      });
    });
    var visited = new Set([fromId]), previous = Object.create(null), queue = [fromId];
    for (var index = 0; index < queue.length; index += 1) {
      var current = queue[index];
      for (var step = 0; step < adjacent[current].length; step += 1) {
        var neighbour = adjacent[current][step];
        if (visited.has(neighbour.id)) continue;
        visited.add(neighbour.id);
        previous[neighbour.id] = { id: current, edge: neighbour.edge };
        if (neighbour.id === toId) {
          var pathNodes = [toId], pathEdges = [], cursor = toId;
          while (cursor !== fromId) {
            pathEdges.push(previous[cursor].edge);
            cursor = previous[cursor].id;
            pathNodes.push(cursor);
          }
          return { nodes: pathNodes.reverse(), edges: pathEdges.reverse() };
        }
        queue.push(neighbour.id);
      }
    }
    return null;
  }

  function relatives(graph, id) {
    var result = { parents: [], partners: [], children: [], siblings: [] };
    if (!graph.nodes.some(function (node) { return node.id === id; })) return result;
    graph.edges.forEach(function (edge) {
      if (edge.type === 'parent') {
        if (edge.target === id) result.parents.push(edge.source);
        if (edge.source === id) result.children.push(edge.target);
      } else if (edge.type === 'partner') {
        if (edge.source === id) result.partners.push(edge.target);
        if (edge.target === id) result.partners.push(edge.source);
      }
    });
    graph.edges.forEach(function (edge) {
      if (edge.type === 'parent' && edge.target !== id && result.parents.indexOf(edge.source) !== -1) {
        result.siblings.push(edge.target);
      }
    });
    Object.keys(result).forEach(function (kind) {
      result[kind] = Array.from(new Set(result[kind])).sort(compareStrings);
    });
    return result;
  }

  function validDate(month, day, year) {
    var m = Number(month), d = Number(day), y = Number(year);
    if (m < 1 || m > 12 || d < 1 || y < 1) return false;
    var leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  function readableLine(line) {
    return String(line || '').replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
      function (match, month, day, year) {
        return validDate(month, day, year)
          ? Number(day) + ' ' + MONTHS[Number(month) - 1] + ' ' + year : match;
      });
  }

  function birthYear(person) {
    var birth = (person.lines || []).find(function (line) { return /^Birth\b/i.test(line); });
    if (!birth) return '';
    var value = birth.replace(/^Birth\b\s*:?\s*/i, '').trim();
    var date = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?=\s|$)/);
    if (date) return validDate(date[1], date[2], date[3]) ? date[3] : '';
    var year = value.match(/^(\d{4})(?=\s|$)/);
    return year && Number(year[1]) > 0 ? year[1] : '';
  }

  global.FamilyMapCore = { normalise: normalise, initials: initials,
    searchPeople: searchPeople, buildLayout: buildLayout, findPath: findPath,
    relatives: relatives, readableLine: readableLine, birthYear: birthYear, bounds: bounds };
}(window));
