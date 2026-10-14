# Backcountry Powder Pigs

Backcountry avalanche map for Japan. Built-in areas: Hakuba, Myoko, Lotte Arai, Charmant Hiuchi, Kagura, Niseko, Rusutsu, Kiroro, Furano, Asahidake. Riders can add their own. Runs in the phone browser and installs to the home screen. Works offline in the areas you download.

## What it does

- **GSI topo map** (国土地理院) with 10 m elevation data underneath.
- **Area packs**: download only the areas you ride. Standard detail is roughly 10–25 MB per area, Detailed roughly 25–80 MB. Nothing else is stored.
- **Your own areas**: Area menu → Add your own area. Frame it on the map, name it, pick the nearest JAN bulletin and band heights. Every area (built-in or yours) has Adjust box. Your areas travel with your shared pins file.
- **Map**: Latest satellite by default (Sentinel-2, 10 m, newest clear pass in the last 90 days, pick earlier passes by date; needs a free Copernicus account and signal). GSI topo underneath, and on its own when there's no signal.
- **Aspect overlay** (compass button, or Layers → Aspect overlay): its own on/off layer that works alone or on top of danger or slope shading. Slopes 20°+ coloured by the way they face (N blue, E green, S yellow, W red and the in-betweens). "Match today's report" makes the aspects and heights the bulletin flags strong and the rest faint, for route planning. Tap aspects on or off.
- **English labels** over the map: ski resorts, peaks with height, passes, ridges, valleys, villages and lakes, English with the Japanese underneath. Where OpenStreetMap has no English name, the label says what it is (Peak, Ridge, Pass). Layers also has a Japanese map-word glossary, since the topo map's own printing is Japanese.
- **Routes**: plan a route by tapping the map (distance, climb, descent, Munter touring time, elevation profile, steepest slope and how much is on 30°+). Planned routes are dashed magenta.
- **Tracks**: record your trip (time, moving time, distance, climb, descent), saved as you go. Keep or discard at the end. Recorded tracks are solid electric blue. Share any route or track as GPX, or import GPX from mates, CalTopo or Gaia. Keep the app open while recording; phones pause GPS for web apps when the screen locks.
- **Hazard and handy markers**: rocks, cliff / drop-off, cornice, avalanche debris, open creek, tree wells, ice, no entry, regroup / safe spot, good snow. Amber = hazard, red = keep out, blue = water, green = good to know. Temporary ones fade after two weeks. Verified and shared like slide pins.
- **Help**: the ? button at the top opens a basic guide; it also shows the first time the app opens.
- **Lifts and runs** from OpenStreetMap, with the ski resort named in each lift's popup (green easy, red intermediate, black advanced), saved with the area pack.
- **Avalanche brief** per area: danger rating for alpine, treeline and below treeline, the avalanche problems drawn as JAN-style aspect roses, a short summary, recent avalanches from the report, and links to the full bulletin.
- **Danger shading**: red on steep slopes the bulletin says to stay off (by elevation band and aspect), amber where you need a good reason. Falls back to slope-angle shading when there is no rating.
- **Red skull pins**: recent avalanches, from the daily bulletin and from riders. Show slides from this week, this month or this season (since 1 November), set in Settings.
- **Black pins**: known slide paths. Seeded from JAN's fatal-incident database, plus rider reports.
- **Rider reports** use the standard observation fields: size 1–5, avalanche type, trigger, aspect, elevation, slope, crown depth, width, run length, bed surface, involvement, injuries, and how the reporter knows. Elevation, slope and aspect auto-fill from the elevation data.
- **Verification and trust**: other riders confirm or dispute a pin. 1 confirmation = Confirmed, 3+ = Trusted, more disputes than confirmations = Disputed. You can't verify your own pin.
- **Sharing**: pins live on the phone. Settings → Share my pins sends a file; your mate imports it, verifies, and sends theirs back. Imports merge and never duplicate.
- **Handy places** from OpenStreetMap: onsens (♨), parking, huts, lift stations, konbini, hospitals, koban.
- **GPS readout**: your elevation, slope, aspect, band and that band's rating.

## Put it online (GitHub Pages, free)

1. Create a **public** repository called `backcountrypowderpigs` on github.com.
2. Upload every file in this folder (keep the folders).
3. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save**.
4. After a minute it's live at `https://backcountrypowderpigs.github.io/backcountrypowderpigs/`.
5. On your phone open that link, then **Share → Add to Home Screen** (iPhone) or **Install app** (Android).
6. On Wi-Fi, tap the download button and save the areas you're riding.

## Adding a built-in area

Edit `data/areas.json`: copy an entry, give it a new `id`, a box (`bounds: [[south, west], [north, east]]`), the JAN `region` whose bulletin covers it, band heights, and any resort links. Regions are listed at the top of that file. Seed known slide paths for it in `data/known-slides.json`.

## Latest satellite setup

1. Free account at dataspace.copernicus.eu.
2. Sentinel Hub dashboard → Configuration Utility → copy the Simple WMS instance ID.
3. In the app: Settings → Latest satellite → paste → Save.

## How the daily brief gets updated

`data/bulletins.json` is the only file that changes. It is keyed by JAN region (hakuba, myoko, kagura, niseko, daisetsu, tateyama), not by riding area, because several areas share one bulletin. During the season a scheduled Claude task reads each JAN bulletin every morning, writes the ratings, problems (aspect/elevation zones), a short summary and any reported avalanches with approximate positions into that file, and pushes it to this repo. The app fetches it every time it's opened with signal and keeps the last copy for offline use.

Format per region:

```json
{
  "status": "current",
  "issued": "2026-12-20T05:30:00+09:00",
  "url": "https://data.nadare.jp/avalanche_informations/12345?locale=en",
  "ratings": { "alp": 3, "tl": 3, "btl": 2 },
  "summary": "Short paraphrase of the travel advice.",
  "problems": [
    { "type": "Wind slab", "likelihood": "Likely", "size": "1-2",
      "zones": { "alp": ["NE","E"], "tl": ["NE","E"], "btl": [] } }
  ],
  "recentAvalanches": [
    { "id": "jan-2026-12-20-1", "date": "2026-12-19", "lat": 36.7, "lon": 137.8, "approx": true,
      "place": "Happo-one, north-facing gully", "size": "2", "type": "Storm slab", "trigger": "Natural",
      "aspect": "N", "elevation": 1800, "involvement": "Nobody caught", "source": "JAN bulletin 20 Dec 2026" }
  ]
}
```

Ratings: 0 none, 1 Low, 2 Moderate, 3 Considerable, 4 High, 5 Extreme.

## Danger shading rules

- High or Extreme in a band: every slope 27° or steeper in that band is red.
- Considerable: 30°+ slopes on aspects the problems flag are red; other 30°+ slopes are amber.
- Moderate: 30°+ slopes on flagged aspects are amber.
- Runout zones below steep ground are **not** shaded and can still be hit.

Elevation bands: Hakuba uses JAN's guide (treeline about 1,900–2,200 m). All other areas are estimates; change them in Settings.

## Data sources

Topo and elevation: Geospatial Information Authority of Japan (GSI). Places, lifts and runs: © OpenStreetMap contributors. Satellite: contains modified Copernicus Sentinel data. Bulletins and incident records: Japan Avalanche Network (nadare.jp), summarised with links back. This app is a planning aid. It does not replace avalanche training, a beacon, shovel and probe, or judgement on the day.
