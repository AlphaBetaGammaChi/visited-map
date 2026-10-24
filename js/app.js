/* visited-map — main app */
"use strict";

const UK_BOUNDS = [[49.8, -8.9], [60.9, 2.0]];
const WORLD_BOUNDS = [[-58, -170], [83, 179]];
const SCOPE_BOUNDS = { uk: UK_BOUNDS, world: WORLD_BOUNDS };
const REGION_FILES = { uk: "data/regions.geojson", world: "data/regions-world.geojson" };
const OVERPASS = "https://overpass-api.de/api/interpreter";
const OVERPASS_UA = "visited-map/1.0";
const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>';

const state = {
  collections: [],      // index.json + custom collections
  collection: null,
  sites: [],
  siteIndex: new Map(),
  profiles: [],
  profile: null,
  visits: {},
  mode: "pins",
  regionSets: {},       // scope -> {fc, flat:[{name,bbox,polys}]}
  regionScope: null,    // scope currently in regionLayer
  userPos: null,        // {lat, lon} after geolocate
};

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------- map */

const map = L.map("map", { zoomControl: true }).fitBounds(UK_BOUNDS);
L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19, subdomains: "abcd" }).addTo(map);

const pinLayer = L.markerClusterGroup({ maxClusterRadius: 45, disableClusteringAtZoom: 11 });
const regionLayer = L.geoJSON(null, {
  style: () => ({}),
  onEachFeature: (f, l) => l.bindTooltip("", { className: "region-tip", sticky: true }),
});
let userMarker = null;

function siteIcon(site, visited) {
  const glyph = site.flag || state.collection.glyph || "📍";
  const color = visited ? state.collection.color : "#ffffff";
  const html = `
    <div class="pin ${visited ? "visited" : ""}">
      <div class="bubble" style="${visited ? `background:${color};` : ""}">
        <span>${glyph}</span>
      </div>
    </div>`;
  return L.divIcon({ html, className: "", iconSize: [30, 32], iconAnchor: [15, 30], popupAnchor: [0, -26] });
}

function popupHtml(site, visited) {
  const sub = [site.region, site.addr].filter(Boolean).join(" · ");
  const when = visited ? new Date(visited).toLocaleDateString() : "";
  return `
    <div class="pop-name">${esc(site.flag || "")} ${esc(site.name)}</div>
    <div class="pop-sub">${esc(sub)}${when ? ` · visited ${when}` : ""}</div>
    <button data-site="${site.id}" class="${visited ? "unvisit" : ""}">
      ${visited ? "Remove visit" : "Mark as visited"}
    </button>`;
}

function renderPins() {
  pinLayer.clearLayers();
  const vmap = state.visits[state.collection.id] || {};
  for (const site of state.sites) {
    const visited = vmap[site.id];
    const m = L.marker([site.lat, site.lon], { icon: siteIcon(site, visited) });
    m.bindPopup(popupHtml(site, visited));
    pinLayer.addLayer(m);
  }
}

/* ----------------------------------------------------- region helpers */

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

function polysOf(geom) {
  return geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
}

function bboxOf(polys) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const poly of polys) for (const ring of poly) for (const p of ring) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function regionForPoint(lat, lon, flat) {
  for (const r of flat) {
    const b = r.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    for (const poly of r.polys) {
      if (poly.length && pointInRing(lon, lat, poly[0])) return r.name;
    }
  }
  return "";
}

async function ensureRegions(scope) {
  if (!state.regionSets[scope]) {
    const fc = await loadJSON(REGION_FILES[scope]);
    const flat = fc.features.map((f) => ({
      name: f.properties.name,
      polys: polysOf(f.geometry),
      bbox: bboxOf(polysOf(f.geometry)),
    }));
    state.regionSets[scope] = { fc, flat };
  }
  if (state.regionScope !== scope) {
    regionLayer.clearLayers();
    regionLayer.addData(state.regionSets[scope].fc);
    state.regionScope = scope;
  }
}

/* ------------------------------------------------------- choropleth */

