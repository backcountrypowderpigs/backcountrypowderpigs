/* Backcountry Powder Pigs — backcountry avalanche map for Japan.
   Topo + elevation: GSI (国土地理院) tiles. Bulletins: JAN, summarised daily into data/bulletins.json.
   Pins live on this phone (localStorage) and move between phones with Export / Import. */
'use strict';

/* ------------------------------------------------------------------ constants */
const GSI = {
  std: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  dem: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png',
};
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const GEOCODE = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const RATING_NAMES = ['No rating', 'Low', 'Moderate', 'Considerable', 'High', 'Extreme'];
const BAND_NAMES = { alp: 'Alpine', tl: 'Treeline', btl: 'Below treeline' };

const SIZES = [
  ['1', 'Harmless to people unless pushed off a cliff'],
  ['1.5', 'Between 1 and 2'],
  ['2', 'Could bury, injure or kill a person'],
  ['2.5', 'Between 2 and 3'],
  ['3', 'Could bury and destroy a car or a small building'],
  ['3.5', 'Between 3 and 4'],
  ['4', 'Could destroy a truck, several buildings or a large area of forest'],
  ['5', 'Largest known; could gouge the landscape'],
];
const TYPES = ['Dry loose', 'Wet loose', 'Storm slab', 'Wind slab', 'Persistent slab', 'Deep persistent slab', 'Wet slab', 'Glide (full depth)', 'Cornice fall', 'Not sure'];
const TRIGGERS = ['Natural', 'Rider, accidental', 'Rider, intentional (ski cut)', 'Remote (triggered from a distance)', 'Explosives', 'Cornice', 'Not sure'];
const BED = ['New snow interface', 'Surface hoar', 'Facets', 'Depth hoar', 'Melt-freeze crust', 'Rain crust', 'Graupel', 'Ground (full depth)', 'Not sure'];
const INVOLVE = ['Nobody caught', 'Caught, not buried', 'Partly buried', 'Fully buried', 'Not known'];
const HOW_RECENT = ['Saw it release', 'Saw fresh debris', 'Saw old debris', 'Heard from someone'];
const FREQ = ['Most storms', 'A few times a season', 'Most seasons', 'Every few years'];
const WHEN = ['Early season', 'Mid winter', 'Spring', 'Any time'];
const HOW_PATH = ['Seen it run', 'Debris or broken trees', 'Local guide or patrol', 'Heard from someone'];
const DISPUTE_REASONS = ['Wrong spot', 'Size is off', 'Type is off', 'Didn\'t happen', 'Other'];

/* ------------------------------------------------------------------ storage */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('Phone storage is full'); return false; } },
};
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
const deviceId = store.get('deviceId', null) || (() => { const id = 'd-' + uid(); store.set('deviceId', id); return id; })();

const state = {
  areas: [], builtinAreas: [], regions: {}, area: null, bulletins: null, demo: store.get('demo', false),
  customAreas: store.get('customAreas', []), boundsOverrides: store.get('boundsOverrides', {}),
  slides: [], pins: store.get('pins', []),
  shade: store.get('shade', 'danger'), base: store.get('base', 'sat') === 'topo' ? 'topo' : 'sat',
  show: Object.assign({ recent: true, path: true, onsen: true, parking: true, hut: true, shop: true, lifts: true, labels: true }, store.get('show', {})),
  recentDays: store.get('recentDays', 14),
  aspectSel: store.get('aspectSel', ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']), aspectMatch: store.get('aspectMatch', true),
  aspectOn: store.get('aspectOn', store.get('shade', '') === 'aspect'),
  bandOverrides: store.get('bandOverrides', {}),
  packs: store.get('packs', {}),
  geo: store.get('geo', {}),
  placed: store.get('placed', {}),
  me: null, view: null,
};

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysAgo(dateStr) { const t = Date.parse(dateStr); return isNaN(t) ? Infinity : (Date.now() - t) / 864e5; }
function fmtDate(s) { const d = new Date(s); return isNaN(d) ? esc(s) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
function fmtAgo(s) { const h = (Date.now() - Date.parse(s)) / 36e5; if (!isFinite(h)) return ''; if (h < 1) return 'just now'; if (h < 36) return Math.round(h) + ' h ago'; return Math.round(h / 24) + ' days ago'; }
function fmtBytes(b) { return b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
function inBounds(lat, lon, b, pad = 0) { return lat >= b[0][0] - pad && lat <= b[1][0] + pad && lon >= b[0][1] - pad && lon <= b[1][1] + pad; }
// Prefer the current area when boxes overlap (Myoko / Arai / Charmant do).
function areaFor(lat, lon) {
  if (state.area && inBounds(lat, lon, state.area.bounds, 0.02)) return state.area;
  return state.areas.find(a => inBounds(lat, lon, a.bounds, 0.02)) || null;
}
function rebuildAreas() {
  state.areas = state.builtinAreas.map(a => state.boundsOverrides[a.id] ? Object.assign({}, a, { bounds: state.boundsOverrides[a.id], boxCheck: false, boxEdited: true }) : a)
    .concat(state.customAreas.map(a => Object.assign({ custom: true, bandsSource: 'you', links: [] }, a)));
  if (state.area) state.area = state.areas.find(a => a.id === state.area.id) || state.areas[0];
}
function regionName(r) { return r && state.regions[r] ? state.regions[r].name : 'None'; }
function bandsFor(area) { return Object.assign({}, area.bands, state.bandOverrides[area.id] || {}); }
function bandOf(area, elev) { const b = bandsFor(area); return elev >= b.alpMin ? 'alp' : elev >= b.tlMin ? 'tl' : 'btl'; }
// Bulletins are published per JAN region; several riding areas share one.
function regionBulletin(r) {
  const B = state.bulletins; if (!B || !r) return null;
  if (state.demo && B.demo && B.demo[r]) return Object.assign({ isDemo: true }, B.demo[r]);
  return (B.regions && B.regions[r]) || null;
}
function bulletinFor(areaId) { const a = state.areas.find(x => x.id === areaId); return a ? regionBulletin(a.region) : null; }
function hasRatings(b) { return !!(b && b.ratings && (b.ratings.alp || b.ratings.tl || b.ratings.btl)); }

/* ------------------------------------------------------------------ tile maths */
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const tileUrl = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
function tilesFor(bounds, z) {
  const out = []; const x0 = lon2x(bounds[0][1], z), x1 = lon2x(bounds[1][1], z), y0 = lat2y(bounds[1][0], z), y1 = lat2y(bounds[0][0], z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}

/* ------------------------------------------------------------------ elevation (GSI dem_png) */
// Each pixel: x = R*65536 + G*256 + B; 2^23 = no data; below 2^23 => x*0.01 m, above => (x-2^24)*0.01 m.
const demMem = new Map();
const demCanvas = document.createElement('canvas'); demCanvas.width = demCanvas.height = 256;
const demCtx = demCanvas.getContext('2d', { willReadFrequently: true });
function getDem(z, x, y) {
  const key = z + '/' + x + '/' + y;
  if (demMem.has(key)) return demMem.get(key);
  const p = fetch(tileUrl(GSI.dem, z, x, y), { mode: 'cors' })
    .then(r => r.ok ? r.blob() : null)
    .then(b => b ? createImageBitmap(b) : null)
    .then(bmp => {
      if (!bmp) return null;
      demCtx.clearRect(0, 0, 256, 256); demCtx.drawImage(bmp, 0, 0);
      const px = demCtx.getImageData(0, 0, 256, 256).data; const out = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) {
        const v = px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2];
        out[i] = v === 8388608 ? NaN : (v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01);
      }
      return out;
    })
    .catch(() => null);
  demMem.set(key, p);
  if (demMem.size > 80) demMem.delete(demMem.keys().next().value);
  return p;
}
function cell(d, i, j) { i = i < 0 ? 0 : i > 255 ? 255 : i; j = j < 0 ? 0 : j > 255 ? 255 : j; return d[j * 256 + i]; }
// Horn's method. Returns slope (deg) and aspect (deg, direction the slope faces).
function slopeAspect(d, i, j, res) {
  const a = cell(d, i - 1, j - 1), b = cell(d, i, j - 1), c = cell(d, i + 1, j - 1),
        e = cell(d, i - 1, j), f = cell(d, i + 1, j),
        g = cell(d, i - 1, j + 1), h = cell(d, i, j + 1), k = cell(d, i + 1, j + 1);
  if (isNaN(a + b + c + e + f + g + h + k)) return null;
  const dzdx = ((c + 2 * f + k) - (a + 2 * e + g)) / (8 * res);
  const dzdy = ((g + 2 * h + k) - (a + 2 * b + c)) / (8 * res); // per metre southward
  const slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
  const aspect = (Math.atan2(-dzdx, dzdy) * 180 / Math.PI + 360) % 360;
  return { slope, aspect };
}
const aspectName = deg => ASPECTS[Math.round(deg / 45) % 8];
const pxRes = (lat, z) => 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * 2 ** z);

async function terrainAt(lat, lon) {
  const z = 14, n = 256 * 2 ** z;
  const gx = (lon + 180) / 360 * n;
  const r = lat * Math.PI / 180; const gy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), i = Math.floor(gx % 256), j = Math.floor(gy % 256);
  const d = await getDem(z, tx, ty); if (!d) return null;
  const elev = d[j * 256 + i]; if (isNaN(elev)) return null;
  const sa = slopeAspect(d, i, j, pxRes(lat, z));
  return { elev: Math.round(elev), slope: sa ? Math.round(sa.slope) : null, aspect: sa ? aspectName(sa.aspect) : null };
}

/* ------------------------------------------------------------------ danger rules
   Turns the bulletin into map shading. RED = stay off. AMBER = only with a good reason and good travel habits.
   >=4 High/Extreme: every slope 27°+ in that band is red, 25-27° amber.
   3 Considerable: 30°+ slopes on aspects the bulletin's problems flag are red; other 30°+ slopes amber.
   2 Moderate: 30°+ slopes on flagged aspects amber.
   Shading marks the steep ground itself. Runout zones below it are NOT shaded and can still be hit. */
const DANGER_RED = [214, 18, 36, 150], DANGER_AMBER = [247, 148, 30, 105];
const SLOPE_COLS = [[45, [40, 30, 50, 130]], [40, [140, 40, 170, 135]], [35, [226, 32, 40, 130]], [30, [247, 148, 30, 130]], [27, [250, 225, 0, 125]]];
function dangerClass(slope, aspectDeg, elev, ctx) {
  if (slope < 25) return null;
  const band = elev >= ctx.alpMin ? 'alp' : elev >= ctx.tlMin ? 'tl' : 'btl';
  const r = ctx.ratings[band] || 0; if (!r) return null;
  const flagged = ctx.flags[band].has(aspectName(aspectDeg));
  if (r >= 4) return slope >= 27 ? DANGER_RED : DANGER_AMBER;
  if (slope < 30) return (r === 3 && flagged && slope >= 27) ? DANGER_AMBER : null;
  if (r === 3) return flagged ? DANGER_RED : DANGER_AMBER;
  if (r === 2) return flagged ? DANGER_AMBER : null;
  return null;
}
/* Aspect shading: every slope 20°+ coloured by the way it faces. With "match the report" on,
   the aspect + elevation combos the bulletin's problems flag are strong and the rest are faint,
   so you can see at a glance which slopes the report is worried about and plan a line on the others. */
const ASPECT_RGB = { N: [37, 99, 235], NE: [6, 182, 212], E: [22, 163, 74], SE: [163, 190, 20], S: [234, 179, 8], SW: [249, 115, 22], W: [220, 38, 38], NW: [147, 51, 234] };
function aspectClass(slope, aspectDeg, elev, ctx) {
  if (slope < 20) return null;
  const asp = aspectName(aspectDeg); if (!state.aspectSel.includes(asp)) return null;
  const c = ASPECT_RGB[asp];
  if (ctx) {
    const band = elev >= ctx.alpMin ? 'alp' : elev >= ctx.tlMin ? 'tl' : 'btl';
    return [c[0], c[1], c[2], ctx.flags[band].has(asp) ? (slope >= 30 ? 175 : 130) : 28];
  }
  return [c[0], c[1], c[2], slope >= 30 ? 130 : 75];
}
function aspectMatchActive() {
  const b = bulletinFor(state.area.id);
  return state.aspectMatch && !!(b && b.problems && b.problems.length);
}
function slopeClass(slope) { for (const [min, col] of SLOPE_COLS) if (slope >= min) return col; return null; }
function shadeContext() {
  const a = state.area; const b = bulletinFor(a.id); const bands = bandsFor(a);
  const flags = { alp: new Set(), tl: new Set(), btl: new Set() };
  ((b && b.problems) || []).forEach(p => ['alp', 'tl', 'btl'].forEach(k => ((p.zones && p.zones[k]) || []).forEach(x => flags[k].add(x))));
  return { ratings: (b && b.ratings) || {}, flags, alpMin: bands.alpMin, tlMin: bands.tlMin };
}
function effectiveShade() {
  if (state.shade === 'aspect') state.shade = 'danger';
  if (state.shade === 'danger' && !hasRatings(bulletinFor(state.area.id))) return 'slope';
  return state.shade;
}

