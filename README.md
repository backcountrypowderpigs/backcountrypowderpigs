# Backcountry Powder Pigs

Backcountry avalanche map for Japan. Built-in areas: Hakuba, Myoko, Lotte Arai, Charmant Hiuchi, Kagura, Niseko, Rusutsu, Kiroro, Furano, Asahidake. Riders can add their own. Runs in the phone browser and installs to the home screen. Works offline in the areas you download.

## What it does

- **GSI topo map** (国土地理院) with 10 m elevation data underneath.
- **Area packs**: download only the areas you ride. Each pack includes the GSI HD aerial photo as an offline backup. Standard (to zoom 15) is roughly 25–65 MB per area, Detailed (to zoom 16) roughly 80–250 MB. Nothing else is stored.
- **Your own areas**: Area menu → Add your own area. Frame it on the map, name it, pick the nearest JAN bulletin and band heights. Every area (built-in or yours) has Adjust box. Your areas travel with your shared pins file.
- **Zoom**: down to a 10 m scale bar. Satellite mode switches to the sharp GSI aerial photo when you zoom in close (summer imagery, can be a few years old), and back to the latest Sentinel-2 pass when you zoom out. Close-up slope and aspect shading uses the 5 m GSI elevation survey where it exists (most mountain areas).
- **Map**: three choices in Layers. **Latest satellite**: the newest clear Sentinel-2 pass over the area (10 m, for current snow cover; free from Microsoft Planetary Computer, no account). **HD photo**: GSI's sharp aerial photo (summer, can be a few years old) for close-up detail. **Topo**: GSI topo, which also sits under the satellite so gaps or no signal never show black, and is what works offline.
- **Aspect overlay** (compass button, or Layers → Aspect overlay): its own on/off layer that works alone or on top of danger or slope shading. Slopes 20°+ coloured by the way they face (N blue, E green, S yellow, W red and the in-betweens). "Match today's report" makes the aspects and heights the bulletin flags strong and the rest faint, for route planning. Tap aspects on or off.
- **English labels** over the map: ski resorts, peaks with height, passes, ridges, valleys, villages and lakes, English with the Japanese underneath. Where OpenStreetMap has no English name, the label says what it is (Peak, Ridge, Pass). Layers also has a Japanese map-word glossary, since the topo map's own printing is Japanese.
- **Routes**: plan a route by tapping the map (distance, climb, descent, Munter touring time, elevation profile, steepest slope and how much is on 30°+). Planned routes are dashed magenta.
- **Steep sections on planned routes** glow under the line: amber = steep (skin 20–25° / ride 35–40°), red = very steep (skin 25–30°, kick turns / ride 40–45°), purple = boot-pack (skin 30°+ / ride 45°+). Uphill uses the route's own grade; downhill uses the slope of the ground. The route panel shows steepest skin, steepest ride, how far is over 20°, and how much is on 30°+ avalanche terrain.
- **Tracks**: record your trip (time, moving time, distance, climb, descent), saved as you go. Keep or discard at the end. Recorded tracks are solid electric blue. Share any route or track as GPX, or import GPX from mates, CalTopo or Gaia. Keep the app open while recording; phones pause GPS for web apps when the screen locks.
- **Hazard and handy markers**: rocks, cliff / drop-off, cornice, avalanche debris, open creek, tree wells, ice, no entry, regroup / safe spot, good snow. Amber = hazard, red = keep out, blue = water, green = good to know. Temporary ones fade after two weeks. Verified and shared like slide pins.
- **Help**: the ? button at the top opens a basic guide; it also shows the first time the app opens.
- **Lifts and runs** from OpenStreetMap, with the ski resort named in each lift's popup (green easy, red intermediate, black advanced), saved with the area pack.
- **Avalanche brief** per area: danger rating for alpine, treeline and below treeline, the avalanche problems drawn as JAN-style aspect roses, a short summary, recent avalanches from the report, and links to the full bulletin.
- **Danger shading**: red on steep slopes the bulletin says to stay off (by elevation band and aspect), amber where you need a good reason. Falls back to slope-angle shading when there is no rating.
- **Black pins**: recent avalanches, from the daily bulletin and from riders. Show slides from this week, this month or this season (since 1 November), set in Settings.
- **Red skull pins**: known slide paths and past incidents. Seeded from JAN's fatal-incident database, plus rider reports.
- **Rider reports** use the standard observation fields: size 1–5, avalanche type, trigger, aspect, elevation, slope, crown depth, width, run length, bed surface, involvement, injuries, and how the reporter knows. Elevation, slope and aspect auto-fill from the elevation data.
- **Verification and trust**: other riders confirm or dispute a pin. 1 confirmation = Confirmed, 3+ = Trusted, more disputes than confirmations = Disputed. You can't verify your own pin.
- **Sharing by link**: send a route, track or marker (or pick several) from its panel, the Routes sheet or Settings. The app makes a link with everything packed inside it (no server or account) and opens your phone's share menu, so you can send it by text, LINE, WhatsApp or email. Your mate taps it and chooses Add to my map. Nothing is duplicated if they get it twice. On iPhone, links open in Safari, so to add to the home-screen app copy the link and paste it in Settings → Got a link? Paste it here. Pins can still be shared as a file too.
- **Natural mountain onsens** (teal ♨): wild and hike-in hot springs such as Renge, Hakuba Yari, Tsubame's Ogon-no-yu and Kawara-no-yu, Nakadake and Akayu, with season, access and notes. Listed in `data/natural-onsens.json` (add more there), plus any natural hot spring mapped on OpenStreetMap.
- **Handy places** from OpenStreetMap: town onsens (orange ♨), parking, huts, lift stations, konbini, hospitals, koban.
- **Route checks**: planned routes glow amber/red/purple on steep climbs and descents, and ! flags mark 45°+ ground, red danger shading and hazard markers within 30 m. On a red or purple climb, **Suggest a gentler line** finds a lower-angle path (dotted green) from the elevation data; tap Use it or Keep mine. It only knows the slope, not cliffs, trees, creeks or snow, so check it with your own eyes.
- **Track recording with activities**: pick how you're going up (snowshoes, splitboard, verts, bootpack). The app works out breaks (stopped 1 min+), riding (fast and dropping), bootpack/verts (a climb steeper than your setting, 20° default, after a stop) and transitions (a break where the activity changes). Each has its own line: blue dashed snowshoe, blue dash-dot skin, purple dotted bootpack, purple dashed verts, solid orange riding; white dots for breaks, orange ⇄ for transitions. Force it while recording (Auto / Climb / Boot / Ride), and fix any section afterwards.
- **English for the topo map's names**: every name GSI prints (valleys, creeks, gullies, ridges, passes, peaks, waterfalls, settlements) is shown in English under the Japanese, from GSI's vector map (built into `data/labels/` by an Action). Readings are approximate; tap a name for the Japanese to show rescuers.
- **SOS (bottom left)**: works without signal. Your coordinates (decimal and degrees-minutes-seconds), height, the nearest named creek, peak and village with distance and direction, call buttons for 110 (police, mountain rescue) and 119 (fire, ambulance), and a ready-made Japanese message to read out or show.
- **Refresh (left side)**: pulls today's avalanche report and riders' new hazards, pins and tracks without updating the app.
- **GPS readout**: your elevation, slope, aspect, band and that band's rating.

