#!/usr/bin/env python3
"""Build the datasets for visited-map.

Downloads site locations from OpenStreetMap (Overpass), assigns each site to a
county/unitary-authority region from the bundled GADM GBR level-2 GeoJSON, and
writes:

  data/collections/<id>.json   - one file per collection
  data/regions.geojson         - simplified region boundaries for the choropleth
  data/index.json              - collection catalogue (merged with data/branding.json)

Usage:
    python3 scripts/build_data.py            # rebuild from cached raw files
    python3 scripts/build_data.py --fetch    # download fresh OSM data first

Only needs the Python standard library.
"""

import json
import math
import os
import re
import sys
import time
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "raw")
COLLECTIONS = os.path.join(DATA, "collections")
BOUNDARY_FILES = [
    # (file, code-field, name-field)  — ONS local authority districts via
    # martinjc/UK-GeoJSON (proper names, includes London boroughs) + NI LGDs.
    (os.path.join(DATA, "lad.json"), "LAD13CD", "LAD13NM"),
    (os.path.join(DATA, "lgd.json"), "LGDCode", "LGDNAME"),
]

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "visited-map-data-builder/1.0 (github pages site; contact: repo owner)"}

# ONS boundary files (via martinjc/UK-GeoJSON) — downloaded on demand by --fetch
BOUNDARY_URLS = {
    "lad.json": "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/gb/lad.json",
    "lgd.json": "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/ni/lgd.json",
}

GB_AREA = 'area["ISO3166-1"="GB"][admin_level=2]->.gb;'
LONDON_AREA = 'rel(175342)->.l;.l map_to_area->.lon;'

# Overpass QL per collection. `filter` keys are applied in post-processing.
SOURCES = {
    "rspb": {
        "query": f"""
            [out:json][timeout:240];
            {GB_AREA}
            (
              nwr["operator"~"RSPB|Royal Society for the Protection",i](area.gb);
              nwr["name"~"RSPB",i](area.gb);
            );
            out center tags;""",
    },
    "national-trust": {
        "query": f"""
            [out:json][timeout:240];
            {GB_AREA}
            nwr["operator"~"National Trust",i](area.gb);
            out center tags;""",
    },
    "embassies": {
        "query": f"""
            [out:json][timeout:120];
            {LONDON_AREA}
            (
              nwr["office"="diplomatic"](area.lon);
              nwr["amenity"="embassy"](area.lon);
            );
            out center tags;""",
    },
    "costa": {
        "query": f"""
            [out:json][timeout:240];
            {GB_AREA}
            nwr["name"~"Costa",i]["amenity"~"cafe|fast_food|restaurant"](area.gb);
            out center tags;""",
    },
}


def fetch(name, query):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, f"{name}.json")
    print(f"fetching {name} ...", flush=True)
    r = subprocess.run(
        [
            "curl", "-sf", "-m", "280", "-X", "POST", OVERPASS,
            "-A", UA["User-Agent"],
            "--data-urlencode", "data=" + query,
            "-o", path,
        ],
        check=False,
    )
    if r.returncode != 0 or not os.path.exists(path):
        raise SystemExit(f"overpass fetch failed for {name} (curl exit {r.returncode})")
    size = os.path.getsize(path)
    print(f"  {size/1e6:.1f} MB -> {path}", flush=True)
    time.sleep(5)  # be polite to Overpass


# ---------------------------------------------------------------- regions

COUNTRY_OF = {"E": "England", "W": "Wales", "S": "Scotland", "N": "Northern Ireland"}


def load_regions():
    """Return list of (gid, name, country, geometry) from the ONS boundaries."""
    regions = []
    for path, code_key, name_key in BOUNDARY_FILES:
        with open(path) as f:
            g = json.load(f)
        for feat in g["features"]:
            p = feat["properties"]
            code = p[code_key]
            regions.append((code, p[name_key], COUNTRY_OF.get(code[0], ""), feat["geometry"]))
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


def region_for(lat, lon, regions, bbox_cache):
    for gid, name, country, geom in regions:
        bb = bbox_cache.setdefault(gid, bbox_of(geom))
        if not (bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3]):
            continue
        for poly in polys_of(geom):
            if point_in_ring(lon, lat, poly[0]):
                return gid, name
    return None, None


def bbox_of(geom):
    xs, ys = [], []
    for poly in polys_of(geom):
        for ring in poly:
            for pt in ring:
                xs.append(pt[0])
                ys.append(pt[1])
    return (min(xs), min(ys), max(xs), max(ys))


# ----------------------------------------------------------------- sites