// One painter for both overlays: classify(slope, aspectDeg, elev) -> [r,g,b,a] or null.
const TerrainLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    paintTerrain(c, coords, this.options.classifier()).then(() => done(null, c), () => done(null, c));
    return c;
  },
});
function shadeClassifier() {
  const mode = effectiveShade(); if (mode === 'off') return null;
  if (mode === 'danger') { const ctx = shadeContext(); return (s, a, e) => dangerClass(s, a, e, ctx); }
  return s => slopeClass(s);
}
function aspectClassifier() {
  if (!state.aspectOn) return null;
  const ctx = aspectMatchActive() ? shadeContext() : null;
  // Fainter when another shading is on underneath, so both stay readable.
  const k = effectiveShade() === 'off' ? 1 : 0.7;
  return (s, a, e) => { const c = aspectClass(s, a, e, ctx); return c ? [c[0], c[1], c[2], Math.round(c[3] * k)] : null; };
}
async function paintTerrain(canvas, { x, y, z }, classify) {
  if (!classify || z < 12) return;
  const dz = Math.min(z, 14), scale = 2 ** (z - dz), dx = Math.floor(x / scale), dy = Math.floor(y / scale);
  const d = await getDem(dz, dx, dy); if (!d) return;
  const span = 256 / scale, offX = (x % scale) * span, offY = (y % scale) * span;
  const res = pxRes(tile2lat(dy + 0.5, dz), dz);
  const g = canvas.getContext('2d'); const img = g.createImageData(256, 256); const px = img.data;
  for (let j = 0; j < span; j++) for (let i = 0; i < span; i++) {
    const di = offX + i, dj = offY + j; const sa = slopeAspect(d, di, dj, res); if (!sa) continue;
    const col = classify(sa.slope, sa.aspect, d[dj * 256 + di]);
    if (!col) continue;
    for (let by = 0; by < scale; by++) for (let bx = 0; bx < scale; bx++) {
      const p = ((j * scale + by) * 256 + i * scale + bx) * 4; px[p] = col[0]; px[p + 1] = col[1]; px[p + 2] = col[2]; px[p + 3] = col[3];
    }
  }
  g.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ map */
const map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 6, maxZoom: 17, tap: true });
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.attributionControl.setPrefix(false);
const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">GSI Japan</a> · POIs © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Avalanche info: <a href="https://nadare.jp" target="_blank" rel="noopener">JAN</a>';
const topo = L.tileLayer(GSI.std, { maxZoom: 17, maxNativeZoom: 16, attribution: ATTR, crossOrigin: true });
const shadeLayer = new TerrainLayer({ maxZoom: 17, opacity: 1, zIndex: 300, classifier: shadeClassifier });
const aspectLayer = new TerrainLayer({ maxZoom: 17, opacity: 1, zIndex: 310, classifier: aspectClassifier });
function redrawShading() { shadeLayer.redraw(); aspectLayer.redraw(); }
const poiLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);

const lineRenderer = L.canvas({ padding: 0.3 });
let areaOutline = null;

/* ---------- Latest satellite: Sentinel-2 via Copernicus Data Space (free account) ----------
   Finds recent passes over the area with low cloud, newest first, and shows the chosen date.
   10 m pixels: snow cover, ridgelines, forest edges and big debris; not tracks or cornices. */
const SH = 'https://sh.dataspace.copernicus.eu/ogc/';
const sat = { layer: null, layerName: store.get('satLayerName', ''), dates: [], date: null, err: '', loadedFor: null };
const satId = () => (store.get('satInstance', '') || '').trim();
function isoDay(d) { return d.toISOString().slice(0, 10); }
function satRange() { const to = new Date(), from = new Date(Date.now() - 90 * 864e5); return [isoDay(from), isoDay(to)]; }
async function satDiscover() {
  if (sat.layerName) return;
  const r = await fetch(SH + 'wms/' + encodeURIComponent(satId()) + '?SERVICE=WMS&REQUEST=GetCapabilities');
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 || r.status === 404 ? 'Copernicus didn\'t accept that ID. Check it in Settings.' : 'Copernicus isn\'t answering. Try again later.');
  const names = [...(await r.text()).matchAll(/<Layer[^>]*>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
  sat.layerName = names.find(n => /TRUE/i.test(n)) || names.find(n => /NATURAL/i.test(n)) || names[0] || '';
  if (!sat.layerName) throw new Error('That Copernicus setup has no image layers. Use the "Simple WMS" instance.');
  store.set('satLayerName', sat.layerName);
}
async function satFindDates(area) {
  const toM = (lat, lon) => [lon * 20037508.34 / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI];
  const [x0, y0] = toM(area.bounds[0][0], area.bounds[0][1]), [x1, y1] = toM(area.bounds[1][0], area.bounds[1][1]);
  const [from, to] = satRange();
  sat.dates = [];
  try {
    const r = await fetch(SH + 'wfs/' + encodeURIComponent(satId()) + '?SERVICE=WFS&REQUEST=GetFeature&TYPENAMES=DSS2&SRSNAME=EPSG:3857&BBOX=' + [x0, y0, x1, y1].map(v => v.toFixed(0)).join(',') + '&TIME=' + from + '/' + to + '&MAXCC=60&MAXFEATURES=100&OUTPUTFORMAT=application/json');
    const j = await r.json(); const by = {};
    (j.features || []).forEach(f => { const p = f.properties || {}; const d = (p.date || '').slice(0, 10); const cc = Number(p.cloudCoverPercentage); if (!d) return; if (by[d] == null || cc < by[d]) by[d] = isFinite(cc) ? cc : 100; });
    sat.dates = Object.entries(by).map(([d, cc]) => ({ d, cc })).sort((a, b) => b.d.localeCompare(a.d));
  } catch (e) { sat.dates = []; }
  const clear = sat.dates.find(x => x.cc <= 20) || sat.dates[0];
  sat.date = clear ? clear.d : null; sat.loadedFor = area.id;
}
function buildSatLayer() {
  if (sat.layer) map.removeLayer(sat.layer);
  const [from, to] = satRange();
  sat.layer = L.tileLayer.wms(SH + 'wms/' + encodeURIComponent(satId()), {
    layers: sat.layerName, format: 'image/jpeg', uppercase: true, tileSize: 512, maxZoom: 17, zIndex: 2,
    time: sat.date ? sat.date + '/' + sat.date : from + '/' + to, maxcc: sat.date ? 100 : 20, showlogo: false,
    attribution: 'Contains modified Copernicus Sentinel data ' + new Date().getFullYear(),
  }).addTo(map);
  updateSatFlag();
}
function updateSatFlag() {
  const f = $('#satFlag');
  if (state.base !== 'sat') { f.hidden = true; return; }
  if (!satId()) { f.textContent = 'Satellite: tap to set up'; f.hidden = false; return; }
  const cur = sat.dates.find(x => x.d === sat.date);
  f.textContent = sat.err ? 'Satellite unavailable' : sat.date ? 'Satellite ' + fmtDate(sat.date) + (cur ? ' · ' + Math.round(cur.cc) + '% cloud' : '') : 'Satellite: latest clear, last 90 days';
  f.hidden = false;
}
async function ensureSat() {
  sat.err = '';
  if (!satId()) { updateSatFlag(); return; }
  try {
    if (!navigator.onLine) throw new Error('No signal, so showing the topo map. Satellite comes back when you have signal.');
    await satDiscover();
    if (sat.loadedFor !== state.area.id) await satFindDates(state.area);
    buildSatLayer();
  } catch (e) { sat.err = e.message; if (sat.layer) { map.removeLayer(sat.layer); sat.layer = null; } updateSatFlag(); }
}

function setBase() {
  if (sat.layer && state.base !== 'sat') { map.removeLayer(sat.layer); sat.layer = null; }
  if (!map.hasLayer(topo)) topo.addTo(map);
  shadeLayer.addTo(map); aspectLayer.addTo(map);
  updateNativeZoom();
  if (state.base === 'sat') return ensureSat();
  updateSatFlag();
}
function drawOutline() {
  if (areaOutline) map.removeLayer(areaOutline);
  areaOutline = L.rectangle(state.area.bounds, { color: '#17507e', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
}
function updateNativeZoom() {
  const p = state.area && state.packs[state.area.id];
  const z = (!navigator.onLine && p) ? p.maxZ : 16;
  if (topo.options.maxNativeZoom !== z) { topo.options.maxNativeZoom = z; topo.redraw(); }
}

/* ------------------------------------------------------------------ markers */
const SKULL = '<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#c8102e" stroke="#fff" stroke-width="2"/><g stroke="#fff" stroke-width="2.4" stroke-linecap="round"><line x1="8.5" y1="20.5" x2="23.5" y2="26.5"/><line x1="23.5" y1="20.5" x2="8.5" y2="26.5"/></g><path d="M16 5.6c-4.9 0-8 3.2-8 7.3 0 2.5 1.1 4.2 2.9 5.2v2.6h10.2v-2.6c1.8-1 2.9-2.7 2.9-5.2 0-4.1-3.1-7.3-8-7.3z" fill="#fff"/><circle cx="12.7" cy="13.3" r="2" fill="#c8102e"/><circle cx="19.3" cy="13.3" r="2" fill="#c8102e"/><path d="M16 15.6l-1.2 2.1h2.4z" fill="#c8102e"/></svg>';
const PATH = '<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#111" stroke="#fff" stroke-width="2"/><path d="M6.5 23.5L15 8l5 9 2.5-3.5 3.5 9.5" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M12.5 14c1.5 2.5 1 5-1 7.5M17 18c.8 1.6.5 3.4-.6 5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
function pinIcon(kind, cls) {
  return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17],
    html: '<div class="pin ' + cls + '" style="position:relative">' + (kind === 'recent' ? SKULL : PATH) + (/unverified/.test(cls) ? '<span class="pin-ring"></span>' : '') + '</div>' });
}

function trustOf(p) {
  if (p.source === 'jan') return { level: 'official', label: 'JAN record' };
  if (p.source === 'demo') return { level: 'demo', label: 'Demo' };
  const v = Object.entries(p.verifications || {}).filter(([d]) => d !== p.deviceId).map(([, x]) => x);
  const c = v.filter(x => x.v === 'confirm').length, d = v.filter(x => x.v === 'dispute').length;
  if (d >= 1 && d >= c) return { level: 'disputed', label: 'Disputed (' + c + '✓ ' + d + '✗)', c, d };
  if (c >= 3) return { level: 'trusted', label: 'Trusted · ' + c + ' confirmed', c, d };
  if (c >= 1) return { level: 'confirmed', label: 'Confirmed by ' + c, c, d };
  return { level: 'unverified', label: 'Unverified', c, d };
}

// All pins the map knows about: rider pins, JAN slide paths, JAN recent avalanches from the bulletin.
function allPins() {
  const out = [];
  state.pins.forEach(p => out.push(p));
  state.slides.forEach(s => {
    const loc = s.lat != null ? [s.lat, s.lon] : (state.geo[s.id] || state.placed[s.id]);
    if (!loc) return;
    out.push({ id: s.id, kind: 'path', source: 'jan', lat: loc[0], lon: loc[1], area: s.area, name: s.name, nameJa: s.nameJa,
      incidents: s.incidents, type: s.type, aspect: s.aspect, locNote: s.lat != null ? 'Located from GSI place names' : state.geo[s.id] ? 'Located automatically from the GSI place name (approximate)' : 'Placed by you (approximate)' });
  });
  new Set(state.areas.map(a => a.region).filter(Boolean)).forEach(reg => {
    const b = regionBulletin(reg);
    ((b && b.recentAvalanches) || []).forEach(r => {
      if (r.lat == null) return;
      const a = areaFor(r.lat, r.lon);
      out.push(Object.assign({}, r, { kind: 'recent', source: b.isDemo ? 'demo' : 'jan', sourceLabel: r.source || 'JAN bulletin', area: a ? a.id : '' }));
    });
  });
  return out;
}
function renderPins() {
  pinLayer.clearLayers();
  allPins().forEach(p => {
    if (p.kind === 'recent' && !state.show.recent) return;
    if (p.kind === 'path' && !state.show.path) return;
    const t = trustOf(p);
    let cls = t.level;
    if (p.kind === 'recent' && p.source !== 'demo') {
      const age = daysAgo(p.date);
      if (age > state.recentDays) return;
      if (age > 3) cls += ' old';
    }
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.kind, cls), keyboard: true, title: p.kind === 'recent' ? 'Recent avalanche' : 'Known slide path', zIndexOffset: p.kind === 'recent' ? 600 : 500 });
    m.on('click', () => openPin(p.id));
    pinLayer.addLayer(m);
  });
}
function findPin(id) { return allPins().find(p => p.id === id); }

