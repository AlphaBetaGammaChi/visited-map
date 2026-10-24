# Visited Map

A static web app for ticking off places you've visited — RSPB reserves,
National Trust properties, London embassies, Costa shops, or anything else you
add — shown on a map with branded pins, an eBird-style regional choropleth,
a checklist and a stats table.

![screenshot](docs/screenshot.png)

## Features

- **Personal profiles** — multiple named profiles stored in the browser
  (localStorage), with JSON export/import to move between devices.
- **Collections** — each collection is a JSON file of sites. Ships with RSPB
  reserves, National Trust, London embassies and Costa Coffee; add your own by
  dropping a file in `data/collections/` and an entry in `data/branding.json`.
- **Map** — Leaflet + free Carto Voyager tiles (no API key). Sites show as
  pins with the collection glyph; visited pins fill with the brand colour and
  get a green tick. Large collections cluster automatically.
- **Regions view** — eBird-profile-style choropleth: UK counties/unitary
  authorities coloured by how many sites you've visited, with visited/total
  tooltips.
- **Checklist** — searchable tick-off list of every site.
- **Stats** — life-list total with progress bar, per-region table, and a
  recent-visits list.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` won't work — browsers block the
JSON fetches.)

## Deploy to GitHub Pages

```sh
git init && git add -A && git commit -m "Initial visited-map site"
gh repo create visited-map --public --source . --push
gh api repos/{owner}/visited-map/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

Or push to any repo and enable **Settings → Pages → Deploy from branch →
main / (root)**. The site is 100% static — no build step, no server.

## Adding a collection

Create `data/collections/my-list.json`:

```json
[
  {"id": "my-1", "name": "Some Place", "lat": 51.5, "lon": -0.1,
   "region": "Greater London", "addr": "1 High St"}
]
```

`region` must match a region `name` in `data/regions.geojson` to count on the
choropleth (leave it `""` to skip). Optional `flag` field overrides the
collection glyph per site.

Add an entry in `data/branding.json` (`title`, `color`, `glyph`, `singular`),
then either rerun `python3 scripts/build_data.py` (which merges branding into
`data/index.json`) or add the entry to `data/index.json` by hand.

## Rebuilding the datasets

```sh
python3 scripts/build_data.py --fetch   # download fresh OSM data (Overpass)
python3 scripts/build_data.py           # rebuild from data/raw/*.json cache
```

Site data comes from OpenStreetMap (© OSM contributors, ODbL) via Overpass;
region boundaries are ONS local-authority districts + NI LGDs (via
[martinjc/UK-GeoJSON](https://github.com/martinjc/UK-GeoJSON)), simplified by
the script. Costa locations in OSM are incomplete — treat that collection as
best-effort.

## Architecture

- `js/store.js` — storage abstraction. All persistence goes through the
  `Store.impl` interface; `LocalStore` is the browser implementation. To add
  real cloud accounts later (e.g. Firebase Auth + Firestore), implement the
  same interface and set `Store.impl = FirebaseStore`.
- `js/app.js` — map, checklist, stats, profiles.
- `scripts/build_data.py` — data pipeline (stdlib only).
