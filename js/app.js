/* visited-map — main app */
"use strict";

const UK_BOUNDS = [[49.8, -8.9], [60.9, 2.0]];
const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>';

const state = {
  collections: [],      // from data/index.json
  collection: null,     // active collection metadata
  sites: [],            // active collection sites
  siteIndex: new Map(), // id -> site
  profiles: [],
  profile: null,
  visits: {},           // active profile visits
  mode: "pins",
  regions: null,        // regions.geojson
};

const siteDataCache = {};
const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------- map */

const map = L.map("map", { zoomControl: true }).fitBounds(UK_BOUNDS);
L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19, subdomains: "abcd" }).addTo(map);

const pinLayer = L.markerClusterGroup({
  maxClusterRadius: 45,
  disableClusteringAtZoom: 11,
});
const regionLayer = L.geoJSON(null, {
  style: () => ({}),
  onEachFeature: (f, l) => {
    l.bindTooltip("", { className: "region-tip", sticky: true });
  },
});

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

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

/* ------------------------------------------------------- choropleth */

function regionCounts() {
  const counts = {};       // region name -> { visited, total }
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
  // eBird-style ramp: pale tint of accent -> saturated accent
  const t = Math.min(1, 0.15 + 0.85 * (visited / max));
  const mix = (a) => Math.round(255 + (a - 255) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function renderRegions() {
  if (!state.regions) return;
  const counts = regionCounts();
  const max = Math.max(1, ...Object.values(counts).map((c) => c.visited));
  regionLayer.setStyle((f) => {
    const c = counts[f.properties.name];
    return {
      fillColor: regionColor(c?.visited || 0, max),
      fillOpacity: 0.85,
      color: "#9aa0a6",
      weight: 1,
    };
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

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  map.removeLayer(pinLayer);
  map.removeLayer(regionLayer);
  $("#region-legend").hidden = mode !== "regions";
  if (mode === "pins") {
    map.addLayer(pinLayer);
    map.scrollWheelZoom.enable();
  } else {
    map.addLayer(regionLayer);
    if (state.collection.id === "embassies") map.fitBounds([[51.28, -0.55], [51.7, 0.3]]);
    else map.fitBounds(UK_BOUNDS);
  }
}

/* -------------------------------------------------------------- data */

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

async function loadCollection(id) {
  state.collection = state.collections.find((c) => c.id === id);
  document.documentElement.style.setProperty("--accent", state.collection.color);
  document.querySelectorAll("#collection-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.id === id));
  document.querySelectorAll("#collection-tabs button").forEach((b) => {
    if (b.dataset.id === id) b.style.background = state.collection.color;
  });
  document.querySelectorAll("#collection-tabs button:not(.active)").forEach((b) => (b.style.background = ""));

  if (!siteDataCache[id]) siteDataCache[id] = await loadJSON(`data/collections/${id}.json`);
  state.sites = siteDataCache[id];
  state.siteIndex = new Map(state.sites.map((s) => [s.id, s]));

  renderPins();
  renderChecklist();
  renderStats();
  if (state.regions) renderRegions();
  if (state.mode === "pins") {
    if (id === "embassies") map.fitBounds([[51.28, -0.55], [51.7, 0.3]]);
    else map.fitBounds(UK_BOUNDS);
  }
}

/* ----------------------------------------------------------- checklist */

function siteSubLine(site, when) {
  const bits = [site.region, site.addr].filter(Boolean);
  if (when) bits.push("✓ " + new Date(when).toLocaleDateString());
  return bits.join(" · ");
}

function renderChecklist() {
  const q = $("#search").value.trim().toLowerCase();
  const vmap = state.visits[state.collection.id] || {};
  const list = $("#checklist");
  list.innerHTML = "";
  let shown = 0;
  const frag = document.createDocumentFragment();
  for (const site of state.sites) {
    if (q && !(site.name.toLowerCase().includes(q) || (site.region || "").toLowerCase().includes(q))) continue;
    shown++;
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
    (q ? ` · ${shown} shown` : "");
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
}

/* --------------------------------------------------------------- boot */

async function boot() {
  try {
    state.collections = await loadJSON("data/index.json");
    state.regions = await loadJSON("data/regions.geojson");
  } catch (err) {
    document.body.innerHTML = `<p style="padding:2em">Failed to load data: ${esc(err.message)}.<br>
      If you opened this as a file:// URL, serve it over HTTP instead (e.g. <code>python3 -m http.server</code>).</p>`;
    return;
  }

  regionLayer.addData(state.regions);

  const tabs = $("#collection-tabs");
  for (const c of state.collections) {
    const b = document.createElement("button");
    b.dataset.id = c.id;
    b.textContent = `${c.glyph || ""} ${c.title}`.trim();
    b.addEventListener("click", () => loadCollection(c.id));
    tabs.appendChild(b);
  }

  await ensureProfile();
  refreshProfileButton();
  wireEvents();
  renderRegions();
  await loadCollection(state.collections[0].id);
}

boot();