def norm_name(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def elements(path):
    with open(path) as f:
        return json.load(f)["elements"]


def centroid(el):
    if "lat" in el:
        return el["lat"], el["lon"]
    c = el.get("center")
    return (c["lat"], c["lon"]) if c else (None, None)


RSPB_EXCLUDE = re.compile(
    r"shop|office|centre|center|café|cafe|car ?park|depot|garage|warehouse|"
    r"pumping|toilet|headquarters|hide\b|hides\b|trail\b|path\b|entrance|"
    r"gateway|platform|viewing|boardwalk|screen\b|shelter|picnic|"
    r"loop\b|bimble|circular|scout|barn\b|fields\b|"
    r"cottage|workshop|garden|memorial|bench", re.I)


def build_rspb(els):
    sites, seen = [], set()
    for el in els:
        t = el.get("tags", {})
        name = t.get("name", "")
        if not name or RSPB_EXCLUDE.search(name):
            continue
        if not re.search(r"\bRSPB\b|Royal Society", name + " " + t.get("operator", ""), re.I):
            continue
        # drop facilities that aren't reserves (shops, offices, car parks)
        place_tags = ("leisure", "boundary", "natural", "landuse", "water",
                      "wetland", "tourism", "geological")
        facility_tags = ("shop", "office", "amenity")
        if not any(k in t for k in place_tags) and any(k in t for k in facility_tags):
            continue
        key = norm_name(re.sub(r"\b(rspb|nature reserve|reserve|nnr|national)\b", "", name, flags=re.I))
        if key in seen:
            continue
        seen.add(key)
        lat, lon = centroid(el)
        if lat is None:
            continue
        sites.append({
            "id": "rspb-" + key,
            "name": name,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "osm": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
        })
    return sites


# Names that indicate a trail / facility rather than a tickable property.
NT_DROP_NAME = re.compile(
    r"\bwalk\b|\bwalks\b|trail|circular|stroll|ramble|hike|saunter|waymarked|"
    r"cottage|bothy|bunkhouse|campsite|camp ?site|caravan|holiday let|"
    r"car ?park|parking|toilet|picnic|kiosk|notice|information board|"
    r"interpretation|signpost|waymark|bench|seat\b|memorial bench|"
    r"visitor centre|visitor center|reception|ticket office|second ?hand book|"
    r"bookshop|gift shop|plant sale|café|cafe|tea ?room|restaurant|pub\b|"
    r"office|workshop|sawmill|yard\b|depot|store\b|garage|pump(ing)? station|"
    r"sluice|weir|pump\b|boathouse|landing|ferry|jetty|slipway|mooring|"
    r"^track\b|\bgate\b|entrance|access point|stile|bridge\b|ford\b|"
    r"bird hide|wildlife hide|\bhide\b|viewpoint marker|orienteering|geocache|"
    r"^\(.*\)|^\d{3,4}\b|^mtb\b|bike trail|play ?area|playground|den building|"
    r"dog bin|litter bin|recycling|water tap|shower|laundry|wi-?fi|"
    r"\bstores?\b|\bshop\b|\bshed\b|\bbothy\b", re.I)

NT_KEEP_TAGS = ("wikidata", "historic", "boundary", "leisure", "natural",
                "landuse", "ruins", "archaeological_site", "place", "military")

NT_KEEP_TOURISM = {"attraction", "museum", "gallery", "viewpoint",
                   "theme_park", "zoo", "picnic_site", "camp_site"}
NT_DROP_TAGS = ("route", "shop", "office", "man_made")


def build_nt(els):
    sites, seen = [], set()
    for el in els:
        t = el.get("tags", {})
        name = (t.get("name") or "").strip()
        if not name or name.lower() in ("national trust", "national trust for scotland"):
            continue
        if NT_DROP_NAME.search(name):
            continue
        if "route" in t or t.get("tourism") in ("information", "artwork"):
            continue
        if t.get("amenity") in ("parking", "toilets", "cafe", "restaurant",
                                "fast_food", "drinking_water", "bicycle_rental",
                                "bench", "waste_basket") and "wikidata" not in t:
            continue
        # must look like a place, not just a facility
        strong = any(k in t for k in NT_KEEP_TAGS) or t.get("tourism") in NT_KEEP_TOURISM
        if not strong:
            # buildings only count when clearly part of a visitable site
            if not ("building" in t and any(k in t for k in ("historic", "tourism", "wikidata"))):
                continue
        if any(k in t for k in NT_DROP_TAGS) and "wikidata" not in t and "historic" not in t:
            continue
        key = norm_name(name)
        if key in seen:
            continue
        seen.add(key)
        lat, lon = centroid(el)
        if lat is None:
            continue
        sites.append({
            "id": "nt-" + key,
            "name": name,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "osm": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
        })
    return sites


FLAG_OVERRIDES = {"UK": "GB", "EN": "GB", "EL": "GR", "PALESTINE": "PS"}


def flag_emoji(iso):
    if not iso:
        return ""
    iso = FLAG_OVERRIDES.get(iso.upper(), iso.upper())
    if len(iso) != 2 or not iso.isalpha():
        return ""
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in iso)


# not the embassy itself — consulates, visa services, sections, residences
EMBASSY_DROP = re.compile(
    r"visa|consul|commercial|trade|economic|naval|military|defen[cs]e|attach|"
    r"residence|ambassador'?s|cultural|institut|application cent|honorary|"
    r"section|office of|bureau", re.I)