/* ------------------------------------------------------------------ POIs (OpenStreetMap via Overpass) */
const POI_GLYPH = { onsen: '♨', parking: 'P', hut: '▲', lift: '⇡', shop: '24', medical: '✚', police: '交' };
const POI_LABEL = { onsen: 'Onsen / hot spring', parking: 'Parking', hut: 'Mountain hut', lift: 'Lift station', shop: 'Convenience store', medical: 'Hospital / clinic', police: 'Police box (koban)' };
const POI_SHOW = { onsen: 'onsen', parking: 'parking', hut: 'hut', lift: 'hut', shop: 'shop', medical: 'shop', police: 'shop' };
function poiCategory(t) {
  if (t.natural === 'hot_spring' || t.amenity === 'public_bath' || t['bath:type'] === 'onsen' || t.leisure === 'onsen') return 'onsen';
  if (t.amenity === 'parking') return (t.access === 'private' || t.parking === 'underground') ? null : 'parking';
  if (t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut') return 'hut';
  if (t.aerialway === 'station') return 'lift';
  if (t.shop === 'convenience') return 'shop';
  if (t.amenity === 'hospital' || t.amenity === 'clinic') return 'medical';
  if (t.amenity === 'police') return 'police';
  return null;
}
async function loadPois(area) {
  const empty = { points: [], lines: [], labels: [] };
  if (!('caches' in window)) return empty;
  const r = await caches.match('/pois/' + area.id).catch(() => null);
  if (!r) return empty;
  try { const j = await r.json(); return Array.isArray(j) ? { points: j, lines: [] } : j; } catch (e) { return empty; }
}
function labelCategory(t) {
  if (t.landuse === 'winter_sports') return 'resort';
  if (t.natural === 'peak' || t.natural === 'volcano') return 'peak';
  if (t.natural === 'saddle') return 'saddle';
  if (t.natural === 'ridge') return 'ridge';
  if (t.natural === 'valley') return 'valley';
  if (t.natural === 'water') return 'water';
  if (t.place) return 'place';
  return null;
}
// When OpenStreetMap has no English name, say what the thing is from the Japanese ending.
const JA_WORDS = [['スキー場', 'ski area'], ['温泉', 'onsen'], ['尾根', 'ridge'], ['乗越', 'col'], ['峠', 'pass'], ['岳', 'peak'], ['峰', 'peak'], ['山', 'mountain'], ['沢', 'gully / creek'], ['谷', 'valley'], ['川', 'river'], ['池', 'pond'], ['湖', 'lake'], ['滝', 'waterfall'], ['平', 'flat'], ['原', 'plateau'], ['台', 'plateau'], ['頭', 'top / knoll']];
const LABEL_TYPE = { resort: 'Ski resort', peak: 'Peak', saddle: 'Pass / col', ridge: 'Ridge', valley: 'Valley', water: 'Lake / pond', place: 'Village' };
function englishFor(l) {
  if (l.en) return l.en;
  const w = JA_WORDS.find(([k]) => (l.ja || '').endsWith(k));
  return w ? w[1].charAt(0).toUpperCase() + w[1].slice(1) : LABEL_TYPE[l.c];
}
const LABEL_MINZ = { resort: 11, peak: 12, place: 12, saddle: 13, ridge: 13, valley: 13, water: 13 };
function nearestResort(labels, lat, lon) {
  let best = null, bd = 0.03;
  labels.forEach(l => { if (l.c !== 'resort') return; const d = Math.hypot(l.lat - lat, (l.lon - lon) * 0.8); if (d < bd) { bd = d; best = l; } });
  return best;
}
const RUN_COL = { novice: '#1f9d55', easy: '#1f9d55', intermediate: '#d42a2a', advanced: '#111', expert: '#111', freeride: '#111' };
async function renderPois() {
  poiLayer.clearLayers();
  if (!state.area || map.getZoom() < 11) return;
  const data = state._pois && state._pois.area === state.area.id ? state._pois.data : (state._pois = { area: state.area.id, data: await loadPois(state.area) }).data;
  const pois = data.points || [];
  const z = map.getZoom(); const vb = map.getBounds().pad(0.2);
  const labels = data.labels || [];
  if (state.show.labels) labels.forEach(l => {
    if (z < LABEL_MINZ[l.c] || !vb.contains([l.lat, l.lon])) return;
    const en = englishFor(l), showJa = l.ja && l.ja !== en;
    const html = '<div class="map-label lbl-' + l.c + '">' + (l.c === 'peak' ? '▲ ' : '') + '<b>' + esc(en) + '</b>' + (l.ele && l.c === 'peak' ? ' ' + l.ele + ' m' : '') + (showJa ? '<span class="ja">' + esc(l.ja) + '</span>' : '') + '</div>';
    poiLayer.addLayer(L.marker([l.lat, l.lon], { icon: L.divIcon({ className: 'label-wrap', iconSize: null, html }), interactive: false, keyboard: false, zIndexOffset: l.c === 'resort' ? 300 : 0 }));
  });
  // Lifts and runs (OpenStreetMap). Japanese colour convention: green easy, red intermediate, black advanced.
  if (state.show.lifts) (data.lines || []).forEach(l => {
    const isLift = l.c === 'lift';
    const pl = L.polyline(l.pts, isLift
      ? { renderer: lineRenderer, color: '#1b2430', weight: 2.5, opacity: .95 }
      : { renderer: lineRenderer, color: RUN_COL[l.diff] || '#6b7a89', weight: 3, opacity: .7, dashArray: l.diff ? null : '4 4' });
    const mid = l.pts[Math.floor(l.pts.length / 2)], resort = nearestResort(labels, mid[0], mid[1]);
    pl.bindPopup((resort ? '<span class="small muted">' + esc(englishFor(resort)) + (resort.ja && resort.ja !== englishFor(resort) ? ' · ' + esc(resort.ja) : '') + '</span><br>' : '') +
      '<b>' + esc(l.name || (isLift ? 'Lift' : 'Ski run')) + '</b>' + (l.ja && l.ja !== l.name ? '<br><span class="muted">' + esc(l.ja) + '</span>' : '') +
      '<br><span class="small muted">' + (isLift ? esc(l.kind.replace('_', ' ')) : 'Run' + (l.diff ? ' · ' + esc(l.diff) : '')) + ' · OpenStreetMap</span>');
    poiLayer.addLayer(pl);
  });
  if (z < 12) return;
  pois.forEach(p => {
    if (!state.show[POI_SHOW[p.c]]) return;
    if (p.c === 'parking' && z < 14) return;
    if (!vb.contains([p.lat, p.lon])) return;
    const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html: '<div class="poi ' + p.c + '">' + POI_GLYPH[p.c] + '</div>' }) });
    const nm = p.en || p.name;
    const html = '<b>' + esc(nm || POI_LABEL[p.c]) + '</b>' + (p.en && p.name && p.en !== p.name ? '<br><span class="muted">' + esc(p.name) + '</span>' : '') +
      '<br><span class="muted small">' + POI_LABEL[p.c] + (p.fee ? ' · fee: ' + esc(p.fee) : '') + (p.cap ? ' · ' + esc(p.cap) + ' spaces' : '') + '</span>' +
      (p.hours ? '<br><span class="small">Hours: ' + esc(p.hours) + '</span>' : '') +
      '<br><a class="small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lon + '">Directions</a>';
    m.bindPopup(html);
    poiLayer.addLayer(m);
  });
}

/* ------------------------------------------------------------------ area packs (offline) */
async function downloadPack(area, maxZ, onProgress) {
  if (!('caches' in window)) throw new Error('Offline saving needs the app opened from its https web address.');
  const cache = await caches.open('pack-' + area.id);
  const jobs = [];
  for (let z = 10; z <= maxZ; z++) tilesFor(area.bounds, z).forEach(t => jobs.push(tileUrl(GSI.std, ...t)));
  for (let z = 12; z <= 14; z++) tilesFor(area.bounds, z).forEach(t => jobs.push(tileUrl(GSI.dem, ...t)));
  let done = 0, bytes = 0, failed = 0; const total = jobs.length + 2;
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const url = jobs[i++];
      try {
        const hit = await cache.match(url);
        if (hit) { bytes += Number(hit.headers.get('content-length')) || 15000; }
        else {
          const r = await fetch(url, { mode: 'cors' });
          if (r.ok) { const b = await r.clone().blob(); bytes += b.size; await cache.put(url, r); }
          else if (r.status !== 404) failed++;
        }
      } catch (e) { failed++; }
      done++; onProgress(done / total, bytes);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed > jobs.length * 0.2) throw new Error('Lost connection part way. Tap Download again to finish; tiles already saved are kept.');

  // Onsens, parking, huts, lifts, konbini, medical, koban
  const s = area.bounds[0][0], w = area.bounds[0][1], n = area.bounds[1][0], e = area.bounds[1][1];
  const bb = s + ',' + w + ',' + n + ',' + e;
  const q = '[out:json][timeout:60];(' +
    'nwr["natural"="hot_spring"](' + bb + ');nwr["amenity"="public_bath"](' + bb + ');nwr["bath:type"="onsen"](' + bb + ');' +
    'nwr["amenity"="parking"](' + bb + ');nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](' + bb + ');' +
    'node["aerialway"="station"](' + bb + ');nwr["shop"="convenience"](' + bb + ');' +
    'nwr["amenity"~"^(hospital|clinic|police)$"](' + bb + ');' +
    // Names for the English label layer: resorts, peaks, passes, ridges, valleys, villages, lakes
    'nwr["landuse"="winter_sports"]["name"](' + bb + ');node["natural"~"^(peak|volcano|saddle)$"]["name"](' + bb + ');' +
    'way["natural"~"^(ridge|valley)$"]["name"](' + bb + ');node["place"~"^(town|village|hamlet|locality)$"]["name"](' + bb + ');' +
    'nwr["natural"="water"]["name"](' + bb + '););out center tags;' +
    '(way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow)$"](' + bb + ');' +
    'way["piste:type"="downhill"](' + bb + '););out geom tags;';
  try {
    const r = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (r.ok) {
      const j = await r.json();
      const list = [], lines = [], labels = [];
      (j.elements || []).forEach(el => {
        const t = el.tags || {};
        if (el.geometry && (t.aerialway || t['piste:type'])) {
          const pts = el.geometry.map(g => [+g.lat.toFixed(5), +g.lon.toFixed(5)]);
          if (pts.length > 1) lines.push({ c: t.aerialway ? 'lift' : 'run', kind: t.aerialway || '', name: t['name:en'] || t.name || t['piste:name'] || '', ja: t.name || '', diff: t['piste:difficulty'] || '', pts });
          return;
        }
        const lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat == null) return;
        const lc = labelCategory(t);
        if (lc) { labels.push({ c: lc, lat, lon, ja: t.name || '', en: t['name:en'] || t['name:ja-Latn'] || t['name:ja_rm'] || '', ele: parseInt(t.ele, 10) || null }); if (lc !== 'resort') return; }
        const c = poiCategory(t); if (!c) return;
        list.push({ c, lat, lon, name: t.name || '', en: t['name:en'] || '', fee: t.fee || '', hours: t.opening_hours || '', cap: t.capacity || '' });
      });
      const json = JSON.stringify({ points: list, lines, labels });
      await cache.put('/pois/' + area.id, new Response(json, { headers: { 'Content-Type': 'application/json' } }));
      bytes += json.length;
    }
  } catch (e) { /* POIs are a nice-to-have */ }
  done++; onProgress(done / total, bytes);

  // Locate known slide paths that only have a place name
  for (const sl of state.slides.filter(x => x.area === area.id && x.lat == null && x.geocode && !state.geo[x.id])) {
    try {
      const r = await fetch(GEOCODE + encodeURIComponent(sl.geocode));
      const j = await r.json();
      const hit = (j || []).map(f => f.geometry && f.geometry.coordinates).find(c => c && inBounds(c[1], c[0], area.bounds, 0.03));
      if (hit) state.geo[sl.id] = [hit[1], hit[0]];
    } catch (e) { /* leave unplaced */ }
  }
  store.set('geo', state.geo);
  done++; onProgress(1, bytes);
  state.packs[area.id] = { date: new Date().toISOString(), maxZ, bytes, tiles: jobs.length };
  store.set('packs', state.packs);
  state._pois = null;
}
async function deletePack(area) {
  await caches.delete('pack-' + area.id);
  delete state.packs[area.id]; store.set('packs', state.packs); state._pois = null;
}
function estimatePack(area, maxZ) {
  let n = 0; for (let z = 10; z <= maxZ; z++) n += tilesFor(area.bounds, z).length;
  let d = 0; for (let z = 12; z <= 14; z++) d += tilesFor(area.bounds, z).length;
  return n * 18000 + d * 60000;
}

