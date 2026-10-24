#!/usr/bin/env python3
"""Build the datasets for visited-map.

Driven entirely by collections.config.json — adding a collection means adding
a config entry, not Python. Each entry declares:

  id, title, singular, color, glyph, scope ("uk" | "world"), description
  source:
    {"type": "overpass", "area": "gb"|"london"|null, "query": "<QL fragment>"}
    {"type": "inline",   "sites": [{"name","lat","lon", ...}]}

Optional filters applied to OSM elements (all regexes, case-insensitive):
  require_name_match  - name+operator must match
  exclude_name        - drop elements whose name matches
  exclude_tags        - {key: regex} hard drop when tag matches
  exclude_tags_soft   - {key: regex} drop unless a tag in exclude_soft_unless
  require.any_tags    - element must have one of these tags …
  require.tag_in      - … or have key=value in this map …
  require.building_needs - … or be a building with one of these tags
  require.if_tags     - the require rule only applies when one of these is set
  drop_tags           - {"tags": [...], "unless": [...]}

Optional shaping:
  flag_tag            - ISO country tag -> site.flag emoji
  addr                - build site.addr from addr:housenumber + addr:street
  fixed_name          - override OSM name
  region_suffix       - append " · <region>" to the display name
  name_fallback_tag / name_fallback_prefix - synthesise a name when absent
  dedupe              - "name" (default) | "city-coord"
  dedupe_strip        - regex stripped before name dedupe

Usage:
    python3 scripts/build_data.py            # rebuild from data/raw/ cache
    python3 scripts/build_data.py --fetch    # download fresh data first

Writes:
    data/collections/<id>.json
    data/regions.geojson        (UK council areas)
    data/regions-world.geojson  (world countries)
    data/index.json             (collection catalogue)
"""

import json
import math
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "raw")
COLLECTIONS_DIR = os.path.join(DATA, "collections")
CONFIG = os.path.join(ROOT, "collections.config.json")

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "visited-map-data-builder/1.0 (github pages site; contact: repo owner)"}

AREAS = {
    "gb": 'area["ISO3166-1"="GB"][admin_level=2]->.gb;',
    "london": 'rel(175342)->.l;.l map_to_area->.lon;',
}

# Boundary sources -> which region set they feed.
REGION_FILES = {
    "uk": [
        (os.path.join(DATA, "lad.json"), "LAD13CD", "LAD13NM"),
        (os.path.join(DATA, "lgd.json"), "LGDCode", "LGDNAME"),
    ],
    "world": [
        (os.path.join(DATA, "countries.geo.json"), "id", "name"),
    ],
}

REGION_OUT = {"uk": "regions.geojson", "world": "regions-world.geojson"}

BOUNDARY_URLS = {
    "lad.json": "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/gb/lad.json",
    "lgd.json": "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/ni/lgd.json",
    "countries.geo.json": "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json",
}

# eps per scope: UK districts need more detail than world countries
SIMPLIFY_EPS = {"uk": 0.002, "world": 0.02}


# ------------------------------------------------------------------ fetch

def fetch_overpass(cid, src):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, f"{cid}.json")
    area_decl = AREAS.get(src.get("area") or "", "")
    ql = f"[out:json][timeout:240];\n{area_decl}\n{src['query']}\nout center tags;"
    print(f"fetching {cid} ...", flush=True)
    r = subprocess.run(
        ["curl", "-sf", "-m", "280", "-X", "POST", OVERPASS,
         "-A", UA["User-Agent"], "--data-urlencode", "data=" + ql, "-o", path],
        check=False)
    if r.returncode != 0 or not os.path.exists(path):
        print(f"  !! overpass fetch failed for {cid} (exit {r.returncode}) — skipping")
        if os.path.exists(path):
            os.remove(path)
        return
    print(f"  {os.path.getsize(path)/1e6:.1f} MB -> {path}", flush=True)
    time.sleep(5)  # politeness — do not remove


def fetch_boundaries():
    for fname, url in BOUNDARY_URLS.items():
        path = os.path.join(DATA, fname)
        if not os.path.exists(path):
            print(f"fetching boundaries {fname} ...", flush=True)
            subprocess.run(["curl", "-sfL", "-m", "300", url, "-o", path], check=True)


# ---------------------------------------------------------------- regions

COUNTRY_OF = {"E": "England", "W": "Wales", "S": "Scotland", "N": "Northern Ireland"}


# the NI LGD source mislabels Ards and North Down
REGION_NAME_FIXES = {"East Coast": "Ards and North Down"}