function regionCounts() {
  const counts = {};
  const vmap = state.visits[state.collection.id] || {};
  for (const s of state.sites) {
    if (!s.region) continue;
    counts[s.region] = counts[s.region] || { visited: 0, total: 0 };
    counts[s.region].total++;
    if (vmap[s.id]) counts[s.region].visited++;
  }
  return counts;
}

function hexToRgb(h) {
  h = h.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function regionColor(visited, max) {
  if (!visited) return "#f1f3f5";
  const [r, g, b] = hexToRgb(state.collection.color);
  const t = Math.min(1, 0.15 + 0.85 * (visited / max));
  const mix = (a) => Math.round(255 + (a - 255) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function renderRegions() {
  if (state.mode !== "regions" || !state.regionSets[state.collection.scope]) return;
  const counts = regionCounts();
  const max = Math.max(1, ...Object.values(counts).map((c) => c.visited));
  regionLayer.setStyle((f) => {
    const c = counts[f.properties.name];
    return { fillColor: regionColor(c?.visited || 0, max), fillOpacity: 0.85, color: "#9aa0a6", weight: 1 };
  });
  regionLayer.eachLayer((l) => {
    const c = counts[l.feature.properties.name];
    const v = c ? `${c.visited}/${c.total}` : "0";
    l.setTooltipContent(`<b>${esc(l.feature.properties.name)}</b><br>${v} ${esc(state.collection.singular)}${v === "1" ? "" : "s"} visited`);
  });
  const col = state.collection.color;
  $("#region-legend").innerHTML = `
    <div>${esc(state.collection.singular)}s visited per region</div>
    <div class="ramp" style="background:linear-gradient(to right,#f1f3f5,${col})"></div>
    <div style="display:flex;justify-content:space-between"><span>0</span><span>${max}</span></div>`;
}

function collectionBounds() {
  if (state.collection.bounds) return state.collection.bounds;
  return SCOPE_BOUNDS[state.collection.scope || "uk"] || UK_BOUNDS;
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  map.removeLayer(pinLayer);
  map.removeLayer(regionLayer);
  $("#region-legend").hidden = mode !== "regions";
  if (mode === "pins") {
    map.addLayer(pinLayer);
  } else {
    map.addLayer(regionLayer);
    renderRegions();
    map.fitBounds(collectionBounds());
  }
}

/* -------------------------------------------------------------- data */

const siteCache = {};

async function loadCollection(id) {
  state.collection = state.collections.find((c) => c.id === id);
  document.documentElement.style.setProperty("--accent", state.collection.color);
  document.querySelectorAll("#collection-tabs button").forEach((b) => {
    const active = b.dataset.id === id;
    b.classList.toggle("active", active);
    b.style.background = active ? state.collection.color : "";
  });

  if (!siteCache[id]) {
    siteCache[id] = state.collection.custom
      ? LocalStore._get("customsites:" + id, [])
      : await loadJSON(`data/collections/${id}.json`);
  }
  state.sites = siteCache[id];
  state.siteIndex = new Map(state.sites.map((s) => [s.id, s]));

  await ensureRegions(state.collection.scope || "uk");
  renderPins();
  renderChecklist();
  renderStats();
  renderRegions();
  map.fitBounds(collectionBounds());
}

/* ----------------------------------------------------------- checklist */

function haversineKm(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function siteSubLine(site, when) {
  const bits = [site.region, site.addr].filter(Boolean);
  if (when) bits.push("✓ " + new Date(when).toLocaleDateString());
  return bits.join(" · ");
}

function renderChecklist() {
  const q = $("#search").value.trim().toLowerCase();
  const status = $("#filter-status").value;
  const sortBy = $("#sort-by").value;
  const vmap = state.visits[state.collection.id] || {};

  let shown = state.sites.filter((s) => {
    const visited = !!vmap[s.id];
    if (status === "todo" && visited) return false;
    if (status === "done" && !visited) return false;
    if (q && !(s.name.toLowerCase().includes(q) || (s.region || "").toLowerCase().includes(q))) return false;
    return true;
  });

  if (sortBy === "region") shown.sort((a, b) => (a.region || "").localeCompare(b.region || "") || a.name.localeCompare(b.name));
  else if (sortBy === "nearest" && state.userPos) shown.sort((a, b) => haversineKm(state.userPos, a) - haversineKm(state.userPos, b));

  const list = $("#checklist");
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const site of shown) {
    const when = vmap[site.id];
    const li = document.createElement("li");
    li.className = when ? "done" : "";
    li.innerHTML = `
      <input type="checkbox" ${when ? "checked" : ""} data-id="${site.id}">
      <span class="glyph">${site.flag || state.collection.glyph || "📍"}</span>
      <span class="meta"><span class="name">${esc(site.name)}</span>
        <div class="sub">${esc(siteSubLine(site, when))}</div></span>`;
    li.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") {
        const cb = li.querySelector("input");
        cb.checked = !cb.checked;
        toggleVisit(site.id, cb.checked);
      }
    });
    li.querySelector("input").addEventListener("change", (e) => toggleVisit(site.id, e.target.checked));
    frag.appendChild(li);
  }
  list.appendChild(frag);
  const done = Object.keys(vmap).filter((k) => state.siteIndex.has(k)).length;
  $("#checklist-progress").textContent =
    `${done} of ${state.sites.length} ${state.collection.singular}s visited` +
    (shown.length !== state.sites.length ? ` · ${shown.length} shown` : "");
}

