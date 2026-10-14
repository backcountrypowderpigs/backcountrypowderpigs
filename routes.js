/* Routes and tracks for Backcountry Powder Pigs.
   - Plan: tap the map to lay out a line. Distance, climb, descent, touring time (Munter), elevation profile,
     steepest slope and how much of the line is on 30°+ ground, all from GSI 10 m elevation (works offline in downloaded areas).
   - Record: GPS track with time, moving time, distance, climb and descent. Saved on the phone as it goes, so closing the app doesn't lose it.
   - Saved routes and tracks: show / hide, rename, delete, share as GPX, import GPX.
   Colours: planned = dashed magenta, recorded = solid electric blue, both with a white + dark outline so they stand out
   over satellite, danger shading and the aspect overlay. */
'use strict';
(function () {
  const PLAN_COL = '#ff2bd6', TRACK_COL = '#00b4ff';
  const routes = store.get('routes', []);
  const visible = new Set(store.get('routesVisible', []));
  const routeLayer = L.layerGroup().addTo(map);
  const liveLayer = L.layerGroup().addTo(map);
  const save = () => { store.set('routes', routes); store.set('routesVisible', [...visible]); };

  /* ---------- maths ---------- */
  const R = 6371000;
  function hav(a, b) {
    const t = Math.PI / 180, dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Climb/descent with a small dead-band so GPS and DEM noise don't add fake metres.
  function climb(eles, band = 4) {
    let gain = 0, loss = 0, ref = null;
    eles.forEach(e => {
      if (e == null || isNaN(e)) return;
      if (ref == null) { ref = e; return; }
      if (e - ref >= band) { gain += e - ref; ref = e; } else if (ref - e >= band) { loss += ref - e; ref = e; }
    });
    return { gain: Math.round(gain), loss: Math.round(loss) };
  }
  const fmtKm = m => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : Math.round(m) + ' m';
  const fmtDur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + ' h ' + String(m).padStart(2, '0') + ' min' : m + ' min'; };
  const fmtClock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };

  // Sample a planned line every ~25 m against the elevation data.
  async function analyseLine(pts) {
    const samples = []; let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) { samples.push({ lat: pts[0][0], lon: pts[0][1], d: 0 }); continue; }
      const a = pts[i - 1], b = pts[i], seg = hav(a, b), n = Math.max(1, Math.ceil(seg / 25));
      for (let k = 1; k <= n; k++) samples.push({ lat: a[0] + (b[0] - a[0]) * k / n, lon: a[1] + (b[1] - a[1]) * k / n, d: cum + seg * k / n });
      cum += seg;
    }
    const terr = await Promise.all(samples.map(s => terrainAt(s.lat, s.lon).catch(() => null)));
    samples.forEach((s, i) => { s.ele = terr[i] ? terr[i].elev : null; s.slope = terr[i] ? terr[i].slope : null; });
    const c = climb(samples.map(s => s.ele));
    // Munter: 1 unit = 1 km or 100 m up. Touring pace 4 units/h up, 10 units/h down/flat.
    let hours = 0;
    for (let i = 1; i < samples.length; i++) {
      const dk = (samples[i].d - samples[i - 1].d) / 1000, dz = (samples[i].ele != null && samples[i - 1].ele != null) ? samples[i].ele - samples[i - 1].ele : 0;
      hours += dz > 0 ? (dk + dz / 100) / 4 : dk / 10;
    }
    const sl = samples.filter(s => s.slope != null);
    const steep = sl.filter(s => s.slope >= 30).length;
    return {
      dist: cum, gain: c.gain, loss: c.loss, est: hours * 3600,
      maxSlope: sl.length ? Math.max(...sl.map(s => s.slope)) : null,
      steepPct: sl.length ? Math.round(100 * steep / sl.length) : null,
      hasEle: sl.length > 0,
      profile: samples.filter((s, i) => i % Math.max(1, Math.floor(samples.length / 160)) === 0 || i === samples.length - 1).map(s => [Math.round(s.d), s.ele]),
    };
  }
  function trackStats(pts) {
    let dist = 0, moving = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = hav(pts[i - 1], pts[i]); dist += d;
      const dt = (pts[i][3] - pts[i - 1][3]) / 1000;
      if (dt > 0 && dt < 180 && d / dt > 0.25) moving += dt;
    }
    const c = climb(pts.map(p => p[2]));
    const time = pts.length > 1 ? (pts[pts.length - 1][3] - pts[0][3]) / 1000 : 0;
    let cum = 0;
    const prof = pts.map((p, i) => { if (i) cum += hav(pts[i - 1], p); return [Math.round(cum), p[2]]; });
    const step = Math.max(1, Math.floor(prof.length / 160));
    return { dist, gain: c.gain, loss: c.loss, time, moving, profile: prof.filter((p, i) => i % step === 0 || i === prof.length - 1) };
  }

  /* ---------- drawing ---------- */
  function cased(latlngs, col, dashed, weight = 4, opacity = 1) {
    return [
      L.polyline(latlngs, { color: '#0b1520', weight: weight + 6, opacity: 0.45 * opacity, interactive: false }),
      L.polyline(latlngs, { color: '#ffffff', weight: weight + 3, opacity: 0.95 * opacity, interactive: false }),
      L.polyline(latlngs, { color: col, weight, opacity, dashArray: dashed ? '10 8' : null, lineCap: dashed ? 'butt' : 'round' }),
    ];
  }
  function drawSaved() {
    routeLayer.clearLayers();
    routes.filter(r => visible.has(r.id)).forEach(r => {
      const ll = r.pts.map(p => [p[0], p[1]]); if (ll.length < 2) return;
      const parts = cased(ll, r.type === 'plan' ? PLAN_COL : TRACK_COL, r.type === 'plan', 4, 0.9);
      parts[2].on('click', () => openRoute(r.id));
      parts.forEach(p => routeLayer.addLayer(p));
      routeLayer.addLayer(L.circleMarker(ll[0], { radius: 5, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1, interactive: false }));
      routeLayer.addLayer(L.circleMarker(ll[ll.length - 1], { radius: 5, color: '#fff', weight: 2, fillColor: '#0b1520', fillOpacity: 1, interactive: false }));
    });
  }

  function profileSvg(profile) {
    const pts = (profile || []).filter(p => p[1] != null);
    if (pts.length < 2) return '<p class="small muted" style="margin:0">No elevation data here yet. Download this area, or open it with signal, to see the profile.</p>';
    const W = 300, H = 90, pad = 4, maxD = pts[pts.length - 1][0] || 1;
    const es = pts.map(p => p[1]), lo = Math.min(...es), hi = Math.max(...es), span = Math.max(20, hi - lo);
    const xy = pts.map(p => [(pad + (W - 2 * pad) * p[0] / maxD).toFixed(1), (H - pad - (H - 2 * pad - 14) * (p[1] - lo) / span).toFixed(1)]);
    const line = xy.map(p => p.join(',')).join(' ');
    return '<svg class="profile" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Elevation profile">' +
      '<polygon points="' + pad + ',' + (H - pad) + ' ' + line + ' ' + (W - pad) + ',' + (H - pad) + '" class="profile-fill"/>' +
      '<polyline points="' + line + '" class="profile-line"/></svg>' +
      '<div class="spread small muted"><span>' + Math.round(lo) + ' m low</span><span>' + Math.round(hi) + ' m high</span><span>' + fmtKm(maxD) + '</span></div>';
  }
  function statsHtml(r) {
    const s = r.stats || {};
    const cell = (k, v) => '<div class="stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    let h = '<div class="stats">' + cell('Distance', fmtKm(s.dist || 0)) + cell('Climb', '↑ ' + (s.gain || 0) + ' m') + cell('Descent', '↓ ' + (s.loss || 0) + ' m');
    if (r.type === 'plan') h += cell('Est. time', s.est ? fmtDur(s.est) : '–');
    else h += cell('Time', fmtDur(s.time || 0)) + cell('Moving', fmtDur(s.moving || 0));
    h += '</div>';
    if (r.type === 'plan' && s.maxSlope != null) h += '<p class="small" style="margin:0">Steepest point <b>' + s.maxSlope + '°</b>. <b>' + s.steepPct + '%</b> of the line is on 30° or steeper' + (s.steepPct > 0 ? ': check it against today\'s danger shading.' : '.') + '</p>';
    if (r.type === 'plan') h += '<p class="small muted" style="margin:0">Time is a touring estimate (Munter: 4 units/h up, 10 down). Your pace will differ.</p>';
    return h;
  }

  /* ---------- planning ---------- */
  let plan = null; // { pts: [[lat,lon]], stats }
  const bar = document.createElement('div'); bar.className = 'route-bar'; bar.hidden = true; document.body.appendChild(bar);
  let planTimer = null;
  function startPlan(existing) {
    stopAllModes(); closeSheet();
    plan = { pts: existing ? existing.pts.map(p => [p[0], p[1]]) : [], editId: existing ? existing.id : null, name: existing ? existing.name : '' };
    document.body.classList.add('planning');
    map.on('click', onPlanClick);
    renderPlan(); toast('Tap the map to add points along your line', 2500);
  }
  function onPlanClick(e) { plan.pts.push([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]); renderPlan(); }
  function renderPlan() {
    liveLayer.clearLayers();
    if (!plan) return;
    if (plan.pts.length > 1) cased(plan.pts, PLAN_COL, true).forEach(p => liveLayer.addLayer(p));
    plan.pts.forEach((p, i) => {
      const m = L.marker(p, { draggable: true, icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="vertex' + (i === 0 ? ' first' : '') + '"></div>' }) });
      m.on('drag', ev => { plan.pts[i] = [ev.latlng.lat, ev.latlng.lng]; });
      m.on('dragend', renderPlan);
      liveLayer.addLayer(m);
    });
    bar.innerHTML = '<div class="route-bar-head"><b class="plan-dot">Planning</b><span id="planStats" class="small">' + (plan.pts.length < 2 ? 'Tap the map to add points. Drag a point to move it.' : 'Working it out…') + '</span></div>' +
      '<div class="btn-row"><button class="btn small" id="pUndo"' + (plan.pts.length ? '' : ' disabled') + '>Undo</button><button class="btn small" id="pClear"' + (plan.pts.length ? '' : ' disabled') + '>Clear</button><button class="btn small ghost" id="pCancel">Cancel</button><button class="btn small primary" id="pSave"' + (plan.pts.length > 1 ? '' : ' disabled') + '>Save route</button></div>';
    bar.hidden = false;
    $('#pUndo').onclick = () => { plan.pts.pop(); renderPlan(); };
    $('#pClear').onclick = () => { plan.pts = []; renderPlan(); };
    $('#pCancel').onclick = () => { endPlan(); };
    $('#pSave').onclick = () => savePlan();
    clearTimeout(planTimer);
    if (plan.pts.length > 1) planTimer = setTimeout(async () => {
      const s = await analyseLine(plan.pts); if (!plan) return; plan.stats = s;
      const el = $('#planStats'); if (el) el.innerHTML = fmtKm(s.dist) + ' · ↑ ' + s.gain + ' m · ↓ ' + s.loss + ' m · ~' + fmtDur(s.est) + (s.maxSlope != null ? ' · max ' + s.maxSlope + '°' : '');
    }, 250);
  }
  function endPlan() { map.off('click', onPlanClick); plan = null; liveLayer.clearLayers(); bar.hidden = true; document.body.classList.remove('planning'); }
  async function savePlan() {
    const p = plan; const stats = p.stats || await analyseLine(p.pts);
    let r = p.editId && routes.find(x => x.id === p.editId);
    if (r) { r.pts = p.pts; r.stats = stats; r.updated = new Date().toISOString(); }
    else { r = { id: 'r-' + uid(), type: 'plan', name: 'Route ' + new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + (state.area ? ' · ' + state.area.name : ''), created: new Date().toISOString(), area: state.area && state.area.id, pts: p.pts, stats }; routes.unshift(r); }
    visible.add(r.id); save(); endPlan(); drawSaved(); openRoute(r.id, true);
  }

  /* ---------- recording ---------- */
  let rec = store.get('recording', null); // { id, start, pts:[[lat,lon,ele,t]], paused }
  let recWatch = null, wakeLock = null, recTick = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; } }
  document.addEventListener('visibilitychange', () => { if (rec && !rec.paused && !document.hidden) keepAwake(); });
  function startRec() {
    if (!navigator.geolocation) { toast('This device can\'t share its position with the app'); return; }
    stopAllModes(); closeSheet();
    rec = rec || { id: 't-' + uid(), start: Date.now(), pts: [], paused: false };
    rec.paused = false; store.set('recording', rec);
    document.body.classList.add('recording');
    recWatch = navigator.geolocation.watchPosition(onRecFix, err => { if (err.code === 1) { toast('Location is blocked. Allow it for this site in your settings.'); pauseRec(); } }, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
    keepAwake(); renderRec(); clearInterval(recTick); recTick = setInterval(renderRecBar, 1000);
    $('#recBtn').classList.add('rec-on');
  }
  async function onRecFix(pos) {
    if (!rec || rec.paused) return;
    const { latitude: lat, longitude: lon, accuracy, altitude } = pos.coords;
    if (accuracy > 40) return; // too rough to keep
    const last = rec.pts[rec.pts.length - 1];
    if (last && hav(last, [lat, lon]) < Math.max(5, accuracy / 3)) return;
    const t = await terrainAt(lat, lon).catch(() => null);
    const ele = t ? t.elev : (altitude != null ? Math.round(altitude) : null);
    rec.pts.push([+lat.toFixed(6), +lon.toFixed(6), ele, pos.timestamp || Date.now()]);
    store.set('recording', rec); renderRec();
  }
  function pauseRec() {
    if (!rec) return; rec.paused = true; store.set('recording', rec);
    if (recWatch != null) { navigator.geolocation.clearWatch(recWatch); recWatch = null; }
    try { wakeLock && wakeLock.release(); } catch (e) { } wakeLock = null; renderRecBar();
  }
  function renderRec() {
    liveLayer.clearLayers();
    if (!rec) return;
    const ll = rec.pts.map(p => [p[0], p[1]]);
    if (ll.length > 1) cased(ll, TRACK_COL, false, 5).forEach(p => liveLayer.addLayer(p));
    if (ll.length) liveLayer.addLayer(L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 3, fillColor: TRACK_COL, fillOpacity: 1, interactive: false }));
    renderRecBar();
  }
  function renderRecBar() {
    if (!rec) return;
    const s = trackStats(rec.pts), elapsed = (Date.now() - rec.start) / 1000;
    bar.innerHTML = '<div class="route-bar-head"><b class="rec-dot' + (rec.paused ? ' paused' : '') + '">' + (rec.paused ? 'Paused' : 'Recording') + '</b><span class="rec-clock">' + fmtClock(elapsed) + '</span></div>' +
      '<div class="stats">' +
      '<div class="stat"><span class="k">Distance</span><span class="v">' + fmtKm(s.dist) + '</span></div>' +
      '<div class="stat"><span class="k">Climb</span><span class="v">↑ ' + s.gain + ' m</span></div>' +
      '<div class="stat"><span class="k">Descent</span><span class="v">↓ ' + s.loss + ' m</span></div>' +
      '<div class="stat"><span class="k">Moving</span><span class="v">' + fmtDur(s.moving) + '</span></div></div>' +
      (rec.pts.length === 0 && !rec.paused ? '<p class="small muted" style="margin:0">Waiting for a GPS fix… out of mobile range this can take a minute or two.</p>' : '') +
      '<p class="small muted" style="margin:0">Keep the app open: phones pause GPS for web apps when the screen locks. The screen stays on while recording.</p>' +
      '<div class="btn-row">' + (rec.paused ? '<button class="btn small primary" id="rResume">Resume</button>' : '<button class="btn small" id="rPause">Pause</button>') + '<button class="btn small danger" id="rStop">Stop</button></div>';
    bar.hidden = false;
    const pz = $('#rPause'); if (pz) pz.onclick = pauseRec;
    const rs = $('#rResume'); if (rs) rs.onclick = startRec;
    $('#rStop').onclick = stopRec;
  }
  function stopRec() {
    pauseRec(); clearInterval(recTick);
    const r = rec; rec = null; store.set('recording', null);
    document.body.classList.remove('recording'); $('#recBtn').classList.remove('rec-on'); bar.hidden = true; liveLayer.clearLayers();
    if (!r || r.pts.length < 2) { toast('Nothing recorded. Track discarded.'); return; }
    const t = { id: r.id, type: 'track', name: 'Track ' + new Date(r.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + (state.area ? ' · ' + state.area.name : ''), created: new Date(r.start).toISOString(), area: state.area && state.area.id, pts: r.pts, stats: trackStats(r.pts), pending: true };
    routes.unshift(t); visible.add(t.id); save(); drawSaved(); openRoute(t.id, true);
  }
  function stopAllModes() { if (plan) endPlan(); }

  /* ---------- sheets ---------- */
  function openRoutes() {
    const plans = routes.filter(r => r.type === 'plan'), tracks = routes.filter(r => r.type === 'track' && !r.pending);
    const item = r => '<div class="list-item route-item" data-open="' + r.id + '"><span class="swatch ' + r.type + '"></span><span><span class="t">' + esc(r.name) + '</span><br><span class="s">' + fmtKm(r.stats.dist || 0) + ' · ↑ ' + (r.stats.gain || 0) + ' m' + (r.type === 'track' ? ' · ' + fmtDur(r.stats.time || 0) : r.stats.est ? ' · ~' + fmtDur(r.stats.est) : '') + ' · ' + fmtDate(r.created) + '</span></span>' +
      '<label class="vis" title="Show on map"><input type="checkbox" data-vis="' + r.id + '"' + (visible.has(r.id) ? ' checked' : '') + '> Show</label></div>';
    let h = '<div class="btn-row"><button class="btn primary" id="goPlan">Plan a route</button><button class="btn" id="goRec">' + (rec ? 'Back to recording' : '● Record a track') + '</button></div>' +
      '<div class="legend small"><span><span class="sw" style="background:repeating-linear-gradient(90deg,' + PLAN_COL + ' 0 8px,transparent 8px 12px);border:0"></span>Planned route</span><span><span class="sw" style="background:' + TRACK_COL + ';border:0"></span>Recorded track</span></div>';
    h += '<div class="stack"><p class="eyebrow">Planned routes</p>' + (plans.length ? '<div class="list">' + plans.map(item).join('') + '</div>' : '<p class="small muted" style="margin:0">None yet. Plan one, or import a GPX file.</p>') + '</div>';
    h += '<div class="stack"><p class="eyebrow">Recorded tracks</p>' + (tracks.length ? '<div class="list">' + tracks.map(item).join('') + '</div>' : '<p class="small muted" style="margin:0">None yet.</p>') + '</div>';
    h += '<button class="btn" id="gpxImport">Import GPX (from a mate, CalTopo, Gaia…)</button><input type="file" id="gpxFile" accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden>';
    openSheet('Routes and tracks', h, { view: 'routes', tall: true });
    $('#goPlan').onclick = () => startPlan();
    $('#goRec').onclick = () => { if (rec) { closeSheet(); renderRec(); } else startRec(); };
    $('#sheetBody').querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => { if (e.target.closest('.vis')) return; openRoute(el.dataset.open); }));
    $('#sheetBody').querySelectorAll('[data-vis]').forEach(cb => cb.onchange = () => { cb.checked ? visible.add(cb.dataset.vis) : visible.delete(cb.dataset.vis); save(); drawSaved(); });
    $('#gpxImport').onclick = () => $('#gpxFile').click();
    $('#gpxFile').onchange = async e => { const f = e.target.files[0]; if (f) await importGpx(f); e.target.value = ''; };
  }
  function openRoute(id, fresh) {
    const r = routes.find(x => x.id === id); if (!r) return;
    visible.add(r.id); save(); drawSaved();
    try { map.fitBounds(L.latLngBounds(r.pts.map(p => [p[0], p[1]])), { padding: [40, 40], maxZoom: 15 }); } catch (e) { }
    let h = '';
    if (r.pending) h += '<div class="card"><b>Keep this track?</b><span class="small muted">Name it and keep it, or throw it away.</span></div>';
    h += '<div class="field"><label for="rName">Name</label><input type="text" id="rName" maxlength="60" value="' + esc(r.name) + '"></div>';
    h += statsHtml(r) + profileSvg(r.stats.profile);
    h += '<div class="btn-row">' + (r.pending ? '<button class="btn primary" id="rKeep">Keep</button><button class="btn" id="rDiscard">Discard</button>'
      : '<button class="btn" id="rShare">Share GPX</button>' + (r.type === 'plan' ? '<button class="btn" id="rEdit">Edit line</button>' : '') + '<button class="btn" id="rDel">Delete</button>') + '</div>';
    if (r.pending) h += '<button class="btn small ghost" id="rShare">Share GPX</button>';
    openSheet(r.type === 'plan' ? 'Planned route' : 'Recorded track', h, { view: 'route' });
    const nameEl = $('#rName'); nameEl.onchange = () => { r.name = nameEl.value.trim() || r.name; save(); };
    const keep = $('#rKeep'); if (keep) keep.onclick = () => { r.name = nameEl.value.trim() || r.name; delete r.pending; save(); toast('Track kept'); openRoutes(); };
    const disc = $('#rDiscard'); if (disc) disc.onclick = () => { removeRoute(r.id); toast('Track discarded'); closeSheet(); };
    const sh = $('#rShare'); if (sh) sh.onclick = () => shareGpx(r);
    const ed = $('#rEdit'); if (ed) ed.onclick = () => startPlan(r);
    const del = $('#rDel'); if (del) del.onclick = () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; del.classList.add('danger'); return; }
      removeRoute(r.id); toast('Deleted'); openRoutes();
    };
    if (fresh && r.type === 'plan') toast('Route saved');
  }
  function removeRoute(id) { const i = routes.findIndex(x => x.id === id); if (i >= 0) routes.splice(i, 1); visible.delete(id); save(); drawSaved(); }

  /* ---------- GPX ---------- */
  function toGpx(r) {
    const x = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
    const pt = (tag, p) => '<' + tag + ' lat="' + p[0] + '" lon="' + p[1] + '">' + (p[2] != null ? '<ele>' + p[2] + '</ele>' : '') + (p[3] ? '<time>' + new Date(p[3]).toISOString() + '</time>' : '') + '</' + tag + '>';
    const body = r.type === 'plan' ? '<rte><name>' + x(r.name) + '</name>' + r.pts.map(p => pt('rtept', p)).join('') + '</rte>'
      : '<trk><name>' + x(r.name) + '</name><trkseg>' + r.pts.map(p => pt('trkpt', p)).join('') + '</trkseg></trk>';
    return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Backcountry Powder Pigs" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>' + x(r.name) + '</name></metadata>' + body + '</gpx>';
  }
  function shareGpx(r) {
    const name = (r.name || 'route').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.gpx';
    const blob = new Blob([toGpx(r)], { type: 'application/gpx+xml' });
    const file = new File([blob], name, { type: 'application/gpx+xml' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: r.name, text: r.name + ' (' + fmtKm(r.stats.dist) + ', ↑ ' + r.stats.gain + ' m) from Backcountry Powder Pigs' }).catch(() => { }); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function importGpx(file) {
    try {
      const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
      const grab = sel => [...doc.getElementsByTagName(sel)].map(n => {
        const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
        const e = n.getElementsByTagName('ele')[0], t = n.getElementsByTagName('time')[0];
        return [lat, lon, e ? Math.round(parseFloat(e.textContent)) : null, t ? Date.parse(t.textContent) || 0 : 0];
      }).filter(p => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
      let pts = grab('trkpt'), type = 'track';
      if (pts.length < 2) { pts = grab('rtept'); type = 'plan'; }
      if (pts.length < 2) { pts = grab('wpt'); type = 'plan'; }
      if (pts.length < 2) { toast('No route or track found in that file'); return; }
      if (type === 'track' && !pts.every(p => p[3])) type = 'plan';
      pts = pts.slice(0, 20000);
      const nm = (doc.getElementsByTagName('name')[0] || {}).textContent || file.name.replace(/\.gpx$/i, '');
      const r = { id: 'r-' + uid(), type, name: String(nm).slice(0, 60), created: new Date().toISOString(), pts, stats: type === 'plan' ? await analyseLine(pts.map(p => [p[0], p[1]])) : trackStats(pts) };
      if (type === 'plan') r.pts = pts.map(p => [p[0], p[1]]);
      routes.unshift(r); visible.add(r.id); save(); drawSaved(); openRoute(r.id); toast('Imported ' + r.name);
    } catch (e) { toast('Couldn\'t read that GPX file'); }
  }

  /* ---------- buttons ---------- */
  function fab(id, label, svg) {
    const b = document.createElement('button'); b.id = id; b.className = 'fab'; b.setAttribute('aria-label', label); b.title = label; b.innerHTML = svg;
    $('.fabs').insertBefore(b, $('#packsBtn')); return b;
  }
  fab('routesBtn', 'Routes and tracks', '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="18" r="2.2" fill="currentColor"/><circle cx="19" cy="6" r="2.2" fill="currentColor"/><path d="M6.5 16.5c3-1 2-5 5.5-6s4.5-1.5 5.5-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2.5" stroke-linecap="round"/></svg>').onclick = openRoutes;
  fab('recBtn', 'Record a track', '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.5" fill="#e11d48"/></svg>').onclick = () => {
    if (rec && !rec.paused) { renderRec(); toast('Recording. Use Pause or Stop below.', 1800); } else startRec();
  };

  // Pick up a recording that was running when the app was closed.
  if (rec) { document.body.classList.add('recording'); $('#recBtn').classList.add('rec-on'); rec.paused = true; renderRec(); toast('Unfinished track found. Tap Resume to carry on, or Stop to save it.', 4000); }
  drawSaved();
  window.powderRoutes = { openRoutes, startPlan, startRec };
})();