def load_regions(scope):
    regions = []
    for path, code_key, name_key in REGION_FILES[scope]:
        with open(path) as f:
            g = json.load(f)
        for feat in g["features"]:
            p = feat["properties"]
            code = str(p.get(code_key) or p.get(name_key))
            country = COUNTRY_OF.get(code[0], "") if scope == "uk" else ""
            name = REGION_NAME_FIXES.get(p[name_key], p[name_key])
            regions.append((code, name, country, feat["geometry"]))
    return regions


def polys_of(geom):
    return geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            xcross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xcross:
                inside = not inside
        j = i
    return inside


def bbox_of(geom):
    xs, ys = [], []
    for poly in polys_of(geom):
        for ring in poly:
            for pt in ring:
                xs.append(pt[0])
                ys.append(pt[1])
    return (min(xs), min(ys), max(xs), max(ys))


def region_for(lat, lon, regions, bbox_cache):
    for gid, name, country, geom in regions:
        bb = bbox_cache.setdefault(gid, bbox_of(geom))
        if not (bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3]):
            continue
        for poly in polys_of(geom):
            if point_in_ring(lon, lat, poly[0]):
                return gid, name
    return None, None


# ------------------------------------------------------------- simplify

def dp(points, eps):
    if len(points) < 3:
        return points
    ax, ay = points[0]
    bx, by = points[-1]
    dx, dy = bx - ax, by - ay
    denom = math.hypot(dx, dy) or 1e-12
    worst, worst_i = -1, -1
    for i in range(1, len(points) - 1):
        px, py = points[i]
        dist = abs((px - ax) * dy - (py - ay) * dx) / denom
        if dist > worst:
            worst, worst_i = dist, i
    if worst <= eps:
        return [points[0], points[-1]]
    return dp(points[: worst_i + 1], eps)[:-1] + dp(points[worst_i:], eps)


def simplify_ring(ring, eps):
    """DP on a closed ring — split at the farthest point so the baseline is
    non-zero (otherwise rings collapse to a point)."""
    if len(ring) < 6:
        return ring
    pts = ring[:-1] if ring[0] == ring[-1] else list(ring)
    ax, ay = pts[0]
    k = max(range(1, len(pts)), key=lambda i: (pts[i][0] - ax) ** 2 + (pts[i][1] - ay) ** 2)
    out = dp(pts[: k + 1], eps)[:-1] + dp(pts[k:] + [pts[0]], eps)[:-1]
    out.append(out[0])
    return out


def simplify_geom(geom, eps, prec=4):
    polys = []
    for poly in polys_of(geom):
        rings = []
        for ring in poly:
            pts = simplify_ring(ring, eps)
            if len(pts) >= 4:
                rings.append([[round(p[0], prec), round(p[1], prec)] for p in pts])
        if rings:
            polys.append(rings)
    if geom["type"] == "MultiPolygon":
        return {"type": "MultiPolygon", "coordinates": polys}
    return {"type": "Polygon", "coordinates": polys[0] if polys else []}


# ----------------------------------------------------------------- sites

def norm_name(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def centroid(el):
    if "lat" in el:
        return el["lat"], el["lon"]
    c = el.get("center")
    return (c["lat"], c["lon"]) if c else (None, None)


FLAG_OVERRIDES = {"UK": "GB", "EN": "GB", "EL": "GR", "PALESTINE": "PS"}


def flag_emoji(iso):
    if not iso:
        return ""
    iso = FLAG_OVERRIDES.get(iso.upper(), iso.upper())
    if len(iso) != 2 or not iso.isalpha():
        return ""
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in iso)


def addr_of(t):
    return " ".join(filter(None, [t.get("addr:housenumber", ""), t.get("addr:street", "")])).strip()


def passes(cfg, t, name):
    exc_name = cfg.get("exclude_name")
    if exc_name and re.search(exc_name, name, re.I):
        return False
    for key, pat in (cfg.get("exclude_tags") or {}).items():
        if key in t and re.search(pat, t.get(key, ""), re.I):
            return False
    unless = cfg.get("exclude_soft_unless", [])
    for key, pat in (cfg.get("exclude_tags_soft") or {}).items():
        if key in t and re.search(pat, t.get(key, ""), re.I) and not any(u in t for u in unless):
            return False
    dt = cfg.get("drop_tags")
    if dt and any(k in t for k in dt["tags"]) and not any(u in t for u in dt["unless"]):
        return False
    req = cfg.get("require")
    if req:
        gated = req.get("if_tags")
        if gated is None or any(k in t for k in gated):
            ok = any(k in t for k in req.get("any_tags", []))
            if not ok:
                for k, vals in req.get("tag_in", {}).items():
                    if t.get(k) in vals:
                        ok = True
                        break
            if not ok and "building" in t and any(u in t for u in req.get("building_needs", [])):
                ok = True
            if not ok:
                return False
    return True


