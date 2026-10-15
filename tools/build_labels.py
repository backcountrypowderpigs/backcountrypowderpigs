"""Build data/labels/<area>.json: every name GSI prints on the topo map (valleys, creeks, peaks, ridges,
passes, waterfalls, ponds, settlements, shrines, hospitals...) with an English reading and meaning.

Source: GSI optimised vector tiles (国土地理院最適化ベクトルタイル), the 'Anno' (annotation) layer, which holds
the same names as the raster topo map. Runs on GitHub Actions (see .github/workflows/places.yml).
"""
import gzip, json, math, os, re, sys, time
import requests
import mapbox_vector_tile
import pykakasi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'labels')
UA = {'User-Agent': 'BackcountryPowderPigs/1.0 (github.com/backcountrypowderpigs)'}
PBF = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf'
PMT = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles'
VZ = 13  # vector zoom 13 = the names shown on raster zoom 14
kks = pykakasi.kakasi()

# GSI annotation codes -> what kind of name it is
KIND = {311: 'peak', 312: 'peak', 313: 'peak', 314: 'peak', 315: 'peak', 316: 'peak', 333: 'range',
        332: 'terrain', 832: 'pass', 331: 'plateau', 830: 'plateau', 321: 'lake', 820: 'lake', 322: 'river',
        323: 'water', 822: 'waterfall', 5801: 'waterfall', 831: 'onsen', 6331: 'onsen', 6332: 'crater',
        110: 'town', 120: 'town', 130: 'town', 140: 'town', 210: 'place', 220: 'place', 800: 'place',
        3231: 'shrine', 661: 'shrine', 3232: 'temple', 662: 'temple', 3241: 'police', 3211: 'police', 3242: 'fire',
        3243: 'hospital', 3218: 'post', 6341: 'sight', 4105: 'memorial'}

# Japanese endings -> (reading, English meaning). Longest first.
SUFFIX = [('雪渓', 'sekkei', 'snowfield'), ('尾根', 'one', 'ridge'), ('乗越', 'nokkoshi', 'col'), ('高原', 'kogen', 'plateau'),
          ('温泉', 'onsen', 'hot spring'), ('小屋', 'goya', 'hut'), ('新道', 'shindo', 'trail'), ('登山口', 'tozanguchi', 'trailhead'),
          ('沢', 'sawa', 'creek / gully'), ('谷', 'dani', 'valley'), ('川', 'gawa', 'river'), ('滝', 'taki', 'waterfall'),
          ('峠', 'toge', 'pass'), ('岳', 'dake', 'peak'), ('峰', 'mine', 'peak'), ('山', 'yama', 'mountain'), ('頭', 'atama', 'top / knoll'),
          ('池', 'ike', 'pond'), ('沼', 'numa', 'marsh'), ('湖', 'ko', 'lake'), ('平', 'daira', 'flat'), ('原', 'hara', 'plateau / meadow'),
          ('峡', 'kyo', 'gorge'), ('渓', 'kei', 'gorge'), ('岩', 'iwa', 'rock'), ('鼻', 'hana', 'spur'), ('窪', 'kubo', 'hollow'),
          ('坂', 'saka', 'slope'), ('台', 'dai', 'plateau'), ('森', 'mori', 'forest'), ('ノ頭', 'no atama', 'top / knoll'),
          ('神社', 'jinja', 'shrine'), ('寺', 'ji', 'temple'), ('駅', 'eki', 'station')]
KIND_EN = {'peak': 'peak', 'range': 'mountains', 'pass': 'pass', 'plateau': 'plateau', 'lake': 'lake / pond', 'river': 'river',
           'water': 'creek / valley', 'waterfall': 'waterfall', 'onsen': 'hot spring', 'crater': 'crater', 'town': 'town',
           'place': 'settlement', 'shrine': 'shrine', 'temple': 'temple', 'police': 'police', 'fire': 'fire station',
           'hospital': 'hospital', 'post': 'post office', 'sight': 'landmark', 'memorial': 'disaster memorial', 'terrain': ''}


def hep(text):
    s = ' '.join(x['hepburn'] for x in kks.convert(text)).strip()
    s = re.sub(r'ou', 'o', s); s = re.sub(r'uu', 'u', s); s = re.sub(r'\s+', '', s)
    return s[:1].upper() + s[1:]


