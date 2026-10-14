"""Build data/places/<area>.json for every built-in area.

Runs on GitHub Actions (see .github/workflows/places.yml), so the app ships with
English place names, ski resorts, lifts, runs, onsens and parking already inside it
and never has to wait for a slow public server on the mountain.

English name, best first:
  1. name:en (or a romanised tag) from OpenStreetMap
  2. the English label on Wikidata
  3. the Japanese name turned into romaji (pykakasi), with common endings in English
The Japanese name is always kept.
"""
import json, os, re, sys, time, datetime
import requests
import pykakasi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'places')
MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
UA = {'User-Agent': 'BackcountryPowderPigs/1.0 (github.com/backcountrypowderpigs)'}
kks = pykakasi.kakasi()

# Japanese endings that read better as English words
SUFFIX = [('スキーリゾート', 'Ski Resort'), ('スキー場', 'Ski Area'), ('温泉郷', 'Onsen'), ('温泉', 'Onsen'), ('駅', 'Station'),
          ('村', 'Village'), ('町', 'Town'), ('市', 'City'), ('ロープウェイ', 'Ropeway'), ('ゴンドラ', 'Gondola')]


def romaji(ja):
    if not ja:
        return ''
    tail = ''
    for k, en in SUFFIX:
        if ja.endswith(k) and len(ja) > len(k):
            ja, tail = ja[:-len(k)], en
            break
    words = ' '.join(x['hepburn'] for x in kks.convert(ja)).strip()
    words = re.sub(r'ou', 'o', words)
    words = re.sub(r'uu', 'u', words)
    words = re.sub(r'\s+', ' ', words)
    out = ' '.join(w[:1].upper() + w[1:] for w in words.split(' ') if w)
    return (out + (' ' + tail if tail else '')).strip()


def label_category(t):
    if t.get('railway') == 'station': return 'station'
    if t.get('tourism') in ('viewpoint', 'attraction'): return 'sight'
    if t.get('landuse') == 'winter_sports': return 'resort'
    n = t.get('natural')
    if n in ('peak', 'volcano'): return 'peak'
    if n in ('saddle', 'ridge', 'valley', 'water'): return n
    if t.get('place'): return 'place'
    return None


def is_wild(t):
    """A hot spring out in nature: mapped as natural=hot_spring with no bath house, hotel or building."""
    nm = t.get('name', '')
    if re.search(r'野湯|秘湯', nm):
        return True
    return (t.get('natural') == 'hot_spring' and not t.get('amenity') and not t.get('building') and not t.get('tourism')
            and not t.get('opening_hours') and t.get('fee', 'no') != 'yes')


def poi_category(t):
    if is_wild(t): return 'wild'
    if t.get('natural') == 'hot_spring' or t.get('amenity') == 'public_bath' or t.get('bath:type') == 'onsen' or t.get('leisure') == 'onsen': return 'onsen'
    if t.get('amenity') == 'parking': return None if (t.get('access') == 'private' or t.get('parking') == 'underground') else 'parking'
    if t.get('tourism') in ('alpine_hut', 'wilderness_hut'): return 'hut'
    if t.get('aerialway') == 'station': return 'lift'
    if t.get('shop') == 'convenience': return 'shop'
    if t.get('amenity') in ('hospital', 'clinic'): return 'medical'
    if t.get('amenity') == 'police': return 'police'
    return None


def names(t):
    ja = t.get('name', '')
    en = t.get('name:en') or t.get('name:ja-Latn') or t.get('name:ja_rm') or ''
    wd = t.get('wikidata', '') if not en and re.match(r'^Q\d+$', t.get('wikidata', '')) else ''
    return {'name': en or ja, 'ja': ja, 'en': en, 'romaji': '' if en else romaji(ja), 'wd': wd}


def query(bounds):
    s, w = bounds[0]; n, e = bounds[1]
    bb = f'{s},{w},{n},{e}'
    return ('[out:json][timeout:180];('
            f'nwr["natural"="hot_spring"]({bb});nwr["amenity"="public_bath"]({bb});nwr["bath:type"="onsen"]({bb});'
            f'nwr["name"~"野湯|秘湯"]({bb});nwr["amenity"="parking"]({bb});nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]({bb});'
            f'node["aerialway"="station"]({bb});nwr["shop"="convenience"]({bb});'
            f'nwr["amenity"~"^(hospital|clinic|police)$"]({bb});'
            f'nwr["landuse"="winter_sports"]["name"]({bb});node["natural"~"^(peak|volcano|saddle)$"]["name"]({bb});'
            f'way["natural"~"^(ridge|valley)$"]["name"]({bb});node["place"~"^(city|town|village|suburb|neighbourhood|hamlet|locality)$"]["name"]({bb});'
            f'nwr["natural"="water"]["name"]({bb});node["railway"="station"]["name"]({bb});'
            f'nwr["tourism"~"^(viewpoint|attraction)$"]["name"]({bb}););out center tags;'
            f'(way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow)$"]({bb});'
            f'way["piste:type"="downhill"]({bb}););out geom tags;')


def overpass(q):
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            try:
                r = requests.post(url, data={'data': q}, headers=UA, timeout=240)
                if r.ok:
                    return r.json()
                last = f'{url} {r.status_code}'
            except Exception as ex:  # noqa: BLE001
                last = f'{url} {ex}'
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(f'Overpass failed: {last}')