/* ------------------------------------------------------------------ bulletins */
async function loadBulletins(force) {
  try {
    const r = await fetch('data/bulletins.json' + (force ? '?t=' + Date.now() : ''), { cache: force ? 'no-store' : 'default' });
    if (!r.ok) throw new Error();
    state.bulletins = await r.json();
    store.set('bulletinsCache', state.bulletins);
  } catch (e) {
    state.bulletins = state.bulletins || store.get('bulletinsCache', null);
    if (force) toast('No signal. Showing the last brief saved on this phone.');
  }
  updateChip(); redrawShading(); renderPins();
}
function updateChip() {
  const b = bulletinFor(state.area.id);
  const r = (b && b.ratings) || {};
  ['alp', 'tl', 'btl'].forEach(k => { const i = $('#chipBands i[data-b="' + k + '"]'); i.className = 'r' + (r[k] || 0); });
  let txt = 'Brief';
  if (b && b.isDemo) txt = 'DEMO';
  else if (!b) txt = 'No brief';
  else if (b.status === 'off-season') txt = 'Off season';
  else if (hasRatings(b)) { const top = Math.max(r.alp || 0, r.tl || 0, r.btl || 0); txt = RATING_NAMES[top] + ' · ' + fmtAgo(b.issued); }
  $('#chipText').textContent = txt;
}

/* ------------------------------------------------------------------ sheet */
function openSheet(title, html, opts = {}) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false; $('#sheet').classList.toggle('tall', !!opts.tall);
  $('#sheetBody').scrollTop = 0;
  state.view = opts.view || title;
}
function closeSheet() { $('#sheet').hidden = true; state.view = null; }
$('#sheetClose').addEventListener('click', closeSheet);
(function grip() { let y0 = null; const g = $('#sheetGrip'); g.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true }); g.addEventListener('touchend', e => { if (y0 != null && e.changedTouches[0].clientY - y0 > 60) closeSheet(); y0 = null; }); })();

function ratingPill(r) { return '<span class="band-pill r' + (r || 0) + '">' + RATING_NAMES[r || 0] + '</span>'; }

// JAN-style aspect/elevation rose: inner ring alpine, middle treeline, outer below treeline.
function roseSvg(zones) {
  const cx = 38, cy = 38, rings = [['alp', 0, 11], ['tl', 11, 22], ['btl', 22, 31]];
  let s = '<svg viewBox="0 0 76 76" role="img" aria-label="Aspect and elevation rose">';
  rings.forEach(([band, r0, r1]) => ASPECTS.forEach((asp, k) => {
    const a0 = (k * 45 - 22.5 - 90) * Math.PI / 180, a1 = (k * 45 + 22.5 - 90) * Math.PI / 180;
    const p = (r, a) => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
    const d = r0 === 0 ? 'M' + cx + ' ' + cy + 'L' + p(r1, a0) + 'A' + r1 + ' ' + r1 + ' 0 0 1 ' + p(r1, a1) + 'Z'
      : 'M' + p(r0, a0) + 'L' + p(r1, a0) + 'A' + r1 + ' ' + r1 + ' 0 0 1 ' + p(r1, a1) + 'L' + p(r0, a1) + 'A' + r0 + ' ' + r0 + ' 0 0 0 ' + p(r0, a0) + 'Z';
    const on = zones && zones[band] && zones[band].includes(asp);
    s += '<path class="rose-sector ' + (on ? 'rose-on' : 'rose-off') + '" d="' + d + '"/>';
  }));
  s += '<text class="rose-label" x="38" y="5.5" text-anchor="middle">N</text></svg>';
  return s;
}

function aspectRoseSvg() {
  const cx = 40, cy = 40, r = 30;
  let s = '<svg viewBox="0 0 80 80" width="80" height="80" role="img" aria-label="Aspect colours">';
  ASPECTS.forEach((asp, k) => {
    const a0 = (k * 45 - 22.5 - 90) * Math.PI / 180, a1 = (k * 45 + 22.5 - 90) * Math.PI / 180, am = (k * 45 - 90) * Math.PI / 180;
    const p = (rr, a) => (cx + rr * Math.cos(a)).toFixed(2) + ' ' + (cy + rr * Math.sin(a)).toFixed(2);
    const on = state.aspectSel.includes(asp);
    s += '<path d="M' + cx + ' ' + cy + 'L' + p(r, a0) + 'A' + r + ' ' + r + ' 0 0 1 ' + p(r, a1) + 'Z" fill="rgb(' + ASPECT_RGB[asp].join(',') + ')" fill-opacity="' + (on ? .9 : .15) + '" stroke="var(--surface)" stroke-width="1"/>';
    const [tx, ty] = p(r + 7, am).split(' ');
    s += '<text x="' + tx + '" y="' + (+ty + 2.5) + '" text-anchor="middle" class="rose-label">' + asp + '</text>';
  });
  return s + '</svg>';
}
function showBrief() {
  const a = state.area, b = bulletinFor(a.id), bands = bandsFor(a);
  let h = '';
  if (!b) {
    h += '<div class="card warn"><b>No brief saved on this phone yet.</b><span class="small">Open the app once with signal to fetch it.</span></div>';
  } else {
    if (b.isDemo) h += '<div class="card demo"><span class="badge demo">DEMO DAY</span><span class="small">Made-up danger ratings on top of a real JAN bulletin so you can see how the map behaves on a bad day. Not a forecast.</span></div>';
    h += '<div class="stack"><div class="spread"><p class="eyebrow">' + esc(a.name) + ' · ' + (b.status === 'off-season' ? 'Off season' : 'Issued ' + fmtDate(b.issued)) + '</p>' +
      '<button class="btn small ghost" id="refreshB">Refresh</button></div>';
    if (state.bulletins && state.bulletins.updated) h += '<p class="small muted" style="margin:0">Brief checked ' + fmtAgo(state.bulletins.updated) + '.' + ((Date.now() - Date.parse(b.issued)) / 36e5 > 36 && b.status !== 'off-season' && !b.isDemo ? ' <b class="err">This bulletin is more than a day and a half old.</b>' : '') + '</p>';
    h += '</div>';
    h += '<div class="ratings">' + ['alp', 'tl', 'btl'].map(k => {
      const range = k === 'alp' ? 'above ' + bands.alpMin + ' m' : k === 'tl' ? bands.tlMin + '–' + bands.alpMin + ' m' : 'below ' + bands.tlMin + ' m';
      return '<div class="rating-row"><span class="lbl">' + BAND_NAMES[k] + '<small>' + range + (a.bandsSource === 'estimate' && !state.bandOverrides[a.id] ? ' (estimate)' : '') + '</small></span>' + ratingPill(b.ratings && b.ratings[k]) + '</div>';
    }).join('') + '</div>';
    if (b.summary) h += '<p style="margin:0">' + esc(b.summary) + '</p>';
    if (b.problems && b.problems.length) {
      h += '<div class="stack"><p class="eyebrow">Avalanche problems</p>' + b.problems.map(p =>
        '<div class="problem">' + roseSvg(p.zones) + '<div><b>' + esc(p.type) + '</b><div class="small muted">' + esc(p.likelihood || '') + (p.size ? ' · size ' + esc(p.size) : '') + '</div>' + (p.note ? '<div class="small">' + esc(p.note) + '</div>' : '') + '</div></div>').join('') +
        '<p class="small muted" style="margin:0">Rose: inside ring alpine, middle treeline, outside below treeline. Orange = where the problem is.</p></div>';
    }
    const rec = (b.recentAvalanches || []);
    if (rec.length) {
      h += '<div class="stack"><p class="eyebrow">Recent avalanches in the report</p><div class="list">' + rec.map(r =>
        '<button class="list-item" data-pin="' + esc(r.id) + '"><span>' + SKULL.replace('width="34" height="34"', 'width="26" height="26"') + '</span><span><span class="t">' + esc(r.place || 'Location not given') + '</span><span class="s"><br>' +
        fmtDate(r.date) + ' · size ' + esc(r.size || '?') + ' · ' + esc(r.type || '') + (r.aspect ? ' · ' + esc(r.aspect) : '') + (r.elevation ? ' · ' + esc(r.elevation) + ' m' : '') + (r.lat == null ? ' · not on map (no location given)' : '') + '</span></span></button>').join('') + '</div></div>';
    }
  }
  // Riders' pins in this area
  const mine = state.pins.filter(p => p.area === a.id);
  const recent = mine.filter(p => p.kind === 'recent' && daysAgo(p.date) <= state.recentDays);
  h += '<div class="card"><p class="eyebrow" style="margin:0">Rider reports, ' + esc(a.name) + '</p><span>' + recent.length + ' recent slide' + (recent.length === 1 ? '' : 's') + ' in the last ' + state.recentDays + ' days · ' + mine.filter(p => p.kind === 'path').length + ' slide paths added by riders</span></div>';

  const unplaced = state.slides.filter(s => s.area === a.id && s.lat == null && !state.geo[s.id] && !state.placed[s.id]);
  if (unplaced.length) {
    h += '<div class="stack"><p class="eyebrow">Known slide paths not on the map yet</p><p class="small muted" style="margin:0">From JAN\'s incident database, which names the place but gives no coordinates. If you know where it is, place it.</p><div class="list">' +
      unplaced.map(s => '<div class="list-item" style="cursor:default"><span>' + PATH.replace('width="34" height="34"', 'width="26" height="26"') + '</span><span><span class="t">' + esc(s.name) + '</span> <span class="s">' + esc(s.nameJa) + '</span><br><span class="s">' +
        s.incidents.map(i => fmtDate(i.date) + ': ' + esc(i.summary)).join('<br>') + '</span><br><span class="row" style="margin-top:6px"><button class="btn small" data-place="' + s.id + '">Place on map</button><a class="small" href="' + esc(s.incidents[0].url) + '" target="_blank" rel="noopener">JAN record</a></span></span></div>').join('') + '</div></div>';
  }

  const reg = state.regions[a.region];
  h += '<div class="stack"><p class="eyebrow">Full bulletins · ' + esc(reg ? 'JAN ' + reg.name : 'no bulletin linked') + '</p>' +
    (a.regionNote ? '<p class="small muted" style="margin:0">' + esc(a.regionNote) + '</p>' : '') +
    (!reg ? '<p class="small muted" style="margin:0">This area has no bulletin region. Pick the nearest one in the Area menu → Edit.</p>' : '') +
    ((reg && reg.links) || []).map(l => '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + ' ↗</a>').join('') + (b && b.url ? '<a href="' + esc(b.url) + '" target="_blank" rel="noopener">The bulletin this brief came from ↗</a>' : '') + '</div>';
  if (state.bulletins && state.bulletins.demo && state.bulletins.demo[a.region]) h += '<button class="btn" id="demoToggle">' + (state.demo ? 'Back to the real brief' : 'Show demo day (bad conditions)') + '</button>';
  h += '<p class="small muted" style="margin:0">This brief summarises the bulletin. Read the full bulletin before you go, and make your own call on the snow you find. The map can\'t see wind loading, cornices or what fell overnight.</p>';
  openSheet('Avalanche brief', h, { view: 'brief', tall: true });

  const rb = $('#refreshB'); if (rb) rb.onclick = async () => { rb.disabled = true; await loadBulletins(true); showBrief(); };
  const dt = $('#demoToggle'); if (dt) dt.onclick = () => { state.demo = !state.demo; store.set('demo', state.demo); updateChip(); redrawShading(); renderPins(); showBrief(); };
  $('#sheetBody').querySelectorAll('[data-pin]').forEach(el => el.onclick = () => { const p = findPin(el.dataset.pin); if (p) { closeSheet(); map.setView([p.lat, p.lon], 15); openPin(p.id); } });
  $('#sheetBody').querySelectorAll('[data-place]').forEach(el => el.onclick = () => startPlacing({ placeSlide: el.dataset.place }));
}

/* ------------------------------------------------------------------ layers */
function showLayers() {
  const eff = effectiveShade();
  const b = bulletinFor(state.area.id);
  const seg = (name, cur, opts) => '<div class="seg" data-seg="' + name + '">' + opts.map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  const tog = (k, l) => '<label class="row"><input type="checkbox" data-show="' + k + '"' + (state.show[k] ? ' checked' : '') + '> ' + l + '</label>';
  let h = '<div class="field"><span class="lbl">Map</span>' + seg('base', state.base, [['sat', 'Latest satellite'], ['topo', 'Topo']]);
  if (state.base === 'sat') {
    if (!satId()) h += '<div class="card warn small"><b>One-off setup needed.</b><span>Sentinel-2 images come from the EU\'s free Copernicus service and need a free account. Settings → Latest satellite has the steps.</span><button class="btn small" id="goSatSetup">Set it up</button></div>';
    else if (sat.err) h += '<div class="card warn small">' + esc(sat.err) + '</div>';
    else {
      h += '<span class="help">Sentinel-2, 10 m pixels. Shows snow cover, ridgelines, forest edges and big debris; not tracks or cornices. Needs signal; with no signal the topo shows instead. Cloud % is for the whole 100 km scene, so check your valley and step back a pass if it\'s clouded.</span>';
      if (sat.dates.length) h += '<div class="chips" data-chips="satdate">' + sat.dates.slice(0, 10).map(x => '<button type="button" data-v="' + x.d + '" class="' + (x.d === sat.date ? 'on' : '') + '">' + new Date(x.d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + Math.round(x.cc) + '%</button>').join('') + '</div>';
      else h += '<span class="help">Couldn\'t list the passes, so it\'s showing the newest image under 20% cloud from the last 90 days.</span>';
    }
  }
  h += '</div>';
  h += '<div class="field"><span class="lbl">Shading</span>' + seg('shade', state.shade, [['danger', 'Today\'s danger'], ['slope', 'Slope angle'], ['off', 'Off']]) + '</div>';
  if (state.shade === 'danger' && eff !== 'danger') h += '<div class="card warn small">No danger rating for ' + esc(state.area.name) + ' right now' + (b && b.status === 'off-season' ? ' (off season)' : '') + ', so the map is showing slope angles instead.</div>';
  const aspectHtml = (() => {
    let a = '<div class="field"><span class="lbl">Aspect overlay</span>' + '<div class="seg" id="aspOnSeg"><button type="button" data-v="on" class="' + (state.aspectOn ? 'on' : '') + '">On</button><button type="button" data-v="off" class="' + (state.aspectOn ? '' : 'on') + '">Off</button></div><span class="help">Works on its own or on top of the shading above. Also the compass button on the map.</span></div>';
    if (!state.aspectOn) return a;
    const matching = aspectMatchActive();
    return a + '<div class="aspect-legend">' + aspectRoseSvg() + '<div class="stack small">' +
      '<span>Slopes 20° and steeper, coloured by the way they face. Stronger colour from 30°.</span>' +
      '<label class="row"><input type="checkbox" id="aspMatch"' + (state.aspectMatch ? ' checked' : '') + '> Match today\'s report</label>' +
      '<span class="muted">' + (matching ? 'Strong = aspect and height the report flags. Faint = not flagged. Pick lines in the faint colours.' : state.aspectMatch ? 'No avalanche problems in the report right now, so every aspect shows the same.' : 'Showing every aspect the same.') + '</span></div></div>' +
      '<div class="field"><span class="lbl">Show these aspects</span><div class="chips aspects" id="aspChips">' + ASPECTS.map(a => '<button type="button" data-v="' + a + '" class="' + (state.aspectSel.includes(a) ? 'on' : '') + '" style="border-left:6px solid rgb(' + ASPECT_RGB[a].join(',') + ')">' + a + '</button>').join('') + '</div><span class="help">Tap to hide an aspect, e.g. show only north-facing to find cold snow.</span></div>';
  })();
  if (eff === 'danger') h += '<div class="legend"><span><span class="sw" style="background:rgba(214,18,36,.6)"></span><b>Red: stay off.</b> Steep slopes the bulletin rates dangerous for their height and aspect.</span><span><span class="sw" style="background:rgba(247,148,30,.45)"></span><b>Amber: only with good reason</b>, one at a time, and a way out.</span><span class="muted">Ground below the shading (gullies, runouts) can still be hit by slides from above.</span></div>';
  else if (eff === 'slope') h += '<div class="legend"><span><span class="sw" style="background:rgb(250,225,0)"></span>27–29°</span><span><span class="sw" style="background:rgb(247,148,30)"></span>30–34°</span><span><span class="sw" style="background:rgb(226,32,40)"></span>35–39°</span><span><span class="sw" style="background:rgb(140,40,170)"></span>40–44°</span><span><span class="sw" style="background:rgb(40,30,50)"></span>45° and steeper</span><span class="muted">Most slab avalanches start on 30–45° slopes.</span></div>';
  h += aspectHtml;
  h += '<div class="field"><span class="lbl">Show</span>' + tog('recent', 'Recent avalanches (red skulls)') + tog('path', 'Known slide paths (black pins)') + tog('onsen', '♨ Onsens') + tog('parking', 'Parking (zoom in to see)') + tog('labels', 'English place names and ski resorts') + tog('lifts', 'Lifts and ski runs') + tog('hut', 'Huts and lift stations') + tog('shop', 'Konbini, medical, koban') + '</div>';
  h += '<details class="glossary"><summary>Japanese map words</summary><p class="small muted">The topo map\'s own text is Japanese and can\'t be translated in place. These endings tell you what a name is.</p><dl class="kv small">' +
    [['岳 / 山 / 峰', 'dake / yama / mine: peak, mountain'], ['尾根', 'one: ridge'], ['沢', 'sawa: gully, creek'], ['谷', 'tani / dani: valley'], ['峠 / 乗越', 'tōge / nokkoshi: pass, col'], ['頭', 'atama / kashira: knoll, top'], ['平 / 原', 'taira / hara: flat, plateau'], ['池 / 湖', 'ike / ko: pond, lake'], ['滝', 'taki: waterfall'], ['川', 'kawa / gawa: river'], ['温泉', 'onsen: hot spring'], ['小屋', 'koya: hut'], ['登山口', 'tozanguchi: trailhead'], ['駐車場', 'chūshajō: parking'], ['スキー場', 'sukījō: ski area'], ['ゲート', 'gēto: backcountry gate'], ['雪崩', 'nadare: avalanche'], ['立入禁止', 'tachiiri kinshi: no entry']]
      .map(([j, e]) => '<dt lang="ja">' + j + '</dt><dd>' + e + '</dd>').join('') + '</dl></details>';
  openSheet('Layers', h, { view: 'layers', tall: true });
  const gs = $('#goSatSetup'); if (gs) gs.onclick = showSettings;
  $('#aspOnSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setAspect(b.dataset.v === 'on'); showLayers(); });
  const am = $('#aspMatch'); if (am) am.onchange = () => { state.aspectMatch = am.checked; store.set('aspectMatch', am.checked); redrawShading(); showLayers(); };
  const ac = $('#aspChips'); if (ac) ac.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return; const a = b.dataset.v;
    state.aspectSel = state.aspectSel.includes(a) ? state.aspectSel.filter(x => x !== a) : state.aspectSel.concat(a);
    store.set('aspectSel', state.aspectSel); b.classList.toggle('on'); redrawShading();
  });
  const sd = $('#sheetBody [data-chips="satdate"]');
  if (sd) sd.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; sat.date = b.dataset.v; buildSatLayer(); showLayers(); });
  $('#sheetBody').querySelectorAll('[data-seg] button').forEach(btn => btn.onclick = () => {
    const k = btn.parentElement.dataset.seg; state[k] = btn.dataset.v; store.set(k, state[k]);
    if (k === 'base') Promise.resolve(setBase()).then(() => { if (state.view === 'layers') showLayers(); });
    else redrawShading();
    showLayers();
  });
  $('#sheetBody').querySelectorAll('[data-show]').forEach(cb => cb.onchange = () => { state.show[cb.dataset.show] = cb.checked; store.set('show', state.show); renderPins(); renderPois(); });
}

