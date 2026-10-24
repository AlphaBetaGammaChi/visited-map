# visited-map — project notes

Static GitHub Pages app for ticking off visited places — Leaflet map with
branded pins, searchable checklist, stats table, and an eBird-style UK
council-area choropleth. 100% static: no build step, no backend, no API keys.

- Repo: `https://github.com/AlphaBetaGammaChi/visited-map`
- Live: `https://alphabetagammachi.github.io/visited-map/`
- Preview locally: `python3 -m http.server 8000` — opening `index.html` via
  `file://` fails because browsers block the JSON fetches.
- There is no test suite or linter; verification is "serve it and click
  through map / checklist / stats / profile export-import".

## Layout

- `index.html`, `css/style.css` — shell + styling (accent colour driven by the
  `--accent` CSS var set per collection).
- `js/app.js` — map, pins, choropleth, checklist, stats, profiles, boot.
- `js/store.js` — storage abstraction; all persistence goes through
  `Store.impl` (currently `LocalStore` = localStorage). To add cloud sync
  later, implement the same interface and swap `Store.impl`.
- `data/collections/<id>.json` — one site array per collection.
- `data/branding.json` — per-collection `title`, `singular`, `color`, `glyph`,
  `description`, `source`.
- `data/index.json` — generated catalogue (site counts + merged branding).
- `data/regions.geojson` — simplified UK local-authority boundaries (~1.4 MB).
- `data/lad.json`, `data/lgd.json` — raw ONS boundary inputs (gitignored,
  auto-downloaded by `--fetch`).
- `data/raw/` — raw Overpass responses (gitignored).
- `scripts/build_data.py` — stdlib-only data pipeline.

## Collections (current)

| id | sites | notes |
|---|---|---|
| `rspb` | 172 | OSM `operator`/`name` match, facilities filtered out |
| `national-trust` | 748 | heavy name/tag filtering (car parks, hides, shops) |
| `embassies` | 175 | London-only query; flag emoji from `country` tag |
| `costa` | 2,381 | OSM coverage incomplete — treat as best-effort |

## Adding a collection

1. `data/collections/<id>.json` — array of
   `{id, name, lat, lon, region, addr?, flag?, osm?}`.
2. Entry in `data/branding.json`.
3. Rerun `python3 scripts/build_data.py` (merges branding into `index.json`)
   or add the `index.json` entry by hand.
4. For OSM-sourced data: add a `SOURCES[<id>]` Overpass query and a
   `BUILDERS[<id>]` filter function in `scripts/build_data.py`.

`region` must match a feature `properties.name` in `data/regions.geojson` to
count on the choropleth and stats table; use `""` to skip. Per-site `flag`
overrides the collection glyph (used by embassies for country flags).

## Rebuilding data

```sh
python3 scripts/build_data.py --fetch   # fresh Overpass + boundary downloads
python3 scripts/build_data.py           # rebuild from data/raw/ cache
```

## Gotchas

- **UK assumptions are hardcoded**: `UK_BOUNDS` in `app.js`, the regions layer
  is UK LADs/NI LGDs, and `embassies` special-cases London bounds in both
  `setMode` and `loadCollection`. Anything global needs these generalised.
- Pin alignment: markers use `iconAnchor: [15,30]` in `siteIcon`; do NOT
  re-add a CSS transform on `.pin` — that was a past double-offset bug.
- The builder regexes (`RSPB_EXCLUDE`, `NT_DROP_NAME`, `EMBASSY_DROP`) are
  deliberately aggressive; tightening or loosening them changes site counts —
  sanity-check counts after editing.
- `region_for` does point-in-polygon over ~390 LAD polygons per site; it's
  fine at current sizes but would be slow for a large global dataset.
- Profiles/visits are per-browser localStorage; export/import JSON
  (`version: 1` payload) is the only cross-device path.
- Visits are keyed `visits[profileId][collectionId][siteId] = isoTimestamp` —
  keep site `id`s stable or visit history orphans.

## In progress / planned

- Global collections: `data/countries.geo.json` (world countries, ~250 KB)
  is downloaded but not yet wired in. Plan: per-collection `scope`
  (`uk`/`world`), a country-level regions layer for world collections, WWT
  (~10 sites), possibly Starbucks (dataset size TBD — fallback: UNESCO sites
  or capital cities), and a small global demo collection.
