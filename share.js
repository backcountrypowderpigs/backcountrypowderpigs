/* Share by link for Backcountry Powder Pigs.
   Routes, tracks and pins are packed into the link itself (after the #), compressed. No server, no account:
   your mate taps the link, sees what you sent and adds it to their map. The # part never leaves their phone. */
'use strict';
(function () {
  const BASE = location.origin + location.pathname;
  const MAX_LINK = 60000; // longer than this and some messaging apps cut it off

  /* ---------- packing ---------- */
  const b64 = {
    enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const b = atob(str), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
  };
  async function through(u8, Kind) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new Kind('deflate-raw'))).arrayBuffer()); }
  async function pack(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'undefined') { try { return 'z' + b64.enc(await through(raw, CompressionStream)); } catch (e) { } }
    return 'j' + b64.enc(raw);
  }
  async function unpack(code) {
    const u = b64.dec(code.slice(1));
    const raw = code[0] === 'z' ? await through(u, DecompressionStream) : u;
    return JSON.parse(new TextDecoder().decode(raw));
  }

  // Points as whole numbers (1e-5° ≈ 1 m), each one the change from the last, so they compress well.
  function encPts(pts, track) {
    const out = []; let pl = 0, pn = 0, pe = 0, pt = 0;
    pts.forEach(p => {
      const la = Math.round(p[0] * 1e5), lo = Math.round(p[1] * 1e5); out.push(la - pl, lo - pn); pl = la; pn = lo;
      if (track) { const e = p[2] == null ? pe : Math.round(p[2]), t = Math.round((p[3] || 0) / 1000); out.push(e - pe, t - pt); pe = e; pt = t; }
    });
    return out;
  }
  function decPts(a, track) {
    const st = track ? 4 : 2, pts = []; let la = 0, lo = 0, e = 0, t = 0;
    for (let i = 0; i + st <= a.length; i += st) {
      la += a[i]; lo += a[i + 1]; const p = [la / 1e5, lo / 1e5];
      if (track) { e += a[i + 2]; t += a[i + 3]; p.push(e, t * 1000); }
      pts.push(p);
    }
    return pts;
  }
  // Thin a recorded track (Douglas-Peucker) so long days still fit in a link. Keeps the shape to within a few metres.
  function thin(pts, tol) {
    if (pts.length < 3) return pts;
    const k = Math.cos(pts[0][0] * Math.PI / 180), xy = pts.map(p => [p[1] * 111320 * k, p[0] * 110540]);
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let best = 0, idx = -1;
      const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      for (let i = a + 1; i < b; i++) {
        const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L2));
        const d = Math.hypot(xy[i][0] - ax - t * dx, xy[i][1] - ay - t * dy);
        if (d > best) { best = d; idx = i; }
      }
      if (best > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function trimPin(p) {
    const o = {};
    ['id', 'kind', 'lat', 'lon', 'deviceId', 'reporter', 'area', 'date', 'size', 'type', 'trigger', 'aspect', 'elevation', 'slope', 'crown', 'width', 'run', 'bed', 'involve',
      'injured', 'killed', 'how', 'freq', 'when', 'name', 'notes', 'createdAt', 'updatedAt', 'htype'].forEach(k => { const v = p[k]; if (v !== '' && v != null && v !== 0) o[k] = v; });
    if (p.verifications && Object.keys(p.verifications).length) o.verifications = p.verifications;
    o.lat = +(+p.lat).toFixed(5); o.lon = +(+p.lon).toFixed(5);
    return o;
  }
  // One route as a compact object (used by links and by crew sync).
  function encRoute(x, tol = 3) {
    const track = x.type === 'track';
    const o = { i: x.id, n: x.name, t: track ? 't' : 'p', c: x.created, p: encPts(track ? thin(x.pts, tol) : x.pts, track) };
    if (track && x.stats) o.s = ['dist', 'gain', 'loss', 'time', 'moving'].map(k => Math.round(x.stats[k] || 0));
    if (track && x.act) o.a = { u: x.act.upMode, s: x.act.steep, m: x.act.marks || [], e: x.act.edits || {} };
    return o;
  }
  function decRoute(x, from) {
    const track = x.t === 't';
    return { id: String(x.i || ''), name: String(x.n || ''), type: track ? 'track' : 'plan', created: x.c, from, pts: Array.isArray(x.p) ? decPts(x.p, track) : [], sentStats: track && Array.isArray(x.s) ? x.s : null, act: track && x.a ? { upMode: x.a.u, steep: x.a.s, marks: x.a.m || [], edits: x.a.e || {} } : undefined };
  }
  async function buildLink(routes, pins) {
    const from = reporterName();
    let tol = 3, link;
    for (let tries = 0; tries < 6; tries++) {
      const r = routes.map(x => encRoute(x, tol));
      link = BASE + '#s=' + await pack({ a: 'pp', v: 1, f: from, r, p: pins.map(trimPin) });
      if (link.length <= MAX_LINK || !routes.some(x => x.type === 'track')) break;
      tol *= 2; // a very long track: thin it harder and try again
    }
    return link;
  }

  // The same icon each item has on the map, for the share lists.
  function iconFor(kind, x) {
    if (kind === 'r') return '<span class="swatch ' + (x.type === 'track' ? 'track' : 'plan') + '" style="width:26px;height:6px"></span>';
    if (x.kind === 'hazard') return '<span class="hz-pin small" style="background:' + hazardOf(x.htype).col + '">' + hazardSvg(hazardOf(x.htype).id, 16) + '</span>';
    return (x.kind === 'recent' ? PATH : SKULL).replace('width="34" height="34"', 'width="28" height="28"');
  }

  /* ---------- sending ---------- */
  function describe(nr, np) {
    const bits = []; if (nr) bits.push(nr + ' route' + (nr === 1 ? '' : 's')); if (np) bits.push(np + ' marker' + (np === 1 ? '' : 's'));
    return bits.join(' and ');
  }
  async function send({ routes = [], pins = [] }, label) {
    if (!routes.length && !pins.length) { toast('Pick something to send'); return; }
    let link;
    try { link = await buildLink(routes, pins); } catch (e) { toast('Couldn\'t make the link'); return; }
    if (link.length > MAX_LINK) { toast('Too much for one link. Send fewer things at once, or use the GPX / pins file.', 4000); return; }
    label = label || describe(routes.length, pins.length);
    const text = label + ' from ' + (reporterName() || 'a mate') + ' on Backcountry Powder Pigs. Tap the link to add it to your map:';
    if (navigator.share) {
      try { await navigator.share({ title: label, text, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    showLink(link, text);
  }
  function showLink(link, text) {
    openSheet('Send this link', '<p class="small muted" style="margin:0">Copy the link and paste it into a message to your mate.</p>' +
      '<div class="field"><label for="shLink">Link</label><textarea id="shLink" readonly rows="4" style="word-break:break-all">' + esc(link) + '</textarea></div>' +
      '<button class="btn primary" id="shCopy">Copy link</button>', { view: 'sharelink' });
    $('#shCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(text + '\n' + link); toast('Copied. Paste it into a message.'); }
      catch (e) { const t = $('#shLink'); t.focus(); t.select(); toast('Select all and copy'); }
    };
  }

  // Pick several routes and markers to send in one link.
  function picker() {
    const routes = (window.powderRoutes ? powderRoutes.all() : []).filter(r => !r.pending);
    const pins = state.pins.slice().sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    const here = state.area ? state.area.id : '';
    const pinLabel = p => p.kind === 'hazard' ? hazardOf(p.htype).label : p.kind === 'recent' ? 'Avalanche' + (p.size ? ' size ' + p.size : '') : 'Slide path';
    const row = (kind, id, title, sub, on, ico) => '<label class="list-item pick"><input type="checkbox" data-' + kind + '="' + esc(id) + '"' + (on ? ' checked' : '') + '><span class="pick-ico">' + (ico || '') + '</span><span><span class="t">' + esc(title) + '</span><br><span class="s">' + esc(sub) + '</span></span></label>';
    let h = '';
    if (routes.length) h += '<div class="stack"><p class="eyebrow">Routes and tracks</p><div class="list">' + routes.map(r => row('r', r.id, r.name, (r.type === 'plan' ? 'Planned' : 'Recorded') + ' · ' + powderRoutes.fmtKm(r.stats.dist || 0) + ' · ↑ ' + (r.stats.gain || 0) + ' m', false, iconFor('r', r))).join('') + '</div></div>';
    if (pins.length) {
      h += '<div class="stack"><p class="eyebrow">Markers and slide reports</p><div class="btn-row"><button class="btn small" id="pkArea">All in ' + esc(state.area ? state.area.name : 'this area') + '</button><button class="btn small" id="pkNone">None</button></div><div class="list">' +
        pins.map(p => row('p', p.id, pinLabel(p) + (p.name ? ': ' + p.name : ''), [((state.areas.find(a => a.id === p.area) || {}).name) || '', p.date ? fmtDate(p.date) : '', p.reporter ? 'by ' + p.reporter : ''].filter(Boolean).join(' · '), false, iconFor('p', p))).join('') + '</div></div>';
    }
    if (!h) { toast('Nothing to send yet. Plan a route or drop a marker first.'); return; }
    h += '<button class="btn primary" id="pkSend" disabled>Send</button>';
    openSheet('Send to a mate', h, { view: 'sharepick', tall: true });
    const body = $('#sheetBody');
    const count = () => {
      const nr = body.querySelectorAll('[data-r]:checked').length, np = body.querySelectorAll('[data-p]:checked').length;
      $('#pkSend').disabled = !(nr + np); $('#pkSend').textContent = nr + np ? 'Send ' + describe(nr, np) : 'Send';
    };
    body.addEventListener('change', count);
    const ar = $('#pkArea'); if (ar) ar.onclick = () => { body.querySelectorAll('[data-p]').forEach(cb => { const p = pins.find(x => x.id === cb.dataset.p); cb.checked = !!p && p.area === here; }); count(); };
    const nn = $('#pkNone'); if (nn) nn.onclick = () => { body.querySelectorAll('[data-p]').forEach(cb => { cb.checked = false; }); count(); };
    $('#pkSend').onclick = () => {
      const rs = [...body.querySelectorAll('[data-r]:checked')].map(cb => routes.find(r => r.id === cb.dataset.r)).filter(Boolean);
      const ps = [...body.querySelectorAll('[data-p]:checked')].map(cb => pins.find(p => p.id === cb.dataset.p)).filter(Boolean);
      send({ routes: rs, pins: ps });
    };
  }

  /* ---------- receiving ---------- */
  const inIosBrowser = /iP(hone|ad|od)/.test(navigator.userAgent) && navigator.standalone === false;
  async function receive(code) {
    let d;
    try { d = await unpack(decodeURIComponent(code)); } catch (e) { toast('That link is broken or cut off. Ask for it again.', 4000); return; }
    if (!d || d.a !== 'pp') { toast('That isn\'t a Powder Pigs link'); return; }
    const from = String(d.f || '').slice(0, 40) || 'A mate';
    const routes = (Array.isArray(d.r) ? d.r : []).slice(0, 50).map(x => decRoute(x, from)).filter(r => r.pts.length > 1);
    const pins = (Array.isArray(d.p) ? d.p : []).slice(0, 2000).filter(p => p && isFinite(p.lat) && isFinite(p.lon));
    if (!routes.length && !pins.length) { toast('That link is empty'); return; }
    const have = new Set((window.powderRoutes ? powderRoutes.all() : []).map(r => r.id)), havePins = new Set(state.pins.map(p => p.id));
    const pinLabel = p => p.kind === 'hazard' ? hazardOf(p.htype).label : p.kind === 'recent' ? 'Avalanche report' : 'Slide path';
    const row = (kind, i, title, sub, dup, ico) => '<label class="list-item pick"><input type="checkbox" data-' + kind + '="' + i + '" checked><span class="pick-ico">' + (ico || '') + '</span><span><span class="t">' + esc(title) + '</span><br><span class="s">' + esc(sub) + (dup ? ' · already on your map (will update)' : '') + '</span></span></label>';
    let h = '<p style="margin:0"><b>' + esc(from) + '</b> sent you ' + esc(describe(routes.length, pins.length)) + '.</p>';
    if (inIosBrowser) h += '<div class="card"><b>Use the home-screen app?</b><span class="small">iPhone opened this link in Safari, which keeps its own separate map. To add it to your Powder Pigs app instead: tap <b>Copy link</b>, open Powder Pigs from your home screen, then Settings → <b>Got a link? Paste it here</b>.</span><button class="btn small" id="rcCopy">Copy link</button></div>';
    if (routes.length) h += '<div class="list">' + routes.map((r, i) => row('r', i, r.name || (r.type === 'plan' ? 'Planned route' : 'Recorded track'), (r.type === 'plan' ? 'Planned route' : 'Recorded track') + ' · ' + powderRoutes.fmtKm(r.sentStats ? r.sentStats[0] : r.pts.reduce((m, p, k) => k ? m + map.distance(r.pts[k - 1], p) : 0, 0)), have.has(r.id), iconFor('r', r))).join('') + '</div>';
    if (pins.length) h += '<div class="list">' + pins.map((p, i) => row('p', i, pinLabel(p) + (p.name ? ': ' + p.name : ''), [p.date ? fmtDate(p.date) : '', p.reporter ? 'by ' + p.reporter : ''].filter(Boolean).join(' · ') || 'Marker', havePins.has(p.id), iconFor('p', p))).join('') + '</div>';
    h += '<div class="btn-row"><button class="btn primary" id="rcAdd">Add to my map</button><button class="btn" id="rcNo">Not now</button></div>';
    openSheet('Shared with you', h, { view: 'receive' });
    const link = BASE + '#s=' + code;
    const cp = $('#rcCopy'); if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied. Now open Powder Pigs from your home screen.', 4000); } catch (e) { showLink(link, ''); } };
    $('#rcNo').onclick = closeSheet;
    $('#rcAdd').onclick = async () => {
      const body = $('#sheetBody');
      const rs = [...body.querySelectorAll('[data-r]:checked')].map(cb => routes[+cb.dataset.r]);
      const ps = [...body.querySelectorAll('[data-p]:checked')].map(cb => pins[+cb.dataset.p]);
      $('#rcAdd').disabled = true; $('#rcAdd').textContent = 'Adding…';
      let nr = 0;
      for (const r of rs) { try { if (await powderRoutes.addShared(r)) nr++; } catch (e) { } }
      const { added, updated } = ps.length ? mergePins(ps) : { added: 0, updated: 0 };
      closeSheet();
      const pts = rs.flatMap(r => r.pts.map(p => [p[0], p[1]])).concat(ps.map(p => [p.lat, p.lon]));
      if (pts.length) {
        const a = areaFor(pts[0][0], pts[0][1]); if (a && state.area && a.id !== state.area.id) setArea(a.id, false);
        try { map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 15 }); } catch (e) { }
      }
      const bits = []; if (nr) bits.push(nr + ' route' + (nr === 1 ? '' : 's')); if (added) bits.push(added + ' marker' + (added === 1 ? '' : 's')); if (updated) bits.push(updated + ' updated');
      toast(bits.length ? 'Added ' + bits.join(', ') : 'Already on your map', 3000);
    };
  }
  function codeFrom(text) { const m = String(text || '').match(/#s=([A-Za-z0-9_\-%]+)/); return m ? m[1] : null; }
  function openText(text) {
    if (/#crew=/.test(text || '') && window.powderSync) { powderSync.joinFromText(text); return; }
    const c = codeFrom(text); if (!c) { toast('Paste the whole link your mate sent'); return; } receive(c);
  }
  function checkHash() {
    const c = codeFrom(location.hash); if (!c) return;
    history.replaceState(null, '', location.pathname + location.search); // so a refresh or the back button doesn't open it again
    const wait = (n = 0) => { if (state.areas && state.areas.length && window.powderRoutes) receive(c); else if (n < 50) setTimeout(() => wait(n + 1), 200); };
    wait();
  }
  window.addEventListener('hashchange', checkHash);
  checkHash();

  window.powderShare = { send, picker, openText, encRoute, decRoute };
})();