function setAspect(on) {
  state.aspectOn = on; store.set('aspectOn', on);
  $('#aspectBtn').classList.toggle('on', on); $('#aspectBtn').setAttribute('aria-pressed', on);
  redrawShading();
}
$('#aspectBtn').addEventListener('click', () => { setAspect(!state.aspectOn); toast(state.aspectOn ? 'Aspect overlay on' : 'Aspect overlay off', 1400); if (state.view === 'layers') showLayers(); });

/* ------------------------------------------------------------------ areas */
function showAreaPicker() {
  const item = a => {
    const p = state.packs[a.id];
    return '<div class="list-item" style="grid-template-columns:1fr auto;cursor:default"><button class="linkish" data-area="' + a.id + '"><span class="t">' + esc(a.name) + ' <span class="muted">' + esc(a.nameJa || '') + '</span></span><br><span class="s">' +
      (p ? 'Offline ready · ' + fmtBytes(p.bytes) : 'Not downloaded') + ' · bulletin: ' + esc(regionName(a.region)) + (a.boxCheck ? ' · <b>box approximate, check it</b>' : '') + '</span></button>' +
      '<span class="stack" style="justify-items:end">' + (state.area.id === a.id ? '<span class="badge official">Current</span>' : '') +
      '<button class="btn small ghost" data-box="' + a.id + '">Adjust box</button>' + (a.custom ? '<button class="btn small ghost" data-edit="' + a.id + '">Edit</button>' : '') + '</span></div>';
  };
  const mine = state.areas.filter(a => a.custom), built = state.areas.filter(a => !a.custom);
  const h = '<div class="list">' + built.map(item).join('') + '</div>' +
    (mine.length ? '<div class="stack"><p class="eyebrow">Your areas</p><div class="list">' + mine.map(item).join('') + '</div></div>' : '') +
    '<div class="card"><b>Riding somewhere else?</b><span class="small muted">Frame it on the map and save it as your own area. It gets the same offline download, shading and pins. Share it with mates in your pins file.</span><button class="btn primary" id="addArea">Add your own area</button></div>' +
    '<button class="btn" id="goPacks">Manage downloads</button>';
  openSheet('Where are you riding?', h, { view: 'areas', tall: true });
  const body = $('#sheetBody');
  body.querySelectorAll('[data-area]').forEach(el => el.onclick = () => { setArea(el.dataset.area, true); closeSheet(); });
  body.querySelectorAll('[data-box]').forEach(el => el.onclick = () => { const a = state.areas.find(x => x.id === el.dataset.box); setArea(a.id, false); map.fitBounds(a.bounds); startBox({ areaId: a.id }); });
  body.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => areaForm(state.customAreas.find(x => x.id === el.dataset.edit)));
  $('#addArea').onclick = () => startBox({});
  $('#goPacks').onclick = showPacks;
}
function setArea(id, fly) {
  const a = state.areas.find(x => x.id === id) || state.areas[0];
  const changed = !state.area || state.area.id !== a.id;
  state.area = a; store.set('area', a.id);
  $('#areaName').textContent = a.name; $('#areaNameJa').textContent = a.nameJa || '';
  if (fly) map.fitBounds(a.bounds, { padding: [10, 10] });
  updateChip(); updateNativeZoom(); redrawShading(); state._pois = null; renderPois(); drawOutline();
  if (changed && state.base === 'sat') { sat.loadedFor = null; ensureSat(); }
}

/* ---------- drawing an area box ---------- */
let boxing = null;
function frameBounds() {
  const r = $('#boxFrame').getBoundingClientRect(), m = $('#map').getBoundingClientRect();
  const sw = map.containerPointToLatLng([r.left - m.left, r.bottom - m.top]), ne = map.containerPointToLatLng([r.right - m.left, r.top - m.top]);
  return [[+sw.lat.toFixed(4), +sw.lng.toFixed(4)], [+ne.lat.toFixed(4), +ne.lng.toFixed(4)]];
}
function updateBoxInfo() {
  if (!boxing) return;
  const b = frameBounds(), fake = { bounds: b };
  const std = estimatePack(fake, 15), det = estimatePack(fake, 16);
  const tooBig = std > 150e6 || map.getZoom() < 10;
  $('#boxInfo').innerHTML = tooBig ? '<span class="err">Too big to download. Zoom in to frame just where you\'ll ride.</span>' : 'Download about ' + fmtBytes(std) + ' standard, ' + fmtBytes(det) + ' detailed.';
  $('#boxOk').disabled = tooBig;
}
function startBox(opts) {
  closeSheet(); boxing = opts;
  $('#boxBar').hidden = false; $('.fabs').hidden = true; $('#readout').hidden = true;
  $('#boxTitle').textContent = opts.areaId ? 'Pan and zoom so the box covers the riding area' : 'Frame the area you\'ll ride, then save it';
  map.on('move', updateBoxInfo); updateBoxInfo();
}
function stopBox() { map.off('move', updateBoxInfo); boxing = null; $('#boxBar').hidden = true; $('.fabs').hidden = false; if (watchId != null) $('#readout').hidden = false; }
$('#boxCancel').addEventListener('click', stopBox);
$('#boxOk').addEventListener('click', () => {
  const b = frameBounds(), o = boxing; stopBox();
  if (o.areaId) {
    const ca = state.customAreas.find(x => x.id === o.areaId);
    if (ca) { ca.bounds = b; ca.center = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]; store.set('customAreas', state.customAreas); }
    else { state.boundsOverrides[o.areaId] = b; store.set('boundsOverrides', state.boundsOverrides); }
    rebuildAreas(); setArea(o.areaId, false);
    toast(state.packs[o.areaId] ? 'Box saved. Update the download to cover the new box.' : 'Box saved');
    return;
  }
  areaForm(null, b);
});

