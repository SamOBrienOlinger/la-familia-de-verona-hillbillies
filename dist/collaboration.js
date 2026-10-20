/* Shared editorial tools. No browser-only database, embedded credentials or anonymous writes. */
(function () {
  'use strict';
  const apiMeta = document.querySelector('meta[name="family-api"]');
  const base = apiMeta ? new URL(apiMeta.content, location.href) : null;
  if (base && base.origin !== location.origin) throw new Error('Use the same-origin family API.');
  let account = null, csrf = '', snapshot = null, revision = 0;
  let busy = false, dirty = false, opener = null, objectURLs = [], modalToken = 0;
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const button = (text, callback, className = 'secondary-button') => {
    const item = node('button', text, className); item.type = 'button';
    item.addEventListener('click', callback); return item;
  };
  const banner = node('div', undefined, 'collab-banner');
  banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite'); banner.hidden = true;
  document.body.append(banner);
  const dialog = node('dialog', undefined, 'collab-dialog'); dialog.id = 'contributor-dialog';
  dialog.setAttribute('aria-labelledby', 'contributor-title');
  document.body.append(dialog);
  const launch = button('Contribute', dashboard, 'secondary-button contribute-button');
  launch.id = 'contributor-open';
  document.querySelector('.header-actions').prepend(launch);

  function message(text, refresh = false) {
    banner.replaceChildren(node('span', text)); banner.hidden = false;
    if (refresh) banner.append(button('Refresh map', () => refreshSnapshot().then(() => message('The shared map is up to date.')).catch(e => message(e.message))));
    banner.append(button('Dismiss', () => { banner.hidden = true; }));
  }
  function describe(value) {
    if (value == null) return '—';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(describe).join(' ');
    return Object.entries(value || {}).map(([key, detail]) => key + ': ' + describe(detail)).join(' ');
  }
  async function request(path, options = {}) {
    if (!base) throw new Error('Shared editing is available in the Heroku app, not this static preview.');
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Invalid API address.');
    const headers = {Accept: 'application/json', ...options.headers};
    if (options.method && options.method !== 'GET') headers['X-CSRFToken'] = csrf;
    let body = options.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch(url, {...options, body, headers, credentials: 'same-origin', signal: controller.signal});
      const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (!response.ok) {
        const error = new Error(payload ? describe(payload.detail || payload) : 'The server could not complete the request.');
        error.status = response.status; throw error;
      }
      if (!payload) throw new Error('The server returned an unexpected response. Check the shared record before retrying; the write may have completed.');
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request timed out. Check the shared record before retrying; the server may still have received it.');
      if (error instanceof TypeError) throw new Error('Cannot reach the backend. Your form is still here; check your connection.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function all(path) {
    const rows = []; let next = path;
    while (next) { const page = await request(next); rows.push(...page.results); next = page.next; }
    return rows;
  }
  async function session() {
    const result = await request('account/session/'); csrf = result.csrf; account = result.user;
    launch.textContent = account ? 'Edit family' : 'Contribute'; return result;
  }
  function context() { return window.FamilyMap?.context() || {chart: 'renee', selected: null}; }
  function people(chart) { return (snapshot?.data.charts || []).filter(c => !chart || c.id === chart).flatMap(c => c.people); }
  function personName(id) { return people().find(p => p.id === id)?.name || id; }
  async function refreshSnapshot() {
    const value = await request('snapshot/');
    if (!value.data.charts.length) throw new Error('The backend has no charts yet. Run the import_family management command.');
    snapshot = value; revision = value.revision;
    window.FamilyMap.replaceSnapshot(value); injectActions();
  }
  function cleanupURLs() { objectURLs.forEach(URL.revokeObjectURL); objectURLs = []; }
  function close(force = false) {
    if (busy && !force) return;
    if (dirty && !force) {
      if (dialog.querySelector('.discard-prompt')) return;
      const warning = node('div', undefined, 'discard-prompt');
      warning.append(node('p', 'You have unsaved changes. Discard them?'),
        button('Keep editing', () => warning.remove()),
        button('Discard changes', () => close(true), 'danger-button'));
      dialog.append(warning); warning.querySelector('button').focus(); return;
    }
    dirty = false; modalToken++; cleanupURLs(); dialog.querySelectorAll('video').forEach(v => v.pause());
    dialog.close(); if (opener?.isConnected) opener.focus();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
  function screen(title) {
    if (!dialog.open) { opener = document.activeElement; dialog.showModal(); }
    cleanupURLs(); dirty = false; modalToken++;
    const heading = node('h2', title); heading.id = 'contributor-title'; heading.tabIndex = -1;
    const header = node('header', undefined, 'collab-heading');
    const x = button('Close', () => close()); x.id = 'contributor-close'; header.append(heading, x);
    const error = node('div', undefined, 'collab-error'); error.id = 'contributor-error'; error.hidden = true;
    error.setAttribute('role', 'alert'); error.tabIndex = -1;
    const body = node('div', undefined, 'collab-body'); dialog.replaceChildren(header, error, body);
    heading.focus(); return body;
  }
  function showError(error) {
    const box = dialog.querySelector('#contributor-error'); if (!box) return;
    box.textContent = error.message; box.hidden = false; box.focus();
    if (error.status === 409) box.append(node('p', 'Your draft has not been overwritten. Copy any text you need, close this form and reopen the current record to reconcile it.'));
  }
  async function loading(title, builder) {
    const body = screen(title), token = modalToken; body.append(node('p', 'Loading…'));
    try { await builder(body, () => token === modalToken); } catch (error) { if (token === modalToken) { body.replaceChildren(); showError(error); } }
  }
  function field(form, label, name, value = '', type = 'text', required = false) {
    const wrap = node('label', undefined, 'collab-field'); wrap.append(node('span', label));
    const input = node(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.name = name; input.value = value ?? ''; input.required = required;
    if (type === 'textarea') input.rows = 3;
    wrap.append(input); form.append(wrap); return input;
  }
  function select(form, label, name, options, value) {
    const wrap = node('label', undefined, 'collab-field'); wrap.append(node('span', label));
    const input = node('select'); input.name = name;
    options.forEach(([id, text]) => { const option = node('option', text); option.value = id; input.append(option); });
    input.value = value || options[0]?.[0] || ''; wrap.append(input); form.append(wrap); return input;
  }
  function formIn(body, saveLabel, save) {
    const form = node('form'), fields = node('fieldset'); fields.className = 'collab-fields';
    const controls = node('div', undefined, 'collab-controls'), submit = node('button', saveLabel, 'primary-button'); submit.type = 'submit';
    controls.append(button('Cancel', () => close()), submit); form.append(fields, controls); body.append(form);
    fields.addEventListener('input', () => { dirty = true; }); fields.addEventListener('change', () => { dirty = true; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return;
      const values = new FormData(form);
      busy = true; launch.disabled = true; fields.disabled = true; submit.disabled = true;
      dialog.querySelector('#contributor-close').disabled = true;
      const old = submit.textContent; submit.textContent = 'Saving…'; form.setAttribute('aria-busy', 'true');
      let saved = false;
      try {
        await save(values); saved = true; dirty = false;
        try { await session(); await refreshSnapshot(); message('Saved to the shared family record.'); }
        catch (error) { message('Saved, but the map could not refresh. ' + error.message, true); }
        close(true);
      } catch (error) { showError(error); }
      finally {
        busy = false; launch.disabled = false; fields.disabled = false; submit.disabled = false; submit.textContent = old; form.removeAttribute('aria-busy');
        const closeButton = dialog.querySelector('#contributor-close'); if (closeButton) closeButton.disabled = false;
        if (saved) injectActions();
      }
    });
    return fields;
  }
  async function dashboard() {
    if (busy) return;
    if (dialog.open && dirty) { close(); return; }
    if (!base) {
      const body = screen('Shared family editing');
      body.append(node('p', 'This is a read-only preview. Shared editing needs the Django backend running on Heroku.'),
        node('p', 'No edits or uploads are stored only in this browser. The original tree remains available.'));
      return;
    }
    await loading('Contribute to the family record', async (body, current) => {
      await session(); if (!snapshot) await refreshSnapshot(); if (!current()) return;
      if (!account) { loginForm(false); return; }
      body.replaceChildren(node('p', 'Signed in as ' + account.username + '. Every contributor can add, edit and restore shared records.'));
      const actions = node('div', undefined, 'collab-menu');
      actions.append(button('Add a person', () => personForm()), button('Add a connection', () => relationForm()),
        button('Upload a memory', () => mediaForm()), button('Change history', () => history()), button('Open Trash', () => trash()));
      if (account.staff) actions.append(button('Create invitation', invitation));
      actions.append(button('Refresh shared map', async () => { try { await refreshSnapshot(); message('Shared map refreshed.'); } catch (error) { showError(error); } }),
        button('Sign out', async () => { try { const result = await request('account/logout/', {method: 'POST', body: {}}); csrf = result.csrf; account = null; launch.textContent = 'Contribute'; close(true); injectActions(); message('Signed out. The family map is read-only.'); } catch (error) { showError(error); } }));
      body.append(actions, node('p', 'The viewer and its original charts are public. Only share photographs and details you have permission to publish.'));
    });
  }
  function loginForm(register) {
    const body = screen(register ? 'Join the family contributors' : 'Sign in to contribute');
    body.append(node('p', register ? 'Use a single-use invitation from the family maintainer. All contributor accounts have the same editing rights.' : 'Sign in to save changes for everyone.'));
    const fields = formIn(body, register ? 'Create account' : 'Sign in', async values => {
      const result = await request('account/' + (register ? 'register/' : 'login/'), {method: 'POST', body: Object.fromEntries(values)});
      account = result.user; csrf = result.csrf;
    });
    field(fields, 'Username', 'username', '', 'text', true).autocomplete = 'username';
    if (register) field(fields, 'Email address', 'email', '', 'email', true).autocomplete = 'email';
    const password = field(fields, 'Password' + (register ? ' (at least 12 characters)' : ''), 'password', '', 'password', true);
    password.autocomplete = register ? 'new-password' : 'current-password';
    if (register) { password.minLength = 12; field(fields, 'Invitation code', 'invite', '', 'text', true).autocomplete = 'off'; }
    body.append(button(register ? 'Already a contributor? Sign in' : 'Have an invitation? Join the family', () => { if (!dirty) loginForm(!register); else close(); }));
    const reset = node('a', 'Forgot your password?'); reset.href = '/accounts/password_reset/'; body.append(reset);
  }
  async function personForm(id) {
    await loading(id ? 'Edit person' : 'Add a person', async (body, current) => {
      const record = id ? await request('people/' + id + '/') : {chart: context().chart, generation: 1, lines: [], aliases: []};
      if (!current()) return; body.replaceChildren();
      body.append(node('p', 'You are editing ' + record.chart + '. Source charts are kept separate; changes here do not rewrite the original PDF.'));
      const fields = formIn(body, 'Save person', values => {
        const lines = ['Birth', 'Marriage', 'Death'].filter(key => values.get(key).trim()).map(key => key + ' ' + values.get(key).trim());
        lines.push(...values.get('other').split('\n').map(s => s.trim()).filter(Boolean));
        const payload = {chart: record.chart, name: values.get('name'), aliases: values.get('aliases').split('\n').filter(Boolean),
          lines, notes: values.get('notes'), generation: Number(values.get('generation'))};
        return request('people/' + (id ? id + '/' : ''), {method: id ? 'PATCH' : 'POST', body: payload,
          headers: id ? {'If-Match': String(record.version)} : {}});
      });
      field(fields, 'Full name', 'name', record.name, 'text', true).maxLength = 160;
      field(fields, 'Other names / aliases (one per line)', 'aliases', record.aliases.join('\n'), 'textarea').maxLength = 3400;
      ['Birth', 'Marriage', 'Death'].forEach(key => field(fields, key + ' date (year or MM/DD/YYYY; leave unknown dates blank)', key,
        record.lines.find(line => line.startsWith(key + ' '))?.slice(key.length + 1) || '').maxLength = 300);
      field(fields, 'Other recorded details (one per line)', 'other', record.lines.filter(line => !/^(Birth|Marriage|Death) /.test(line)).join('\n'), 'textarea').maxLength = 6000;
      field(fields, 'Notes', 'notes', record.notes, 'textarea').maxLength = 5000;
      const gen = field(fields, 'Starting generation (connections may place this person in a later generation)', 'generation', record.generation, 'number', true); gen.min = 1; gen.max = 30;
      if (record.source_snapshot && Object.keys(record.source_snapshot).length) {
        const source = node('details'); source.append(node('summary', 'View the unmodified source record'), node('pre', JSON.stringify(record.source_snapshot, null, 2)));
        body.append(source);
      }
    });
  }
  async function relationForm(id) {
    await loading(id ? 'Edit connection' : 'Add a family connection', async (body, current) => {
      const record = id ? await request('relationships/' + id + '/') : {chart: context().chart, source: context().selected};
      if (!current()) return; body.replaceChildren(node('p', 'Parent → child is directional. Partner links do not imply a biological relationship. Cycles and duplicate links are rejected.'));
      const fields = formIn(body, 'Save connection', values => request('relationships/' + (id ? id + '/' : ''), {
        method: id ? 'PATCH' : 'POST', headers: id ? {'If-Match': String(record.version)} : {},
        body: {chart: record.chart, source: values.get('source'), target: values.get('target'), kind: values.get('kind'), notes: values.get('notes')}}));
      const choices = people(record.chart).map(p => [p.id, p.name]);
      select(fields, 'Connection type', 'kind', [['parent', 'Parent → child'], ['partner', 'Partners']], record.kind);
      select(fields, 'First person (the parent for a parent → child link)', 'source', choices, record.source);
      select(fields, 'Second person (the child for a parent → child link)', 'target', choices, record.target);
      field(fields, 'Connection notes', 'notes', record.notes, 'textarea').maxLength = 500;
    });
  }
  async function connections(id) {
    await loading('Connections for ' + personName(id), async (body, current) => {
      const records = (await all('relationships/?chart=' + encodeURIComponent(context().chart))).filter(e => e.source === id || e.target === id);
      if (!current()) return; body.replaceChildren(button('Add a connection', () => relationForm()));
      records.forEach(e => {
        const row = node('div', undefined, 'collab-record');
        row.append(node('p', personName(e.source) + (e.kind === 'parent' ? ' → child: ' : ' — partner: ') + personName(e.target)),
          button('Edit connection', () => relationForm(e.id)), button('Move connection to Trash', () => confirmTrash('relationships', e), 'danger-button'));
        body.append(row);
      });
      if (!records.length) body.append(node('p', 'No active connections.'));
    });
  }
  async function mediaForm(id, selected) {
    await loading(id ? 'Edit memory' : 'Upload a memory', async (body, current) => {
      const record = id ? await request('media/' + id + '/') : {people: [selected || context().selected].filter(Boolean)};
      if (!current()) return; body.replaceChildren(node('p', 'JPEG, PNG or WebP: up to 8 MB. MP4 or MOV: up to 20 MB and two minutes. Upload one file at a time. The newest edited memory appears on the map.'));
      const fields = formIn(body, id ? 'Save memory' : 'Upload memory', values => {
        if (!values.get('file')?.size) values.delete('file');
        return request('media/' + (id ? id + '/' : ''), {method: id ? 'PATCH' : 'POST', body: values,
          headers: id ? {'If-Match': String(record.version)} : {}});
      });
      field(fields, 'Caption', 'caption', record.caption, 'text', true).maxLength = 200;
      field(fields, 'Image description / video description', 'alt', record.alt, 'text', true).maxLength = 300;
      field(fields, 'Photographer / source credit', 'credit', record.credit).maxLength = 200;
      const file = field(fields, id ? 'Replace file (optional)' : 'Choose a file', 'file', '', 'file', !id);
      file.accept = '.jpg,.jpeg,.png,.webp,.mp4,.mov';
      const preview = node('div', undefined, 'upload-preview'); fields.append(preview);
      file.addEventListener('change', () => {
        cleanupURLs(); preview.replaceChildren(); consent.checked = false; const selectedFile = file.files[0]; if (!selectedFile) return;
        const image = selectedFile.type.startsWith('image/'), max = image ? 8 : 20;
        if (selectedFile.size > max * 1024 * 1024) { file.value = ''; showError(new Error('This file exceeds the ' + max + ' MB limit.')); return; }
        const url = URL.createObjectURL(selectedFile); objectURLs.push(url);
        const media = node(image ? 'img' : 'video'); media.src = url;
        if (image) media.alt = 'Preview of the selected upload'; else { media.controls = true; media.playsInline = true; }
        preview.append(media, node('p', selectedFile.name + ' · ' + (selectedFile.size / 1048576).toFixed(1) + ' MB'));
      });
      const picker = node('fieldset', undefined, 'people-picker'); picker.append(node('legend', 'People in this memory (select all relevant source profiles)'));
      const filter = field(picker, 'Filter the people list', 'people-filter', '', 'search');
      const choices = node('div', undefined, 'people-choices');
      (snapshot.data.charts || []).forEach(chart => chart.people.forEach(person => {
        const label = node('label'), check = node('input'); check.type = 'checkbox'; check.name = 'people'; check.value = person.id;
        check.checked = record.people.includes(person.id); label.append(check, node('span', person.name + ' · ' + chart.label)); choices.append(label);
      }));
      filter.addEventListener('input', () => choices.querySelectorAll('label').forEach(label => { label.hidden = !window.FamilyMapCore.normalise(label.textContent).includes(window.FamilyMapCore.normalise(filter.value)); }));
      picker.append(choices); fields.append(picker);
      const label = node('label', undefined, 'consent-check'), consent = node('input'); consent.type = 'checkbox'; consent.name = 'consent_confirmed'; consent.value = 'true'; consent.required = true; consent.checked = !!record.consent_confirmed;
      label.append(consent, node('span', 'I have permission to publish this memory, including appropriate parental permission where children are pictured.'));
      fields.append(label);
    });
  }
  async function memories(id) {
    await loading('Memories for ' + personName(id), async (body, current) => {
      const records = await all('media/?person=' + encodeURIComponent(id)); if (!current()) return;
      body.replaceChildren(button('Upload another memory', () => mediaForm(null, id)));
      records.forEach(m => {
        const row = node('section', undefined, 'collab-record'), media = node(m.kind === 'image' ? 'img' : 'video'); media.src = m.url;
        if (m.kind === 'image') media.alt = m.alt; else { media.controls = true; media.playsInline = true; media.preload = 'metadata'; }
        row.append(media, node('h3', m.caption), node('p', m.credit || m.alt), button('Edit or replace memory', () => mediaForm(m.id)),
          button('Move memory to Trash', () => confirmTrash('media', m), 'danger-button')); body.append(row);
      });
      if (!records.length) body.append(node('p', 'No memories have been uploaded for this person yet.'));
    });
  }
  function confirmTrash(kind, record) {
    const body = screen('Move to Trash?');
    body.append(node('p', 'This removes ' + (record.name || record.caption || 'this connection') + ' from the shared map for everyone. You can restore it from Trash.'),
      node('p', kind === 'people' ? 'Connections involving this person also move to Trash. Restore the person first, then restore their connections individually.' : 'This does not erase the unmodified source chart or previously published copies.'));
    formIn(body, 'Move to Trash', () => request(kind + '/' + record.id + '/', {method: 'DELETE', headers: {'If-Match': String(record.version)}}));
    dialog.querySelector('button[type="submit"]').className = 'danger-button';
  }
  async function trash() {
    await loading('Recover deleted records', async (body, current) => {
      const groups = await Promise.all(['people', 'relationships', 'media'].map(async kind => [kind, await all(kind + '/?trash=1')]));
      if (!current()) return; body.replaceChildren(node('p', 'Restore people before restoring their connections. Connections are revalidated; cycles and duplicates cannot be restored.'));
      groups.forEach(([kind, records]) => {
        body.append(node('h3', kind === 'media' ? 'Memories' : kind === 'people' ? 'People' : 'Connections'));
        if (!records.length) body.append(node('p', 'Nothing in Trash.'));
        records.forEach(record => {
          const row = node('div', undefined, 'collab-record');
          row.append(node('p', record.name || record.caption || personName(record.source) + ' — ' + personName(record.target)));
          row.append(button('Restore', async event => {
            const target = event.currentTarget; target.disabled = true;
            try { await request(kind + '/' + record.id + '/restore/', {method: 'POST', body: {}, headers: {'If-Match': String(record.version)}}); await refreshSnapshot(); await trash(); message('Record restored.'); }
            catch (error) { showError(error); target.disabled = false; }
          })); body.append(row);
        });
      });
    });
  }
  async function history(id) {
    await loading('Change history', async (body, current) => {
      const path = 'history/?' + (id ? 'object_id=' + encodeURIComponent(id) : '');
      const page = await request(path); if (!current()) return;
      body.replaceChildren(node('p', 'History records successful changes and the contributor who made them. The original source data is retained separately.'));
      const draw = data => {
        data.results.forEach(event => {
          const row = node('details', undefined, 'collab-record');
          row.append(node('summary', event.actor_name + ' · ' + event.action + ' ' + event.entity + ' · ' + new Date(event.created_at).toLocaleString()));
          const keys = new Set([...Object.keys(event.before), ...Object.keys(event.after)]);
          keys.forEach(key => { if (!['source_snapshot', 'updated_at', 'version'].includes(key) && JSON.stringify(event.before[key]) !== JSON.stringify(event.after[key])) row.append(node('p', key + ': ' + describe(event.before[key] ?? '—') + ' → ' + describe(event.after[key] ?? '—'))); }); body.append(row);
        });
        if (data.next_before) body.append(button('Load earlier changes', async event => {
          const target = event.currentTarget; target.disabled = true;
          try { const more = await request(path + '&before=' + data.next_before); target.remove(); draw(more); }
          catch (error) { target.disabled = false; showError(error); }
        }));
      };
      draw(page); if (!page.results.length) body.append(node('p', 'No changes have been recorded yet.'));
    });
  }
  function invitation() {
    const body = screen('Invite a contributor'); body.append(node('p', 'The code can be used once and expires in seven days. Share it privately.'));
    const form = node('form'), email = field(form, 'Email address (recommended)', 'email', '', 'email');
    const submit = node('button', 'Create invitation', 'primary-button'); submit.type = 'submit'; form.append(submit); body.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true;
      try { const result = await request('invites/', {method: 'POST', body: {email: email.value}});
        const code = field(body, 'Single-use invitation code', 'code', result.invite); code.readOnly = true; code.select(); }
      catch (error) { showError(error); } finally { submit.disabled = false; }
    });
  }
  function injectActions() {
    document.querySelectorAll('.contributor-actions').forEach(item => item.remove());
    if (!account || !snapshot) return;
    const id = context().selected, person = people().find(p => p.id === id); if (!person) return;
    const group = node('section', undefined, 'contributor-actions'); group.setAttribute('aria-label', 'Edit shared family record');
    group.append(button('Edit details', () => personForm(id)), button('Manage memories', () => memories(id)),
      button('Manage connections', () => connections(id)), button('View edit history', () => history(id)),
      button('Move person to Trash', () => confirmTrash('people', person), 'danger-button'));
    document.querySelector('#panel-body .profile-source')?.after(group);
  }
  document.addEventListener('family:panel', injectActions);
  if (base) {
    Promise.all([session(), refreshSnapshot()]).then(() => { injectActions(); message('Connected to the shared family record.'); }).catch(error => message('Shared editing is unavailable. ' + error.message));
    setInterval(async () => {
      if (document.hidden || busy) return;
      try { const current = await request('revision/'); if (current.revision !== revision) message('The shared family record has new changes. Your open form will not be overwritten.', true); }
      catch (_) { /* Do not discard drafts or replace the map during a network interruption. */ }
    }, 30000);
  }
}());
