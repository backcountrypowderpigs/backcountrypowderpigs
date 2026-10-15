/* Live sync for Backcountry Powder Pigs, through one free Google Firebase (Firestore) database.
   - Public, to everyone using the app: slide reports, slide paths, hazard markers, checks, and any route or track
     its owner marks "Everyone".
   - Crew only (friends who share a crew code): good-snow markers, and routes and tracks marked "My crew"
     (new ones go to the crew by default once you're in one).
   - Each phone signs in anonymously (no account, no email). The database rules only let a phone change or delete its own things.
   - With signal or Wi-Fi the phone sends what changed and fetches what changed since last time. No signal: it waits
     and catches up later; everything keeps working from the phone.
   Settings: data/sync.json (Firebase web API key and project id, public by design). Rules: firestore.rules. */
'use strict';
(function () {
  const S = {
    cfg: null, on: store.get('syncOn', true), busy: false, timer: null, last: store.get('syncLast', null), err: '',
    auth: store.get('syncAuth', null),              // { uid, idToken, refreshToken, exp }
    crew: store.get('crew', null),                  // { code, name, joinedAt }
    cursor: store.get('syncCursors', {}),           // collection path -> last serverAt seen
    pushed: store.get('syncPushed2', {}),           // doc path -> version key we last sent (live docs only)
    pushedChecks: store.get('syncPushedChecks', {}),// pin id -> my check time we last sent
    crewPins: store.get('crewPins', []),            // pin ids that came from the crew
    backup: store.get('backupCode', null),          // private backup of everything on this phone (secret code)
    lastBackup: store.get('lastBackup', null),
  };
  const persist = () => { store.set('syncPushed2', S.pushed); store.set('syncPushedChecks', S.pushedChecks); store.set('syncCursors', S.cursor); store.set('crewPins', S.crewPins); };
  const ready = () => !!(S.cfg && S.cfg.apiKey && S.cfg.projectId);
  const root = () => 'projects/' + S.cfg.projectId + '/databases/(default)/documents';
  const api = () => 'https://firestore.googleapis.com/v1/' + root();
  const crewPath = () => S.crew ? 'crews/' + S.crew.code + '/items' : null;
  const BASE = location.origin + location.pathname;

  /* ---------- anonymous sign-in ---------- */
  async function token() {
    const a = S.auth;
    if (a && a.idToken && a.exp > Date.now() + 60000) return a.idToken;
    let r, j;
    if (a && a.refreshToken) {
      r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + S.cfg.apiKey, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(a.refreshToken) });
      if (r.ok) { j = await r.json(); S.auth = { uid: j.user_id, idToken: j.id_token, refreshToken: j.refresh_token, exp: Date.now() + Number(j.expires_in) * 1000 }; store.set('syncAuth', S.auth); return S.auth.idToken; }
    }
    r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + S.cfg.apiKey, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error('sign-in ' + r.status);
    j = await r.json();
    S.auth = { uid: j.localId, idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + Number(j.expiresIn) * 1000 };
    store.set('syncAuth', S.auth);
    return S.auth.idToken;
  }

  /* ---------- what should be in the database from this phone ---------- */
  const mine = p => p.source === 'user' && p.deviceId === deviceId;
  const isCrewPin = p => p.kind === 'hazard' && p.htype === 'goodsnow';
  function wanted() {
    const want = {}; // doc path -> { key, fields }
    const doc = (path, json, key, kind) => {
      const f = { json: { stringValue: json }, uid: { stringValue: S.auth.uid }, deleted: { booleanValue: false } };
      if (kind) f.kind = { stringValue: kind };
      want[path] = { key: (kind ? kind + '#' : '') + key, fields: f };
    };
    if (S.on) state.pins.filter(mine).forEach(p => {
      const key = (p.updatedAt || p.createdAt || '1') + '|' + JSON.stringify(p.verifications || {}).length;
      if (isCrewPin(p)) { if (crewPath()) doc(crewPath() + '/' + p.id, JSON.stringify(p), key, 'pin'); }
      else doc('pins/' + p.id, JSON.stringify(p), key);
    });
    if (S.on) (window.powderRoutes ? powderRoutes.all() : []).filter(r => !r.synced && !r.from && !r.pending).forEach(r => {
      const w = powderRoutes.shareOf(r); if (w === 'me' || (w === 'crew' && !crewPath())) return;
      const key = w + '|' + r.name + '|' + r.pts.length + '|' + Math.round((r.stats && r.stats.dist) || 0) + '|' + JSON.stringify(r.act || {}).length;
      const json = JSON.stringify(Object.assign({ from: reporterName() || '' }, powderShare.encRoute(r, 2)));
      if (json.length > 800000) return; // far too long for one record; send it by link instead
      if (w === 'all') doc('routes/' + r.id, json, key); else doc(crewPath() + '/' + r.id, json, key, 'route');
    });
    // Private backup: every pin and route on this phone plus your settings, under your secret backup code.
    if (S.backup) {
      const bp = 'backups/' + S.backup + '/items/';
      state.pins.filter(p => p.source === 'user').forEach(p => doc(bp + p.id, JSON.stringify(p), (p.updatedAt || p.createdAt || '1') + '|' + JSON.stringify(p.verifications || {}).length, 'pin'));
      (window.powderRoutes ? powderRoutes.all() : []).filter(r => !r.synced && !r.pending).forEach(r => {
        let o = Object.assign({}, r); delete o._upgrading;
        let json = JSON.stringify(o);
        if (json.length > 800000) { o.pts = powderShare.decRoute(powderShare.encRoute(r, 2), '').pts; json = JSON.stringify(o); }
        if (json.length > 800000) return;
        doc(bp + r.id, json, (r.share || '') + '|' + r.name + '|' + r.pts.length + '|' + (r.created || '') + '|' + JSON.stringify(r.act || {}).length, 'route');
      });
      const meta = backupMeta(); doc(bp + '_settings', JSON.stringify(meta), JSON.stringify(meta).length + '|' + JSON.stringify(meta).split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0), 'meta');
    }
    return want;
  }
  async function commit(writes) {
    const send = async w => fetch(api() + ':commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify({ writes: w }) });
    for (let i = 0; i < writes.length; i += 50) {
      const batch = writes.slice(i, i + 50), r = await send(batch);
      if (r.ok) continue;
      if (r.status !== 403) throw new Error('send ' + r.status);
      // One record refused (e.g. a pin first sent from this phone before a reinstall): send the rest one by one and skip it.
      for (const w of batch) { const r1 = await send([w]); if (!r1.ok && r1.status !== 403) throw new Error('send ' + r1.status); }
    }
  }
  const stamp = [{ fieldPath: 'serverAt', setToServerValue: 'REQUEST_TIME' }];
  async function push() {
    const want = wanted(), writes = [], done = [];
    Object.entries(want).forEach(([path, d]) => {
      if (S.pushed[path] === d.key) return;
      writes.push({ update: { name: root() + '/' + path, fields: d.fields }, updateTransforms: stamp }); done.push([path, d.key]);
    });
    // Anything we sent before that shouldn't be there now (deleted, or moved between just me / crew / everyone): mark it removed.
    Object.keys(S.pushed).forEach(path => {
      if (want[path]) return;
      if (!S.on && !path.startsWith('backups/')) return; // sync switched off: leave shared things as they were
      const id = path.split('/').pop(), f = { json: { stringValue: JSON.stringify({ id, deviceId }) }, uid: { stringValue: S.auth.uid }, deleted: { booleanValue: true } };
      if (path.startsWith('crews/') || path.startsWith('backups/')) f.kind = { stringValue: String(S.pushed[path]).split('#')[0] === 'route' ? 'route' : 'pin' };
      if (path.startsWith('backups/')) f.kind = { stringValue: ['route', 'meta'].includes(String(S.pushed[path]).split('#')[0]) ? String(S.pushed[path]).split('#')[0] : 'pin' };
      writes.push({ update: { name: root() + '/' + path, fields: f }, updateTransforms: stamp }); done.push([path, null]);
    });
    // My checks on other riders' public pins
    const checks = [];
    state.pins.filter(p => p.source === 'user' && !mine(p) && !isCrewPin(p)).forEach(p => {
      const v = (p.verifications || {})[deviceId]; if (!v || S.pushedChecks[p.id] === v.at) return;
      writes.push({ update: { name: root() + '/checks/' + p.id + '__' + S.auth.uid, fields: { pin: { stringValue: p.id }, json: { stringValue: JSON.stringify({ deviceId, v }) }, uid: { stringValue: S.auth.uid } } }, updateTransforms: stamp });
      checks.push([p.id, v.at]);
    });
    if (!writes.length) return 0;
    await commit(writes);
    done.forEach(([path, key]) => { if (key) S.pushed[path] = key; else delete S.pushed[path]; });
    checks.forEach(([id, at]) => { S.pushedChecks[id] = at; });
    persist();
    return writes.length;
  }

  /* ---------- fetch what changed ---------- */
  async function query(path) {
    const parts = path.split('/'), col = parts.pop(), parent = parts.length ? '/' + parts.join('/') : '';
    const out = []; let cur = S.cursor[path] || null;
    for (let page = 0; page < 20; page++) {
      const q = { structuredQuery: { from: [{ collectionId: col }], orderBy: [{ field: { fieldPath: 'serverAt' }, direction: 'ASCENDING' }], limit: 300 } };
      if (cur) q.structuredQuery.where = { fieldFilter: { field: { fieldPath: 'serverAt' }, op: 'GREATER_THAN', value: { timestampValue: cur } } };
      const r = await fetch(api() + parent + ':runQuery', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify(q) });
      if (!r.ok) throw new Error('fetch ' + r.status);
      const rows = (await r.json()).filter(x => x.document).map(x => x.document.fields || {});
      rows.forEach(f => out.push(f));
      if (rows.length) cur = rows[rows.length - 1].serverAt.timestampValue;
      if (rows.length < 300) break;
    }
    return { rows: out.filter(f => !(f.uid && f.uid.stringValue === S.auth.uid)).map(f => { let j = null; try { j = JSON.parse(f.json.stringValue); } catch (e) { } return { j, del: !!(f.deleted && f.deleted.booleanValue), kind: f.kind ? f.kind.stringValue : '', f }; }).filter(x => x.j),
      done: () => { if (cur) S.cursor[path] = cur; } };
  }
  function dropPins(gone) {
    const before = state.pins.length;
    state.pins = state.pins.filter(p => !gone.some(g => g.id === p.id && g.deviceId === p.deviceId));
    return before - state.pins.length;
  }
  async function routesIn(rows, scope) {
    let n = 0;
    for (const x of rows) {
      const id = x.j.i || x.j.id;
      if (x.del) { if (powderRoutes.removeSynced(id)) n++; continue; }
      try { if (await powderRoutes.upsertSynced(powderShare.decRoute(x.j, String(x.j.from || '').slice(0, 40)), scope)) n++; } catch (e) { }
    }
    return n;
  }
  async function pull() {
    let changed = 0, pinsChanged = false;
    // public pins
    const pins = await query('pins');
    const add = pins.rows.filter(x => !x.del && x.j.id).map(x => x.j), gone = pins.rows.filter(x => x.del).map(x => x.j);
    if (add.length) { const m = mergePins(add); changed += m.added + m.updated; }
    if (gone.length) { const k = dropPins(gone); changed += k; if (k) pinsChanged = true; }
    pins.done();
    // public routes
    const routes = await query('routes');
    changed += await routesIn(routes.rows, 'all'); routes.done();
    // crew
    if (crewPath()) {
      const items = await query(crewPath());
      const cAdd = items.rows.filter(x => x.kind === 'pin' && !x.del).map(x => x.j), cGone = items.rows.filter(x => x.kind === 'pin' && x.del).map(x => x.j);
      if (cAdd.length) { const m = mergePins(cAdd.filter(isCrewPin)); changed += m.added + m.updated; cAdd.forEach(p => { if (!S.crewPins.includes(p.id)) S.crewPins.push(p.id); }); }
      if (cGone.length) { const k = dropPins(cGone); changed += k; if (k) pinsChanged = true; }
      changed += await routesIn(items.rows.filter(x => x.kind !== 'pin'), 'crew');
      items.done();
    }
    // checks on public pins
    const checks = await query('checks');
    checks.rows.forEach(({ j, f }) => {
      const p = state.pins.find(x => x.id === (f.pin && f.pin.stringValue)); if (!p || !j.v || !j.deviceId || j.deviceId === p.deviceId) return;
      if (j.v.v !== 'confirm' && j.v.v !== 'dispute') return;
      p.verifications = p.verifications || {};
      const cur = p.verifications[j.deviceId];
      if (!cur || (j.v.at || '') > (cur.at || '')) { p.verifications[j.deviceId] = { v: j.v.v, reason: String(j.v.reason || '').slice(0, 60), note: String(j.v.note || '').slice(0, 200), name: String(j.v.name || '').slice(0, 40), at: String(j.v.at || '').slice(0, 30) }; changed++; pinsChanged = true; }
    });
    checks.done();
    persist();
    if (pinsChanged) { savePins(); renderPins(); }
    return changed;
  }

  /* ---------- when to sync ---------- */
  async function sync(manual) {
    if (!ready() || S.busy || (!S.on && !S.backup)) return;
    if (!navigator.onLine) { if (manual) toast('No signal. It will sync when you are back in range.'); return; }
    S.busy = true; S.err = ''; paint();
    try {
      await token();
      const sent = await push();
      const got = S.on ? await pull() : 0;
      if (S.backup) { S.lastBackup = new Date().toISOString(); store.set('lastBackup', S.lastBackup); }
      S.last = new Date().toISOString(); store.set('syncLast', S.last);
      if (manual) toast('Synced' + (sent ? ' · sent ' + sent : '') + (got ? ' · ' + got + ' new or updated' : ''));
      else if (got) toast(got + ' new or updated from other riders', 2500);
    } catch (e) {
      S.err = String(e.message || e);
      if (/sign-in|40[13]/.test(S.err)) { S.auth = null; store.set('syncAuth', null); }
      if (manual) toast('Sync didn\'t work: ' + S.err);
    }
    S.busy = false; paint();
    if (S.again) { S.again = false; soon(); } // something changed while we were syncing
  }
  function soon(ms = 3000) { if (!ready() || (!S.on && !S.backup)) return; if (S.busy) { S.again = true; return; } clearTimeout(S.timer); S.timer = setTimeout(() => sync(false), ms); }
  // Saving pins anywhere in the app (new marker, edit, check, delete) syncs a few seconds later.
  // (savePins is a top-level function in app.js, so it lives on window and app.js picks up the wrapped one.)
  const origSave = window.savePins;
  window.savePins = function () { origSave(); if (S.busy) S.again = true; else soon(); };

  /* ---------- crews ---------- */
  function newCode() { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('') + 'pp00'; }
  function setCrew(c) {
    const old = S.crew;
    S.crew = c; store.set('crew', c);
    if (old && (!c || old.code !== c.code)) {
      // Leaving a crew: their routes and good-snow markers go from this phone; mine get removed from that crew next sync.
      powderRoutes.all().filter(r => r.synced === 'crew').map(r => r.id).forEach(id => powderRoutes.removeSynced(id));
      state.pins = state.pins.filter(p => !(S.crewPins.includes(p.id) && !mine(p))); S.crewPins = []; origSave(); renderPins();
      delete S.cursor['crews/' + old.code + '/items'];
    }
    persist(); soon(500);
  }
  const inviteLink = () => BASE + '#crew=' + S.crew.code + '~' + encodeURIComponent(S.crew.name);
  async function invite() {
    const link = inviteLink(), text = 'Join my Powder Pigs crew "' + S.crew.name + '" to share tracks, routes and good-snow spots:';
    if (navigator.share) { try { await navigator.share({ title: 'Join my crew', text, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text + '\n' + link); toast('Invite link copied. Paste it into a message.'); } catch (e) { toast('Couldn\'t copy. Long-press the link in Settings.'); }
  }
  function askJoin(code, name) {
    if (!/^[a-z0-9]{16,40}$/.test(code)) { toast('That crew link is broken'); return; }
    if (S.crew && S.crew.code === code) { toast('You\'re already in ' + S.crew.name); return; }
    name = String(name || 'Crew').slice(0, 40);
    openSheet('Join a crew', '<p style="margin:0">Join <b>' + esc(name) + '</b>?</p><p class="small muted" style="margin:0">Your crew sees the routes and tracks you share with "My crew" and your good-snow markers, and you see theirs. Hazards and slide reports are shared with all riders either way.' +
      (S.crew ? ' This replaces your current crew, <b>' + esc(S.crew.name) + '</b>.' : '') + '</p>' +
      (ready() ? '' : '<p class="small warn-text" style="margin:0">Live sync isn\'t set up in this app yet, so the crew won\'t sync until it is.</p>') +
      '<div class="btn-row"><button class="btn primary" id="cjYes">Join</button><button class="btn" id="cjNo">Not now</button></div>', { view: 'crewjoin' });
    $('#cjNo').onclick = closeSheet;
    $('#cjYes').onclick = () => { setCrew({ code, name, joinedAt: new Date().toISOString() }); closeSheet(); toast('You\'re in ' + name + '. New routes and tracks go to the crew unless you change them.', 3500); };
  }
  function joinFromText(t) { const m = String(t || '').match(/#crew=([a-z0-9]+)(?:~([^&\s]*))?/); if (!m) { toast('Paste the whole invite link'); return; } let n = ''; try { n = decodeURIComponent(m[2] || ''); } catch (e) { } askJoin(m[1], n); }
  function checkHash() {
    if (!/#crew=/.test(location.hash)) return;
    const h = location.hash; history.replaceState(null, '', location.pathname + location.search);
    const wait = (n = 0) => { if (window.powderRoutes && state.areas && state.areas.length) joinFromText(h); else if (n < 50) setTimeout(() => wait(n + 1), 200); };
    wait();
  }
  window.addEventListener('hashchange', checkHash);
  checkHash();

  /* ---------- backup and restore ---------- */
  const BACKUP_KEYS = ['reporterName', 'crew', 'satInstance', 'satLayerName', 'customAreas', 'bandOverrides', 'placed', 'recentWindow', 'show', 'routesVisible', 'hiddenRoutes', 'syncOn', 'base', 'area', 'movedPins'];
  function backupMeta() { const o = { deviceId, savedAt: new Date().toISOString().slice(0, 10) }; BACKUP_KEYS.forEach(k => { const v = store.get(k, undefined); if (v !== undefined) o[k] = v; }); return o; }
  function newBackupCode() { const a = new Uint8Array(16); crypto.getRandomValues(a); const c = [...a].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('').toUpperCase(); return 'PP-' + c.match(/.{4}/g).join('-'); }
  const cleanCode = t => { const m = String(t || '').toUpperCase().replace(/\s+/g, '').match(/PP-?([A-Z0-9]{4})-?([A-Z0-9]{4})-?([A-Z0-9]{4})-?([A-Z0-9]{4})/); return m ? 'PP-' + m.slice(1).join('-') : null; };
  // Put a backup's contents onto this phone: merges with what's already here, never throws anything away.
  async function restore(text) {
    const code = cleanCode(text);
    if (!code) { toast('That doesn\'t look like a backup code (PP-XXXX-XXXX-XXXX-XXXX)'); return; }
    if (!ready()) { toast('Needs live sync set up in the app'); return; }
    if (!navigator.onLine) { toast('Needs signal or Wi-Fi to restore'); return; }
    toast('Getting your backup…', 2000);
    try {
      await token();
      const old = S.cursor['backups/' + code + '/items']; delete S.cursor['backups/' + code + '/items'];
      const all = []; let cur = null;
      for (let page = 0; page < 50; page++) {
        const q = { structuredQuery: { from: [{ collectionId: 'items' }], orderBy: [{ field: { fieldPath: 'serverAt' }, direction: 'ASCENDING' }], limit: 300 } };
        if (cur) q.structuredQuery.where = { fieldFilter: { field: { fieldPath: 'serverAt' }, op: 'GREATER_THAN', value: { timestampValue: cur } } };
        const r = await fetch(api() + '/backups/' + code + ':runQuery', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify(q) });
        if (!r.ok) throw new Error('backup ' + r.status);
        const rows = (await r.json()).filter(x => x.document).map(x => x.document.fields);
        rows.forEach(f => all.push(f)); if (rows.length) cur = rows[rows.length - 1].serverAt.timestampValue;
        if (rows.length < 300) break;
      }
      if (old) S.cursor['backups/' + code + '/items'] = old;
      const live = all.filter(f => !(f.deleted && f.deleted.booleanValue)).map(f => { try { return { kind: f.kind.stringValue, j: JSON.parse(f.json.stringValue) }; } catch (e) { return null; } }).filter(Boolean);
      const pins = live.filter(x => x.kind === 'pin').map(x => x.j), routes = live.filter(x => x.kind === 'route').map(x => x.j), meta = (live.find(x => x.kind === 'meta') || {}).j;
      if (!pins.length && !routes.length && !meta) { toast('Nothing found for that code. Check it and try again.', 3500); return; }
      // Pins and routes: add anything missing, keep what's here.
      const curPins = store.get('pins', []), ids = new Set(curPins.map(p => p.id));
      pins.forEach(p => { if (p && p.id && !ids.has(p.id)) curPins.push(p); });
      store.set('pins', curPins);
      const curRoutes = store.get('routes', []), rids = new Set(curRoutes.map(r => r.id));
      routes.forEach(r => { if (r && r.id && !rids.has(r.id)) curRoutes.push(r); });
      store.set('routes', curRoutes);
      if (meta) {
        if (meta.deviceId) store.set('deviceId', meta.deviceId); // so your pins are yours again (edit, move, delete)
        BACKUP_KEYS.forEach(k => { if (meta[k] !== undefined && (store.get(k, undefined) === undefined || ['reporterName', 'crew', 'customAreas'].includes(k))) store.set(k, meta[k]); });
      }
      store.set('backupCode', code);
      store.set('syncPushed2', {}); // send it all again from this phone
      store.set('syncAuth', null);
      toast('Restored ' + pins.length + ' pins and ' + routes.length + ' routes. Reloading…', 2500);
      setTimeout(() => location.reload(), 1500);
    } catch (e) { toast('Couldn\'t restore: ' + (e.message || e), 4000); }
  }
  async function shareCode() {
    const text = 'My Backcountry Powder Pigs backup code: ' + S.backup + '\nKeep this safe. Settings → Backup → Restore lets you get everything back on a new phone or after reinstalling.';
    if (navigator.share) { try { await navigator.share({ title: 'Powder Pigs backup code', text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(S.backup); toast('Backup code copied'); } catch (e) { toast('Write it down: ' + S.backup, 6000); }
  }
  // Backup file: everything in one file, works with no signal.
  function saveFile() {
    const data = { app: 'powder-pigs-backup', v: 1, savedAt: new Date().toISOString(), deviceId, backupCode: S.backup, pins: store.get('pins', []), routes: store.get('routes', []), meta: backupMeta() };
    const name = 'powder-pigs-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Powder Pigs backup' }).catch(() => { }); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function loadFile(f) {
    let d; try { d = JSON.parse(await f.text()); } catch (e) { toast('That isn\'t a backup file'); return; }
    if (!d || d.app !== 'powder-pigs-backup') { if (d && d.app === 'powder-pigs') { importPins(f); return; } toast('That isn\'t a Powder Pigs backup file'); return; }
    const curPins = store.get('pins', []), ids = new Set(curPins.map(p => p.id)); (d.pins || []).forEach(p => { if (p && p.id && !ids.has(p.id)) curPins.push(p); }); store.set('pins', curPins);
    const curRoutes = store.get('routes', []), rids = new Set(curRoutes.map(r => r.id)); (d.routes || []).forEach(r => { if (r && r.id && !rids.has(r.id)) curRoutes.push(r); }); store.set('routes', curRoutes);
    if (d.deviceId) store.set('deviceId', d.deviceId);
    if (d.backupCode && !S.backup) store.set('backupCode', d.backupCode);
    if (d.meta) BACKUP_KEYS.forEach(k => { if (d.meta[k] !== undefined && store.get(k, undefined) === undefined) store.set(k, d.meta[k]); });
    store.set('syncPushed2', {});
    toast('Restored from file. Reloading…', 2000); setTimeout(() => location.reload(), 1200);
  }
  function backupHtml() {
    const n = state.pins.filter(p => p.source === 'user').length, nr = (window.powderRoutes ? powderRoutes.all() : []).filter(r => !r.synced && !r.pending).length;
    return '<div class="stack" id="backupBox"><p class="eyebrow">Backup</p>' +
      (S.backup ? '<p class="small muted" style="margin:0">Your ' + n + ' pin' + (n === 1 ? '' : 's') + ', ' + nr + ' route' + (nr === 1 ? '' : 's') + ' and tracks, and your settings are backed up privately whenever you have signal. Updating the app never touches them; this is for a lost phone, a new phone, or deleting the app from your home screen.</p>' +
        '<p style="margin:0">Backup code: <b style="font-variant-numeric:tabular-nums;letter-spacing:.03em">' + esc(S.backup) + '</b></p><p class="small muted" style="margin:0">Last backed up ' + ago(S.lastBackup) + '. Keep the code safe (screenshot it or send it to yourself). Anyone with it can see your backup.</p>' +
        '<div class="btn-row"><button class="btn primary" id="bkShare">Save my code</button><button class="btn" id="bkNow">Back up now</button></div>'
        : '<p class="small muted" style="margin:0">Online backup starts once live sync is set up.</p>') +
      '<div class="field"><label for="bkCode">Restore from a backup code</label><input type="text" id="bkCode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="PP-XXXX-XXXX-XXXX-XXXX"></div><button class="btn" id="bkRestore">Restore</button>' +
      '<details class="small"><summary>Backup file (works without signal)</summary><div class="btn-row" style="margin-top:8px"><button class="btn" id="bkFile">Save a backup file</button><button class="btn" id="bkLoad">Restore from a file</button></div><input type="file" id="bkFileIn" accept=".json,application/json" hidden></details></div>';
  }

  /* ---------- Settings section ---------- */
  const ago = t => { if (!t) return 'never'; const s = (Date.now() - Date.parse(t)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  function crewHtml() {
    if (S.crew) return '<div class="stack" id="crewBox"><p class="eyebrow">Your crew</p><p style="margin:0"><b>' + esc(S.crew.name) + '</b></p>' +
      '<p class="small muted" style="margin:0">Your crew sees your good-snow markers and the routes and tracks you share with "My crew" (new ones do by default; change it on each route). Everyone sees hazards and slide reports.</p>' +
      '<div class="btn-row"><button class="btn primary" id="crInvite">Invite friends</button><button class="btn" id="crLeave">Leave crew</button></div></div>';
    return '<div class="stack" id="crewBox"><p class="eyebrow">Your crew</p><p class="small muted" style="margin:0">A crew is your group of friends. Tracks, routes and good-snow markers you share with "My crew" only go to them. Start one and send the invite, or tap an invite link a mate sent you.</p>' +
      '<div class="field"><label for="crName">Crew name</label><input type="text" id="crName" maxlength="40" placeholder="e.g. Powder Pigs Hakuba 2027"></div><button class="btn primary" id="crMake">Start a crew</button></div>';
  }
  function html() {
    if (!ready()) return backupHtml() + '<div class="stack" id="syncBox"><p class="eyebrow">Live sync</p><p class="small muted" style="margin:0">Not set up yet. Once it is, hazards and slide reports appear on every phone automatically when there\'s signal, and crews can share tracks.</p></div>' + crewHtml();
    const others = state.pins.filter(p => p.source === 'user' && p.deviceId !== deviceId).length;
    return '<div class="stack" id="syncBox"><p class="eyebrow">Live sync</p>' +
      '<label class="list-item pick"><input type="checkbox" id="syncOn"' + (S.on ? ' checked' : '') + '><span><span class="t">Sync automatically when there\'s signal</span><br><span class="s">Your slide reports, slide paths, hazard markers and checks go to every rider, and theirs come to you. Routes and tracks only go where you choose on each one.</span></span></label>' +
      '<p class="small" style="margin:0" id="syncStatus">' + status() + '</p>' +
      '<p class="small muted" style="margin:0">' + others + ' pin' + (others === 1 ? '' : 's') + ' from other riders on this phone. Only you can change or delete your own.</p>' +
      '<button class="btn" id="syncNow"' + (S.on ? '' : ' disabled') + '>Sync now</button></div>' + crewHtml() + backupHtml();
  }
  function status() {
    if (!S.on) return 'Off. Everything stays on this phone.';
    if (S.busy) return 'Syncing…';
    if (!navigator.onLine) return 'Waiting for signal · last synced ' + ago(S.last);
    return (S.err ? '<span class="warn-text">Last try failed (' + esc(S.err) + ')</span> · ' : '') + 'Last synced ' + ago(S.last);
  }
  function paint() { const el = $('#syncStatus'); if (el) el.innerHTML = status(); }
  function wire() {
    const on = $('#syncOn'); if (on) on.onchange = () => { S.on = on.checked; store.set('syncOn', S.on); $('#syncNow').disabled = !S.on; paint(); if (S.on) sync(true); };
    const now = $('#syncNow'); if (now) now.onclick = () => sync(true);
    const bs = $('#bkShare'); if (bs) bs.onclick = shareCode;
    const bn = $('#bkNow'); if (bn) bn.onclick = () => sync(true);
    const br = $('#bkRestore'); if (br) br.onclick = () => restore($('#bkCode').value);
    const bf = $('#bkFile'); if (bf) bf.onclick = saveFile;
    const bl = $('#bkLoad'); if (bl) bl.onclick = () => $('#bkFileIn').click();
    const bi = $('#bkFileIn'); if (bi) bi.onchange = e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; };
    const mk = $('#crMake'); if (mk) mk.onclick = () => { const n = $('#crName').value.trim(); if (!n) { toast('Give your crew a name'); return; } setCrew({ code: newCode(), name: n, joinedAt: new Date().toISOString() }); showSettings(); invite(); };
    const inv = $('#crInvite'); if (inv) inv.onclick = invite;
    const lv = $('#crLeave'); if (lv) lv.onclick = () => {
      if (!lv.dataset.armed) { lv.dataset.armed = '1'; lv.textContent = 'Tap again to leave'; lv.classList.add('danger'); return; }
      setCrew(null); toast('Left the crew'); showSettings();
    };
  }

  async function init() {
    try { S.cfg = await fetch('data/sync.json', { cache: 'no-cache' }).then(r => r.json()); } catch (e) { S.cfg = store.get('syncCfgCache', null); }
    if (ready()) store.set('syncCfgCache', S.cfg);
    if (!ready()) return;
    if (!S.backup) { S.backup = newBackupCode(); store.set('backupCode', S.backup); }
    window.addEventListener('online', () => soon(1000));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(1500); });
    setInterval(() => { if (!document.hidden) sync(false); }, 5 * 60 * 1000);
    soon(2500);
  }
  init();

  window.powderSync = { html, wire, soon, sync: () => sync(true), crew: () => S.crew, joinFromText, restore, deleted() { soon(); }, _S: S };
})();