function areaForm(existing, bounds) {
  const a = existing || { name: '', region: '', bands: { alpMin: 1800, tlMin: 1400 } };
  const regs = Object.entries(state.regions);
  // Suggest the bulletin region of the nearest built-in area.
  if (!existing && bounds) {
    const c = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]; let best = null, bd = Infinity;
    state.builtinAreas.forEach(x => { const d = Math.hypot(x.center[0] - c[0], x.center[1] - c[1]); if (d < bd) { bd = d; best = x; } });
    if (best && bd < 0.6) { a.region = best.region; a.bands = Object.assign({}, best.bands); }
  }
  let h = '<div class="field"><label for="a-name">Name</label><input type="text" id="a-name" maxlength="40" value="' + esc(a.name) + '" placeholder="e.g. Nozawa Onsen"></div>' +
    '<div class="field"><label for="a-reg">Which JAN bulletin covers it?</label><select id="a-reg"><option value="">None (slope shading only)</option>' +
    regs.map(([k, r]) => '<option value="' + k + '"' + (a.region === k ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</select><span class="help">Pick the nearest. The danger shading uses its ratings.</span></div>' +
    '<div class="grid3"><div class="field"><label for="a-alp">Alpine from m</label><input type="number" id="a-alp" value="' + a.bands.alpMin + '"></div><div class="field"><label for="a-tl">Treeline from m</label><input type="number" id="a-tl" value="' + a.bands.tlMin + '"></div><div></div></div>' +
    '<div id="aErr" class="err" hidden></div><div class="btn-row">' + (existing ? '<button class="btn" id="aDel">Delete area</button>' : '') + '<button class="btn primary" id="aSave">' + (existing ? 'Save' : 'Save area') + '</button></div>';
  openSheet(existing ? 'Edit ' + a.name : 'New area', h, { view: 'areaform' });
  $('#aSave').onclick = () => {
    const name = $('#a-name').value.trim(), alp = Number($('#a-alp').value), tl = Number($('#a-tl').value);
    const err = $('#aErr');
    if (!name) { err.textContent = 'Give it a name.'; err.hidden = false; return; }
    if (!(alp > tl && tl > 0)) { err.textContent = 'Alpine has to start higher than treeline.'; err.hidden = false; return; }
    const rec = existing || { id: 'u-' + uid(), bounds, center: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2], zoom: Math.min(map.getZoom(), 13) };
    Object.assign(rec, { name, nameJa: '', region: $('#a-reg').value, bands: { alpMin: alp, tlMin: tl } });
    if (!existing) state.customAreas.push(rec);
    store.set('customAreas', state.customAreas); rebuildAreas(); setArea(rec.id, !existing); closeSheet();
    toast(existing ? 'Area saved' : name + ' added. Download it from the download button when you\'re on Wi-Fi.');
  };
  const del = $('#aDel'); if (del) del.onclick = async () => {
    if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; del.classList.add('danger'); return; }
    await deletePack(a).catch(() => { });
    state.customAreas = state.customAreas.filter(x => x.id !== a.id); store.set('customAreas', state.customAreas);
    rebuildAreas(); setArea(state.areas[0].id, true); closeSheet(); toast('Area deleted');
  };
}


async function showPacks() {
  let est = '';
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); est = 'Using ' + fmtBytes(e.usage || 0) + ' on this phone.'; } } catch (e) { }
  const h = '<p class="small muted" style="margin:0">Download only where you\'re riding. Each pack holds the GSI topo map, elevation data for slope shading, lifts and runs, onsens, parking and the known slide paths. ' + est + '</p>' +
    state.areas.map(a => {
      const p = state.packs[a.id];
      return '<div class="card" data-pack="' + a.id + '"><div class="spread"><b>' + esc(a.name) + ' <span class="muted">' + esc(a.nameJa || '') + '</span></b>' + (p ? '<span class="badge trusted">Offline ready</span>' : '<span class="badge unverified">Not saved</span>') + '</div>' +
        (p ? '<span class="small muted">' + fmtBytes(p.bytes) + ' · detail to zoom ' + p.maxZ + ' · saved ' + fmtDate(p.date) + '</span>' : '') +
        (a.boxCheck ? '<span class="small warn-text">Box is approximate. Check it with Adjust box in the area menu first.</span>' : '') +
        '<div class="seg" data-detail><button type="button" data-v="15" class="on">Standard ~' + fmtBytes(estimatePack(a, 15)) + '</button><button type="button" data-v="16">Detailed ~' + fmtBytes(estimatePack(a, 16)) + '</button></div>' +
        '<div class="progress" hidden><i></i></div><span class="small muted prog-text" hidden></span>' +
        '<div class="btn-row"><button class="btn primary" data-dl>' + (p ? 'Update' : 'Download') + '</button>' + (p ? '<button class="btn" data-del>Delete</button>' : '') + '</div></div>';
    }).join('') + '<p class="small muted" style="margin:0">Use Wi-Fi. Standard is fine for planning; Detailed shows every contour and track up close.</p>';
  openSheet('Offline areas', h, { view: 'packs', tall: true });
  $('#sheetBody').querySelectorAll('[data-pack]').forEach(card => {
    const a = state.areas.find(x => x.id === card.dataset.pack);
    card.querySelectorAll('[data-detail] button').forEach(b => b.onclick = () => { card.querySelectorAll('[data-detail] button').forEach(x => x.classList.toggle('on', x === b)); });
    card.querySelector('[data-dl]').onclick = async (ev) => {
      if (!navigator.onLine) { toast('You need signal (ideally Wi-Fi) to download.'); return; }
      const btn = ev.currentTarget; btn.disabled = true;
      const maxZ = Number(card.querySelector('[data-detail] .on').dataset.v);
      const bar = card.querySelector('.progress'), txt = card.querySelector('.prog-text'); bar.hidden = false; txt.hidden = false;
      try {
        await downloadPack(a, maxZ, (f, bytes) => { bar.firstElementChild.style.width = (f * 100).toFixed(0) + '%'; txt.textContent = (f * 100).toFixed(0) + '% · ' + fmtBytes(bytes); });
        toast(a.name + ' saved for offline');
        renderPins(); renderPois(); showPacks();
      } catch (e) { txt.textContent = e.message || 'Download failed. Try again on Wi-Fi.'; btn.disabled = false; }
    };
    const del = card.querySelector('[data-del]');
    if (del) del.onclick = () => {
      if (del.dataset.armed) { deletePack(a).then(() => { toast(a.name + ' deleted'); showPacks(); renderPois(); }); }
      else { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; del.classList.add('danger'); }
    };
  });
}

/* ------------------------------------------------------------------ locate */
let watchId = null, meMarker = null, meCircle = null, firstFix = true;
$('#locateBtn').addEventListener('click', () => {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; meLayer.clearLayers(); $('#locateBtn').classList.remove('on'); $('#readout').hidden = true; return; }
  if (!navigator.geolocation) { toast('This phone can\'t share its position with the app'); return; }
  $('#locateBtn').classList.add('on'); firstFix = true;
  watchId = navigator.geolocation.watchPosition(onFix, err => { toast(err.code === 1 ? 'Location is blocked. Allow it for this site in your phone settings.' : 'Waiting for GPS…'); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
});
async function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  state.me = [lat, lon];
  if (!meMarker) {
    meMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="me-dot"></div>' }), interactive: false });
    meCircle = L.circle([lat, lon], { radius: accuracy, color: '#2b7fd0', weight: 1, fillOpacity: .08, interactive: false });
    meLayer.addLayer(meCircle); meLayer.addLayer(meMarker);
  } else { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]).setRadius(accuracy); }
  if (firstFix) { firstFix = false; map.setView([lat, lon], Math.max(map.getZoom(), 15)); const a = areaFor(lat, lon); if (a && a.id !== state.area.id) setArea(a.id); }
  const t = await terrainAt(lat, lon);
  const el = $('#readout');
  if (!t) { el.innerHTML = '±' + Math.round(accuracy) + ' m · no elevation data here'; el.hidden = false; return; }
  const band = bandOf(state.area, t.elev); const b = bulletinFor(state.area.id); const r = b && b.ratings ? b.ratings[band] : 0;
  el.innerHTML = '<b>' + t.elev.toLocaleString() + ' m</b> · ' + (t.slope != null ? t.slope + '° ' + (t.aspect || '') : '') + '<br>' + BAND_NAMES[band] + (r ? ' ' + ratingPill(r) : '') + ' <span class="muted">±' + Math.round(accuracy) + ' m</span>';
  el.hidden = false;
}

/* ------------------------------------------------------------------ placing pins */
let placing = null;
function startPlacing(opts = {}) {
  closeSheet(); placing = Object.assign({ kind: 'recent' }, opts);
  $('#placeBar').hidden = false; $('.fabs').hidden = true; $('#readout').hidden = true;
  $('#placeKind').hidden = !!opts.placeSlide || !!opts.movePin;
  $('#placeTitle').textContent = opts.placeSlide ? 'Put the cross on ' + (state.slides.find(s => s.id === opts.placeSlide) || {}).name : opts.movePin ? 'Move the cross to the right spot' : 'Move the map to put the cross where the slide started';
  $('#placeKind').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === placing.kind));
  if (map.getZoom() < 14) map.setZoom(14);
}
function stopPlacing() { placing = null; $('#placeBar').hidden = true; $('.fabs').hidden = false; if (watchId != null) $('#readout').hidden = false; }
$('#placeKind').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; placing.kind = b.dataset.v; $('#placeKind').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
$('#placeCancel').addEventListener('click', stopPlacing);
$('#placeOk').addEventListener('click', () => {
  const c = map.getCenter(); const p = placing; stopPlacing();
  if (p.placeSlide) { state.placed[p.placeSlide] = [c.lat, c.lng]; store.set('placed', state.placed); renderPins(); toast('Placed. Marked as approximate.'); return; }
  if (p.movePin) { const pin = state.pins.find(x => x.id === p.movePin); if (pin) { pin.lat = c.lat; pin.lon = c.lng; pin.updatedAt = new Date().toISOString(); savePins(); renderPins(); openPin(pin.id); } return; }
  pinForm(p.kind, c.lat, c.lng);
});
$('#addBtn').addEventListener('click', () => startPlacing());
map.on('contextmenu', e => { pinForm('recent', e.latlng.lat, e.latlng.lng); }); // long-press on phones

/* ------------------------------------------------------------------ pin form */
function chips(name, options, value, extraCls = '') {
  return '<div class="chips ' + extraCls + '" data-chips="' + name + '">' + options.map(o => { const v = Array.isArray(o) ? o[0] : o; return '<button type="button" data-v="' + esc(v) + '" class="' + (String(value) === String(v) ? 'on' : '') + '">' + esc(v) + '</button>'; }).join('') + '</div>';
}
function savePins() { store.set('pins', state.pins); }
function reporterName() { return store.get('reporterName', ''); }

