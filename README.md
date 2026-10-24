# Visited Map

A static web app for ticking off places you've visited — RSPB reserves,
National Trust properties, London embassies, coffee chains, or **any category
you add** — shown on a map with branded pins, an eBird-style regional
choropleth, a checklist and a stats table.

## Features

- **Personal profiles** — multiple named profiles stored in the browser
  (localStorage), with JSON export/import to move between devices.
- **Any collection** — add a category in the app itself: query OpenStreetMap
  by tag (`brand=Greggs`, `name~Wetherspoons`, `amenity=biergarten`…), upload
  a CSV/JSON list, or paste JSON. No code changes needed.
- **UK & world scope** — UK collections colour a council-area choropleth
  (391 districts incl. London boroughs); world collections colour 180
  countries.
- **Map** — Leaflet + free Carto Voyager tiles (no API key). Pins show the
  collection glyph/flag; visited pins fill with the brand colour and get a
  green tick. Large collections cluster automatically.
- **Regions view** — eBird-profile-style choropleth coloured by visits per
  region, with visited/total tooltips.
- **Checklist** — searchable tick-off list with To visit/Visited filter and
  A–Z/Region/Nearest sort; **Stats** — progress bar, per-region table,
  recent visits. Geolocate button for sorting by distance.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` via `file://` won't work — browsers block JSON fetch.)

## Deploy to GitHub Pages

```sh
git init && git add -A && git commit -m "Initial visited-map site"
gh repo create visited-map --public --source . --push
gh api repos/{owner}/visited-map/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

Or enable **Settings → Pages → Deploy from branch → main / (root)**.
100% static — no build step, no server, no API keys.

## Adding a collection — three ways

### In the app (no code)

Press **＋** in the header. Pick a title, emoji, colour and scope
(UK/world), then either:

- **From OpenStreetMap** — enter a tag `key` and `value` (regex). The app
  queries Overpass directly, e.g. `brand` = `Greggs`, `name` = `WWT|RSPB`,
  `amenity` = `biergarten`.
- **Upload** — CSV or JSON with `name`, `lat`, `lon` (+ optional `addr`,
  `region`, `flag`). GeoJSON FeatureCollections work too.
- **Paste JSON** — `[{"name":"Place","lat":51.5,"lon":-0.1}]`

Sites are auto-assigned to regions (in-browser point-in-polygon) and saved
in localStorage — they persist like built-in collections.

### Via config (shipped with the site)

Edit `collections.config.json` — each collection is a declarative entry:

```json
{
  "id": "greggs", "title": "Greggs", "singular": "shop",
  "color": "#00569e", "glyph": "🥐", "scope": "uk",
  "source": {"type": "overpass", "area": "gb",
             "query": "nwr[\"brand\"~\"Greggs\",i](area.gb);"},
  "fixed_name": "Greggs", "region_suffix": true, "dedupe": "city-coord"
}
```

or hand-curated:

```json
{"source": {"type": "inline",
            "sites": [{"name": "WWT Slimbridge", "lat": 51.7409, "lon": -2.4017}]}}
```

Filter keys (`exclude_name`, `exclude_tags`, `require`, `drop_tags`…) are
documented at the top of `scripts/build_data.py`. Then:

```sh
python3 scripts/build_data.py --fetch   # download fresh OSM + boundaries
python3 scripts/build_data.py           # rebuild from data/raw/ cache
```

### Data sources

Site data: OpenStreetMap (© OSM contributors, ODbL) via Overpass — coverage
is best-effort (e.g. Costa/Starbucks are under-mapped). Regions: ONS
local-authority districts + NI LGDs (via martinjc/UK-GeoJSON) for `uk`
scope, and johan/world.geo.json countries for `world` scope.

## Architecture

- `js/store.js` — storage abstraction (`Store.impl`). `LocalStore` today;
  a cloud backend (e.g. Firebase) only needs to implement the same async
  interface.
- `js/app.js` — map, checklist, stats, profiles, custom collections.
- `scripts/build_data.py` — config-driven data pipeline (stdlib + curl).
- `collections.config.json` — the single source of truth for shipped
  collections (branding + query + filters).
