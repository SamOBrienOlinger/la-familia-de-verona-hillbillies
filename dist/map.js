/* Family Map: a static, spatial explorer of the original family records. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var data = window.FAMILY_DATA, graphData = window.FAMILY_GRAPH, core = window.FamilyMapCore;
  if (!data || !graphData || !core) {
    if ($('load-error')) $('load-error').hidden = false;
    return;
  }

  var viewport = $('map-viewport'), world = $('map-world'), sidebar = $('sidebar');
  var panel = $('panel-body'), search = $('map-search');
  var svgNS = 'http://www.w3.org/2000/svg';
  var camera = { x: 0, y: 0, scale: 0.75 }, frameRequest = 0;
  var chart, graph, layout, people, markers = new Map(), connections = [];
  var state = { chart: 'renee', selected: null, mode: 'explore', query: '',
    generation: null, memories: false, route: null, routeFrom: '', routeTo: '', expanded: false };
  var pointerMap = new Map(), gesture = null, suppressClickUntil = 0, keyboardNavigation = false;
  var minimumScale = 0.025, maximumScale = 2.2, lastDialogTrigger = null;

  function el(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }

  function svg(tag, attributes) {
    var node = document.createElementNS(svgNS, tag);
    Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, attributes[key]); });
    return node;
  }

  function button(label, className, callback) {
    var node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
  }

  function announce(message) { $('map-status').textContent = message; }
  function mobile() { return window.matchMedia('(max-width: 760px)').matches; }
  function personName(id) { return people.get(id) ? people.get(id).name : ''; }
  function mediaFor(person) { return person.mediaGroup ? data.mediaGroups[person.mediaGroup] : null; }
  function sourceUrl() { return 'assets/' + state.chart + '-descendant-chart.pdf'; }

  function avatar(person, className) {
    var holder = el('span', className), media = mediaFor(person);
    var src = media && (media.type === 'video' ? media.poster : media.src);
    if (src) {
      var img = el('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      img.addEventListener('error', function () { holder.textContent = core.initials(person.name); }, { once: true });
      holder.append(img);
    } else holder.textContent = core.initials(person.name);
    holder.setAttribute('aria-hidden', 'true');
    return holder;
  }

  function stopVideos(container) {
    container.querySelectorAll('video').forEach(function (video) {
      video.pause();
      try { video.currentTime = 0; } catch (error) { /* Not loaded yet. */ }
    });
  }

  function visibleFrame() {
    var rect = viewport.getBoundingClientRect();
    var small = mobile();
    var sideRect = sidebar.getBoundingClientRect();
    var left = small ? 18 : sideRect.right - rect.left + 24;
    var right = Math.max(left + 100, rect.width - (small && state.expanded ? 18 : small ? 66 : 84));
    var toolbar = document.querySelector('.map-toolbar');
    var topElement = getComputedStyle(toolbar).visibility === 'hidden' ? sidebar.querySelector('.search-shell') : toolbar;
    var top = topElement.getBoundingClientRect().bottom - rect.top + 18;
    var bottom = rect.height - (mobile() ? 88 : 64);
    if (small && state.expanded) {
      var panelRect = sidebar.querySelector('.panel-shell').getBoundingClientRect();
      bottom = Math.min(bottom, panelRect.top - rect.top - 16);
    }
    // On short screens the sheet is capped in CSS to leave usable map space.
    bottom = Math.max(top + 48, bottom);
    return { left: left, right: right, top: top, bottom: bottom,
      width: right - left, height: bottom - top,
      x: (left + right) / 2, y: (top + bottom) / 2 };
  }

  function paintCamera() {
    frameRequest = 0;
    world.style.transform = 'translate(' + camera.x + 'px,' + camera.y + 'px) scale(' + camera.scale + ')';
    $('zoom-value').textContent = Math.round(camera.scale * 100) + '%';
    $('zoom-in').disabled = camera.scale >= maximumScale;
    $('zoom-out').disabled = camera.scale <= minimumScale;
    viewport.classList.toggle('is-overview', camera.scale < 0.4);
    var rect = viewport.getBoundingClientRect();
    var mini = $('minimap-view');
    var x = Math.max(0, -camera.x / camera.scale), y = Math.max(0, -camera.y / camera.scale);
    var endX = Math.min(layout.width, (rect.width - camera.x) / camera.scale);
    var endY = Math.min(layout.height, (rect.height - camera.y) / camera.scale);
    mini.setAttribute('x', x);
    mini.setAttribute('y', y);
    mini.setAttribute('width', Math.max(0, endX - x));
    mini.setAttribute('height', Math.max(0, endY - y));
  }

  function scheduleCamera() { if (!frameRequest) frameRequest = requestAnimationFrame(paintCamera); }

  function setCamera(x, y, scale) {
    camera.scale = Math.max(minimumScale, Math.min(maximumScale, scale));
    var rect = viewport.getBoundingClientRect();
    // Keep some of the family reachable even after a long drag into empty space.
    camera.x = Math.max(-layout.width * camera.scale + 80, Math.min(rect.width - 80, x));
    camera.y = Math.max(-layout.height * camera.scale + 80, Math.min(rect.height - 80, y));
    scheduleCamera();
  }

  function zoomAt(scale, x, y) {
    scale = Math.max(minimumScale, Math.min(maximumScale, scale));
    var ratio = scale / camera.scale;
    setCamera(x - (x - camera.x) * ratio, y - (y - camera.y) * ratio, scale);
  }

  function zoomBy(factor) {
    var frame = visibleFrame();
    zoomAt(camera.scale * factor, frame.x, frame.y);
  }

  function centerNode(id, zoom) {
    var node = layout.byId[id];
    if (!node) return;
    var frame = visibleFrame();
    var scale = zoom ? Math.max(camera.scale, mobile() ? 0.78 : 0.92) : camera.scale;
    setCamera(frame.x - node.x * scale, frame.y - node.y * scale, scale);
  }

  function fitNodes(ids, maxScale) {
    var nodes = ids ? ids.map(function (id) { return layout.byId[id]; }).filter(Boolean) : layout.nodes;
    if (!nodes.length) return;
    // A parent route passes through a couple junction which can lie outside
    // the selected cards' bounds. Keep those bends visible when fitting it.
    if (ids && state.route && ids === state.route.nodes) {
      var usedFamilies = new Set(state.route.edges.filter(function (edge) { return edge.type === 'parent'; }).map(function (edge) { return edge.familyId; }));
      graph.families.forEach(function (family) {
        if (!usedFamilies.has(family.id)) return;
        var parents = family.parents.map(function (id) { return layout.byId[id]; });
        nodes.push({ x: parents.reduce(function (sum, p) { return sum + p.x; }, 0) / parents.length,
          y: parents.reduce(function (sum, p) { return sum + p.y; }, 0) / parents.length });
      });
    }
    var area = core.bounds(nodes), frame = visibleFrame();
    var scale = Math.max(minimumScale, Math.min(maxScale || 1, (frame.width - 28) / area.width, (frame.height - 30) / area.height));
    setCamera(frame.x - area.centerX * scale, frame.y - area.centerY * scale, scale);
  }

  function setExpanded(expanded) {
    state.expanded = expanded;
    sidebar.classList.toggle('is-expanded', expanded);
    $('panel-toggle').setAttribute('aria-expanded', String(expanded));
  }

  function syncHash() {
    var params = new URLSearchParams();
    params.set('chart', state.chart);
    if (state.selected && state.mode === 'profile') params.set('person', state.selected);
    if (state.route) { params.set('from', state.routeFrom); params.set('to', state.routeTo); }
    try { window.history.replaceState(null, '', '#' + params.toString()); } catch (error) { /* Local-file restrictions. */ }
  }

  function selectedRelatives() {
    var relatives = state.selected ? core.relatives(graph, state.selected) : {};
    return new Set(Object.keys(relatives).flatMap(function (key) { return relatives[key]; }));
  }

  function results() {
    return core.searchPeople(chart.people, state.query).filter(function (person) {
      return (!state.generation || layout.byId[person.id].generation === state.generation)
        && (!state.memories || Boolean(mediaFor(person)));
    });
  }

  function updateHighlights() {
    var matches = new Set(results().map(function (person) { return person.id; }));
    var relatives = selectedRelatives();
    var pathIds = new Set(state.route ? state.route.nodes : []);
    var pathEdges = new Set(state.route ? state.route.edges.map(function (edge) { return edge.id; }) : []);
    var filtered = Boolean(state.query || state.generation || state.memories);
    markers.forEach(function (marker, id) {
      marker.classList.toggle('is-selected', id === state.selected);
      marker.setAttribute('aria-pressed', String(id === state.selected));
      marker.classList.toggle('is-relative', relatives.has(id));
      marker.classList.toggle('is-route', pathIds.has(id));
      marker.classList.toggle('is-search-hit', Boolean(state.query) && matches.has(id));
      marker.classList.toggle('is-muted', (filtered && !matches.has(id) || state.route && !pathIds.has(id)) && id !== state.selected);
    });
    connections.forEach(function (connection) {
      var onPath = connection.edges.some(function (edge) { return pathEdges.has(edge.id); });
      var partnerOnPath = connection.edges.some(function (edge) { return edge.type === 'partner' && pathEdges.has(edge.id); });
      var hasParentEdges = connection.edges.some(function (edge) { return edge.type === 'parent'; });
      var nearPerson = state.selected && connection.edges.some(function (edge) {
        return edge.source === state.selected || edge.target === state.selected;
      });
      connection.node.classList.toggle('is-highlighted', onPath || Boolean(nearPerson && !state.route));
      connection.node.classList.toggle('is-dim', Boolean(state.route && !onPath));
      connection.node.classList.toggle('partner-line', connection.partner && (onPath ? partnerOnPath : $('show-partners').checked));
      connection.node.style.display = connection.partner && !hasParentEdges && !$('show-partners').checked && !onPath ? 'none' : '';
    });
    $('generation-bands').hidden = !$('show-generations').checked;
    world.classList.toggle('hide-dates', !$('show-dates').checked);
    $('filter-all').setAttribute('aria-pressed', String(!state.memories));
    $('filter-memories').setAttribute('aria-pressed', String(state.memories));
    $('generation-nav').querySelectorAll('button').forEach(function (node) {
      node.setAttribute('aria-pressed', String(Number(node.dataset.generation) === state.generation));
    });
    $('locate-person').disabled = !state.selected;
    $('clear-search').hidden = !state.query;
  }

  function drawWorld() {
    markers.clear();
    connections = [];
    $('person-markers').replaceChildren();
    $('connection-lines').replaceChildren();
    $('generation-bands').replaceChildren();
    $('generation-nav').replaceChildren();
    world.style.width = layout.width + 'px';
    world.style.height = layout.height + 'px';
    $('connection-lines').setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
    $('connection-lines').setAttribute('width', layout.width);
    $('connection-lines').setAttribute('height', layout.height);

    layout.generations.forEach(function (generation) {
      var band = el('div', 'generation-band');
      band.style.left = (generation.x - 210) + 'px';
      band.style.width = '460px';
      band.style.height = layout.height + 'px';
      band.append(el('span', 'generation-title', 'GENERATION ' + generation.index));
      $('generation-bands').append(band);
      var chip = button('Gen ' + generation.index, '', function () {
        state.generation = state.generation === generation.index ? null : generation.index;
        state.mode = 'explore'; state.selected = null; state.route = null;
        renderPanel(); updateHighlights(); syncHash();
        if (state.generation) fitNodes(layout.nodes.filter(function (n) { return n.generation === state.generation; }).map(function (n) { return n.id; }), 0.95);
        else fitNodes();
        announce(state.generation ? 'Generation ' + state.generation + ', ' + results().length + ' people.' : 'Showing all generations.');
      });
      chip.dataset.generation = generation.index;
      chip.title = generation.count + ' people in generation ' + generation.index;
      chip.setAttribute('aria-pressed', 'false');
      $('generation-nav').append(chip);
    });

    function addPath(d, edges, partner) {
      var path = svg('path', { d: d, class: 'connection' + (partner ? ' partner-line' : ''), fill: 'none' });
      $('connection-lines').append(path);
      connections.push({ node: path, edges: edges, partner: partner });
    }

    graph.families.forEach(function (family) {
      var parents = family.parents.map(function (id) { return layout.byId[id]; }).filter(Boolean).sort(function (a, b) { return a.y - b.y; });
      if (!parents.length) return;
      var first = parents[0], last = parents[parents.length - 1];
      var join = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
      if (parents.length > 1) {
        var partnerEdges = graph.edges.filter(function (edge) { return edge.familyId === family.id && edge.type === 'partner'; });
        parents.forEach(function (parent) {
          var parentEdges = graph.edges.filter(function (edge) { return edge.familyId === family.id && edge.type === 'parent' && edge.source === parent.id; });
          var edgeY = parent.y + (parent.y < join.y ? 41 : -41);
          addPath('M ' + parent.x + ' ' + edgeY + ' L ' + join.x + ' ' + join.y, partnerEdges.concat(parentEdges), Boolean(partnerEdges.length));
        });
      } else join.x += 120;
      family.children.forEach(function (id) {
        var child = layout.byId[id];
        if (!child) return;
        var trunk = join.x + (child.x - 120 - join.x) * 0.53;
        var relatedEdges = graph.edges.filter(function (edge) { return edge.familyId === family.id && edge.target === id && edge.type === 'parent'; });
        addPath('M ' + join.x + ' ' + join.y + ' H ' + trunk + ' V ' + child.y + ' H ' + (child.x - 120), relatedEdges, false);
      });
      if (family.children.length) $('connection-lines').append(svg('circle', { cx: join.x, cy: join.y, r: 4, class: 'junction' }));
    });

    layout.nodes.forEach(function (node) {
      var person = people.get(node.id), media = mediaFor(person);
      var marker = button('', 'person-marker', function () {
        if (performance.now() < suppressClickUntil) return;
        openPerson(node.id);
      });
      marker.dataset.personId = node.id;
      marker.style.left = node.x + 'px';
      marker.style.top = node.y + 'px';
      marker.title = person.name;
      marker.setAttribute('aria-label', person.name + ', generation ' + node.generation + (media ? ', ' + (media.type === 'video' ? 'video' : 'photograph') + ' available' : '') + '. Open profile.');
      marker.append(avatar(person, 'marker-avatar'));
      var copy = el('span', 'marker-copy');
      copy.append(el('span', 'marker-name', person.name));
      var meta = el('span', 'marker-meta');
      meta.append(el('span', 'marker-generation', 'Generation ' + node.generation));
      var year = core.birthYear(person);
      if (year) meta.append(el('span', 'marker-date', ' · b. ' + year));
      copy.append(meta); marker.append(copy);
      if (media) marker.append(el('span', 'media-dot', media.type === 'video' ? '▶' : '●'));
      marker.addEventListener('focus', function () { if (keyboardNavigation) centerNode(node.id, true); });
      $('person-markers').append(marker);
      markers.set(node.id, marker);
    });

    var mini = $('minimap-svg'), view = $('minimap-view');
    mini.replaceChildren();
    mini.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
    mini.setAttribute('preserveAspectRatio', 'none');
    graph.edges.forEach(function (edge) {
      var a = layout.byId[edge.source], b = layout.byId[edge.target];
      mini.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#b7c5b2', 'stroke-width': 13 }));
    });
    layout.nodes.forEach(function (node) {
      mini.append(svg('circle', { cx: node.x, cy: node.y, r: 20, fill: mediaFor(people.get(node.id)) ? '#ae6b46' : '#496b55' }));
    });
    mini.append(view);
    updateHighlights();
  }

  function personRow(person, metaText) {
    var row = button('', 'person-row', function () { openPerson(person.id); });
    row.dataset.personId = person.id;
    row.append(avatar(person, 'row-avatar'));
    var copy = el('span', 'row-copy');
    copy.append(el('span', 'row-name', person.name));
    var media = mediaFor(person);
    copy.append(el('span', 'row-meta', metaText || 'Generation ' + layout.byId[person.id].generation + (media ? ' · ' + (media.type === 'video' ? 'Video' : 'Photo') : '')));
    row.append(copy, el('span', 'row-chevron', '›'));
    return row;
  }

  function sourceNote() {
    var note = el('p', 'source-note', (data.collaborative ? 'Family edits are shown here; the original source is unchanged. ' : 'Connections follow Bill’s original chart. '));
    var link = el('a', 'inline-link', 'View source PDF');
    link.href = sourceUrl(); link.target = '_blank'; link.rel = 'noopener';
    note.append(link);
    return note;
  }

  function renderExplore() {
    var found = results(), filtered = Boolean(state.query || state.generation || state.memories);
    $('panel-label').textContent = filtered ? found.length + (found.length === 1 ? ' person found' : ' people found') : 'Explore the family';
    panel.append(el('p', 'eyebrow', chart.label));
    panel.append(el('h1', 'panel-title', state.query ? 'Find your people' : state.generation ? 'Generation ' + state.generation : state.memories ? 'Family memories' : 'Every name, a story.'));
    panel.append(el('p', 'panel-intro', 'Follow a family connection. Open a name to meet the person behind it.'));
    if (!filtered) {
      var stats = el('div', 'stat-row');
      var groups = Array.from(new Set(chart.people.map(function (p) { return p.mediaGroup; }).filter(Boolean)));
      [[chart.people.length, 'people'], [layout.generations.length, 'generations'], [groups.length, 'memories']].forEach(function (pair) {
        var stat = el('div', 'stat'); stat.append(el('strong', '', pair[0]), el('span', '', pair[1])); stats.append(stat);
      });
      panel.append(stats);
      var album = el('section', 'panel-section');
      album.append(el('h2', 'section-heading', 'A few familiar faces'));
      var grid = el('div', 'album-grid');
      groups.forEach(function (id) {
        var media = data.mediaGroups[id], person = chart.people.find(function (p) { return p.mediaGroup === id; });
        var card = button('', 'album-card', function () { openPerson(person.id); });
        var image = el('img', 'album-thumb');
        image.src = (media.type === 'video' ? media.poster : media.src) || 'assets/tree-mark.svg';
        image.alt = media.alt; image.loading = 'lazy';
        card.append(image, el('strong', '', media.caption), el('small', '', media.type === 'video' ? '▶ Watch video' : 'Open photograph'));
        grid.append(card);
      });
      album.append(grid); panel.append(album);
    }
    var section = el('section', 'panel-section');
    section.append(el('h2', 'section-heading', filtered ? found.length + ' matching ' + (found.length === 1 ? 'person' : 'people') : 'People in this branch'));
    if (found.length) {
      var list = el('div', 'people-list'); found.forEach(function (person) { list.append(personRow(person)); }); section.append(list);
    } else {
      section.append(el('p', 'empty-state', 'No matches here. Try a first name, a nickname, or another family branch.'));
      if (state.generation || state.memories) section.append(button('Clear filters', 'secondary-button', function () {
        state.generation = null; state.memories = false; renderPanel(); updateHighlights();
      }));
      if (state.query) {
        var other = data.charts.find(function (item) { return item.id !== state.chart; });
        var otherMatches = core.searchPeople(other.people, state.query);
        if (otherMatches.length) section.append(button('See ' + otherMatches.length + ' in ' + other.label, 'secondary-button', function () {
          switchChart(other.id, { query: state.query });
        }));
      }
    }
    panel.append(section, sourceNote());
  }

  function openMedia(media, trigger) {
    stopVideos(panel);
    var dialog = $('media-dialog'), photo = $('expanded-photo'), video = $('expanded-video');
    photo.hidden = media.type !== 'image'; video.hidden = media.type !== 'video';
    if (media.type === 'image') { photo.src = media.src; photo.alt = media.alt; }
    else { video.src = media.src; if (media.poster) video.poster = media.poster; else video.removeAttribute('poster'); }
    $('media-title').textContent = media.caption;
    $('media-caption').textContent = media.alt;
    showDialog(dialog, trigger);
  }

  function renderProfile() {
    var person = people.get(state.selected);
    if (!person) { state.mode = 'explore'; renderExplore(); return; }
    $('panel-label').textContent = person.mediaLabel || person.name;
    panel.append(button(state.route ? '← Back to connection' : '← Explore the family', 'back-button', function () {
      state.selected = null; state.mode = state.route ? 'route' : 'explore';
      renderPanel(); updateHighlights(); syncHash();
    }));
    panel.append(el('p', 'eyebrow', 'GENERATION ' + layout.byId[person.id].generation));
    var title = el('h1', 'profile-name', person.name); title.tabIndex = -1; panel.append(title);
    panel.append(el('p', 'profile-source', chart.label));
    if (person.notes) panel.append(el('p', 'profile-notes', person.notes));
    var media = mediaFor(person);
    if (media) {
      if (media.type === 'video') {
        var video = el('video', 'profile-media'); video.src = media.src;
        video.controls = true; video.playsInline = true; video.preload = 'metadata';
        video.setAttribute('aria-label', media.alt); if (media.poster) video.poster = media.poster;
        panel.append(video, button('Open larger video', 'secondary-button', function (event) { openMedia(media, event.currentTarget); }));
      } else {
        var photoButton = button('', 'profile-photo-button', function (event) { openMedia(media, event.currentTarget); });
        var photo = el('img', 'profile-media'); photo.src = media.src; photo.alt = media.alt;
        photoButton.append(photo, el('span', '', 'Open photograph ↗'));
        panel.append(photoButton);
      }
      panel.append(el('p', 'source-note', media.caption));
      if (media.credit) panel.append(el('p', 'source-note', 'Credit: ' + media.credit));
      var companions = chart.people.filter(function (p) { return p.mediaGroup === person.mediaGroup && p.id !== person.id; });
      if (companions.length) {
        var group = el('div', 'profile-companions');
        group.append(el('span', '', media.type === 'video' ? 'Also in this video' : 'Also in this photograph'));
        companions.forEach(function (p) { group.append(button(p.mediaLabel || p.name, 'tag-button', function () { openPerson(p.id); })); });
        panel.append(group);
      }
    } else {
      var empty = el('div', 'empty-media');
      empty.append(avatar(person, 'row-avatar'), el('span', '', 'A photograph is still to come.'));
      panel.append(empty);
    }
    var actions = el('div', 'panel-actions');
    actions.append(button('Find connection', 'primary-button', function () { openRoute(person.id); }));
    actions.append(button('Center on map', 'secondary-button', function () { centerNode(person.id, true); announce('Centered on ' + person.name + '.'); }));
    actions.append(button('Copy profile link', 'secondary-button', function (event) { copyProfileLink(event.currentTarget); }));
    panel.append(actions);
    var facts = el('details', 'profile-facts');
    facts.append(el('summary', '', 'From the family records'));
    if (person.lines.length) person.lines.forEach(function (line) { facts.append(el('p', '', core.readableLine(line))); });
    else facts.append(el('p', '', 'No dates or additional details are recorded in this chart yet.'));
    panel.append(facts);
    var related = core.relatives(graph, person.id);
    [['parents', 'Parents'], ['partners', 'Partner'], ['children', 'Children'], ['siblings', 'Siblings']].forEach(function (pair) {
      if (!related[pair[0]].length) return;
      var section = el('section', 'relatives-group'); section.append(el('h2', 'section-heading', pair[1]));
      var list = el('div', 'people-list');
      core.searchPeople(related[pair[0]].map(function (id) { return people.get(id); }), '').forEach(function (p) { list.append(personRow(p)); });
      section.append(list); panel.append(section);
    });
    panel.append(sourceNote());
  }

  function routeStepLabel(edge, fromId) {
    if (edge.type === 'partner') return 'partner of';
    return edge.source === fromId ? 'parent of' : 'child of';
  }

  function renderRoute() {
    $('panel-label').textContent = 'Find a family connection';
    panel.append(button('← Explore the family', 'back-button', function () {
      state.route = null; state.selected = null; state.mode = 'explore'; renderPanel(); updateHighlights(); syncHash();
    }));
    panel.append(el('p', 'eyebrow', chart.label), el('h1', 'panel-title', 'How are we connected?'));
    panel.append(el('p', 'panel-intro', 'Choose two people to follow the shortest connection recorded in this branch.'));
    var form = el('form', 'route-form');
    [['route-from', 'Start with', state.routeFrom], ['route-to', 'Connect to', state.routeTo]].forEach(function (item) {
      var label = el('label', '', item[1]); label.htmlFor = item[0];
      var select = el('select'); select.id = item[0]; select.name = item[0]; select.required = true;
      var placeholder = el('option', '', 'Choose a person'); placeholder.value = ''; select.append(placeholder);
      core.searchPeople(chart.people, '').forEach(function (person) { var option = el('option', '', person.name); option.value = person.id; select.append(option); });
      select.value = item[2] || '';
      form.append(label, select);
    });
    form.append(button('Swap people ⇅', 'secondary-button', function () {
      var from = $('route-from'), to = $('route-to'), saved = from.value; from.value = to.value; to.value = saved;
    }));
    var submit = el('button', 'primary-button', 'Show connection'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      state.routeFrom = $('route-from').value; state.routeTo = $('route-to').value;
      if (!state.routeFrom || !state.routeTo) return;
      state.route = core.findPath(graph, state.routeFrom, state.routeTo);
      renderPanel(); updateHighlights(); syncHash();
      if (state.route) {
        fitNodes(state.route.nodes, 1); announce('Connection found: ' + state.route.edges.length + ' recorded steps.');
        if (keyboardNavigation) panel.querySelector('.route-summary').focus({ preventScroll: true });
      }
      else announce('No recorded connection was found.');
    });
    panel.append(form);
    if (state.route) {
      var path = state.route;
      var summary = el('p', 'route-summary', path.edges.length === 0 ? 'You chose the same person.' : path.edges.length + ' recorded ' + (path.edges.length === 1 ? 'connection' : 'connections'));
      summary.tabIndex = -1; panel.append(summary);
      var steps = el('ol', 'route-steps');
      path.nodes.forEach(function (id, index) {
        var step = el('li', 'route-step');
        step.append(personRow(people.get(id), index === 0 ? 'Starting person' : index === path.nodes.length - 1 ? 'Connected person' : 'Generation ' + layout.byId[id].generation));
        if (index < path.edges.length) step.append(el('span', 'route-link', routeStepLabel(path.edges[index], id) + ' ↓'));
        steps.append(step);
      });
      panel.append(steps, button('Fit this connection on the map', 'secondary-button', function () { fitNodes(state.route.nodes, 1); }));
      panel.append(el('p', 'source-note', 'This path can include partners. Parent links follow the chart and do not distinguish biological, adoptive, or other parentage.'));
    } else if (state.routeFrom && state.routeTo) panel.append(el('p', 'empty-state', 'There is no recorded connection between these people in this chart.'));
    panel.append(sourceNote());
  }

  function renderPanel() {
    var restoreFocus = keyboardNavigation && panel.contains(document.activeElement);
    stopVideos(panel); panel.replaceChildren();
    sidebar.classList.toggle('is-profile', state.mode === 'profile');
    sidebar.classList.toggle('is-route', state.mode === 'route');
    if (state.mode === 'profile') renderProfile(); else if (state.mode === 'route') renderRoute(); else renderExplore();
    panel.scrollTop = 0;
    if (restoreFocus) { var heading = panel.querySelector('h1'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }
    if (typeof window.CustomEvent === 'function') document.dispatchEvent(new window.CustomEvent('family:panel'));
  }

  function openPerson(id) {
    if (!people.has(id)) return;
    state.selected = id; state.mode = 'profile'; state.query = ''; search.value = '';
    state.generation = null; state.memories = false;
    setExpanded(true); renderPanel(); updateHighlights(); syncHash();
    requestAnimationFrame(function () { centerNode(id, true); });
    announce(personName(id) + '. Profile open.');
    if (keyboardNavigation) { var title = panel.querySelector('h1'); if (title) title.focus({ preventScroll: true }); }
  }

  function openRoute(from) {
    state.mode = 'route'; state.routeFrom = from || state.selected || graph.rootId;
    state.routeTo = ''; state.route = null; state.selected = null;
    state.generation = null; state.memories = false; state.query = ''; search.value = '';
    setExpanded(true); renderPanel(); updateHighlights(); syncHash();
    if (keyboardNavigation) $('route-to').focus();
  }

  function copyProfileLink(trigger) {
    syncHash();
    var url = window.location.href;
    function fallback() {
      var existing = panel.querySelector('.copy-link-field');
      if (existing) existing.remove();
      var field = el('input', 'copy-link-field'); field.type = 'text'; field.readOnly = true; field.value = url;
      field.setAttribute('aria-label', 'Profile link. Select and copy this address.');
      trigger.insertAdjacentElement('afterend', field); field.focus(); field.select();
      announce('Select and copy the profile link. A file address works only on this computer.');
    }
    if (navigator.clipboard && window.location.protocol !== 'file:') {
      navigator.clipboard.writeText(url).then(function () { trigger.textContent = 'Link copied'; announce('Profile link copied.'); }).catch(fallback);
    } else fallback();
  }

  function switchChart(id, options) {
    options = options || {};
    var next = data.charts.find(function (item) { return item.id === id; });
    if (!next || !graphData.charts[id]) return;
    stopVideos(document);
    chart = next; graph = graphData.charts[id]; layout = core.buildLayout(chart, graph);
    people = new Map(chart.people.map(function (person) { return [person.id, person]; }));
    state.chart = id; state.selected = null; state.mode = 'explore'; state.route = null;
    state.routeFrom = ''; state.routeTo = ''; state.generation = null; state.memories = false;
    state.query = options.query || ''; search.value = state.query;
    setExpanded(Boolean(options.query));
    $('chart-select').value = id;
    document.querySelectorAll('[data-chart]').forEach(function (node) { node.setAttribute('aria-pressed', String(node.dataset.chart === id)); });
    $('map-label').textContent = chart.label;
    $('map-subtitle').textContent = chart.people.length + ' people · ' + layout.generations.length + ' generations';
    document.title = chart.label + ' · La Familia Family Map';
    drawWorld(); renderPanel();
    var anchor = chart.people.find(function (person) { return person.mediaGroup === 'dan-kole'; });
    var center = layout.byId[anchor ? anchor.id : graph.rootId] || {x: 0, y: 0}, frame = visibleFrame();
    var scale = mobile() ? 0.62 : 0.76;
    setCamera(frame.x - (center.x + (mobile() ? 0 : 210)) * scale, frame.y - center.y * scale, scale);
    if (options.from && options.to && people.has(options.from) && people.has(options.to)) {
      state.routeFrom = options.from; state.routeTo = options.to;
      state.route = core.findPath(graph, options.from, options.to); state.mode = 'route';
      setExpanded(true); renderPanel(); updateHighlights();
      if (!options.person || !people.has(options.person)) requestAnimationFrame(function () { fitNodes(state.route ? state.route.nodes : null, 1); });
    }
    if (options.person && people.has(options.person)) openPerson(options.person);
    syncHash(); announce(chart.label + '. ' + chart.people.length + ' people.');
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.slice(1));
    return { chart: params.get('chart') || 'renee', person: params.get('person'), from: params.get('from'), to: params.get('to') };
  }

  function showDialog(dialog, trigger) {
    lastDialogTrigger = trigger || document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    stopVideos(dialog);
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    if (lastDialogTrigger && lastDialogTrigger.isConnected) lastDialogTrigger.focus({ preventScroll: true });
  }

  ['help', 'media'].forEach(function (name) {
    var dialog = $(name + '-dialog');
    $(name + '-close').addEventListener('click', function () { closeDialog(dialog); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) closeDialog(dialog); });
    dialog.addEventListener('close', function () { stopVideos(dialog); });
  });
  $('help-open').addEventListener('click', function (event) { showDialog($('help-dialog'), event.currentTarget); });

  document.querySelectorAll('[data-chart]').forEach(function (node) { node.addEventListener('click', function () { if (node.dataset.chart !== state.chart) switchChart(node.dataset.chart); }); });
  $('chart-select').addEventListener('change', function (event) { switchChart(event.target.value); });
  search.addEventListener('input', function () {
    state.query = search.value; state.selected = null; state.mode = 'explore'; state.route = null;
    setExpanded(true); renderPanel(); updateHighlights(); syncHash();
    announce(results().length + ' people found.');
  });
  search.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { var found = results(); if (found.length) { event.preventDefault(); openPerson(found[0].id); } }
  });
  $('clear-search').addEventListener('click', function () {
    state.query = ''; search.value = ''; renderPanel(); updateHighlights(); search.focus();
  });
  $('panel-toggle').addEventListener('click', function () {
    setExpanded(!state.expanded);
    if (state.selected) requestAnimationFrame(function () { centerNode(state.selected, false); });
  });
  ['filter-all', 'filter-memories'].forEach(function (id) {
    $(id).addEventListener('click', function () {
      state.memories = id === 'filter-memories'; state.mode = 'explore'; state.selected = null; state.route = null;
      setExpanded(true); renderPanel(); updateHighlights(); syncHash();
      if (state.memories) fitNodes(results().map(function (p) { return p.id; }), 0.95);
    });
  });
  $('route-open').addEventListener('click', function () { openRoute(); });
  $('zoom-in').addEventListener('click', function () { zoomBy(1.25); });
  $('zoom-out').addEventListener('click', function () { zoomBy(0.8); });
  $('fit-map').addEventListener('click', function () { fitNodes(); announce('Fitted all ' + chart.people.length + ' people on the map.'); });
  $('locate-person').addEventListener('click', function () { if (state.selected) centerNode(state.selected, true); });
  $('layers-toggle').addEventListener('click', function () {
    $('layers-panel').hidden = !$('layers-panel').hidden;
    $('layers-toggle').setAttribute('aria-expanded', String(!$('layers-panel').hidden));
  });
  ['show-generations', 'show-dates', 'show-partners'].forEach(function (id) { $(id).addEventListener('change', updateHighlights); });
  $('minimap').addEventListener('click', function (event) {
    if (!event.detail) { fitNodes(); return; }
    var rect = $('minimap-svg').getBoundingClientRect(), frame = visibleFrame();
    var x = Math.max(0, Math.min(layout.width, (event.clientX - rect.left) / rect.width * layout.width));
    var y = Math.max(0, Math.min(layout.height, (event.clientY - rect.top) / rect.height * layout.height));
    setCamera(frame.x - x * camera.scale, frame.y - y * camera.scale, camera.scale);
  });

  function localPoint(event) {
    var rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function beginGesture() {
    var pointers = Array.from(pointerMap.values());
    if (pointers.length >= 2) {
      var a = pointers[0], b = pointers[1];
      gesture = { type: 'pinch', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), camera: Object.assign({}, camera), moved: true };
    } else if (pointers.length === 1) {
      gesture = { type: 'drag', x: pointers[0].x, y: pointers[0].y, camera: Object.assign({}, camera), moved: false };
    } else gesture = null;
  }

  viewport.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    keyboardNavigation = false;
    pointerMap.set(event.pointerId, localPoint(event));
    beginGesture();
    // Preserve native clicks on names; capture only after actual movement.
    if (!event.target.closest('button')) viewport.focus({ preventScroll: true });
  });
  viewport.addEventListener('pointermove', function (event) {
    if (!pointerMap.has(event.pointerId) || !gesture) return;
    var point = localPoint(event); pointerMap.set(event.pointerId, point);
    if (gesture.type === 'pinch') {
      var pointers = Array.from(pointerMap.values());
      if (pointers.length < 2) return;
      var a = pointers[0], b = pointers[1], x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      var scale = Math.max(minimumScale, Math.min(maximumScale, gesture.camera.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
      var ratio = scale / gesture.camera.scale;
      setCamera(x - (gesture.x - gesture.camera.x) * ratio, y - (gesture.y - gesture.camera.y) * ratio, scale);
    } else {
      var dx = point.x - gesture.x, dy = point.y - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) <= 5) return;
      gesture.moved = true;
      setCamera(gesture.camera.x + dx, gesture.camera.y + dy, gesture.camera.scale);
    }
    viewport.classList.add('is-dragging');
    try { viewport.setPointerCapture(event.pointerId); } catch (error) { /* Pointer has already ended. */ }
    event.preventDefault();
  });
  function endPointer(event) {
    if (!pointerMap.has(event.pointerId)) return;
    if (gesture && gesture.moved) suppressClickUntil = performance.now() + 350;
    pointerMap.delete(event.pointerId);
    try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch (error) { /* Pointer already released. */ }
    beginGesture();
    if (!pointerMap.size) viewport.classList.remove('is-dragging');
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  window.addEventListener('blur', function () { pointerMap.clear(); gesture = null; viewport.classList.remove('is-dragging'); });
  viewport.addEventListener('wheel', function (event) {
    event.preventDefault();
    var point = localPoint(event);
    var delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    zoomAt(camera.scale * Math.exp(-Math.max(-140, Math.min(140, delta)) * 0.003), point.x, point.y);
  }, { passive: false });
  viewport.addEventListener('dblclick', function (event) {
    if (event.target.closest('button')) return;
    var point = localPoint(event); zoomAt(camera.scale * 1.5, point.x, point.y);
  });

  document.addEventListener('pointerdown', function (event) {
    keyboardNavigation = false;
    if (!$('layers-panel').contains(event.target) && !$('layers-toggle').contains(event.target)) {
      $('layers-panel').hidden = true; $('layers-toggle').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', function (event) {
    keyboardNavigation = true;
    if (event.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      var layersWereOpen = !$('layers-panel').hidden;
      $('layers-panel').hidden = true; $('layers-toggle').setAttribute('aria-expanded', 'false');
      if (layersWereOpen) { $('layers-toggle').focus(); return; }
      if (state.mode !== 'explore') {
        var previous = state.selected;
        state.mode = 'explore'; state.selected = null; state.route = null;
        renderPanel(); updateHighlights(); syncHash(); setExpanded(false);
        if (previous && markers.has(previous)) markers.get(previous).focus({ preventScroll: true });
        else viewport.focus({ preventScroll: true });
      } else if (mobile()) setExpanded(false);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,select,textarea,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    if (event.key === '/') { event.preventDefault(); search.focus(); setExpanded(true); return; }
    if (!viewport.contains(event.target) && event.target !== viewport) return;
    var pan = event.shiftKey ? 180 : 70;
    var directions = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
    if (directions[event.key]) { event.preventDefault(); setCamera(camera.x + directions[event.key][0], camera.y + directions[event.key][1], camera.scale); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
    else if (event.key === '-') { event.preventDefault(); zoomBy(0.8); }
    else if (event.key === 'Home' || event.key === '0') { event.preventDefault(); fitNodes(); }
  });
  window.addEventListener('hashchange', function () {
    var hash = readHash();
    switchChart(data.charts.some(function (item) { return item.id === hash.chart; }) ? hash.chart : 'renee', hash);
  });
  var resizeTimer;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () { if (state.selected) centerNode(state.selected, false); else setCamera(camera.x, camera.y, camera.scale); }, 100);
  });
  window.addEventListener('pagehide', function () { stopVideos(document); });

  // The backend adapter swaps editorial snapshots through this narrow interface.
  window.FamilyMap = {
    context: function () { return { chart: state.chart, selected: state.selected }; },
    replaceSnapshot: function (value) {
      var old = { x: camera.x, y: camera.y, scale: camera.scale }, options = readHash();
      var query = state.query, generation = state.generation, memories = state.memories;
      data = value.data; graphData = value.graph;
      window.FAMILY_DATA = data; window.FAMILY_GRAPH = graphData;
      switchChart(state.chart, Object.assign({}, options, { query: query }));
      state.generation = generation && layout.generations.some(function (g) { return g.index === generation; }) ? generation : null;
      state.memories = memories;
      renderPanel(); updateHighlights();
      if (!state.selected) setCamera(old.x, old.y, old.scale);
    }
  };

  try {
    var initial = readHash();
    switchChart(data.charts.some(function (item) { return item.id === initial.chart; }) ? initial.chart : 'renee', initial);
  } catch (error) {
    $('load-error').hidden = false;
    announce('The family map could not load. The original charts are still available.');
    console.error('Family Map could not start:', error);
  }
}());
