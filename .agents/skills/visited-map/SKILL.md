---
name: visited-map
description: >-
  Use this skill when working on the visited-map static site (a visited-places
  tracker with a Leaflet map, branded pins, searchable checklist, stats, and
  UK/world choropleths) — adding or debugging collections, editing
  index.html / js/app.js / js/store.js / css / collections.config.json,
  rebuilding data via scripts/build_data.py and Overpass, or extending the
  in-browser "add collection" feature.
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
  - write
---

# visited-map runbook

Repo root: this project. Live site:
`https://alphabetagammachi.github.io/visited-map/`. Fully static — no build,
no backend, no keys. Project notes: `AGENTS.md`; user docs: `README.md`.

## Verify changes

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

`file://` will NOT work (JSON fetches blocked). There is no test suite —
manually click through: collection tabs, pins ↔ regions toggle, checklist
tick/untick, stats table, profile create/switch/export/import, and the ＋
add-collection modal (OSM query / upload / paste). Check the browser console
for fetch errors.

## Architecture contract (preserve these invariants)

1. **`Store.impl` is the only persistence boundary** (`js/store.js`). All
   profile/visit reads and writes go through it — `LocalStore` (localStorage)
   today; a cloud backend must implement the same async interface.
2. **Visit shape**: `visits[collectionId][siteId] = isoTimestamp`, stored per
   profile under `vm:visits:<profileId>`. Keep site `id`s stable across
   rebuilds — renaming ids orphans users' ticked visits.
3. **Static data contract**: `data/index.json` drives the collection tabs;
   `data/collections/<id>.json` is fetched lazily per tab; each collection
   has `scope` ("uk"|"world") selecting its choropleth layer —
   `data/regions.geojson` (391 UK districts) or
   `data/regions-world.geojson` (180 countries), joined by
   `properties.name` === site `region` string.
4. **Collections are config-driven**: `collections.config.json` is the single
   source of truth (branding + Overpass query + filters). Never add
   per-collection Python to `scripts/build_data.py` — extend the generic
   filter keys instead (documented at the top of the script).
5. **Custom (user) collections** live in localStorage:
   `vm:customcollections` = meta list, `vm:customsites:<id>` = sites.
   `custom: true` on the meta; site ids start `osm-` or `row-`.
6. **Escaping**: anything rendered from site/profile data goes through
   `esc()` in `app.js` — keep it that way (OSM names contain markup).

## Common tasks

### Add a shipped collection

1. Add an entry to `collections.config.json` — `source.type` is `overpass`
   (QL fragment, `area: "gb"|"london"|null`) or `inline` (literal sites).
   Filters: `require_name_match`, `exclude_name`, `exclude_tags[_soft]`,
   `require` (`any_tags`/`tag_in`/`building_needs`/`if_tags`), `drop_tags`.
   Shaping: `fixed_name`, `region_suffix`, `flag_tag`, `addr`,
   `dedupe` ("name"|"city-coord"), `dedupe_strip`.
2. `python3 scripts/build_data.py --fetch` (politeness delay is built in;
   don't remove the `time.sleep`), or without `--fetch` if
   `data/raw/<id>.json` is already cached.
3. Check the printed site count against expectations — OSM coverage is
   best-effort; say so in `description`.

### Rebuild existing data

```sh
python3 scripts/build_data.py --fetch   # re-download OSM + boundaries
python3 scripts/build_data.py           # from data/raw/ cache only
```

`data/lad.json`/`data/lgd.json`/`data/countries.geo.json`/`data/raw/` are
gitignored; everything else under `data/` is committed (the site needs it).

## Pitfalls (learned the hard way)

- Pin icons: `L.divIcon` with `iconAnchor: [15,30]` — CSS transforms on
  `.pin` caused a double-offset bug before; leave positioning to Leaflet.
- `embassies` declares a London `bounds` in config (not hardcoded bounds in
  JS — `collectionBounds()` falls back to `SCOPE_BOUNDS[scope]`).
- Choropleth colour ramp is `regionColor(visited, max)` — pale→saturated
  accent, eBird-style; `max` is per-collection (intentional).
- `build_data.py` simplifies boundaries with a custom Douglas-Peucker
  (`simplify_ring` splits closed rings at the farthest point — do not
  "simplify" that, it's what stops rings collapsing).
- The NI `lgd.json` source mislabels "Ards and North Down" as "East Coast" —
  fixed via `REGION_NAME_FIXES`, not by editing the data file.
- Overpass rate-limits concurrent queries — the build script sleeps between
  fetches; the in-app OSM add-collection also posts directly to
  `overpass-api.de` (CORS-enabled) and can hit the same limits.
- Python `urllib` to overpass-api.de fails TLS on macOS system Python —
  that's why `fetch_overpass` shells out to `curl`. Keep it.