async function pinForm(kind, lat, lon, existing) {
  const p = existing ? Object.assign({}, existing) : { id: 'p-' + uid(), kind, lat, lon, date: today(), deviceId, reporter: reporterName(), source: 'user', verifications: {} };
  kind = p.kind;
  const area = areaFor(p.lat, p.lon) || state.area; p.area = area.id;
  const isRecent = kind === 'recent';
  let h = '<div class="seg" id="kindSeg"><button type="button" data-v="recent" class="' + (isRecent ? 'on' : '') + '">Recent slide</button><button type="button" data-v="path" class="' + (!isRecent ? 'on' : '') + '">Known slide path</button></div>';
  h += '<div id="terrainLine" class="small muted">Reading the terrain at the pin…</div>';
  if (!isRecent) h += '<div class="field"><label for="f-name">Name of the slope or gully <span class="muted">(optional)</span></label><input type="text" id="f-name" value="' + esc(p.name || '') + '" maxlength="80"></div>';
  if (isRecent) h += '<div class="field"><label for="f-date">When did it run?</label><input type="date" id="f-date" value="' + esc(p.date || today()) + '" max="' + today() + '"></div>';
  h += '<div class="field"><span class="lbl">' + (isRecent ? 'Size' : 'Typical size') + '</span>' + chips('size', SIZES, p.size) + '<span class="help" id="sizeHelp">' + esc((SIZES.find(s => s[0] === String(p.size)) || ['', 'Size 1 to 5, same scale JAN uses. Half sizes if it\'s in between.'])[1]) + '</span></div>';
  h += '<div class="field"><span class="lbl">' + (isRecent ? 'Type of avalanche' : 'Usual type') + '</span>' + chips('type', TYPES, p.type) + '</div>';
  if (isRecent) h += '<div class="field"><span class="lbl">What set it off?</span>' + chips('trigger', TRIGGERS, p.trigger) + '</div>';
  h += '<div class="field"><span class="lbl">Aspect (way the slope faces) <span class="auto-tag" id="aspAuto"></span></span>' + chips('aspect', ASPECTS, p.aspect, 'aspects') + '</div>';
  h += '<div class="grid3"><div class="field"><label for="f-elev">Start elevation m</label><input type="number" id="f-elev" inputmode="numeric" value="' + esc(p.elevation || '') + '"></div>' +
    '<div class="field"><label for="f-slope">Slope °</label><input type="number" id="f-slope" inputmode="numeric" value="' + esc(p.slope || '') + '"></div>' +
    (isRecent ? '<div class="field"><label for="f-crown">Crown depth cm</label><input type="number" id="f-crown" inputmode="numeric" value="' + esc(p.crown || '') + '"></div>' : '<div></div>') + '</div>';
  if (isRecent) {
    h += '<div class="grid3"><div class="field"><label for="f-width">Width m</label><input type="number" id="f-width" inputmode="numeric" value="' + esc(p.width || '') + '"></div><div class="field"><label for="f-run">Ran m</label><input type="number" id="f-run" inputmode="numeric" value="' + esc(p.run || '') + '"></div><div></div></div>';
    h += '<div class="field"><span class="lbl">Bed surface / weak layer</span>' + chips('bed', BED, p.bed) + '</div>';
    h += '<div class="field"><span class="lbl">Anyone caught?</span>' + chips('involve', INVOLVE, p.involve) + '</div>';
    h += '<div class="grid3"><div class="field"><label for="f-inj">Injured</label><input type="number" id="f-inj" min="0" inputmode="numeric" value="' + esc(p.injured || 0) + '"></div><div class="field"><label for="f-kill">Killed</label><input type="number" id="f-kill" min="0" inputmode="numeric" value="' + esc(p.killed || 0) + '"></div><div></div></div>';
    h += '<div class="field"><span class="lbl">How do you know?</span>' + chips('how', HOW_RECENT, p.how) + '</div>';
  } else {
    h += '<div class="field"><span class="lbl">How often does it run?</span>' + chips('freq', FREQ, p.freq) + '</div>';
    h += '<div class="field"><span class="lbl">When in the season?</span>' + chips('when', WHEN, p.when) + '</div>';
    h += '<div class="field"><span class="lbl">How do you know?</span>' + chips('how', HOW_PATH, p.how) + '</div>';
  }
  h += '<div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" maxlength="1000" placeholder="' + (isRecent ? 'Crown location, debris, what the snowpack showed…' : 'Where it starts, where debris ends up, safe line around it…') + '">' + esc(p.notes || '') + '</textarea></div>';
  h += '<div class="field"><label for="f-rep">Your name</label><input type="text" id="f-rep" maxlength="40" value="' + esc(p.reporter || reporterName()) + '" placeholder="Shown to riders you share pins with"></div>';
  h += '<div id="formErr" class="err" hidden></div><div class="btn-row"><button class="btn" id="fCancel">Cancel</button><button class="btn primary" id="fSave">' + (existing ? 'Save changes' : 'Save pin') + '</button></div>';
  openSheet(existing ? 'Edit pin' : (isRecent ? 'Report a recent slide' : 'Add a known slide path'), h, { view: 'form', tall: true });

  const body = $('#sheetBody');
  body.querySelectorAll('[data-chips]').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const was = b.classList.contains('on'); g.querySelectorAll('button').forEach(x => x.classList.remove('on')); if (!was) b.classList.add('on');
    if (g.dataset.chips === 'size') $('#sizeHelp').textContent = was ? '' : (SIZES.find(s => s[0] === b.dataset.v) || ['', ''])[1];
  }));
  $('#kindSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.v !== kind) pinForm(b.dataset.v, p.lat, p.lon, existing ? Object.assign({}, existing, { kind: b.dataset.v }) : null); });
  $('#fCancel').onclick = closeSheet;
  const val = name => { const on = body.querySelector('[data-chips="' + name + '"] .on'); return on ? on.dataset.v : ''; };
  const num = id => { const el = $('#' + id); if (!el || el.value === '') return null; const n = Number(el.value); return isFinite(n) ? n : null; };

  terrainAt(p.lat, p.lon).then(t => {
    const line = $('#terrainLine'); if (!line) return;
    if (!t) { line.textContent = 'No elevation data at this spot (download the area or get signal to auto-fill).'; return; }
    line.textContent = 'At the pin: ' + t.elev + ' m, ' + (t.slope != null ? t.slope + '°' : '?') + ', faces ' + (t.aspect || '?') + ' (from GSI 10 m elevation data). Change anything that\'s wrong.';
    const e = $('#f-elev'), s = $('#f-slope'); if (e && !e.value) e.value = t.elev; if (s && !s.value && t.slope != null) s.value = t.slope;
    if (t.aspect && !val('aspect')) { const b = body.querySelector('[data-chips="aspect"] [data-v="' + t.aspect + '"]'); if (b) { b.classList.add('on'); $('#aspAuto').textContent = 'auto-filled'; } }
  });

  $('#fSave').onclick = () => {
    const out = Object.assign(p, {
      size: val('size'), type: val('type'), aspect: val('aspect'), how: val('how'),
      elevation: num('f-elev'), slope: num('f-slope'),
      notes: $('#f-notes').value.trim(), reporter: $('#f-rep').value.trim(), updatedAt: new Date().toISOString(),
    });
    if (isRecent) Object.assign(out, { date: $('#f-date').value || today(), trigger: val('trigger'), crown: num('f-crown'), width: num('f-width'), run: num('f-run'), bed: val('bed'), involve: val('involve'), injured: num('f-inj') || 0, killed: num('f-kill') || 0 });
    else Object.assign(out, { name: $('#f-name').value.trim(), freq: val('freq'), when: val('when') });
    const missing = [];
    if (!out.size) missing.push('size'); if (!out.type) missing.push('type'); if (!out.how) missing.push('how you know');
    if (isRecent && !out.trigger) missing.push('what set it off');
    if (!isRecent && !out.freq) missing.push('how often it runs');
    if (missing.length) { const er = $('#formErr'); er.textContent = 'Still needed: ' + missing.join(', ') + '.'; er.hidden = false; er.scrollIntoView({ block: 'center' }); return; }
    if (isRecent && out.date > today()) { const er = $('#formErr'); er.textContent = 'The date can\'t be in the future.'; er.hidden = false; return; }
    if (out.reporter) store.set('reporterName', out.reporter);
    out.createdAt = out.createdAt || out.updatedAt;
    const i = state.pins.findIndex(x => x.id === out.id); if (i >= 0) state.pins[i] = out; else state.pins.push(out);
    savePins(); renderPins(); closeSheet(); toast(existing ? 'Pin updated' : 'Pin saved. Share it from Settings so mates can verify it.');
  };
}

/* ------------------------------------------------------------------ pin detail + verification */
function openPin(id) {
  const p = findPin(id); if (!p) return;
  const t = trustOf(p); const own = p.source === 'user' && p.deviceId === deviceId;
  const isRecent = p.kind === 'recent';
  let h = '<div class="row"><span class="badge ' + t.level + '">' + esc(t.label) + '</span>' + (isRecent && p.date ? '<span class="muted small">' + fmtDate(p.date) + ' · ' + Math.floor(daysAgo(p.date)) + ' days ago</span>' : '') + '</div>';
  if (p.source === 'jan' && p.incidents) {
    h += '<div class="stack"><b>' + esc(p.name) + '</b> <span class="muted">' + esc(p.nameJa || '') + '</span><span class="small muted">' + esc(p.locNote || '') + '</span>' +
      p.incidents.map(i => '<div class="card"><b>' + fmtDate(i.date) + '</b><span class="small">' + esc(i.summary) + '</span><a class="small" href="' + esc(i.url) + '" target="_blank" rel="noopener">JAN incident record ↗</a></div>').join('') +
      '<p class="small muted" style="margin:0">From the Japan Avalanche Network incident database. A fatal slide here means the terrain can produce one again.</p></div>';
    if (state.placed[p.id]) h += '<button class="btn small" id="unplace">Remove my placement</button>';
  } else {
    const row = (k, v) => v || v === 0 ? '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>' : '';
    h += '<dl class="kv">' + row('Name', p.name) + row('Size', p.size ? p.size + ' · ' + ((SIZES.find(s => s[0] === String(p.size)) || [])[1] || '') : '') + row('Type', p.type) + row('Trigger', p.trigger) +
      row('Aspect', p.aspect) + row('Elevation', p.elevation ? p.elevation + ' m' : '') + row('Slope', p.slope ? p.slope + '°' : '') + row('Crown depth', p.crown ? p.crown + ' cm' : '') +
      row('Width', p.width ? p.width + ' m' : '') + row('Ran', p.run ? p.run + ' m' : '') + row('Bed surface', p.bed) + row('People', p.involve) +
      row('Injured', p.injured ? p.injured : '') + row('Killed', p.killed ? p.killed : '') + row('How often', p.freq) + row('When', p.when) +
      row('Place', p.place) + row('Involvement', p.involvement) + row('How they know', p.how) + row('Reported by', p.reporter || (p.source === 'user' ? 'Anonymous' : '')) + row('Source', p.source === 'user' ? '' : p.sourceLabel) + '</dl>';
    if (p.approx) h += '<p class="small muted" style="margin:0">Position is approximate: the bulletin names the area, not exact coordinates.</p>';
    if (p.notes) h += '<p style="margin:0;white-space:pre-wrap">' + esc(p.notes) + '</p>';
  }
  if (p.source === 'user') {
    const vs = Object.entries(p.verifications || {}).filter(([d]) => d !== p.deviceId);
    if (vs.length) h += '<div class="stack"><p class="eyebrow">Checked by</p>' + vs.map(([, v]) => '<div class="small">' + (v.v === 'confirm' ? '✓ ' : '✗ ') + '<b>' + esc(v.name || 'Anonymous') + '</b> · ' + fmtDate(v.at) + (v.reason ? ' · ' + esc(v.reason) : '') + (v.note ? ': ' + esc(v.note) : '') + '</div>').join('') + '</div>';
    if (!own) {
      const mine = (p.verifications || {})[deviceId];
      h += '<div class="card"><b>Have you seen this one?</b><span class="small muted">' + (mine ? 'You ' + (mine.v === 'confirm' ? 'confirmed' : 'disputed') + ' this. You can change your answer.' : 'Confirm only what you saw yourself. Three confirmations makes a pin Trusted.') + '</span>' +
        '<div class="btn-row"><button class="btn primary" id="vYes">It\'s accurate</button><button class="btn" id="vNo">Something\'s wrong</button></div><div id="vMore" hidden></div></div>';
    } else {
      h += '<p class="small muted" style="margin:0">You made this pin. Other riders verify it once you share it (Settings → Share my pins).</p><div class="btn-row"><button class="btn" id="pEdit">Edit</button><button class="btn" id="pMove">Move</button><button class="btn" id="pDel">Delete</button></div>';
    }
  }
  h += '<a class="small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + p.lat.toFixed(5) + ',' + p.lon.toFixed(5) + '">' + p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) + ' ↗</a>';
  openSheet(isRecent ? 'Recent avalanche' : 'Known slide path', h, { view: 'pin' });
  map.panTo([p.lat, p.lon]);

  const up = $('#unplace'); if (up) up.onclick = () => { delete state.placed[p.id]; store.set('placed', state.placed); renderPins(); closeSheet(); };
  const ed = $('#pEdit'); if (ed) ed.onclick = () => pinForm(p.kind, p.lat, p.lon, state.pins.find(x => x.id === p.id));
  const mv = $('#pMove'); if (mv) mv.onclick = () => { map.setView([p.lat, p.lon]); startPlacing({ movePin: p.id }); };
  const dl = $('#pDel'); if (dl) dl.onclick = () => {
    if (!dl.dataset.armed) { dl.dataset.armed = '1'; dl.textContent = 'Tap again to delete'; dl.classList.add('danger'); return; }
    state.pins = state.pins.filter(x => x.id !== p.id); savePins(); renderPins(); closeSheet(); toast('Pin deleted');
  };
  const verify = (v, reason, note) => {
    const pin = state.pins.find(x => x.id === p.id); if (!pin) return;
    pin.verifications = pin.verifications || {};
    pin.verifications[deviceId] = { v, reason: reason || '', note: note || '', name: reporterName(), at: new Date().toISOString() };
    savePins(); renderPins(); openPin(p.id); toast(v === 'confirm' ? 'Thanks. Confirmed.' : 'Thanks. Marked as disputed.');
  };
  const yes = $('#vYes'), no = $('#vNo');
  if (yes) yes.onclick = () => {
    $('#vMore').hidden = false;
    $('#vMore').innerHTML = '<div class="field"><span class="lbl">How do you know?</span>' + chips('vhow', isRecent ? HOW_RECENT : HOW_PATH, '') + '</div><div class="field"><label for="v-note">Anything to add? <span class="muted">(optional)</span></label><input type="text" id="v-note" maxlength="200"></div><button class="btn primary" id="vGo">Confirm</button>';
    wireChips(); $('#vGo').onclick = () => { const how = ($('#vMore [data-chips="vhow"] .on') || {}).dataset; verify('confirm', how ? how.v : '', $('#v-note').value.trim()); };
  };
  if (no) no.onclick = () => {
    $('#vMore').hidden = false;
    $('#vMore').innerHTML = '<div class="field"><span class="lbl">What\'s wrong?</span>' + chips('vwhy', DISPUTE_REASONS, '') + '</div><div class="field"><label for="v-note">Details</label><input type="text" id="v-note" maxlength="200" placeholder="e.g. it was the next gully north"></div><div id="vErr" class="err" hidden>Pick what\'s wrong.</div><button class="btn" id="vGo">Send dispute</button>';
    wireChips(); $('#vGo').onclick = () => { const on = $('#vMore [data-chips="vwhy"] .on'); if (!on) { $('#vErr').hidden = false; return; } verify('dispute', on.dataset.v, $('#v-note').value.trim()); };
  };
}
function wireChips() {
  $('#sheetBody').querySelectorAll('[data-chips]').forEach(g => { if (g._w) return; g._w = 1; g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }); });
}

