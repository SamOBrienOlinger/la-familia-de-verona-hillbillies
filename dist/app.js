(function () {
  'use strict';

  var data = window.FAMILY_DATA;
  var byId = function (id) { return document.getElementById(id); };
  var status = byId('view-status');
  if (!data || !Array.isArray(data.charts) || !data.charts.length) {
    status.textContent = 'The family tree could not load. Please refresh this page.';
    return;
  }

  var viewport = byId('tree-viewport');
  var canvas = byId('tree-canvas');
  var hotspots = byId('person-hotspots');
  var artwork = byId('tree-artwork');
  var search = byId('name-search');
  var searchResults = byId('search-results');
  var list = byId('people-list');
  var dialog = byId('person-dialog');
  var photo = byId('person-photo');
  var placeholder = byId('photo-placeholder');
  var closeButton = byId('dialog-close');
  var mediaQuery = function (query) { return typeof window.matchMedia === 'function' && window.matchMedia(query).matches; };
  var state = {
    chart: data.charts[0],
    view: mediaQuery('(max-width: 560px)') ? 'names' : 'diagram',
    zoom: 1,
    fitted: false,
    currentPerson: null,
    returnFocus: null,
    lastDrag: 0
  };
  var cameraMarkup = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l2-3h4l2 3h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/></svg>';
  var collator = new Intl.Collator('en', { sensitivity: 'base' });
  var normalise = function (value) {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[-‐‑–]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  var hasPhoto = function (person) { return !!(person.photoGroup && data.photoGroups[person.photoGroup]); };
  var personById = function (id) { return state.chart.people.find(function (person) { return person.id === id; }); };
  var initials = function (name) {
    var parts = name.replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };
  var matchesQuery = function (person, query) {
    var haystack = normalise([person.name].concat(person.aliases || []).join(' '));
    return normalise(query).split(' ').filter(Boolean).every(function (term) { return haystack.indexOf(term) !== -1; });
  };
  var currentMatches = function () {
    return state.chart.people.filter(function (person) { return matchesQuery(person, search.value); }).sort(function (a, b) { return collator.compare(a.name, b.name); });
  };
  var announce = function (message) { status.textContent = message; };
  var create = function (tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  var camera = function (className) {
    var span = create('span', className);
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = cameraMarkup;
    return span;
  };

  function syncView() {
    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
    });
    byId('diagram-view').hidden = state.view !== 'diagram';
    byId('names-view').hidden = state.view !== 'names';
    byId('zoom-controls').hidden = state.view !== 'diagram';
    if (state.view === 'names') {
      searchResults.hidden = true;
      renderNames();
    }
  }

  function setView(view) {
    if (view !== 'diagram' && view !== 'names') return;
    state.view = view;
    syncView();
    announce(view === 'names' ? 'Names view. Select a person to open their profile.' : 'Diagram view. Select a name to open their profile.');
  }

  function zoomLimits() {
    var width = viewport.clientWidth || Math.max(280, window.innerWidth - 80);
    var height = viewport.clientHeight || 600;
    return { min: Math.min(0.2, (width - 24) / state.chart.width, (height - 24) / state.chart.height), max: 2.5 };
  }

  function setZoom(value, keepCentre, fitted) {
    var limits = zoomLimits();
    var oldZoom = state.zoom || 1;
    var viewportBounds = viewport.getBoundingClientRect();
    var canvasBounds = canvas.getBoundingClientRect();
    var centreX = (viewportBounds.left + viewport.clientLeft + viewport.clientWidth / 2 - canvasBounds.left) / oldZoom;
    var centreY = (viewportBounds.top + viewport.clientTop + viewport.clientHeight / 2 - canvasBounds.top) / oldZoom;
    state.zoom = Math.max(limits.min, Math.min(limits.max, Number(value) || 1));
    state.fitted = !!fitted;
    canvas.style.width = (state.chart.width * state.zoom) + 'px';
    canvas.style.height = (state.chart.height * state.zoom) + 'px';
    canvas.classList.toggle('is-overview', state.zoom < 0.55);
    byId('zoom-level').textContent = Math.round(state.zoom * 100) + '%';
    byId('zoom-out').disabled = state.zoom <= limits.min + 0.001;
    byId('zoom-in').disabled = state.zoom >= limits.max - 0.001;
    byId('diagram-help-text').textContent = state.zoom < 0.55
      ? 'Whole-tree overview. Zoom in to read names, or switch to Names to browse.'
      : 'Select a name to open a profile. Drag or scroll to explore the diagram.';
    if (keepCentre) {
      canvasBounds = canvas.getBoundingClientRect();
      var offsetX = canvasBounds.left - viewportBounds.left - viewport.clientLeft + viewport.scrollLeft;
      var offsetY = canvasBounds.top - viewportBounds.top - viewport.clientTop + viewport.scrollTop;
      viewport.scrollLeft = Math.max(0, offsetX + centreX * state.zoom - viewport.clientWidth / 2);
      viewport.scrollTop = Math.max(0, offsetY + centreY * state.zoom - viewport.clientHeight / 2);
    }
  }

  function fitTree(shouldAnnounce) {
    var width = viewport.clientWidth || Math.max(280, window.innerWidth - 80);
    var height = viewport.clientHeight || 600;
    setZoom(Math.min((width - 22) / state.chart.width, (height - 22) / state.chart.height), false, true);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    if (shouldAnnounce !== false) announce('The complete tree is fitted to the diagram window.');
  }

  function renderChart() {
    artwork.src = state.chart.image;
    artwork.setAttribute('width', state.chart.width);
    artwork.setAttribute('height', state.chart.height);
    hotspots.replaceChildren();
    state.chart.people.forEach(function (person) {
      var button = create('button', 'person-hotspot' + (hasPhoto(person) ? ' has-photo' : ''));
      button.type = 'button';
      button.dataset.personId = person.id;
      button.id = 'card-' + person.id;
      button.style.left = (person.x / state.chart.width * 100) + '%';
      button.style.top = (person.y / state.chart.height * 100) + '%';
      button.style.width = (person.w / state.chart.width * 100) + '%';
      button.style.height = (person.h / state.chart.height * 100) + '%';
      button.setAttribute('aria-label', person.name + (hasPhoto(person) ? ', open photograph' : ', open profile. Photo not yet added'));
      button.setAttribute('aria-haspopup', 'dialog');
      button.title = person.name + (hasPhoto(person) ? ' — View photograph' : ' — Open profile');
      if (hasPhoto(person)) button.appendChild(camera('photo-badge'));
      hotspots.appendChild(button);
    });
    document.querySelectorAll('[data-chart]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.chart === state.chart.id));
    });
    var photographed = state.chart.people.filter(hasPhoto).length;
    byId('chart-summary').textContent = state.chart.people.length + ' names · ' + photographed + ' linked to a photograph';
    searchResults.hidden = true;
    syncView();
    var width = viewport.clientWidth || Math.max(280, window.innerWidth - 80);
    setZoom(Math.min(1.05, Math.max(0.8, (width - 20) / state.chart.width)), false, false);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    updateMatches(false);
  }

  function selectChart(id) {
    var chart = data.charts.find(function (entry) { return entry.id === id; });
    if (!chart || chart === state.chart) return;
    state.chart = chart;
    search.value = '';
    renderChart();
    announce(chart.label + '. ' + chart.people.length + ' names available.');
  }

  function renderNames() {
    var people = currentMatches();
    list.replaceChildren();
    people.forEach(function (person) {
      var item = create('li');
      var button = create('button', 'person-list-button' + (hasPhoto(person) ? ' has-photo' : ''));
      button.type = 'button';
      button.dataset.personId = person.id;
      button.setAttribute('aria-haspopup', 'dialog');
      var avatar = create('span', 'list-avatar');
      avatar.setAttribute('aria-hidden', 'true');
      if (hasPhoto(person)) {
        var thumb = create('img');
        thumb.src = data.photoGroups[person.photoGroup].src;
        thumb.alt = '';
        thumb.loading = 'lazy';
        avatar.appendChild(thumb);
      } else {
        avatar.textContent = initials(person.name);
      }
      var text = create('span', 'list-person-copy');
      text.appendChild(create('span', 'list-person-name', person.name));
      text.appendChild(create('span', 'list-photo-status', hasPhoto(person) ? 'Open photograph' : 'Photo still to be added'));
      button.appendChild(avatar);
      button.appendChild(text);
      if (hasPhoto(person)) button.appendChild(camera('list-camera'));
      item.appendChild(button);
      list.appendChild(item);
    });
    byId('empty-search').hidden = people.length !== 0;
    byId('names-heading').textContent = normalise(search.value) ? people.length + (people.length === 1 ? ' matching name' : ' matching names') : 'Names in this chart';
  }

  function renderSearchResults(people) {
    searchResults.replaceChildren();
    if (!people.length) {
      searchResults.appendChild(create('p', '', 'No names match. Try a first name or family name.'));
      return;
    }
    var items = create('ul');
    people.forEach(function (person) {
      var item = create('li');
      var button = create('button', '');
      button.type = 'button';
      button.dataset.personId = person.id;
      button.setAttribute('aria-haspopup', 'dialog');
      button.appendChild(create('span', '', person.name));
      if (hasPhoto(person)) button.appendChild(camera(''));
      item.appendChild(button);
      items.appendChild(item);
    });
    searchResults.appendChild(items);
  }

  function updateMatches(shouldAnnounce) {
    var query = normalise(search.value);
    var matches = currentMatches();
    var matchingIds = new Set(matches.map(function (person) { return person.id; }));
    hotspots.querySelectorAll('[data-person-id]').forEach(function (button) {
      button.classList.toggle('is-match', !!query && matchingIds.has(button.dataset.personId));
    });
    if (state.view === 'names') {
      renderNames();
      searchResults.hidden = true;
    } else if (query) {
      renderSearchResults(matches);
      searchResults.hidden = document.activeElement !== search && !searchResults.contains(document.activeElement);
    } else {
      searchResults.hidden = true;
    }
    if (shouldAnnounce !== false) announce(query ? matches.length + (matches.length === 1 ? ' name matches.' : ' names match.') : '');
  }

  function readableLine(line) {
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return line.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, function (match, month, day, year) {
      var m = Number(month), d = Number(day), y = Number(year);
      var date = new Date(Date.UTC(y, m - 1, d));
      if (m < 1 || m > 12 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return match;
      return d + ' ' + months[m - 1] + ' ' + year;
    });
  }

  function showPlaceholder(loadFailed) {
    photo.hidden = true;
    placeholder.hidden = false;
    placeholder.querySelector('h3').textContent = loadFailed ? 'Photograph could not load' : 'No photo added yet';
    placeholder.querySelector('p').textContent = loadFailed ? 'Please close this profile and try again.' : 'This profile is ready for a family photograph.';
  }

  function dialogIsOpen() {
    return dialog.open || dialog.dataset.fallbackOpen === 'true';
  }

  function setFallbackBackground(inert) {
    document.querySelectorAll('.site-header, main, .site-footer').forEach(function (element) {
      element.inert = inert;
    });
  }

  function openPerson(person, trigger) {
    if (!person) return;
    var wasOpen = dialogIsOpen();
    if (!wasOpen) state.returnFocus = trigger || document.activeElement;
    state.currentPerson = person;
    byId('person-title').textContent = person.name;
    byId('placeholder-initials').textContent = initials(person.name);
    byId('profile-source').textContent = 'Recorded in ' + state.chart.label + '.';
    var group = hasPhoto(person) ? data.photoGroups[person.photoGroup] : null;
    byId('profile-eyebrow').textContent = group ? 'FROM THE FAMILY ALBUM' : 'FAMILY PROFILE';
    byId('photo-caption').hidden = !group;
    byId('photo-caption').textContent = group ? group.caption : '';
    photo.onerror = null;
    if (group) {
      placeholder.hidden = true;
      photo.alt = group.alt;
      photo.src = group.src;
      photo.hidden = false;
      photo.onerror = function () { showPlaceholder(true); };
    } else {
      photo.removeAttribute('src');
      photo.alt = '';
      showPlaceholder(false);
    }
    var detailsContainer = byId('profile-details');
    detailsContainer.replaceChildren();
    if (person.lines && person.lines.length) {
      var details = create('details');
      details.appendChild(create('summary', '', 'Details from this chart'));
      person.lines.forEach(function (line) { details.appendChild(create('p', '', readableLine(line))); });
      detailsContainer.appendChild(details);
    }
    var companions = group ? state.chart.people.filter(function (entry) { return entry.photoGroup === person.photoGroup; }) : [];
    byId('photo-people').hidden = !companions.length;
    var companionButtons = byId('photo-people-buttons');
    companionButtons.replaceChildren();
    companions.forEach(function (companion) {
      var label = companion.photoLabel || companion.name;
      var button = create('button', '', label);
      button.type = 'button';
      button.dataset.companionId = companion.id;
      button.setAttribute('aria-label', 'View ' + companion.name + ' in this photograph');
      button.setAttribute('aria-pressed', String(companion.id === person.id));
      companionButtons.appendChild(button);
    });
    searchResults.hidden = true;
    if (!wasOpen) {
      document.body.classList.add('dialog-open');
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
        dialog.dataset.fallbackOpen = 'true';
        setFallbackBackground(true);
      }
      closeButton.focus({ preventScroll: true });
    }
  }

  function afterClose() {
    document.body.classList.remove('dialog-open');
    setFallbackBackground(false);
    var returnFocus = state.returnFocus;
    state.returnFocus = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function closeDialog() {
    if (!dialogIsOpen()) return;
    if (dialog.dataset.fallbackOpen === 'true') {
      dialog.removeAttribute('open');
      delete dialog.dataset.fallbackOpen;
      afterClose();
    } else {
      dialog.close();
    }
  }

  function focusOnTree(person) {
    if (!person) return;
    search.value = '';
    updateMatches(false);
    setView('diagram');
    setZoom(Math.max(state.zoom, 1.25), false, false);
    var x = (person.x + person.w / 2) * state.zoom - viewport.clientWidth / 2;
    var y = (person.y + person.h / 2) * state.zoom - viewport.clientHeight / 2;
    viewport.scrollLeft = Math.max(0, x);
    viewport.scrollTop = Math.max(0, y);
    var target = byId('card-' + person.id);
    if (target) target.focus({ preventScroll: true });
    byId('explorer').scrollIntoView({ behavior: mediaQuery('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth', block: 'start' });
    announce(person.name + ' is highlighted on the tree.');
  }

  document.querySelectorAll('[data-chart]').forEach(function (button) {
    button.addEventListener('click', function () { selectChart(button.dataset.chart); });
  });
  document.querySelectorAll('[data-view]').forEach(function (button) {
    button.addEventListener('click', function () { setView(button.dataset.view); });
  });
  [hotspots, list, searchResults].forEach(function (container) {
    container.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-person-id]');
      if (!button || !container.contains(button)) return;
      if (container === hotspots && Date.now() - state.lastDrag < 220) return;
      openPerson(personById(button.dataset.personId), container === searchResults ? search : button);
    });
  });
  byId('featured-photo').addEventListener('click', function (event) {
    var jenna = state.chart.people.find(function (person) { return person.photoGroup === 'jenna-cromwell' && person.name.indexOf('Jenna') === 0; });
    openPerson(jenna, event.currentTarget);
  });
  search.addEventListener('input', function () { updateMatches(true); });
  search.addEventListener('focus', function () { updateMatches(false); });
  search.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { searchResults.hidden = true; return; }
    if (event.key === 'ArrowDown' && !searchResults.hidden) {
      var first = searchResults.querySelector('button');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter' && normalise(search.value)) {
      var person = currentMatches()[0];
      if (person) { event.preventDefault(); openPerson(person, search); }
    }
  });
  searchResults.addEventListener('keydown', function (event) {
    var buttons = Array.from(searchResults.querySelectorAll('button'));
    var index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault(); search.focus(); searchResults.hidden = true;
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      var next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      if (next < 0) search.focus();
      else if (buttons.length) buttons[Math.min(next, buttons.length - 1)].focus();
    }
  });
  document.addEventListener('pointerdown', function (event) {
    if (!event.target.closest('.search-wrap')) searchResults.hidden = true;
  });
  document.querySelector('.search-wrap').addEventListener('focusout', function () {
    window.setTimeout(function () {
      if (!document.querySelector('.search-wrap').contains(document.activeElement)) searchResults.hidden = true;
    }, 0);
  });
  byId('zoom-in').addEventListener('click', function () { setZoom(state.zoom * 1.25, true, false); });
  byId('zoom-out').addEventListener('click', function () { setZoom(state.zoom / 1.25, true, false); });
  byId('fit-tree').addEventListener('click', function () { fitTree(true); });
  closeButton.addEventListener('click', closeDialog);
  dialog.addEventListener('close', afterClose);
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
  });
  dialog.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
    if (event.key !== 'Tab') return;
    var focusable = Array.from(dialog.querySelectorAll('button, a[href], input, summary, [tabindex="0"]')).filter(function (element) {
      return !element.disabled && !element.closest('[hidden]');
    });
    if (!focusable.length) { event.preventDefault(); closeButton.focus(); return; }
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  byId('photo-people-buttons').addEventListener('click', function (event) {
    var button = event.target.closest('[data-companion-id]');
    if (!button) return;
    var companion = personById(button.dataset.companionId);
    openPerson(companion);
    var active = byId('photo-people-buttons').querySelector('[aria-pressed="true"]');
    if (active) active.focus();
  });
  byId('show-on-tree').addEventListener('click', function () {
    var person = state.currentPerson;
    state.returnFocus = null;
    closeDialog();
    window.requestAnimationFrame(function () { focusOnTree(person); });
  });

  var drag = null;
  viewport.addEventListener('pointerdown', function (event) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
  });
  viewport.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      drag.moved = true;
      viewport.classList.add('is-dragging');
      if (typeof viewport.setPointerCapture === 'function') viewport.setPointerCapture(event.pointerId);
    }
    if (drag.moved) {
      viewport.scrollLeft = drag.left - dx;
      viewport.scrollTop = drag.top - dy;
      event.preventDefault();
    }
  });
  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    if (drag.moved) state.lastDrag = Date.now();
    if (viewport.hasPointerCapture && viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
    drag = null;
    viewport.classList.remove('is-dragging');
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('blur', function () { endDrag(); });
  var resizeTimer;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () { if (state.fitted && state.view === 'diagram') fitTree(false); }, 100);
  });
  artwork.addEventListener('error', function () {
    setView('names');
    announce('The diagram could not load. Every name is still available in the Names view.');
  });
  renderChart();
}());