## Put it online (GitHub Pages, free)

1. Create a **public** repository called `backcountrypowderpigs` on github.com.
2. Upload every file in this folder (keep the folders).
3. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save**.
4. After a minute it's live at `https://backcountrypowderpigs.github.io/backcountrypowderpigs/`.
5. On your phone open that link, then **Share → Add to Home Screen** (iPhone) or **Install app** (Android).
6. On Wi-Fi, tap the download button and save the areas you're riding.

## Live sync (everyone's pins on every phone)

Through a free Google Firebase (Firestore) database, whenever a phone has signal; with no signal the app works as normal and catches up later.
- **Everyone:** slide reports, slide paths, hazard markers, checks, and any route or track whose owner picks "Everyone".
- **Your crew only:** good-snow markers, and routes and tracks set to "My crew" (the default for new ones once you're in a crew). Start a crew in Settings and send the invite link; friends tap it to join.
- **Just me:** routes and tracks set to "Just me" never leave the phone.

Each phone signs in anonymously, and `firestore.rules` only lets a phone change or delete its own things. Crew data is only readable with the crew code from the invite. Riders can turn sync off in Settings.

**Backup:** everything on a phone (all pins, every route and track including "Just me" ones, and settings) is also backed up privately under that phone's secret backup code, shown in Settings → Backup. App updates never touch saved data; the backup is for a lost or new phone, or after deleting the home-screen app. Restore by typing the code in Settings → Backup. There's also a backup file option that works with no signal.

Setup (once):
1. console.firebase.google.com → Add project (Analytics off).
2. Build → Authentication → Get started → Sign-in method → Anonymous → Enable.
3. Build → Firestore Database → Create database → location `asia-northeast1` (Tokyo) → Production mode. Then the Rules tab: paste `firestore.rules` → Publish.
4. Project settings (gear) → Your apps → Web `</>` → register (no hosting). Copy `apiKey` and `projectId` into `data/sync.json`.

The free plan (50,000 reads and 20,000 writes a day) is far more than a crew needs. The web API key is public by design; the rules are what protect the data.

## Adding a built-in area

Edit `data/areas.json`: copy an entry, give it a new `id`, a box (`bounds: [[south, west], [north, east]]`), the JAN `region` whose bulletin covers it, band heights, and any resort links. Regions are listed at the top of that file. Seed known slide paths for it in `data/known-slides.json`.

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