def build_sites(cid, cfg, els):
    sites, seen = [], set()
    dedupe = cfg.get("dedupe", "name")
    strip = cfg.get("dedupe_strip")
    for el in els:
        t = el.get("tags", {})
        name = (cfg.get("fixed_name") or t.get("name") or t.get("name:en") or "").strip()
        if not name and cfg.get("name_fallback_tag"):
            fb = t.get(cfg["name_fallback_tag"], "")
            if fb:
                name = cfg.get("name_fallback_prefix", "") + fb.title()
        if not name:
            continue
        if cfg.get("require_name_match") and not re.search(
            cfg["require_name_match"], name + " " + t.get("operator", ""), re.I
        ):
            continue
        if not passes(cfg, t, name):
            continue
        lat, lon = centroid(el)
        if lat is None:
            continue
        if dedupe == "city-coord":
            key = (norm_name(t.get("addr:city") or t.get("addr:town") or ""),
                   round(lat, 3), round(lon, 3))
        else:
            key = norm_name(re.sub(strip, "", name, flags=re.I) if strip else name)
        if key in seen:
            continue
        seen.add(key)
        sid = key if isinstance(key, str) and key else f"{round(lat,4)}-{round(lon,4)}"
        site = {
            "id": f"{cid}-{sid}",
            "name": name,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "osm": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
        }
        if cfg.get("flag_tag"):
            site["flag"] = flag_emoji(t.get(cfg["flag_tag"], ""))
        if cfg.get("addr") and addr_of(t):
            site["addr"] = addr_of(t)
        sites.append(site)
    return sites


# ------------------------------------------------------------------ main

def main():
    with open(CONFIG) as f:
        collections = json.load(f)["collections"]

    if "--fetch" in sys.argv:
        fetch_boundaries()
        for c in collections:
            if c["source"]["type"] == "overpass":
                fetch_overpass(c["id"], c["source"])

    os.makedirs(COLLECTIONS_DIR, exist_ok=True)
    region_sets = {scope: load_regions(scope) for scope in REGION_FILES
                   if all(os.path.exists(p) for p, _, _ in REGION_FILES[scope])}
    bbox_cache = {}
    index = []

    for c in collections:
        cid, scope = c["id"], c.get("scope", "uk")
        src = c["source"]
        if src["type"] == "inline":
            sites = [
                {"id": f"{cid}-{norm_name(s['name'])}", "name": s["name"],
                 "lat": s["lat"], "lon": s["lon"], "osm": s.get("osm", "")}
                for s in src["sites"]
            ]
        else:
            raw_path = os.path.join(RAW, f"{cid}.json")
            if not os.path.exists(raw_path):
                print(f"!! {raw_path} missing, skipping {cid} (run with --fetch)")
                continue
            with open(raw_path) as f:
                els = json.load(f)["elements"]
            sites = build_sites(cid, c, els)

        regions = region_sets.get(scope, [])
        for s in sites:
            gid, region = region_for(s["lat"], s["lon"], regions, bbox_cache)
            s["region"] = region or ""
            if c.get("region_suffix") and s["region"]:
                s["name"] += " · " + s["region"]
        sites.sort(key=lambda s: s["name"].lower())

        out = os.path.join(COLLECTIONS_DIR, f"{cid}.json")
        with open(out, "w") as f:
            json.dump(sites, f, separators=(",", ":"), ensure_ascii=False)
        print(f"{cid}: {len(sites)} sites -> {out}")

        index.append({
            "id": cid, "count": len(sites), "title": c["title"],
            "singular": c.get("singular", "place"), "color": c["color"],
            "glyph": c.get("glyph", "📍"), "scope": scope,
            **({"bounds": c["bounds"]} if c.get("bounds") else {}),
            "description": c.get("description", ""),
            "source": "OpenStreetMap contributors" if src["type"] == "overpass" else "curated",
        })

    with open(os.path.join(DATA, "index.json"), "w") as f:
        json.dump(index, f, indent=1, ensure_ascii=False)

    for scope, regions in region_sets.items():
        eps = SIMPLIFY_EPS[scope]
        feats = [{
            "type": "Feature",
            "properties": {"id": gid, "name": name, "country": country},
            "geometry": simplify_geom(geom, eps),
        } for gid, name, country, geom in regions]
        rpath = os.path.join(DATA, REGION_OUT[scope])
        with open(rpath, "w") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f,
                      separators=(",", ":"), ensure_ascii=False)
        print(f"{scope} regions: {len(feats)} -> {rpath} ({os.path.getsize(rpath)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
