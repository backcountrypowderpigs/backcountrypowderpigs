/* Live sync for Backcountry Powder Pigs: everyone's slide reports, slide paths, hazard markers and checks,
   shared through one free Google Firebase (Firestore) database. Works like this:
   - Each phone signs in anonymously (no account, no email). That gives it an id the database uses to make sure
     only you can change or delete your own pins.
   - With signal or Wi-Fi, the phone sends what changed on it and fetches what changed for everyone since last time.
     With no signal it just waits: everything still works from the phone, and it catches up when you're back in range.
   - Routes and tracks stay private. Send those with a link.
   Settings live in data/sync.json (Firebase web API key and project id; both are public by design). */
'use strict';
(function () {
  const S = {
    cfg: null, on: store.get('syncOn', true), busy: false, timer: null, last: store.get('syncLast', null), err: '',
    auth: store.get('syncAuth', null),          // { uid, idToken, refreshToken, exp }
    cursor: store.get('syncCursor', { pins: null, checks: null }),
    pushed: store.get('syncPushed', {}),         // pin id -> updatedAt we last sent
    pushedChecks: store.get('syncPushedChecks', {}), // pin id -> my check time we last sent
    tomb: store.get('syncTomb', {}),             // deleted pin id -> time (still to send)
    owners: store.get('syncOwners', {}),         // pin id -> owner uid (pins that came from the cloud)
  };
  const persist = () => { store.set('syncPushed', S.pushed); store.set('syncPushedChecks', S.pushedChecks); store.set('syncTomb', S.tomb); store.set('syncCursor', S.cursor); store.set('syncOwners', S.owners); };
  const ready = () => !!(S.cfg && S.cfg.apiKey && S.cfg.projectId);
  const docs = () => 'https://firestore.googleapis.com/v1/projects/' + S.cfg.projectId + '/databases/(default)/documents';
  const docName = (col, id) => 'projects/' + S.cfg.projectId + '/databases/(default)/documents/' + col + '/' + id;

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

  /* ---------- push: my pins, my deletions, my checks on other people's pins ---------- */
  const mine = p => p.source === 'user' && p.deviceId === deviceId;
  function pendingWrites() {
    const w = [], pinIds = [], checkIds = [], tombIds = [];
    state.pins.filter(mine).forEach(p => {
      const ver = p.updatedAt || p.createdAt || '1';
      const vKey = ver + '|' + JSON.stringify(p.verifications || {}).length;
      if (S.pushed[p.id] === vKey) return;
      w.push({ update: { name: docName('pins', p.id), fields: { json: { stringValue: JSON.stringify(p) }, uid: { stringValue: S.auth.uid }, deleted: { booleanValue: false } } }, updateTransforms: [{ fieldPath: 'serverAt', setToServerValue: 'REQUEST_TIME' }] });
      pinIds.push([p.id, vKey]);
    });
    Object.entries(S.tomb).forEach(([id, t]) => {
      w.push({ update: { name: docName('pins', id), fields: { json: { stringValue: JSON.stringify({ id, deviceId, deletedAt: t }) }, uid: { stringValue: S.auth.uid }, deleted: { booleanValue: true } } }, updateTransforms: [{ fieldPath: 'serverAt', setToServerValue: 'REQUEST_TIME' }] });
      tombIds.push(id);
    });
    state.pins.filter(p => p.source === 'user' && !mine(p)).forEach(p => {
      const v = (p.verifications || {})[deviceId]; if (!v) return;
      if (S.pushedChecks[p.id] === v.at) return;
      w.push({ update: { name: docName('checks', p.id + '__' + S.auth.uid), fields: { pin: { stringValue: p.id }, json: { stringValue: JSON.stringify({ deviceId, v }) }, uid: { stringValue: S.auth.uid } } }, updateTransforms: [{ fieldPath: 'serverAt', setToServerValue: 'REQUEST_TIME' }] });
      checkIds.push([p.id, v.at]);
    });
    return { w, pinIds, checkIds, tombIds };
  }
  async function push() {
    const { w, pinIds, checkIds, tombIds } = pendingWrites();
    if (!w.length) return 0;
    for (let i = 0; i < w.length; i += 100) {
      const r = await fetch(docs() + ':commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify({ writes: w.slice(i, i + 100) }) });
      if (!r.ok) throw new Error('send ' + r.status);
    }
    pinIds.forEach(([id, k]) => { S.pushed[id] = k; });
    checkIds.forEach(([id, at]) => { S.pushedChecks[id] = at; });
    tombIds.forEach(id => { delete S.tomb[id]; delete S.pushed[id]; });
    persist();
    return w.length;
  }

  /* ---------- pull: everything that changed since last time ---------- */
  async function query(col, after) {
    const out = []; let cur = after;
    for (let page = 0; page < 20; page++) {
      const q = { structuredQuery: { from: [{ collectionId: col }], orderBy: [{ field: { fieldPath: 'serverAt' }, direction: 'ASCENDING' }], limit: 300 } };
      if (cur) q.structuredQuery.where = { fieldFilter: { field: { fieldPath: 'serverAt' }, op: 'GREATER_THAN', value: { timestampValue: cur } } };
      const r = await fetch(docs() + ':runQuery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
      if (!r.ok) throw new Error('fetch ' + r.status);
      const rows = (await r.json()).filter(x => x.document).map(x => x.document.fields || {});
      rows.forEach(f => out.push(f));
      if (rows.length) cur = rows[rows.length - 1].serverAt.timestampValue;
      if (rows.length < 300) break;
    }
    return { rows: out, cursor: cur };
  }
  async function pull() {
    const uid = S.auth && S.auth.uid;
    const pins = await query('pins', S.cursor.pins);
    const add = [], gone = [];
    pins.rows.forEach(f => {
      if (f.uid && f.uid.stringValue === uid) return;
      let j; try { j = JSON.parse(f.json.stringValue); } catch (e) { return; }
      if (!j || !j.id) return;
      S.owners[j.id] = f.uid ? f.uid.stringValue : '';
      if (f.deleted && f.deleted.booleanValue) gone.push(j); else add.push(j);
    });
    let changed = 0;
    if (add.length) { const m = mergePins(add); changed += m.added + m.updated; }
    if (gone.length) {
      const before = state.pins.length;
      state.pins = state.pins.filter(p => !gone.some(g => g.id === p.id && g.deviceId === p.deviceId));
      changed += before - state.pins.length;
    }
    const checks = await query('checks', S.cursor.checks);
    checks.rows.forEach(f => {
      if (f.uid && f.uid.stringValue === uid) return;
      let j; try { j = JSON.parse(f.json.stringValue); } catch (e) { return; }
      const p = state.pins.find(x => x.id === (f.pin && f.pin.stringValue)); if (!p || !j || !j.v || !j.deviceId || j.deviceId === p.deviceId) return;
      if (j.v.v !== 'confirm' && j.v.v !== 'dispute') return;
      p.verifications = p.verifications || {};
      const cur = p.verifications[j.deviceId];
      if (!cur || (j.v.at || '') > (cur.at || '')) { p.verifications[j.deviceId] = { v: j.v.v, reason: String(j.v.reason || '').slice(0, 60), note: String(j.v.note || '').slice(0, 200), name: String(j.v.name || '').slice(0, 40), at: String(j.v.at || '').slice(0, 30) }; changed++; }
    });
    S.cursor = { pins: pins.cursor || S.cursor.pins, checks: checks.cursor || S.cursor.checks };
    persist();
    if (changed) { savePins(); renderPins(); }
    return changed;
  }

  /* ---------- when to sync ---------- */
  async function sync(manual) {
    if (!ready() || !S.on || S.busy) return;
    if (!navigator.onLine) { if (manual) toast('No signal. It will sync when you are back in range.'); return; }
    S.busy = true; S.err = ''; paint();
    try {
      await token();
      const sent = await push();
      const got = await pull();
      S.last = new Date().toISOString(); store.set('syncLast', S.last);
      if (manual) toast('Synced' + (sent ? ' · sent ' + sent : '') + (got ? ' · ' + got + ' new or updated' : ''));
      else if (got) toast(got + ' new or updated pin' + (got === 1 ? '' : 's') + ' from other riders', 2500);
    } catch (e) {
      S.err = String(e.message || e);
      if (/sign-in|40[13]/.test(S.err)) { S.auth = null; store.set('syncAuth', null); }
      if (manual) toast('Sync didn\'t work: ' + S.err);
    }
    S.busy = false; paint();
  }
  function soon(ms = 3000) { clearTimeout(S.timer); S.timer = setTimeout(() => sync(false), ms); }

  // Anything that saves pins (new marker, edit, check, delete) triggers a sync a few seconds later.
  // (savePins is a top-level function in app.js, so it lives on window and app.js picks up the wrapped one.)
  const origSave = window.savePins;
  window.savePins = function () { origSave(); if (!S.busy && ready() && S.on) soon(); };

  /* ---------- Settings section ---------- */
  const ago = t => { if (!t) return 'never'; const s = (Date.now() - Date.parse(t)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  function html() {
    if (!ready()) return '<div class="stack" id="syncBox"><p class="eyebrow">Live sync</p><p class="small muted" style="margin:0">Not set up yet. Once it is, everyone\'s slide reports and hazard markers appear on every phone automatically when there\'s signal.</p></div>';
    const others = state.pins.filter(p => p.source === 'user' && p.deviceId !== deviceId).length;
    return '<div class="stack" id="syncBox"><p class="eyebrow">Live sync</p>' +
      '<label class="list-item pick"><input type="checkbox" id="syncOn"' + (S.on ? ' checked' : '') + '><span><span class="t">Share pins with all riders automatically</span><br><span class="s">Your slide reports, slide paths, hazard markers and checks go to everyone using Powder Pigs, and theirs come to you, whenever you have signal. Routes and tracks stay private.</span></span></label>' +
      '<p class="small" style="margin:0" id="syncStatus">' + status() + '</p>' +
      '<p class="small muted" style="margin:0">' + others + ' pin' + (others === 1 ? '' : 's') + ' from other riders on this phone. Only you can change or delete your own pins.</p>' +
      '<button class="btn" id="syncNow"' + (S.on ? '' : ' disabled') + '>Sync now</button></div>';
  }
  function status() {
    if (!S.on) return 'Off. Your pins stay on this phone.';
    if (S.busy) return 'Syncing…';
    if (!navigator.onLine) return 'Waiting for signal · last synced ' + ago(S.last);
    return (S.err ? '<span class="warn-text">Last try failed (' + esc(S.err) + ')</span> · ' : '') + 'Last synced ' + ago(S.last);
  }
  function paint() { const el = $('#syncStatus'); if (el) el.innerHTML = status(); }
  function wire() {
    const on = $('#syncOn'); if (on) on.onchange = () => { S.on = on.checked; store.set('syncOn', S.on); $('#syncNow').disabled = !S.on; paint(); if (S.on) sync(true); };
    const now = $('#syncNow'); if (now) now.onclick = () => sync(true);
  }

  async function init() {
    try { S.cfg = await fetch('data/sync.json', { cache: 'no-cache' }).then(r => r.json()); } catch (e) { S.cfg = store.get('syncCfgCache', null); }
    if (ready()) store.set('syncCfgCache', S.cfg);
    if (!ready()) return;
    window.addEventListener('online', () => soon(1000));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(1500); });
    setInterval(() => { if (!document.hidden) sync(false); }, 5 * 60 * 1000);
    soon(2500);
  }
  init();

  window.powderSync = {
    html, wire, sync: () => sync(true),
    deleted(p) { if (ready() && p && p.source === 'user' && p.deviceId === deviceId && S.pushed[p.id]) { S.tomb[p.id] = new Date().toISOString(); persist(); soon(); } },
    _S: S,
  };
})();