def wikidata(items):
    ids = sorted({x['wd'] for x in items if x.get('wd') and not x.get('en')})
    got = {}
    for i in range(0, len(ids), 50):
        try:
            r = requests.get('https://www.wikidata.org/w/api.php', headers=UA, timeout=60, params={
                'action': 'wbgetentities', 'props': 'labels', 'languages': 'en', 'format': 'json', 'ids': '|'.join(ids[i:i + 50])})
            for qid, ent in (r.json().get('entities') or {}).items():
                lab = ((ent.get('labels') or {}).get('en') or {}).get('value')
                if lab:
                    got[qid] = lab
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    for x in items:
        if x.get('wd') in got:
            x['en'] = got[x['wd']]; x['name'] = x['en']; x['romaji'] = ''
        x.pop('wd', None)


def seeds_for(area_id):
    try:
        d = json.load(open(os.path.join(ROOT, 'data', 'natural-onsens.json'), encoding='utf-8'))
        return [o for o in d.get('onsens', []) if o.get('area') == area_id]
    except Exception:  # noqa: BLE001
        return []


def dist_m(a, b, c, d):
    import math
    x = (d - b) * 111320 * math.cos(math.radians((a + c) / 2)); y = (c - a) * 110540
    return math.hypot(x, y)


def place_seeds(area, points):
    """Natural onsens from data/natural-onsens.json. Ones without a position are found on OpenStreetMap by name
    (inside the area box only)."""
    seeds = seeds_for(area['id'])
    need = [o for o in seeds if o.get('lat') is None and o.get('find')]
    found = {}
    if need:
        s, w = area['bounds'][0]; n, e = area['bounds'][1]
        bb = f'{s},{w},{n},{e}'
        rx = '|'.join(re.escape(o['find']) for o in need)
        try:
            j = overpass(f'[out:json][timeout:60];nwr["name"~"{rx}"]({bb});out center tags;')
            for el in j.get('elements', []):
                nm = (el.get('tags') or {}).get('name', '')
                lat = el.get('lat', (el.get('center') or {}).get('lat')); lon = el.get('lon', (el.get('center') or {}).get('lon'))
                if lat is None: continue
                for o in need:
                    if o['find'] in nm and o['id'] not in found:
                        found[o['id']] = (round(lat, 5), round(lon, 5))
        except Exception as ex:  # noqa: BLE001
            print(f"  natural onsen lookup failed: {ex}")
    out = []
    for o in seeds:
        lat, lon = (o.get('lat'), o.get('lon')) if o.get('lat') is not None else found.get(o['id'], (None, None))
        if lat is None:
            print(f"  {o['id']}: not found on OpenStreetMap yet"); continue
        out.append({'c': 'wild', 'id': o['id'], 'lat': lat, 'lon': lon, 'name': o.get('en') or o.get('ja'), 'ja': o.get('ja', ''), 'en': o.get('en', ''), 'romaji': '',
                    'ele': o.get('ele'), 'season': o.get('season', ''), 'access': o.get('access', ''), 'note': o.get('note', ''), 'fee': '', 'hours': '', 'cap': ''})
    # Drop OpenStreetMap onsen dots sitting on top of a listed natural onsen, so it isn't shown twice.
    keep = [p for p in points if not (p['c'] in ('onsen', 'wild') and any(dist_m(p['lat'], p['lon'], q['lat'], q['lon']) < 300 for q in out))]
    return keep + out


def build(area):
    j = overpass(query(area['bounds']))
    points, lines, labels = [], [], []
    for el in j.get('elements', []):
        t = el.get('tags') or {}
        if el.get('geometry') and (t.get('aerialway') or t.get('piste:type')):
            pts = []
            for g in el['geometry']:
                p = [round(g['lat'], 5), round(g['lon'], 5)]
                if not pts or pts[-1] != p:
                    pts.append(p)
            if len(pts) > 1:
                d = {'c': 'lift' if t.get('aerialway') else 'run', 'kind': t.get('aerialway', ''), 'diff': t.get('piste:difficulty', ''), 'pts': pts}
                d.update(names(t)); lines.append(d)
            continue
        lat = el.get('lat', (el.get('center') or {}).get('lat'))
        lon = el.get('lon', (el.get('center') or {}).get('lon'))
        if lat is None:
            continue
        lat, lon = round(lat, 5), round(lon, 5)
        lc = label_category(t)
        if lc:
            try:
                ele = int(float(str(t.get('ele', '')).replace('m', '').strip()))
            except ValueError:
                ele = None
            d = {'c': lc, 'lat': lat, 'lon': lon, 'ele': ele}; d.update(names(t)); labels.append(d)
            continue
        c = poi_category(t)
        if not c:
            continue
        d = {'c': c, 'lat': lat, 'lon': lon, 'fee': t.get('fee', ''), 'hours': t.get('opening_hours', ''), 'cap': t.get('capacity', '')}
        d.update(names(t)); points.append(d)
    wikidata(points + lines + labels)
    points = place_seeds(area, points)
    return {'v': 3, 'fetched': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z', 'source': 'OpenStreetMap contributors, Wikidata',
            'points': points, 'lines': lines, 'labels': labels}


def main():
    areas = json.load(open(os.path.join(ROOT, 'data', 'areas.json'), encoding='utf-8'))['areas']
    only = set(sys.argv[1:])
    os.makedirs(OUT, exist_ok=True)
    failed = []
    for a in areas:
        if only and a['id'] not in only:
            continue
        try:
            data = build(a)
            with open(os.path.join(OUT, a['id'] + '.json'), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
            print(f"{a['id']}: {len(data['labels'])} labels, {len(data['lines'])} lifts/runs, {len(data['points'])} places")
        except Exception as ex:  # noqa: BLE001
            failed.append(a['id']); print(f"{a['id']}: FAILED {ex}")
        time.sleep(10)
    if failed and len(failed) == len(areas):
        sys.exit(1)


if __name__ == '__main__':
    main()