def build_embassies(els):
    sites, seen = [], set()
    for el in els:
        t = el.get("tags", {})
        name = (t.get("name") or t.get("name:en") or "").strip()
        # OSM `country` = sending country; `target` = receiving country (GB)
        target = t.get("diplomatic:sending_country") or t.get("country") or ""
        if not name:
            continue
        if t.get("diplomatic") == "consulate" or EMBASSY_DROP.search(name):
            continue
        key = norm_name(name)
        if key in seen:
            continue
        seen.add(key)
        lat, lon = centroid(el)
        if lat is None:
            continue
        sites.append({
            "id": "emb-" + key,
            "name": name,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "flag": flag_emoji(target),
            "addr": " ".join(filter(None, [
                t.get("addr:housenumber", ""), t.get("addr:street", "")])).strip(),
            "osm": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
        })
    return sites


def build_costa(els):
    sites, seen = [], set()
    for el in els:
        t = el.get("tags", {})
        name = t.get("name", "")
        if not re.search(r"costa", name + " " + t.get("brand", ""), re.I):
            continue
        if re.search(r"express|pronto|smart ?cafe", name, re.I):
            continue
        lat, lon = centroid(el)
        if lat is None:
            continue
        # de-dupe: Costa + same 4-dp coord cluster (drive-thru + cafe duplicates)
        key = (norm_name(t.get("addr:city") or t.get("addr:town") or ""),
               round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        label = "Costa Coffee"
        extra = " ".join(filter(None, [
            t.get("addr:housenumber", ""), t.get("addr:street", "")])).strip()
        place = t.get("addr:city") or t.get("addr:town") or t.get("addr:village") or ""
        if extra and extra.lower() != "costa coffee":
            label = f"Costa — {extra}"
        elif place:
            label = f"Costa — {place}"
        sites.append({
            "id": f"costa-{round(lat,4)}-{round(lon,4)}".replace(".", ""),
            "name": label if extra or place else name,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "addr": extra,
            "osm": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
        })
    return sites


BUILDERS = {
    "rspb": build_rspb,
    "national-trust": build_nt,
    "embassies": build_embassies,
    "costa": build_costa,
}


# ------------------------------------------------------- geometry simplify

def dp(points, eps):
    """Douglas-Peucker on a list of [x,y]; keeps endpoints."""
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
    """DP on a closed ring. Splitting at the farthest point avoids the
    zero-length baseline that collapses closed rings to a point."""
    if len(ring) < 6:
        return ring
    pts = ring[:-1] if ring[0] == ring[-1] else list(ring)
    ax, ay = pts[0]
    k = max(range(1, len(pts)), key=lambda i: (pts[i][0] - ax) ** 2 + (pts[i][1] - ay) ** 2)
    out = dp(pts[: k + 1], eps)[:-1] + dp(pts[k:] + [pts[0]], eps)[:-1]
    out.append(out[0])
    return out


def simplify_geom(geom, eps=0.002, prec=4):
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


# ------------------------------------------------------------------ main

def main():
    if "--fetch" in sys.argv:
        for fname, url in BOUNDARY_URLS.items():
            path = os.path.join(DATA, fname)
            if not os.path.exists(path):
                print(f"fetching boundaries {fname} ...", flush=True)
                subprocess.run(["curl", "-sfL", "-m", "300", url, "-o", path], check=True)
        for name, src in SOURCES.items():
            fetch(name, src["query"])

    regions = load_regions()
    bbox_cache = {}
    os.makedirs(COLLECTIONS, exist_ok=True)

    index = []
    try:
        with open(os.path.join(DATA, "branding.json")) as f:
            branding = json.load(f)
    except FileNotFoundError:
        branding = {}

    for cid, builder in BUILDERS.items():
        raw_path = os.path.join(RAW, f"{cid}.json")
        if not os.path.exists(raw_path):
            print(f"!! {raw_path} missing, run with --fetch")
            continue
        sites = builder(elements(raw_path))
        for s in sites:
            gid, region = region_for(s["lat"], s["lon"], regions, bbox_cache)
            s["region"] = region or ""
            # qualify generic names with their region for the checklist
            if cid == "costa" and s["name"].lower() in (
                "costa", "costa coffee", "café costa", "cafe costa"
            ):
                s["name"] = "Costa Coffee · " + (s["region"] or "UK")
        sites.sort(key=lambda s: s["name"].lower())
        out = os.path.join(COLLECTIONS, f"{cid}.json")
        with open(out, "w") as f:
            json.dump(sites, f, separators=(",", ":"), ensure_ascii=False)
        print(f"{cid}: {len(sites)} sites -> {out}")
        meta = branding.get(cid, {})
        index.append({"id": cid, "count": len(sites), **meta})

    with open(os.path.join(DATA, "index.json"), "w") as f:
        json.dump(index, f, indent=1, ensure_ascii=False)

    # simplified regions geojson for the choropleth
    feats = []
    for gid, name, country, geom in regions:
        feats.append({
            "type": "Feature",
            "properties": {"id": gid, "name": name, "country": country},
            "geometry": simplify_geom(geom),
        })
    rj = {"type": "FeatureCollection", "features": feats}
    rpath = os.path.join(DATA, "regions.geojson")
    with open(rpath, "w") as f:
        json.dump(rj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"regions: {len(feats)} -> {rpath} ({os.path.getsize(rpath)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