def english(ja, kind):
    """白沢 -> ('Shirasawa', 'creek / gully'). Reading is approximate (place-name readings vary)."""
    ja = ja.strip()
    for k, rd, en in SUFFIX:
        if ja.endswith(k) and len(ja) > len(k):
            stem = ja[:-len(k)]
            return (hep(stem) + rd if rd else hep(stem)), en
    return hep(ja), KIND_EN.get(kind, '')


def tiles(bounds, z):
    (s, w), (n, e) = bounds
    def xy(lat, lon):
        x = (lon + 180) / 360 * 2 ** z
        r = math.radians(lat)
        y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z
        return int(x), int(y)
    x0, y1 = xy(s, w); x1, y0 = xy(n, e)
    return [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def to_lonlat(z, x, y, px, py, extent):
    n = 2 ** z
    lon = (x + px / extent) / n * 360 - 180
    t = math.pi * (1 - 2 * (y + py / extent) / n)
    return lon, math.degrees(math.atan(math.sinh(t)))


_pm = None
def fetch_tile(z, x, y):
    global _pm
    try:
        r = requests.get(PBF.format(z=z, x=x, y=y), headers=UA, timeout=60)
        if r.ok and r.content:
            return r.content
    except Exception:  # noqa: BLE001
        pass
    # PMTiles version (kept up to date)
    try:
        from pmtiles.reader import Reader
        if _pm is None:
            sess = requests.Session()
            def get_bytes(offset, length):
                rr = sess.get(PMT, headers=dict(UA, Range='bytes=%d-%d' % (offset, offset + length - 1)), timeout=60)
                return rr.content
            _pm = Reader(get_bytes)
        return _pm.get(z, x, y)
    except Exception as ex:  # noqa: BLE001
        print('  tile', z, x, y, 'failed', ex)
        return None


def build(area):
    out, seen, shown_keys = [], set(), False
    for (z, x, y) in tiles(area['bounds'], VZ):
        data = fetch_tile(z, x, y)
        if not data:
            continue
        if data[:2] == b'\x1f\x8b':
            data = gzip.decompress(data)
        dec = mapbox_vector_tile.decode(data, default_options={'y_coord_down': True})
        layer = dec.get('Anno')
        if not layer:
            continue
        ext = layer.get('extent', 4096)
        for f in layer['features']:
            p = f.get('properties') or {}
            if not shown_keys:
                print('  Anno attributes:', sorted(p.keys())); shown_keys = True
            code = p.get('vt_code'); ja = str(p.get('vt_text') or '').strip()
            if code not in KIND or not ja or re.fullmatch(r'[\d.\s]+', ja):
                continue
            g = f['geometry']; c = g['coordinates']
            if g['type'] == 'Point': px, py = c
            elif g['type'] == 'LineString': px, py = c[len(c) // 2]
            elif g['type'] == 'MultiPoint': px, py = c[0]
            else: continue
            lon, lat = to_lonlat(z, x, y, px, py, ext)
            (s, w), (n, e) = area['bounds']
            if not (s <= lat <= n and w <= lon <= e):
                continue
            key = (ja, round(lat, 3), round(lon, 3))
            if key in seen:
                continue
            seen.add(key)
            kind = KIND[code]
            kana = p.get('vt_kana') or p.get('kana') or ''
            en, gloss = english(ja, kind)
            if kana:
                en = hep(kana)
            out.append({'ja': ja, 'en': en, 'g': gloss, 'k': kind, 'lat': round(lat, 5), 'lon': round(lon, 5)})
        time.sleep(0.05)
    return {'v': 1, 'source': '国土地理院最適化ベクトルタイル (GSI)', 'labels': out}


def main():
    areas = json.load(open(os.path.join(ROOT, 'data', 'areas.json'), encoding='utf-8'))['areas']
    only = set(sys.argv[1:])
    os.makedirs(OUT, exist_ok=True)
    for a in areas:
        if only and a['id'] not in only:
            continue
        try:
            d = build(a)
            if d['labels']:
                with open(os.path.join(OUT, a['id'] + '.json'), 'w', encoding='utf-8') as f:
                    json.dump(d, f, ensure_ascii=False, separators=(',', ':'))
            print(f"{a['id']}: {len(d['labels'])} names")
        except Exception as ex:  # noqa: BLE001
            print(f"{a['id']}: FAILED {ex}")


if __name__ == '__main__':
    main()