/* --------------------------------------------------------------- stats */

function renderStats() {
  const cid = state.collection.id;
  const vmap = state.visits[cid] || {};
  const ids = Object.keys(vmap).filter((k) => state.siteIndex.has(k));
  const pct = state.sites.length ? Math.round((100 * ids.length) / state.sites.length) : 0;
  $("#stats-summary").innerHTML = `
    <div class="big">${ids.length}<span style="font-size:16px;font-weight:400"> / ${state.sites.length}</span></div>
    <div>${esc(state.collection.singular)}s visited · ${pct}%</div>
    <div class="bar"><i style="width:${pct}%"></i></div>`;

  const counts = regionCounts();
  const rows = Object.entries(counts)
    .map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => b.visited - a.visited || b.total - a.total || a.name.localeCompare(b.name));
  const tb = $("#stats-regions tbody");
  tb.innerHTML = "";
  const col = state.collection.color;
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(r.name)}</td>
      <td class="num">${r.visited}/${r.total}</td>
      <td><div class="bar"><i style="width:${Math.round((100 * r.visited) / r.total)}%;background:${col}"></i></div></td>`;
    tb.appendChild(tr);
  }

  const recent = ids
    .map((id) => ({ site: state.siteIndex.get(id), when: vmap[id] }))
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, 15);
  $("#stats-recent").innerHTML = "";
  for (const r of recent) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(r.site.flag || "")} ${esc(r.site.name)}</span>
      <span class="when">${new Date(r.when).toLocaleDateString()}</span>`;
    $("#stats-recent").appendChild(li);
  }
}

/* -------------------------------------------------------------- visits */

async function toggleVisit(siteId, on) {
  const site = state.siteIndex.get(siteId);
  state.visits = await Store.impl.setVisit(state.profile.id, state.collection.id, siteId, on ? new Date().toISOString() : null);
  toast(on ? `✓ ${site.name}` : `Removed ${site.name}`);
  renderPins();
  renderChecklist();
  renderStats();
  renderRegions();
  refreshProfileButton();
}

function totalVisits() {
  return Object.values(state.visits).reduce((n, m) => n + Object.keys(m).length, 0);
}

/* ------------------------------------------------------------- profile */

