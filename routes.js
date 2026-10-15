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
  // Steep-section glow sits under the route lines.
  map.createPane('routeGlow'); map.getPane('routeGlow').style.zIndex = 395; map.getPane('routeGlow').style.pointerEvents = 'none';
  /* How steep is too steep (common backcountry rules of thumb, splitboard or skis):
     Going UP, the route's own grade:  up to ~15° comfortable skin track; 20-25° steep skinning (heel risers, good edges);
       25-30° very steep: kick turns, ski crampons if firm; 30°+ usually boot-pack instead.
     Going DOWN, the slope you're riding: 35-40° steep; 40-45° very steep, no-fall terrain likely; 45°+ extreme.
     Separately, any ground of 30°+ is avalanche terrain (shown in the stats). */
  const GRADE = {
    up: [[30, 'boot', 'Boot-pack (30°+ uphill)'], [25, 'vsteep', 'Very steep skin: kick turns (25–30°)'], [20, 'steep', 'Steep skin (20–25°)']],
    down: [[45, 'boot', 'Extreme descent (45°+)'], [40, 'vsteep', 'Very steep descent (40–45°)'], [35, 'steep', 'Steep descent (35–40°)']],
  };
  const GLOW = { steep: '#f59e0b', vsteep: '#ef4444', boot: '#7c3aed' };
  const routeLayer = L.layerGroup().addTo(map);
  const liveLayer = L.layerGroup().addTo(map);
  const save = () => { store.set('routes', routes); store.set('routesVisible', [...visible]); if (window.powderSync) powderSync.soon(); };

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
      if (i === 0) { samples.push({ lat: pts[0][0], lon: pts[0][1], d: 0, seg: 0 }); continue; }
      const a = pts[i - 1], b = pts[i], seg = hav(a, b), n = Math.max(1, Math.ceil(seg / 25));
      for (let k = 1; k <= n; k++) samples.push({ lat: a[0] + (b[0] - a[0]) * k / n, lon: a[1] + (b[1] - a[1]) * k / n, d: cum + seg * k / n, seg: i - 1 });
      cum += seg;
    }
    const terr = await Promise.all(samples.map(s => terrainAt(s.lat, s.lon).catch(() => null)));
    samples.forEach((s, i) => { s.ele = terr[i] ? terr[i].elev : null; s.slope = terr[i] ? terr[i].slope : null; s.asp = terr[i] && terr[i].aspect ? ASPECTS.indexOf(terr[i].aspect) * 45 : null; });
    const c = climb(samples.map(s => s.ele));
    // Munter: 1 unit = 1 km or 100 m up. Touring pace 4 units/h up, 10 units/h down/flat.
    let hours = 0;
    for (let i = 1; i < samples.length; i++) {
      const dk = (samples[i].d - samples[i - 1].d) / 1000, dz = (samples[i].ele != null && samples[i - 1].ele != null) ? samples[i].ele - samples[i - 1].ele : 0;
      hours += dz > 0 ? (dk + dz / 100) / 4 : dk / 10;
    }
    const sl = samples.filter(s => s.slope != null);
    const steep = sl.filter(s => s.slope >= 30).length;
    // Grade of the line itself, from smoothed elevation (~100 m window) so DEM noise doesn't spike it.
    const sm = samples.map((s, i) => { let t = 0, n = 0; for (let k = i - 2; k <= i + 2; k++) { const e = samples[k] && samples[k].ele; if (e != null) { t += e; n++; } } return n ? t / n : null; });
    let maxUp = 0, maxDown = 0, upSteepM = 0; const segs = []; let run = null;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], dd = b.d - a.d;
      let cls = null, kind = null;
      if (sm[i] != null && sm[i - 1] != null && dd > 0) {
        const g = Math.atan2(sm[i] - sm[i - 1], dd) * 180 / Math.PI;
        if (g > 1) { kind = 'up'; maxUp = Math.max(maxUp, g); if (g >= 20) upSteepM += dd; const c = GRADE.up.find(([t]) => g >= t); cls = c ? c[1] : null; }
        else { kind = 'down'; const gs = b.slope || 0; maxDown = Math.max(maxDown, gs); const c = GRADE.down.find(([t]) => gs >= t); cls = c ? c[1] : null; }
      }
      if (cls && run && run.cls === cls && run.kind === kind) { run.pts.push([+b.lat.toFixed(5), +b.lon.toFixed(5)]); run.d1 = Math.round(b.d); }
      else if (cls) { run = { cls, kind, i0: i - 1, pts: [[+a.lat.toFixed(5), +a.lon.toFixed(5)], [+b.lat.toFixed(5), +b.lon.toFixed(5)]], d0: Math.round(a.d), d1: Math.round(b.d) }; segs.push(run); }
      if (run) run.i1 = i;
      else run = null;
    }
    return {
      maxUp: Math.round(maxUp), maxDown: Math.round(maxDown), upSteepM: Math.round(upSteepM),
      segs: segs.map(({ i0, i1, ...rest }) => rest), flags: lineFlags(samples), _samples: samples,
      _upRuns: segs.filter(x => x.kind === 'up' && (x.cls === 'vsteep' || x.cls === 'boot')).map(x => ({ i0: x.i0, i1: x.i1 })),
      dist: cum, gain: c.gain, loss: c.loss, est: hours * 3600,
      maxSlope: sl.length ? Math.max(...sl.map(s => s.slope)) : null,
      steepPct: sl.length ? Math.round(100 * steep / sl.length) : null,
      hasEle: sl.length > 0,
      profile: samples.filter((s, i) => i % Math.max(1, Math.floor(samples.length / 160)) === 0 || i === samples.length - 1).map(s => [Math.round(s.d), s.ele]),
    };
  }
  const lean = s => { const o = Object.assign({}, s); delete o._samples; delete o._upRuns; return o; };
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

  /* ---------- "looks impassable" checks ---------- */
  const BLOCK_HZ = ['cliff', 'noentry', 'water'];
  const WARN_HZ = ['cliff', 'noentry', 'water', 'rocks', 'cornice', 'debris', 'treewell', 'ice', 'other'];
  function dangerCtx() {
    try { return state.area && hasRatings(bulletinFor(state.area.id)) ? shadeContext() : null; } catch (e) { return null; }
  }
  function lineFlags(samples) {
    const flags = []; const dctx = dangerCtx();
    const hz = state.pins.filter(p => p.kind === 'hazard' && WARN_HZ.includes(p.htype));
    let inCliff = false, inRed = false; const seenHz = new Set();
    samples.forEach(s => {
      const cliff = s.slope != null && s.slope >= 45;
      if (cliff && !inCliff) flags.push({ t: 'cliff', lat: s.lat, lon: s.lon, v: s.slope });
      inCliff = cliff;
      const red = !!(dctx && s.slope != null && s.asp != null && s.ele != null && dangerClass(s.slope, s.asp, s.ele, dctx) === DANGER_RED);
      if (red && !inRed) flags.push({ t: 'danger', lat: s.lat, lon: s.lon });
      inRed = red;
      hz.forEach(p => { if (!seenHz.has(p.id) && hav([s.lat, s.lon], [p.lat, p.lon]) <= 30) { seenHz.add(p.id); flags.push({ t: 'hazard', lat: p.lat, lon: p.lon, h: p.htype }); } });
    });
    return flags.map(f => Object.assign(f, { lat: +f.lat.toFixed(5), lon: +f.lon.toFixed(5) }));
  }
  const FLAG_COL = { cliff: '#4c1d95', danger: '#dc2626', hazard: '#d97706' };
  function flagText(f) {
    if (f.t === 'cliff') return 'Over 45° here (' + f.v + '°): likely cliff or rock. Probably not passable.';
    if (f.t === 'danger') return 'Crosses red danger shading for today.';
    return 'Passes within 30 m of a marker: ' + hazardOf(f.h).label + '.';
  }
  function drawFlags(flags, layer) {
    (flags || []).forEach(f => {
      const m = L.marker([f.lat, f.lon], { zIndexOffset: 700, icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="route-flag" style="background:' + FLAG_COL[f.t] + '">!</div>' }) });
      m.bindPopup('<b>Check this spot</b><br><span class="small">' + esc(flagText(f)) + '</span>');
      layer.addLayer(m);
    });
  }

  /* ---------- "Suggest a gentler line": least-cost search over the elevation grid ----------
     10 m grid around the steep section. Cost per metre rises with the uphill grade (a good skin track
     is ~10-15°), with 30°+ ground (avalanche terrain) and today's red shading, and the search can't go
     onto 45°+ ground or near cliff / no-entry / open-water markers. 16 move directions allow
     switchbacks at sensible angles. Elevation data only: it can't see trees, bamboo, creeks or today's snow. */
  function simplify(pts, tolM) {
    if (pts.length < 3) return pts;
    const lat0 = pts[0][0], ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    const xy = pts.map(p => [p[1] * kx, p[0] * ky]);
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    (function dp(a, b) {
      let best = -1, bi = -1; const [x1, y1] = xy[a], [x2, y2] = xy[b], L2 = (x2 - x1) ** 2 + (y2 - y1) ** 2 || 1;
      for (let i = a + 1; i < b; i++) {
        const t = Math.max(0, Math.min(1, ((xy[i][0] - x1) * (x2 - x1) + (xy[i][1] - y1) * (y2 - y1)) / L2));
        const d = Math.hypot(xy[i][0] - (x1 + t * (x2 - x1)), xy[i][1] - (y1 + t * (y2 - y1)));
        if (d > best) { best = d; bi = i; }
      }
      if (best > tolM) { keep[bi] = 1; dp(a, bi); dp(bi, b); }
    })(0, pts.length - 1);
    return pts.filter((p, i) => keep[i]);
  }
  async function suggestBetween(A, B) {
    const lat0 = (A[0] + B[0]) / 2, ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180), pad = 300, cell = 10;
    const minLat = Math.min(A[0], B[0]) - pad / ky, maxLat = Math.max(A[0], B[0]) + pad / ky;
    const minLon = Math.min(A[1], B[1]) - pad / kx, maxLon = Math.max(A[1], B[1]) + pad / kx;
    const W = Math.ceil((maxLon - minLon) * kx / cell) + 1, H = Math.ceil((maxLat - minLat) * ky / cell) + 1;
    if (W * H > 450000) return { err: 'That stretch is too long to work out. Try a shorter section.' };
    const z = 14, tiles = {};
    for (let tx = lon2x(minLon, z); tx <= lon2x(maxLon, z); tx++) for (let ty = lat2y(maxLat, z); ty <= lat2y(minLat, z); ty++) tiles[tx + '/' + ty] = await getDem(z, tx, ty);
    const n = 256 * 2 ** z;
    const elevAt = (lat, lon) => {
      const gx = (lon + 180) / 360 * n, r = lat * Math.PI / 180, gy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
      const t = tiles[Math.floor(gx / 256) + '/' + Math.floor(gy / 256)]; return t ? t[Math.floor(gy % 256) * 256 + Math.floor(gx % 256)] : NaN;
    };
    const latOf = j => minLat + j * cell / ky, lonOf = i => minLon + i * cell / kx;
    const E = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) E[j * W + i] = elevAt(latOf(j), lonOf(i));
    const dctx = dangerCtx();
    const blockHz = state.pins.filter(p => p.kind === 'hazard' && BLOCK_HZ.includes(p.htype));
    const SL = new Float32Array(W * H), BAD = new Uint8Array(W * H), RED = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i, e = E[k];
      if (isNaN(e)) { BAD[k] = 1; continue; }
      const ex = (E[j * W + Math.min(W - 1, i + 1)] - E[j * W + Math.max(0, i - 1)]) / (2 * cell);
      const ey = (E[Math.min(H - 1, j + 1) * W + i] - E[Math.max(0, j - 1) * W + i]) / (2 * cell);
      const s = Math.atan(Math.hypot(ex, ey)) * 180 / Math.PI; SL[k] = s;
      if (!(s < 45)) BAD[k] = 1;
      if (dctx && s >= 25) { const asp = (Math.atan2(-ex, -ey) * 180 / Math.PI + 360) % 360; if (dangerClass(s, asp, e, dctx) === DANGER_RED) RED[k] = 1; }
    }
    blockHz.forEach(p => {
      const ci = Math.round((p.lon - minLon) * kx / cell), cj = Math.round((p.lat - minLat) * ky / cell);
      for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) { const i = ci + di, j = cj + dj; if (i >= 0 && j >= 0 && i < W && j < H && Math.hypot(di, dj) <= 3) BAD[j * W + i] = 1; }
    });
    const idx = p => Math.max(0, Math.min(H - 1, Math.round((p[0] - minLat) * ky / cell))) * W + Math.max(0, Math.min(W - 1, Math.round((p[1] - minLon) * kx / cell)));
    const start = idx(A), goal = idx(B); BAD[start] = 0; BAD[goal] = 0;
    const gi = goal % W, gj = (goal / W) | 0;
    const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
    const g = new Float64Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1), closed = new Uint8Array(W * H);
    const heap = []; const push = (k, f) => { heap.push([f, k]); let c = heap.length - 1; while (c) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    g[start] = 0; push(start, 0); let steps = 0;
    while (heap.length) {
      const [, k] = pop(); if (closed[k]) continue; closed[k] = 1;
      if (k === goal) break;
      if (++steps > 600000) break;
      const ci = k % W, cj = (k / W) | 0;
      for (const [di, dj] of MOVES) {
        const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const nk = j * W + i; if (BAD[nk] || closed[nk]) continue;
        const h = Math.hypot(di, dj) * cell, dz = E[nk] - E[k], grade = Math.atan2(Math.abs(dz), h) * 180 / Math.PI;
        let f = dz > 0 ? (grade <= 12 ? 1 : grade <= 18 ? 1.4 : grade <= 22 ? 2.8 : grade <= 27 ? 8 : 40) : (grade > 30 ? 3 : 1);
        if (SL[nk] >= 30) f += 1.5;
        if (RED[nk]) f += 15;
        const ng = g[k] + h * f;
        if (ng < g[nk]) { g[nk] = ng; from[nk] = k; push(nk, ng + Math.hypot(i - gi, j - gj) * cell); }
      }
    }
    if (from[goal] < 0 && goal !== start) return { err: 'Couldn\'t find a gentler way through here: the ground is too steep or blocked. Look for a different approach.' };
    const path = []; for (let k = goal; k !== -1; k = from[k]) path.push([+latOf((k / W) | 0).toFixed(6), +lonOf(k % W).toFixed(6)]);
    path.reverse(); path[0] = [A[0], A[1]]; path[path.length - 1] = [B[0], B[1]];
    return { pts: simplify(path, 6) };
  }

  /* ---------- what you were doing on a recorded track ----------
     Climb modes chosen at the start: snowshoes, splitboard (skinning), verts, bootpack.
     From the GPS points the app works out:
       - Break: stopped for a minute or more (the app keeps no points while you stand still, so a long gap = a stop).
       - Riding: moving fast downhill (over ~8 km/h and dropping).
       - Bootpack / verts: a climb steeper than your setting (20° by default) that starts after a stop.
       - Transition: a break where what you're doing changes (skins off, ride, skins on...).
     You can force it while recording (Climb / Boot / Ride buttons) and fix any section afterwards. */
  const UP_MODES = { snowshoe: 'Snowshoes', split: 'Splitboard', verts: 'Verts', boot: 'Bootpack' };
  const ACT = {
    snowshoe: { label: 'Snowshoeing', col: '#00b4ff', dash: '9 6', cap: 'butt' },
    split: { label: 'Skinning', col: '#00b4ff', dash: '16 5 3 5', cap: 'butt' },
    verts: { label: 'Verts', col: '#a855f7', dash: '5 5', cap: 'butt' },
    boot: { label: 'Bootpack', col: '#a855f7', dash: '1 8', cap: 'round' },
    ride: { label: 'Riding', col: '#ff7a1a', dash: null, cap: 'round' },
    flat: { label: 'Moving', col: '#00b4ff', dash: null, cap: 'round' },
  };
  // Which drawing style a section gets: climb sections use the chosen climb mode; steep ones become boot/verts.
  function actKey(type, upMode) {
    if (type === 'ride') return 'ride';
    if (type === 'boot') return upMode === 'verts' ? 'verts' : 'boot';
    if (upMode === 'verts' || upMode === 'boot') return upMode;
    return upMode === 'snowshoe' ? 'snowshoe' : upMode === 'split' ? 'split' : 'flat';
  }
  function classify(pts, opts = {}) {
    const upMode = opts.upMode || 'split', steep = opts.steep || 20, marks = opts.marks || [], edits = opts.edits || {};
    const n = pts.length; if (n < 2) return { segs: [], stops: [] };
    const tOf = i => pts[i][3] || 0;
    // 1. stops: a step taking 60 s+ at walking-stop speed (no points logged while standing still)
    const stopAfter = new Array(n).fill(0); // stop duration (s) before point i
    for (let i = 1; i < n; i++) {
      const dt = (tOf(i) - tOf(i - 1)) / 1000, d = hav(pts[i - 1], pts[i]);
      if (dt >= 60 && d / dt < 0.3) stopAfter[i] = dt;
    }
    // 2. moving class per point from a ~40 s window: riding = fast and dropping
    const cls = new Array(n).fill('up');
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      while (a < i && tOf(i) - tOf(a) > 20000) a++;
      if (b < i) b = i;
      while (b + 1 < n && tOf(b + 1) - tOf(i) <= 20000 && !stopAfter[b + 1]) b++;
      let d = 0; for (let k = Math.max(a, 1); k <= b; k++) if (!stopAfter[k]) d += hav(pts[k - 1], pts[k]);
      const dt = Math.max(1, (tOf(b) - tOf(a)) / 1000), e0 = pts[a][2], e1 = pts[b][2];
      const vr = (e0 != null && e1 != null) ? (e1 - e0) / dt : 0, sp = d / dt;
      if ((sp > 2.2 && vr < -0.15) || vr < -0.6) cls[i] = 'ride';
    }
    // 3. manual marks while recording override from their time until the next mark
    const ms = marks.slice().sort((x, y) => x.t - y.t);
    if (ms.length) for (let i = 0; i < n; i++) { let m = null; for (const k of ms) { if (k.t <= tOf(i)) m = k; else break; } if (m && m.type !== 'auto') cls[i] = m.type; }
    // 4. runs, split at stops; merge blips under 45 s into the run before
    let runs = [];
    for (let i = 1; i < n; i++) {
      const c = cls[i], last = runs[runs.length - 1];
      if (!last || stopAfter[i] || last.c !== c) runs.push({ c, i0: i - 1, i1: i, stopBefore: stopAfter[i] });
      else last.i1 = i;
    }
    const dur = r => (tOf(r.i1) - tOf(r.i0)) / 1000;
    const merged = [];
    runs.forEach(r => {
      const prev = merged[merged.length - 1];
      if (prev && !r.stopBefore && (dur(r) < 45 || dur(prev) < 45) && !ms.some(m => m.t > tOf(r.i0) && m.t <= tOf(r.i1))) { if (dur(prev) < 45 && dur(r) >= 45) prev.c = r.c; prev.i1 = r.i1; }
      else merged.push(Object.assign({}, r));
    });
    // 5. stats per run, steep climbs after a stop (or at the start) become boot/verts
    const segs = merged.map((r, k) => {
      let dist = 0; for (let i = r.i0 + 1; i <= r.i1; i++) dist += hav(pts[i - 1], pts[i]);
      const c = climb(pts.slice(r.i0, r.i1 + 1).map(p => p[2]));
      let type = r.c;
      if (type === 'up') {
        const grade = dist > 0 ? Math.atan(c.gain / dist) * 180 / Math.PI : 0;
        if ((upMode === 'boot' || upMode === 'verts') || ((k === 0 || r.stopBefore) && grade >= steep && c.gain >= 25)) type = 'boot';
      }
      if (edits[r.i0]) type = edits[r.i0];
      let moving = 0; for (let i = r.i0 + 1; i <= r.i1; i++) if (!stopAfter[i]) moving += (tOf(i) - tOf(i - 1)) / 1000;
      return { type, i0: r.i0, i1: r.i1, dist: Math.round(dist), gain: c.gain, loss: c.loss, time: Math.round(moving), stopBefore: Math.round(r.stopBefore || 0) };
    });
    // 6. stops: a transition when what you're doing changes across it
    const stops = [];
    segs.forEach((g, k) => { if (k && g.stopBefore) stops.push({ i: g.i0, dur: g.stopBefore, transition: segs[k - 1].type !== g.type }); });
    return { segs, stops };
  }
  function activitySummary(r) {
    const A = classify(r.pts, r.act || {}), up = (r.act && r.act.upMode) || 'split';
    const by = {};
    A.segs.forEach(g => { const k = actKey(g.type, up); by[k] = by[k] || { time: 0, gain: 0, loss: 0, dist: 0, n: 0 }; const o = by[k]; o.time += g.time; o.gain += g.gain; o.loss += g.loss; o.dist += g.dist; o.n++; });
    return { A, by, up };
  }
  function drawTrackActs(layer, r, weight, opacity, onClick) {
    const { A, up } = activitySummary(r);
    A.segs.forEach(g => {
      const st = ACT[actKey(g.type, up)], ll = r.pts.slice(g.i0, g.i1 + 1).map(p => [p[0], p[1]]); if (ll.length < 2) return;
      layer.addLayer(L.polyline(ll, { color: '#0b1520', weight: weight + 6, opacity: 0.45 * opacity, interactive: false }));
      layer.addLayer(L.polyline(ll, { color: '#ffffff', weight: weight + 3, opacity: 0.95 * opacity, interactive: false }));
      const pl = L.polyline(ll, { color: st.col, weight, opacity, dashArray: st.dash, lineCap: st.cap, lineJoin: 'round' });
      if (onClick) pl.on('click', onClick);
      layer.addLayer(pl);
    });
    A.stops.forEach(sp => {
      const p = r.pts[sp.i]; if (!p) return;
      const html = sp.transition ? '<div class="act-stop tr" title="Transition">⇄</div>' : '<div class="act-stop" title="Break"></div>';
      layer.addLayer(L.marker([p[0], p[1]], { interactive: false, icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html }) }));
    });
    return A;
  }

  /* ---------- drawing ---------- */
  function cased(latlngs, col, dashed, weight = 4, opacity = 1) {
    return [
      L.polyline(latlngs, { color: '#0b1520', weight: weight + 6, opacity: 0.45 * opacity, interactive: false }),
      L.polyline(latlngs, { color: '#ffffff', weight: weight + 3, opacity: 0.95 * opacity, interactive: false }),
      L.polyline(latlngs, { color: col, weight, opacity, dashArray: dashed ? '10 8' : null, lineCap: dashed ? 'butt' : 'round' }),
    ];
  }
  function glow(segs, layer) {
    (segs || []).forEach(s => layer.addLayer(L.polyline(s.pts, { pane: 'routeGlow', color: GLOW[s.cls], weight: 15, opacity: 0.7, lineCap: 'round', lineJoin: 'round', interactive: false })));
  }
  function drawSaved() {
    routeLayer.clearLayers();
    routes.filter(r => visible.has(r.id)).forEach(r => {
      const ll = r.pts.map(p => [p[0], p[1]]); if (ll.length < 2) return;
      if (r.type === 'plan') { glow(r.stats && r.stats.segs, routeLayer); drawFlags(r.stats && r.stats.flags, routeLayer); }
      if (r.type === 'track' && r.pts.length > 2 && r.pts[0][3]) drawTrackActs(routeLayer, r, 4, 0.95, () => openRoute(r.id));
      else {
        const parts = cased(ll, r.type === 'plan' ? PLAN_COL : TRACK_COL, r.type === 'plan', 4, 0.9);
        parts[2].on('click', () => openRoute(r.id));
        parts.forEach(p => routeLayer.addLayer(p));
      }
      routeLayer.addLayer(L.circleMarker(ll[0], { radius: 5, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1, interactive: false }));
      routeLayer.addLayer(L.circleMarker(ll[ll.length - 1], { radius: 5, color: '#fff', weight: 2, fillColor: '#0b1520', fillOpacity: 1, interactive: false }));
    });
  }

  function profileSvg(profile, segs) {
    const pts = (profile || []).filter(p => p[1] != null);
    if (pts.length < 2) return '<p class="small muted" style="margin:0">No elevation data here yet. Download this area, or open it with signal, to see the profile.</p>';
    const W = 300, H = 90, pad = 4, maxD = pts[pts.length - 1][0] || 1;
    const es = pts.map(p => p[1]), lo = Math.min(...es), hi = Math.max(...es), span = Math.max(20, hi - lo);
    const xy = pts.map(p => [(pad + (W - 2 * pad) * p[0] / maxD).toFixed(1), (H - pad - (H - 2 * pad - 14) * (p[1] - lo) / span).toFixed(1)]);
    const line = xy.map(p => p.join(',')).join(' ');
    return '<svg class="profile" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Elevation profile">' +
      '<polygon points="' + pad + ',' + (H - pad) + ' ' + line + ' ' + (W - pad) + ',' + (H - pad) + '" class="profile-fill"/>' +
      '<polyline points="' + line + '" class="profile-line"/>' +
      (segs || []).map(s => '<rect x="' + (pad + (W - 2 * pad) * s.d0 / maxD).toFixed(1) + '" y="' + (H - 6) + '" width="' + Math.max(1.5, (W - 2 * pad) * (s.d1 - s.d0) / maxD).toFixed(1) + '" height="6" fill="' + GLOW[s.cls] + '"/>').join('') + '</svg>' +
      '<div class="spread small muted"><span>' + Math.round(lo) + ' m low</span><span>' + Math.round(hi) + ' m high</span><span>' + fmtKm(maxD) + '</span></div>';
  }
  function statsHtml(r) {
    const s = r.stats || {};
    const cell = (k, v) => '<div class="stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    let h = '<div class="stats">' + cell('Distance', fmtKm(s.dist || 0)) + cell('Climb', '↑ ' + (s.gain || 0) + ' m') + cell('Descent', '↓ ' + (s.loss || 0) + ' m');
    if (r.type === 'plan') h += cell('Est. time', s.est ? fmtDur(s.est) : '–');
    else h += cell('Time', fmtDur(s.time || 0)) + cell('Moving', fmtDur(s.moving || 0));
    h += '</div>';
    if (r.type === 'plan' && s.maxUp != null) {
      const warn = [];
      if (s.maxUp >= 30) warn.push('Some of the climb is 30°+: plan to boot-pack, or add switchbacks to ease it.');
      else if (s.maxUp >= 25) warn.push('Climb reaches 25–30°: kick turns, and ski crampons if it\'s firm.');
      if (s.maxDown >= 40) warn.push('Descent crosses 40°+ ground: no-fall terrain likely.');
      const fl = s.flags || [], nC = fl.filter(f => f.t === 'cliff').length, nD = fl.filter(f => f.t === 'danger').length, hzs = [...new Set(fl.filter(f => f.t === 'hazard').map(f => hazardOf(f.h).label))];
      if (nC) warn.push('Crosses 45°+ ground in ' + nC + ' place' + (nC > 1 ? 's' : '') + ': likely cliffs or rock, probably not passable (purple ! on the map).');
      if (nD) warn.push('Crosses today\'s red danger shading in ' + nD + ' place' + (nD > 1 ? 's' : '') + ' (red ! on the map).');
      if (hzs.length) warn.push('Passes within 30 m of: ' + hzs.join(', ') + ' (amber ! on the map).');
      h += '<div class="grade-box"><div><span class="k">Skinning</span> steepest <b>' + s.maxUp + '°</b>' + (s.upSteepM ? ' · ' + fmtKm(s.upSteepM) + ' over 20°' : '') + '</div>' +
        '<div><span class="k">Riding</span> steepest ground <b>' + s.maxDown + '°</b></div>' +
        (s.maxSlope != null ? '<div><span class="k">Avalanche terrain</span> <b>' + s.steepPct + '%</b> of the line is on 30°+ ground</div>' : '') +
        warn.map(w => '<div class="grade-warn">' + w + '</div>').join('') + '</div>' + gradeLegend();
    } else if (r.type === 'plan' && s.maxSlope != null) h += '<p class="small" style="margin:0">Steepest point <b>' + s.maxSlope + '°</b>. <b>' + s.steepPct + '%</b> of the line is on 30° or steeper.</p>';
    if (r.type === 'plan') h += '<p class="small muted" style="margin:0">Time is a touring estimate (Munter: 4 units/h up, 10 down). Your pace will differ.</p>';
    if (r.type === 'track' && r.pts.length > 2 && r.pts[0][3]) h += activityHtml(r);
    return h;
  }

  function actSwatch(k) {
    const st = ACT[k];
    return '<svg width="34" height="10" aria-hidden="true"><path d="M2 5 H32" stroke="#fff" stroke-width="7"/><path d="M2 5 H32" stroke="' + st.col + '" stroke-width="4"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + ' stroke-linecap="' + st.cap + '"/></svg>';
  }
  function activityHtml(r) {
    const { A, by, up } = activitySummary(r);
    const order = ['snowshoe', 'split', 'flat', 'verts', 'boot', 'ride'].filter(k => by[k]);
    const nBreak = A.stops.filter(x => !x.transition).length, nTr = A.stops.filter(x => x.transition).length, stopT = A.stops.reduce((t, x) => t + x.dur, 0);
    const laps = A.segs.filter(g => g.type === 'ride' && g.loss >= 50).length;
    let h = '<div class="stack"><p class="eyebrow">What you were doing</p><div class="act-table">' +
      order.map(k => '<div class="act-row"><span>' + actSwatch(k) + '</span><b>' + ACT[k].label + '</b><span>' + fmtDur(by[k].time) + '</span><span>' + (k === 'ride' ? '↓ ' + by[k].loss : '↑ ' + by[k].gain) + ' m</span></div>').join('') +
      '<div class="act-row"><span><span class="act-stop inline"></span></span><b>Breaks</b><span>' + fmtDur(stopT) + '</span><span>' + nBreak + ' stop' + (nBreak === 1 ? '' : 's') + (nTr ? ' · ' + nTr + ' transition' + (nTr === 1 ? '' : 's') : '') + '</span></div>' +
      '</div>' + (laps ? '<p class="small" style="margin:0"><b>' + laps + '</b> run' + (laps === 1 ? '' : 's') + ' ridden.</p>' : '') +
      '<details class="small"><summary>Sections (' + A.segs.length + ') · fix one if it got it wrong</summary><div class="act-secs">' +
      A.segs.map((g, k) => '<div class="act-sec"><span>' + actSwatch(actKey(g.type, up)) + '</span><span>' + (k + 1) + '. ' + fmtDur(g.time) + ' · ' + (g.type === 'ride' ? '↓ ' + g.loss : '↑ ' + g.gain) + ' m</span>' +
        '<select data-sec="' + g.i0 + '" aria-label="What you were doing in section ' + (k + 1) + '">' + [['up', UP_MODES[up] === 'Splitboard' ? 'Skinning' : UP_MODES[up] || 'Climbing'], ['boot', up === 'verts' ? 'Verts' : 'Bootpack'], ['ride', 'Riding']].map(([v, l]) => '<option value="' + v + '"' + (g.type === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>').join('') +
      '</div></details>' +
      '<div class="field"><span class="lbl">Climbing on</span><div class="seg" id="actUp">' + Object.entries(UP_MODES).map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (up === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div></div></div>';
    return h;
  }
  function gradeLegend() {
    return '<div class="legend small"><span><span class="sw" style="background:' + GLOW.steep + ';border:0"></span>Steep: skin 20–25° / ride 35–40°</span>' +
      '<span><span class="sw" style="background:' + GLOW.vsteep + ';border:0"></span>Very steep: skin 25–30° (kick turns) / ride 40–45°</span>' +
      '<span><span class="sw" style="background:' + GLOW.boot + ';border:0"></span>Boot-pack: skin 30°+ / ride 45°+</span></div>';
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
      '<div id="planAssist"></div><div class="btn-row"><button class="btn small" id="pUndo"' + (plan.pts.length ? '' : ' disabled') + '>Undo</button><button class="btn small" id="pClear"' + (plan.pts.length ? '' : ' disabled') + '>Clear</button><button class="btn small ghost" id="pCancel">Cancel</button><button class="btn small primary" id="pSave"' + (plan.pts.length > 1 ? '' : ' disabled') + '>Save route</button></div>';
    bar.hidden = false;
    $('#pUndo').onclick = () => { plan.pts.pop(); renderPlan(); };
    $('#pClear').onclick = () => { plan.pts = []; renderPlan(); };
    $('#pCancel').onclick = () => { endPlan(); };
    $('#pSave').onclick = () => savePlan();
    clearTimeout(planTimer);
    if (plan.pts.length > 1) planTimer = setTimeout(async () => {
      const s = await analyseLine(plan.pts); if (!plan) return; plan.stats = s;
      glow(s.segs, liveLayer); drawFlags(s.flags, liveLayer);
      const as = $('#planAssist');
      if (as) as.innerHTML = s._upRuns.length ? '<button class="btn small assist" id="pSuggest">Suggest a gentler line for the steep climb' + (s._upRuns.length > 1 ? 's (' + s._upRuns.length + ')' : '') + '</button>' : '';
      const sg = $('#pSuggest'); if (sg) sg.onclick = () => suggestForPlan(sg);
      const el = $('#planStats'); if (el) el.innerHTML = fmtKm(s.dist) + ' · ↑ ' + s.gain + ' m · ↓ ' + s.loss + ' m · ~' + fmtDur(s.est) +
        (s.hasEle ? ' · skin max <b class="g-' + (s.maxUp >= 30 ? 'boot' : s.maxUp >= 25 ? 'vsteep' : s.maxUp >= 20 ? 'steep' : 'ok') + '">' + s.maxUp + '°</b> · ride max <b class="g-' + (s.maxDown >= 45 ? 'boot' : s.maxDown >= 40 ? 'vsteep' : s.maxDown >= 35 ? 'steep' : 'ok') + '">' + s.maxDown + '°</b>' : '');
    }, 250);
  }
  // Work out gentler lines for each very steep climb, show them dotted, and let the rider choose.
  async function suggestForPlan(btn) {
    const s = plan && plan.stats; if (!s || !s._samples) return;
    btn.disabled = true; btn.textContent = 'Working out a gentler line…';
    const S = s._samples;
    // Merge runs that are close together, and give each a little room either side.
    const runs = [];
    s._upRuns.forEach(r => { const last = runs[runs.length - 1]; if (last && S[r.i0].d - S[last.i1].d < 100) last.i1 = r.i1; else runs.push({ i0: r.i0, i1: r.i1 }); });
    const out = [];
    for (const r of runs) {
      const a = S[Math.max(0, r.i0 - 2)], b = S[Math.min(S.length - 1, r.i1 + 2)];
      const res = await suggestBetween([a.lat, a.lon], [b.lat, b.lon]);
      if (res.err) { toast(res.err, 4500); continue; }
      out.push({ a, b, pts: res.pts });
    }
    if (!plan) return;
    if (!out.length) { btn.disabled = false; btn.textContent = 'Suggest a gentler line'; return; }
    // Build the full suggested route and measure it.
    let pts = plan.pts.map(p => p.slice());
    out.slice().sort((x, y) => y.a.seg - x.a.seg).forEach(o => {
      pts = pts.slice(0, o.a.seg + 1).concat(o.pts, pts.slice(o.b.seg + 1));
    });
    const ns = await analyseLine(pts); if (!plan) return;
    plan.suggestion = { pts };
    out.forEach(o => cased(o.pts, '#16a34a', true, 4).forEach(l => liveLayer.addLayer(l)));
    $('#planAssist').innerHTML = '<div class="assist-card"><b>Suggested line (dotted green)</b><span class="small">Skin max <b>' + ns.maxUp + '°</b> (yours ' + s.maxUp + '°) · ' + fmtKm(ns.dist) + ' (' + (ns.dist >= s.dist ? '+' : '−') + fmtKm(Math.abs(ns.dist - s.dist)) + ') · ~' + fmtDur(ns.est) + '</span>' +
      '<span class="small muted">From elevation data only. It can\'t see trees, bamboo, creeks or today\'s snow. Check it on the map and on the day.</span>' +
      '<div class="btn-row"><button class="btn small primary" id="pUseSug">Use it</button><button class="btn small" id="pKeepMine">Keep mine</button></div></div>';
    $('#pUseSug').onclick = () => { plan.pts = plan.suggestion.pts; plan.suggestion = null; renderPlan(); toast('Suggested line applied. Drag points to fine-tune.'); };
    $('#pKeepMine').onclick = () => { plan.suggestion = null; renderPlan(); };
  }
  function endPlan() { map.off('click', onPlanClick); plan = null; liveLayer.clearLayers(); bar.hidden = true; document.body.classList.remove('planning'); }
  async function savePlan() {
    const p = plan; const stats = lean(p.stats || await analyseLine(p.pts));
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
  // Before a new recording: how are you going up?
  function askRecMode() {
    if (rec) { startRec(); return; }
    const last = store.get('recUpMode', 'split'), steep = store.get('recSteep', 20);
    openSheet('Record a track', '<div class="field"><span class="lbl">How are you going up?</span><div class="chips" id="rmUp">' +
      Object.entries(UP_MODES).map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (v === last ? 'on' : '') + '">' + l + '</button>').join('') + '</div></div>' +
      '<div class="field"><span class="lbl">Call a climb bootpack / verts when it\'s steeper than</span><div class="seg" id="rmSteep">' + [20, 25, 30].map(v => '<button type="button" data-v="' + v + '" class="' + (v === steep ? 'on' : '') + '">' + v + '°</button>').join('') + '</div>' +
      '<span class="help">After a stop. Splitboarders often skin 20–25°, so 25° is a good choice if you skin steep.</span></div>' +
      '<p class="small muted" style="margin:0">The app works out breaks, transitions, bootpacking and riding as you go, and colours the track to match. You can switch it yourself while recording, and fix any section afterwards.</p>' +
      '<button class="btn primary" id="rmGo">● Start recording</button>', { view: 'recstart' });
    let up = last, st = steep;
    $('#rmUp').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; up = b.dataset.v; $('#rmUp').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
    $('#rmSteep').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; st = +b.dataset.v; $('#rmSteep').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
    $('#rmGo').onclick = () => { store.set('recUpMode', up); store.set('recSteep', st); startRec({ upMode: up, steep: st }); };
  }
  function startRec(act) {
    if (!navigator.geolocation) { toast('This device can\'t share its position with the app'); return; }
    stopAllModes(); closeSheet();
    rec = rec || { id: 't-' + uid(), start: Date.now(), pts: [], paused: false, act: Object.assign({ upMode: 'split', steep: 20, marks: [] }, act || {}) };
    rec.act = rec.act || { upMode: store.get('recUpMode', 'split'), steep: store.get('recSteep', 20), marks: [] };
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
    if (!rec.act) rec.act = { upMode: store.get('recUpMode', 'split'), steep: store.get('recSteep', 20), marks: [] };
    const ll = rec.pts.map(p => [p[0], p[1]]);
    let A = null;
    if (ll.length > 1) A = drawTrackActs(liveLayer, rec, 5, 1);
    const lm = (rec.act.marks || []).slice(-1)[0];
    const curKey = lm && lm.type !== 'auto' ? actKey(lm.type, rec.act.upMode) : A && A.segs.length ? actKey(A.segs[A.segs.length - 1].type, rec.act.upMode) : actKey('up', rec.act.upMode);
    rec._now = curKey;
    if (ll.length) liveLayer.addLayer(L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 3, fillColor: ACT[curKey].col, fillOpacity: 1, interactive: false }));
    renderRecBar();
  }
  function renderRecBar() {
    if (!rec) return;
    const s = trackStats(rec.pts), elapsed = (Date.now() - rec.start) / 1000;
    const lastMark = (rec.act.marks || []).slice(-1)[0], forced = lastMark && lastMark.type !== 'auto' ? lastMark.type : 'auto';
    const nowKey = rec._now || actKey('up', rec.act.upMode);
    bar.innerHTML = '<div class="route-bar-head"><b class="rec-dot' + (rec.paused ? ' paused' : '') + '">' + (rec.paused ? 'Paused' : 'Recording') + '</b><span class="act-now">' + actSwatch(nowKey) + ' ' + ACT[nowKey].label + '</span><span class="rec-clock">' + fmtClock(elapsed) + '</span></div>' +
      '<div class="seg act-seg" id="actForce">' + [['auto', 'Auto'], ['up', UP_MODES[rec.act.upMode] === 'Splitboard' ? 'Skin' : (UP_MODES[rec.act.upMode] || 'Climb')], ['boot', rec.act.upMode === 'verts' ? 'Verts' : 'Boot'], ['ride', 'Ride']].map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (forced === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
      '<div class="stats">' +
      '<div class="stat"><span class="k">Distance</span><span class="v">' + fmtKm(s.dist) + '</span></div>' +
      '<div class="stat"><span class="k">Climb</span><span class="v">↑ ' + s.gain + ' m</span></div>' +
      '<div class="stat"><span class="k">Descent</span><span class="v">↓ ' + s.loss + ' m</span></div>' +
      '<div class="stat"><span class="k">Moving</span><span class="v">' + fmtDur(s.moving) + '</span></div></div>' +
      (rec.pts.length === 0 && !rec.paused ? '<p class="small muted" style="margin:0">Waiting for a GPS fix… out of mobile range this can take a minute or two.</p>' : '') +
      '<p class="small muted" style="margin:0">Keep the app open: phones pause GPS for web apps when the screen locks. The screen stays on while recording.</p>' +
      '<div class="btn-row">' + (rec.paused ? '<button class="btn small primary" id="rResume">Resume</button>' : '<button class="btn small" id="rPause">Pause</button>') + '<button class="btn small danger" id="rStop">Stop</button></div>';
    bar.hidden = false;
    $('#actForce').onclick = e => { const b = e.target.closest('button'); if (!b) return; rec.act.marks = (rec.act.marks || []).concat({ t: Date.now(), type: b.dataset.v }); store.set('recording', rec); toast(b.dataset.v === 'auto' ? 'Working it out automatically' : 'Now: ' + b.textContent, 1500); renderRec(); };
    const pz = $('#rPause'); if (pz) pz.onclick = pauseRec;
    const rs = $('#rResume'); if (rs) rs.onclick = () => startRec();
    $('#rStop').onclick = stopRec;
  }
  function stopRec() {
    pauseRec(); clearInterval(recTick);
    const r = rec; rec = null; store.set('recording', null);
    document.body.classList.remove('recording'); $('#recBtn').classList.remove('rec-on'); bar.hidden = true; liveLayer.clearLayers();
    if (!r || r.pts.length < 2) { toast('Nothing recorded. Track discarded.'); return; }
    const t = { id: r.id, type: 'track', name: 'Track ' + new Date(r.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + (state.area ? ' · ' + state.area.name : ''), created: new Date(r.start).toISOString(), area: state.area && state.area.id, pts: r.pts, stats: trackStats(r.pts), act: r.act, pending: true };
    routes.unshift(t); visible.add(t.id); save(); drawSaved(); openRoute(t.id, true);
  }
  function stopAllModes() { if (plan) endPlan(); }

  /* ---------- sheets ---------- */
  function openRoutes() {
    const own = routes.filter(r => !r.synced);
    const plans = own.filter(r => r.type === 'plan'), tracks = own.filter(r => r.type === 'track' && !r.pending);
    const crewR = routes.filter(r => r.synced === 'crew'), pubR = routes.filter(r => r.synced === 'all');
    const shareTag = r => { if (r.synced) return r.from ? ' · from ' + r.from : ''; const w = shareOf(r); return w === 'crew' ? ' · crew' : w === 'all' ? ' · public' : ''; };
    const item = r => '<div class="list-item route-item" data-open="' + r.id + '"><span class="swatch ' + r.type + '"></span><span><span class="t">' + esc(r.name) + '</span><br><span class="s">' + fmtKm(r.stats.dist || 0) + ' · ↑ ' + (r.stats.gain || 0) + ' m' + (r.type === 'track' ? ' · ' + fmtDur(r.stats.time || 0) : r.stats.est ? ' · ~' + fmtDur(r.stats.est) : '') + shareTag(r) + ' · ' + fmtDate(r.created) + '</span></span>' +
      '<label class="vis" title="Show on map"><input type="checkbox" data-vis="' + r.id + '"' + (visible.has(r.id) ? ' checked' : '') + '> Show</label></div>';
    let h = '<div class="btn-row"><button class="btn primary" id="goPlan">Plan a route</button><button class="btn" id="goRec">' + (rec ? 'Back to recording' : '● Record a track') + '</button></div>' +
      '<div class="legend small"><span><span class="sw" style="background:repeating-linear-gradient(90deg,' + PLAN_COL + ' 0 8px,transparent 8px 12px);border:0"></span>Planned route</span><span><span class="sw" style="background:' + TRACK_COL + ';border:0"></span>Recorded track</span></div>';
    h += '<div class="stack"><p class="eyebrow">Planned routes</p>' + (plans.length ? '<div class="list">' + plans.map(item).join('') + '</div>' : '<p class="small muted" style="margin:0">None yet. Plan one, or import a GPX file.</p>') + '</div>';
    h += '<div class="stack"><p class="eyebrow">Recorded tracks</p>' + (tracks.length ? '<div class="list">' + tracks.map(item).join('') + '</div>' : '<p class="small muted" style="margin:0">None yet.</p>') + '</div>';
    if (crewR.length) h += '<div class="stack"><p class="eyebrow">From your crew</p><div class="list">' + crewR.map(item).join('') + '</div></div>';
    if (pubR.length) h += '<div class="stack"><p class="eyebrow">Shared by other riders</p><div class="list">' + pubR.map(item).join('') + '</div></div>';
    if (plans.length || tracks.length || state.pins.length) h += '<button class="btn" id="shareMany">Send routes and markers to a mate…</button>';
    h += '<button class="btn" id="gpxImport">Import GPX (from a mate, CalTopo, Gaia…)</button><input type="file" id="gpxFile" accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden>';
    openSheet('Routes and tracks', h, { view: 'routes', tall: true });
    $('#goPlan').onclick = () => startPlan();
    $('#goRec').onclick = () => { if (rec) { closeSheet(); renderRec(); } else askRecMode(); };
    $('#sheetBody').querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => { if (e.target.closest('.vis')) return; openRoute(el.dataset.open); }));
    $('#sheetBody').querySelectorAll('[data-vis]').forEach(cb => cb.onchange = () => { cb.checked ? visible.add(cb.dataset.vis) : visible.delete(cb.dataset.vis); save(); drawSaved(); });
    $('#gpxImport').onclick = () => $('#gpxFile').click();
    const sm = $('#shareMany'); if (sm) sm.onclick = () => window.powderShare && powderShare.picker();
    $('#gpxFile').onchange = async e => { const f = e.target.files[0]; if (f) await importGpx(f); e.target.value = ''; };
  }
  function openRoute(id, fresh) {
    const r = routes.find(x => x.id === id); if (!r) return;
    if (r.type === 'plan' && r.stats && r.stats.maxUp == null && !r._upgrading) {
      r._upgrading = true;
      analyseLine(r.pts.map(p => [p[0], p[1]])).then(s => { r.stats = lean(s); delete r._upgrading; save(); drawSaved(); if (state.view === 'route') openRoute(id); });
    }
    visible.add(r.id); save(); drawSaved();
    try { map.fitBounds(L.latLngBounds(r.pts.map(p => [p[0], p[1]])), { padding: [40, 40], maxZoom: 15 }); } catch (e) { }
    let h = '';
    if (r.pending) h += '<div class="card"><b>Keep this track?</b><span class="small muted">Name it and keep it, or throw it away.</span></div>';
    h += '<div class="field"><label for="rName">Name</label><input type="text" id="rName" maxlength="60" value="' + esc(r.name) + '"></div>';
    h += statsHtml(r) + profileSvg(r.stats.profile, r.type === 'plan' ? r.stats.segs : null);
    if (r.synced) h += '<p class="small muted" style="margin:0">' + (r.synced === 'crew' ? 'Shared by your crew' : 'Shared publicly') + (r.from ? ' by <b>' + esc(r.from) + '</b>' : '') + '. Only they can change it.</p>';
    else if (!r.pending && !r.from) {
      const w = shareOf(r), crew = window.powderSync && powderSync.crew();
      h += '<div class="field"><span class="lbl">Who can see it</span><div class="seg" id="rWho">' + [['me', 'Just me'], ['crew', crew ? 'My crew' : 'My crew…'], ['all', 'Everyone']].map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (w === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
        '<span class="help">' + (crew ? 'Crew: ' + esc(crew.name) + '. ' : 'Set up a crew in Settings to share with just your friends. ') + 'Shared routes update on their phones whenever you have signal.</span></div>';
    }
    h += '<div class="btn-row">' + (r.pending ? '<button class="btn primary" id="rKeep">Keep</button><button class="btn" id="rDiscard">Discard</button>'
      : '<button class="btn primary" id="rLink">Send to a mate</button><button class="btn" id="rShare">GPX file</button>' + (r.type === 'plan' && !r.synced ? '<button class="btn" id="rEdit">Edit line</button>' : '') + '<button class="btn" id="rDel">' + (r.synced ? 'Remove from my phone' : 'Delete') + '</button>') + '</div>';
    if (r.pending) h += '<button class="btn small ghost" id="rShare">Share GPX</button>';
    openSheet(r.type === 'plan' ? 'Planned route' : 'Recorded track', h, { view: 'route' });
    const nameEl = $('#rName'); nameEl.onchange = () => { r.name = nameEl.value.trim() || r.name; save(); };
    if (r.synced) nameEl.readOnly = true;
    const who = $('#rWho'); if (who) who.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.v === 'crew' && !(window.powderSync && powderSync.crew())) { toast('Set up or join a crew first'); if (window.showSettings) showSettings(); return; }
      r.share = b.dataset.v; save(); who.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      toast(r.share === 'me' ? 'Just you' : r.share === 'crew' ? 'Shared with your crew' : 'Shared with everyone');
      if (window.powderSync) powderSync.soon();
    });
    const keep = $('#rKeep'); if (keep) keep.onclick = () => { r.name = nameEl.value.trim() || r.name; delete r.pending; save(); toast('Track kept'); openRoutes(); };
    const disc = $('#rDiscard'); if (disc) disc.onclick = () => { removeRoute(r.id); toast('Track discarded'); closeSheet(); };
    const sh = $('#rShare'); if (sh) sh.onclick = () => shareGpx(r);
    $('#sheetBody').querySelectorAll('select[data-sec]').forEach(sel => sel.onchange = () => {
      r.act = r.act || {}; r.act.edits = Object.assign({}, r.act.edits, { [sel.dataset.sec]: sel.value }); save(); drawSaved(); openRoute(r.id);
    });
    const au = $('#actUp'); if (au) au.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; r.act = Object.assign({}, r.act, { upMode: b.dataset.v }); save(); drawSaved(); openRoute(r.id); });
    const lk = $('#rLink'); if (lk) lk.onclick = () => window.powderShare && powderShare.send({ routes: [r] }, r.name);
    const ed = $('#rEdit'); if (ed) ed.onclick = () => startPlan(r);
    const del = $('#rDel'); if (del) del.onclick = () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; del.classList.add('danger'); return; }
      if (r.synced) { const hid = store.get('hiddenRoutes', []); hid.push(r.id); store.set('hiddenRoutes', hid.slice(-500)); }
      removeRoute(r.id); toast(r.synced ? 'Removed from your phone' : 'Deleted'); openRoutes();
    };
    if (fresh && r.type === 'plan') toast('Route saved');
  }
  function removeRoute(id) { const i = routes.findIndex(x => x.id === id); if (i >= 0) routes.splice(i, 1); visible.delete(id); save(); drawSaved(); if (window.powderSync) powderSync.soon(); }
  // Who sees one of my routes: set per route; new routes go to your crew by default once you're in one.
  function shareOf(r) {
    if (r.synced || r.from) return 'me';
    if (r.share) return r.share;
    const c = window.powderSync && powderSync.crew();
    return c && (r.created || '') >= (c.joinedAt || '') ? 'crew' : 'me';
  }
  // Routes that arrive by live sync (crew or public). Upsert by id; public ones start hidden so the map doesn't fill up.
  async function upsertSynced(x, scope) {
    if (!x || !x.id || x.pts.length < 2 || store.get('hiddenRoutes', []).includes(x.id)) return false;
    const old = routes.find(r => r.id === x.id);
    if (old && !old.synced) return false; // never overwrite one of mine
    const type = x.type === 'track' ? 'track' : 'plan';
    const r = { id: x.id, type, name: String(x.name || 'Shared route').slice(0, 60), created: x.created || new Date().toISOString(), from: String(x.from || '').slice(0, 40), synced: scope,
      pts: type === 'plan' ? x.pts.map(p => [p[0], p[1]]) : x.pts, act: x.act };
    if (old && old.name === r.name && old.pts.length === r.pts.length) return false;
    r.stats = type === 'plan' ? lean(await analyseLine(r.pts)) : trackStats(r.pts);
    if (type === 'track' && Array.isArray(x.sentStats)) ['dist', 'gain', 'loss', 'time', 'moving'].forEach((k, i) => { const v = Number(x.sentStats[i]); if (isFinite(v) && v >= 0) r.stats[k] = v; });
    if (old) Object.assign(old, r); else { routes.push(r); if (scope === 'crew') visible.add(r.id); }
    save(); drawSaved();
    return true;
  }
  function removeSynced(id) { const r = routes.find(x => x.id === id); if (r && r.synced) { removeRoute(id); return true; } return false; }

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
      const r = { id: 'r-' + uid(), type, name: String(nm).slice(0, 60), created: new Date().toISOString(), pts, stats: type === 'plan' ? lean(await analyseLine(pts.map(p => [p[0], p[1]]))) : trackStats(pts) };
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
    if (rec && !rec.paused) { renderRec(); toast('Recording. Use Pause or Stop below.', 1800); } else if (rec) startRec(); else askRecMode();
  };

  // Pick up a recording that was running when the app was closed.
  if (rec) { document.body.classList.add('recording'); $('#recBtn').classList.add('rec-on'); rec.paused = true; renderRec(); toast('Unfinished track found. Tap Resume to carry on, or Stop to save it.', 4000); }
  drawSaved();
  // A route or track a mate shared by link. Same id already here = skip.
  async function addShared(x) {
    if (!x || !Array.isArray(x.pts) || x.pts.length < 2) return false;
    if (routes.some(r => r.id === x.id)) { visible.add(x.id); save(); drawSaved(); return false; }
    const type = x.type === 'track' ? 'track' : 'plan';
    const pts = x.pts.slice(0, 20000).filter(p => isFinite(p[0]) && isFinite(p[1]));
    const r = { id: String(x.id || 'r-' + uid()).slice(0, 40), type, name: String(x.name || (type === 'plan' ? 'Shared route' : 'Shared track')).slice(0, 60),
      created: x.created || new Date().toISOString(), from: String(x.from || '').slice(0, 40), pts: type === 'plan' ? pts.map(p => [p[0], p[1]]) : pts, act: x.act };
    r.stats = type === 'plan' ? lean(await analyseLine(r.pts)) : trackStats(r.pts);
    if (type === 'track' && Array.isArray(x.sentStats)) ['dist', 'gain', 'loss', 'time', 'moving'].forEach((k, i) => { const v = Number(x.sentStats[i]); if (isFinite(v) && v >= 0) r.stats[k] = v; });
    routes.unshift(r); visible.add(r.id); save(); drawSaved();
    return true;
  }
  window.powderRoutes = { openRoutes, startPlan, startRec, openRoute, addShared, upsertSynced, removeSynced, shareOf, all: () => routes, fmtKm };
})();