/* ------------------------------------------------------------------ share: export / import */
function exportPins() {
  const data = { app: 'powder-pigs', version: 1, exportedAt: new Date().toISOString(), from: reporterName(), pins: state.pins, areas: state.customAreas };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = 'powder-pigs-pins-' + today() + '.json';
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Avalanche pins', text: 'Avalanche pins from ' + (reporterName() || 'a mate') + '. Open Backcountry Powder Pigs → Settings → Import pins.' }).catch(() => { });
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
}
function cleanPin(x) {
  if (!x || typeof x !== 'object') return null;
  const lat = Number(x.lat), lon = Number(x.lon);
  if (!isFinite(lat) || !isFinite(lon) || lat < 20 || lat > 46 || lon < 122 || lon > 154) return null; // Japan only
  if (x.kind !== 'recent' && x.kind !== 'path') return null;
  const s = v => (v == null ? '' : String(v)).slice(0, 1000);
  const n = v => { const k = Number(v); return isFinite(k) ? k : null; };
  const out = { id: s(x.id).slice(0, 40) || 'p-' + uid(), kind: x.kind, lat, lon, source: 'user', deviceId: s(x.deviceId).slice(0, 40), reporter: s(x.reporter).slice(0, 40),
    area: s(x.area).slice(0, 20), date: s(x.date).slice(0, 10), size: s(x.size).slice(0, 4), type: s(x.type).slice(0, 40), trigger: s(x.trigger).slice(0, 60), aspect: ASPECTS.includes(x.aspect) ? x.aspect : '',
    elevation: n(x.elevation), slope: n(x.slope), crown: n(x.crown), width: n(x.width), run: n(x.run), bed: s(x.bed).slice(0, 40), involve: s(x.involve).slice(0, 40),
    injured: n(x.injured) || 0, killed: n(x.killed) || 0, how: s(x.how).slice(0, 60), freq: s(x.freq).slice(0, 40), when: s(x.when).slice(0, 40), name: s(x.name).slice(0, 80), notes: s(x.notes),
    createdAt: s(x.createdAt).slice(0, 30), updatedAt: s(x.updatedAt).slice(0, 30), verifications: {} };
  if (x.verifications && typeof x.verifications === 'object') Object.entries(x.verifications).slice(0, 200).forEach(([d, v]) => {
    if (v && (v.v === 'confirm' || v.v === 'dispute')) out.verifications[String(d).slice(0, 40)] = { v: v.v, reason: s(v.reason).slice(0, 60), note: s(v.note).slice(0, 200), name: s(v.name).slice(0, 40), at: s(v.at).slice(0, 30) };
  });
  if (!out.area) { const a = areaFor(lat, lon); out.area = a ? a.id : ''; }
  return out;
}
async function importPins(file) {
  let data; try { data = JSON.parse(await file.text()); } catch (e) { toast('That file isn\'t a pins file'); return; }
  if (!data || !['powder-pigs', 'nadare-watch'].includes(data.app) || !Array.isArray(data.pins)) { toast('That file isn\'t a Powder Pigs pins file'); return; }
  let added = 0, updated = 0;
  data.pins.slice(0, 5000).forEach(raw => {
    const x = cleanPin(raw); if (!x) return;
    const cur = state.pins.find(p => p.id === x.id);
    if (!cur) { state.pins.push(x); added++; return; }
    // Merge: keep everyone's verifications (newest per person); take the owner's newer edit of the details.
    Object.entries(x.verifications).forEach(([d, v]) => { const mine = cur.verifications[d]; if (!mine || (v.at || '') > (mine.at || '')) cur.verifications[d] = v; });
    if (x.deviceId === cur.deviceId && (x.updatedAt || '') > (cur.updatedAt || '')) { const keep = cur.verifications; Object.assign(cur, x, { verifications: keep }); }
    updated++;
  });
  // Areas mates have drawn
  let newAreas = 0;
  (Array.isArray(data.areas) ? data.areas : []).slice(0, 50).forEach(x => {
    if (!x || typeof x !== 'object' || state.customAreas.some(a => a.id === x.id)) return;
    const b = x.bounds, ok = Array.isArray(b) && b.length === 2 && b.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    if (!ok || !(b[0][0] < b[1][0] && b[0][1] < b[1][1]) || b[0][0] < 20 || b[1][0] > 46 || b[0][1] < 122 || b[1][1] > 154) return;
    if (b[1][0] - b[0][0] > 0.6 || b[1][1] - b[0][1] > 0.8) return;
    const alp = Number(x.bands && x.bands.alpMin), tl = Number(x.bands && x.bands.tlMin);
    state.customAreas.push({ id: String(x.id).slice(0, 40), name: String(x.name || 'Shared area').slice(0, 40), nameJa: '', bounds: b,
      center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 13, region: state.regions[x.region] ? x.region : '',
      bands: { alpMin: alp > tl && tl > 0 ? alp : 1800, tlMin: alp > tl && tl > 0 ? tl : 1400 } });
    newAreas++;
  });
  if (newAreas) { store.set('customAreas', state.customAreas); rebuildAreas(); }
  savePins(); renderPins();
  toast('Imported: ' + added + ' new pin' + (added === 1 ? '' : 's') + ', ' + updated + ' updated' + (newAreas ? ', ' + newAreas + ' area' + (newAreas === 1 ? '' : 's') : ''));
}
$('#importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importPins(f); e.target.value = ''; });

/* ------------------------------------------------------------------ settings */
function showSettings() {
  const a = state.area, bands = bandsFor(a);
  let h = '<div class="field"><label for="s-name">Your name on pins</label><input type="text" id="s-name" maxlength="40" value="' + esc(reporterName()) + '"></div>';
  h += '<div class="stack"><p class="eyebrow">Share pins with your crew</p><p class="small muted" style="margin:0">Pins live on this phone. Send your file to mates; when they import it they see your pins and can confirm or dispute them. Their file back to you brings their checks and pins. Re-sharing merges, it never duplicates.</p><div class="btn-row"><button class="btn primary" id="sExport">Share my pins (' + state.pins.length + ')</button><button class="btn" id="sImport">Import pins</button></div></div>';
  h += '<div class="stack"><p class="eyebrow">Latest satellite (Sentinel-2)</p><p class="small muted" style="margin:0">Free from the EU Copernicus programme. New passes every few days; the app picks the newest clear one. One-off setup, about 5 minutes:</p>' +
    '<ol class="small" style="margin:0;padding-left:20px;display:grid;gap:4px"><li>Make a free account at <a href="https://dataspace.copernicus.eu/" target="_blank" rel="noopener">dataspace.copernicus.eu</a>.</li><li>Open the Sentinel Hub dashboard from your account, then <b>Configuration Utility</b>.</li><li>Copy the ID of the <b>Simple WMS</b> instance (or create one from the Simple WMS template).</li><li>Paste it here.</li></ol>' +
    '<div class="field"><label for="s-sat">Copernicus instance ID</label><input type="text" id="s-sat" autocomplete="off" spellcheck="false" value="' + esc(satId()) + '" placeholder="e.g. 1a2b3c4d-…"></div><button class="btn" id="sSat">Save and show satellite</button></div>';
  h += '<div class="field"><span class="lbl">Show red skulls for slides in the last</span>' + chips('days', ['3', '7', '14', '30'], String(state.recentDays)) + '<span class="help">Days. Older reports hide automatically.</span></div>';
  h += '<div class="stack"><p class="eyebrow">Elevation bands for ' + esc(a.name) + '</p><p class="small muted" style="margin:0">' + (a.bandsSource === 'JAN' ? 'Set from JAN\'s guide.' : 'These are estimates. If JAN or a local guide gives different heights, change them; the danger shading uses them.') + '</p><div class="grid3"><div class="field"><label for="s-alp">Alpine from (m)</label><input type="number" id="s-alp" value="' + bands.alpMin + '"></div><div class="field"><label for="s-tl">Treeline from (m)</label><input type="number" id="s-tl" value="' + bands.tlMin + '"></div><div class="field"><span class="lbl">&nbsp;</span><button class="btn" id="sBands">Save</button></div></div>' + (state.bandOverrides[a.id] ? '<button class="btn small ghost" id="sBandsReset">Reset to default</button>' : '') + '</div>';
  h += '<div class="stack"><p class="eyebrow">About</p><p class="small muted" style="margin:0">Topo and elevation: Geospatial Information Authority of Japan (GSI). Onsens, parking and other places: © OpenStreetMap contributors. Avalanche bulletins and incident records: Japan Avalanche Network (nadare.jp), summarised. This app helps you plan. It does not replace avalanche training, a beacon, shovel and probe, or your own judgement on the day.</p></div>';
  openSheet('Settings', h, { view: 'settings', tall: true });
  $('#s-name').onchange = e => store.set('reporterName', e.target.value.trim());
  $('#sSat').onclick = () => {
    const v = $('#s-sat').value.trim();
    if (v && !/^[A-Za-z0-9-]{8,64}$/.test(v)) { toast('That doesn\'t look like an instance ID'); return; }
    store.set('satInstance', v); store.set('satLayerName', ''); sat.layerName = ''; sat.loadedFor = null;
    if (!v) { toast('Satellite turned off'); return; }
    state.base = 'sat'; store.set('base', 'sat'); closeSheet(); Promise.resolve(setBase()).then(() => toast(sat.err || 'Satellite on'));
  };
  $('#sExport').onclick = exportPins;
  $('#sImport').onclick = () => $('#importFile').click();
  wireChips();
  $('#sheetBody [data-chips="days"]').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.recentDays = Number(b.dataset.v); store.set('recentDays', state.recentDays); renderPins(); });
  $('#sBands').onclick = () => {
    const alp = Number($('#s-alp').value), tl = Number($('#s-tl').value);
    if (!(alp > tl && tl > 0)) { toast('Alpine has to start higher than treeline'); return; }
    state.bandOverrides[a.id] = { alpMin: alp, tlMin: tl }; store.set('bandOverrides', state.bandOverrides); redrawShading(); toast('Bands saved'); showSettings();
  };
  const rs = $('#sBandsReset'); if (rs) rs.onclick = () => { delete state.bandOverrides[a.id]; store.set('bandOverrides', state.bandOverrides); redrawShading(); showSettings(); };
}

/* ------------------------------------------------------------------ wiring */
$('#areaBtn').addEventListener('click', showAreaPicker);
$('#satFlag').addEventListener('click', () => { if (!satId()) showSettings(); else showLayers(); });
$('#briefChip').addEventListener('click', showBrief);
$('#layersBtn').addEventListener('click', showLayers);
$('#packsBtn').addEventListener('click', showPacks);
$('#settingsBtn').addEventListener('click', showSettings);
map.on('moveend', () => {
  if (!state.area) return;
  renderPois(); const c = map.getCenter();
  if (!boxing) { const a = areaFor(c.lat, c.lng); if (a && a.id !== state.area.id && map.getZoom() >= 11) setArea(a.id); }
  store.set('view', [c.lat, c.lng, map.getZoom()]);
});
function netFlag() { $('#offlineFlag').hidden = navigator.onLine; updateNativeZoom(); }
window.addEventListener('online', () => { netFlag(); loadBulletins(true); });
window.addEventListener('offline', netFlag);
document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) loadBulletins(); });

async function boot() {
  try {
    const [ar, sl] = await Promise.all([fetch('data/areas.json').then(r => r.json()), fetch('data/known-slides.json').then(r => r.json())]);
    state.regions = ar.regions || {}; state.builtinAreas = ar.areas; state.slides = sl.slides; rebuildAreas();
  } catch (e) { toast('Couldn\'t load the app data. Open it once with signal.'); return; }
  state.area = state.areas.find(a => a.id === store.get('area', 'hakuba')) || state.areas[0];
  const v = store.get('view', null);
  if (v && areaFor(v[0], v[1])) map.setView([v[0], v[1]], v[2]); else map.setView(state.area.center, state.area.zoom);
  setArea(state.area.id, false);
  setBase(); netFlag(); setAspect(state.aspectOn);
  state.bulletins = store.get('bulletinsCache', null); updateChip();
  renderPins();
  loadBulletins(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
}
boot();