const PROFILE_COLORS = ["#0ea5e9", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#0d9488"];

function refreshProfileButton() {
  $("#profile-name").textContent = `${state.profile.name} · ${totalVisits()} visited`;
  $("#profile-dot").style.background = state.profile.color;
}

async function renderProfileList() {
  const ul = $("#profile-list");
  ul.innerHTML = "";
  for (const p of state.profiles) {
    const v = await Store.impl.getVisits(p.id);
    const n = Object.values(v).reduce((a, m) => a + Object.keys(m).length, 0);
    const li = document.createElement("li");
    li.className = p.id === state.profile.id ? "active" : "";
    li.innerHTML = `<span class="pdot" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}</span><span class="pcount">${n} visited</span>
      <button class="pdel" title="Delete profile">✕</button>`;
    li.addEventListener("click", () => switchProfile(p.id));
    li.querySelector(".pdel").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete profile "${p.name}" and all its visits?`)) return;
      state.profiles = state.profiles.filter((x) => x.id !== p.id);
      localStorage.removeItem("vm:visits:" + p.id);
      await Store.impl.saveProfiles(state.profiles);
      if (p.id === state.profile.id) await ensureProfile();
      await renderProfileList();
    });
    ul.appendChild(li);
  }
}

async function switchProfile(id) {
  state.profile = state.profiles.find((p) => p.id === id);
  await Store.impl.setActiveProfileId(id);
  state.visits = await Store.impl.getVisits(id);
  refreshProfileButton();
  await renderProfileList();
  renderPins(); renderChecklist(); renderStats(); renderRegions();
}

async function ensureProfile() {
  state.profiles = await Store.impl.loadProfiles();
  if (!state.profiles.length) {
    const p = { id: crypto.randomUUID(), name: "Me", color: PROFILE_COLORS[0], createdAt: new Date().toISOString() };
    state.profiles = [p];
    await Store.impl.saveProfiles(state.profiles);
  }
  const activeId = await Store.impl.getActiveProfileId();
  state.profile = state.profiles.find((p) => p.id === activeId) || state.profiles[0];
  await Store.impl.setActiveProfileId(state.profile.id);
  state.visits = await Store.impl.getVisits(state.profile.id);
}

/* ---------------------------------------------------- custom collections */

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";
}

function customCollections() {
  return LocalStore._get("customcollections", []);
}

function persistCustomCollection(meta, sites) {
  const customs = customCollections().filter((c) => c.id !== meta.id);
  customs.push(meta);
  LocalStore._set("customcollections", customs);
  LocalStore._set("customsites:" + meta.id, sites);
}

function deleteCustomCollection(id) {
  LocalStore._set("customcollections", customCollections().filter((c) => c.id !== id));
  localStorage.removeItem("vm:customsites:" + id);
  delete siteCache[id];
  state.collections = state.collections.filter((c) => c.id !== id);
  const btn = document.querySelector(`#collection-tabs button[data-id="${id}"]`);
  if (btn) btn.remove();
  if (state.collection.id === id) loadCollection(state.collections[0].id);
  renderCustomList();
}

function renderCustomList() {
  const ul = $("#custom-list");
  ul.innerHTML = "";
  for (const c of customCollections()) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pdot" style="background:${c.color}"></span>
      <span class="pname">${esc(c.glyph || "")} ${esc(c.title)}</span>
      <span class="pcount">${c.count} sites · ${c.scope}</span>
      <button class="pdel" title="Delete collection">✕</button>`;
    li.querySelector(".pdel").addEventListener("click", () => {
      if (confirm(`Delete collection "${c.title}"? Visits are kept in case you re-add it.`)) {
        deleteCustomCollection(c.id);
      }
    });
    ul.appendChild(li);
  }
}

function addCollectionTab(c) {
  const b = document.createElement("button");
  b.dataset.id = c.id;
  b.textContent = `${c.glyph || ""} ${c.title}`.trim();
  b.addEventListener("click", () => loadCollection(c.id));
  $("#collection-tabs").appendChild(b);
}

/* ------------------------------------------- add-collection sources */

function assignRegions(sites, scope) {
  const set = state.regionSets[scope];
  for (const s of sites) {
    if (!s.region && set) s.region = regionForPoint(s.lat, s.lon, set.flat);
  }
}

async function sitesFromOverpass(key, value, scope, title) {
  const safe = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const area = scope === "uk" ? 'area["ISO3166-1"="GB"][admin_level=2]->.gb;' : "";
  const areaRef = scope === "uk" ? "(area.gb)" : "";
  const ql = `[out:json][timeout:120];${area}nwr["${safe(key)}"~"${safe(value)}",i]${areaRef};out center tags;`;
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(ql),
  });
  if (!r.ok) throw new Error(`Overpass returned ${r.status} — try again in a minute (it rate-limits)`);
  const d = await r.json();
  const els = d.elements || [];
  if (els.length > 6000) throw new Error(`${els.length} results — too many. Narrow the tag value.`);
  const sites = [];
  for (const el of els) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const name = (t.name || t["name:en"] || title).trim();
    const site = {
      id: `osm-${el.type[0]}${el.id}`,
      name,
      lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      flag: "",
      addr: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
    };
    sites.push(site);
  }
  return sites;
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (cell !== "" || row.length) { row.push(cell); rows.push(row); row = []; cell = ""; }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function sitesFromTable(rows) {
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0);
  const iName = col("name", "title", "site");
  const iLat = col("lat", "latitude", "y");
  const iLon = col("lon", "lng", "longitude", "x");
  if (iName == null || iLat == null || iLon == null) {
    throw new Error("Couldn't find name/lat/lon columns — got: " + head.join(", "));
  }
  const iAddr = col("addr", "address"), iRegion = col("region", "county", "country"), iFlag = col("flag");
  const sites = [];
  for (const r of rows.slice(1)) {
    const lat = parseFloat(r[iLat]), lon = parseFloat(r[iLon]);
    const name = (r[iName] || "").trim();
    if (!name || !isFinite(lat) || !isFinite(lon)) continue;
    sites.push({
      id: "row-" + sites.length, name, lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      addr: iAddr != null ? (r[iAddr] || "").trim() : "",
      region: iRegion != null ? (r[iRegion] || "").trim() : "",
      flag: iFlag != null ? (r[iFlag] || "").trim() : "",
    });
  }
  return sites;
}

function sitesFromJSON(data) {
  if (!Array.isArray(data)) {
    if (data.features) data = data.features.map((f) => ({
      name: f.properties?.name || f.properties?.title,
      lon: f.geometry?.coordinates?.[0], lat: f.geometry?.coordinates?.[1],
      addr: f.properties?.addr || "", region: f.properties?.region || "",
      flag: f.properties?.flag || "",
    }));
    else throw new Error("Expected a JSON array or GeoJSON FeatureCollection");
  }
  const sites = [];
  for (const item of data) {
    const lat = parseFloat(item.lat), lon = parseFloat(item.lon ?? item.lng);
    const name = String(item.name || item.title || "").trim();
    if (!name || !isFinite(lat) || !isFinite(lon)) continue;
    sites.push({
      id: "row-" + sites.length, name, lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      addr: String(item.addr || item.address || ""), region: String(item.region || ""),
      flag: String(item.flag || ""),
    });
  }
  return sites;
}

async function createCollection() {
  const status = $("#ac-status");
  const title = $("#ac-title").value.trim();
  const scope = $("#ac-scope").value;
  if (!title) { status.textContent = "Give it a title first."; return; }
  const meta = {
    id: "c-" + slugify(title) + "-" + Math.random().toString(36).slice(2, 6),
    title, singular: "site", glyph: $("#ac-glyph").value.trim() || "📍",
    color: $("#ac-color").value, scope, custom: true,
  };
  status.textContent = "Working…";
  try {
    const srcTab = document.querySelector(".src-tab.active").dataset.src;
    let sites;
    if (srcTab === "osm") {
      const key = $("#ac-osm-key").value.trim(), value = $("#ac-osm-value").value.trim();
      if (!key || !value) { status.textContent = "Enter a tag key and value."; return; }
      status.textContent = "Querying OpenStreetMap…";
      sites = await sitesFromOverpass(key, value, scope, title);
    } else if (srcTab === "upload") {
      const file = $("#ac-file").files[0];
      if (!file) { status.textContent = "Choose a file first."; return; }
      const text = await file.text();
      sites = file.name.endsWith(".csv") ? sitesFromTable(parseCSV(text)) : sitesFromJSON(JSON.parse(text));
    } else {
      sites = sitesFromJSON(JSON.parse($("#ac-json").value));
    }
    if (!sites.length) { status.textContent = "No usable sites found."; return; }
    status.textContent = `Assigning regions to ${sites.length} sites…`;
    await ensureRegions(scope);
    assignRegions(sites, scope);
    meta.count = sites.length;
    persistCustomCollection(meta, sites);
    state.collections.push(meta);
    addCollectionTab(meta);
    renderCustomList();
    status.textContent = `Added “${title}” — ${sites.length} sites.`;
    await loadCollection(meta.id);
    $("#add-modal").hidden = true;
    toast(`Collection "${title}" added`);
  } catch (err) {
    status.textContent = "Failed: " + err.message;
  }
}

/* --------------------------------------------------------------- misc */

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function wireEvents() {
  document.querySelectorAll(".side-tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".side-tab").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".side-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
    }));

  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));

  $("#search").addEventListener("input", renderChecklist);
  $("#filter-status").addEventListener("change", renderChecklist);
  $("#sort-by").addEventListener("change", renderChecklist);

  $("#locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Geolocation not available");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.circleMarker([state.userPos.lat, state.userPos.lon], {
          radius: 7, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
        }).addTo(map);
        map.setView([state.userPos.lat, state.userPos.lon], Math.max(map.getZoom(), 10));
        $('#sort-by option[value="nearest"]').disabled = false;
        toast("Location found — sort by Nearest enabled");
      },
      () => toast("Couldn't get your location")
    );
  });

  map.on("popupopen", (e) => {
    const btn = e.popup.getElement().querySelector("button[data-site]");
    if (btn) btn.addEventListener("click", () => {
      toggleVisit(btn.dataset.site, !btn.classList.contains("unvisit"));
      map.closePopup();
    });
  });

  // profiles modal
  $("#profile-btn").addEventListener("click", async () => {
    await renderProfileList();
    $("#profile-modal").hidden = false;
  });
  $("#profile-close").addEventListener("click", () => ($("#profile-modal").hidden = true));
  $("#profile-modal").addEventListener("click", (e) => {
    if (e.target.id === "profile-modal") $("#profile-modal").hidden = true;
  });
  $("#new-profile-btn").addEventListener("click", async () => {
    const name = $("#new-profile-name").value.trim();
    if (!name) return;
    const p = {
      id: crypto.randomUUID(),
      name,
      color: PROFILE_COLORS[state.profiles.length % PROFILE_COLORS.length],
      createdAt: new Date().toISOString(),
    };
    state.profiles.push(p);
    await Store.impl.saveProfiles(state.profiles);
    $("#new-profile-name").value = "";
    await switchProfile(p.id);
    toast(`Profile "${name}" created`);
  });
  $("#new-profile-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#new-profile-btn").click();
  });
  $("#export-btn").addEventListener("click", async () => {
    const data = await Store.impl.exportProfile(state.profile.id);
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `visited-map-${state.profile.name.replace(/\W+/g, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const p = await Store.impl.importProfile(payload);
      state.profiles = await Store.impl.loadProfiles();
      await switchProfile(p.id);
      toast(`Imported profile "${p.name}"`);
    } catch (err) {
      alert("Import failed: " + err.message);
    }
    e.target.value = "";
  });

  // add-collection modal
  $("#add-collection-btn").addEventListener("click", () => {
    renderCustomList();
    $("#add-modal").hidden = false;
  });
  $("#add-close").addEventListener("click", () => ($("#add-modal").hidden = true));
  $("#add-modal").addEventListener("click", (e) => {
    if (e.target.id === "add-modal") $("#add-modal").hidden = true;
  });
  document.querySelectorAll(".src-tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".src-tab").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".src-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === b.dataset.src));
    }));
  $("#ac-create").addEventListener("click", createCollection);
}

/* --------------------------------------------------------------- boot */

async function boot() {
  try {
    state.collections = await loadJSON("data/index.json");
  } catch (err) {
    document.body.innerHTML = `<p style="padding:2em">Failed to load data: ${esc(err.message)}.<br>
      If you opened this as a file:// URL, serve it over HTTP instead (e.g. <code>python3 -m http.server</code>).</p>`;
    return;
  }

  // merge custom collections
  for (const c of customCollections()) {
    c.count = (LocalStore._get("customsites:" + c.id, [])).length;
    state.collections.push(c);
  }

  const tabs = $("#collection-tabs");
  for (const c of state.collections) addCollectionTab(c);

  await ensureProfile();
  refreshProfileButton();
  wireEvents();
  await loadCollection(state.collections[0].id);
}

boot();
