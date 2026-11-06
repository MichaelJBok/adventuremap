// Adventure Map: my places on a vector map. Anything named on the map can be clicked and added.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

const PLACES_KEY = "adventuremap.places";
const HIDDEN_KEY = "adventuremap.hiddenCategories";
const VIEW_KEY = "adventuremap.view";
const MENU_KEY = "adventuremap.menuHidden";
const TRACK_VIEW_KEY = "adventuremap.trackView";
const BASE_OPEN_KEY = "adventuremap.baseOptionsOpen";
const DISPLAY_KEY = "adventuremap.display"; // chosen colours and heatmap style; synced to the account when signed in
// Each heatmap style runs from one pass to the most worn paths; `line` draws the tracks up close.
const HEAT_STYLES = {
  fire: { name: "Fire", line: "#E65100", ramp: ["rgba(33,102,172,0.55)", "#7B1FA2", "#E65100", "#FFC107", "#FFFDE7"] },
  ocean: { name: "Ocean", line: "#0277BD", ramp: ["rgba(0,77,64,0.5)", "#00838F", "#0288D1", "#4FC3F7", "#E1F5FE"] },
  viridis: { name: "Viridis", line: "#21918C", ramp: ["rgba(68,1,84,0.5)", "#3B528B", "#21918C", "#5EC962", "#FDE725"] },
  magenta: { name: "Magenta", line: "#C2185B", ramp: ["rgba(74,20,140,0.5)", "#7B1FA2", "#C2185B", "#F06292", "#FCE4EC"] },
  ink: { name: "Ink", line: "#212121", ramp: ["rgba(33,33,33,0.15)", "rgba(33,33,33,0.3)", "rgba(33,33,33,0.5)", "rgba(33,33,33,0.7)", "rgba(0,0,0,0.9)"] },
};
// OpenFreeMap's styles share their tiles, fonts and icons, so my own layers carry over between them.
const VECTOR_STYLES = { light: "positron", dark: "dark" };
const styleUrl = (base) => `https://tiles.openfreemap.org/styles/${VECTOR_STYLES[base] ?? "liberty"}`;
const HEAT_WIDTHS = { thin: 0.6, normal: 1, wide: 1.7 };
const DEFAULT_DISPLAY = { colors: {}, sizes: {}, opacities: {}, solid: {}, base: {}, heatStyle: "fire", heatWidth: "normal" };
const HEAT_STEP_M = 50; // heatmap points are spaced evenly along each track, so time spent in one spot doesn't count extra
const NEW_CATEGORY = "__new__";
const TRACK_KINDS = [
  { name: "Runs", color: "#D81B60", sports: ["Run", "TrailRun"] },
  { name: "Hikes and walks", color: "#00897B", sports: ["Hike", "Walk"] },
  { name: "Rides", color: "#3949AB", sports: ["Ride", "GravelRide", "MountainBikeRide", "EBikeRide"] },
  { name: "Other tracks", color: "#546E7A" },
];
const LIST_LIMIT = 100;
const ALWAYS_VISIBLE = "Places"; // never consolidated into circles

const GEOCACHES = "Geocaches";
const MUSHROOMS = "Mushrooms"; // read-only layer: finds are kept and edited in Svampkartan
const SVAMPKARTAN_KEY = "svampkartan.spots"; // same web address, so the same browser storage
const BASE_COLORS = { "Places": "#0288D1", "Points of Interest": "#F9A825", "Geocaches": "#7CB342", "Dive Sites": "#E65100", [MUSHROOMS]: "#8E24AA" };
const EXTRA_COLORS = ["#D81B60", "#00897B", "#6D4C41", "#3949AB", "#C0CA33", "#5E35B1"];

// Labels on the base map that can be added, and the category each one suggests.
const ADDABLE = { poi: "Points of Interest", mountain_peak: "Points of Interest", park: "Points of Interest",
  water_name: "Points of Interest", aerodrome_label: "Places", place: "Places" };

let places = readJson(PLACES_KEY, []);
let mushrooms = readJson(SVAMPKARTAN_KEY, []).map(toMushroom);
let tracks = [];
let heatPoints = null; // built the first time the heatmap is shown
let trackView = readJson(TRACK_VIEW_KEY, "lines");
let display = { ...DEFAULT_DISPLAY, ...readJson(DISPLAY_KEY, {}) };
let hidden = new Set(readJson(HIDDEN_KEY, []));
let cloud = null; // set by sync.js while signed in
let placing = false;
let draft = null; // { marker, editing } while the form is open
let popup = null;
const sourceIds = new Map(); // category -> map source id

// --- Data ---
function saveLocal() { writeJson(PLACES_KEY, places); }

const allPlaces = () => [...places, ...mushrooms];

// A Svampkartan spot as a map entry. A visit logged with amount 0 means nothing was found that day.
function toMushroom(s) {
  const dates = [{ date: s.date, amount: s.amount }, ...(s.visits ?? [])]
    .filter((v) => v.date && (v.amount === "" || Number(v.amount) !== 0))
    .map((v) => v.date).sort().reverse();
  return { id: `svamp-${s.id}`, lat: s.lat, lon: s.lon, name: s.species || "Unknown mushroom", category: MUSHROOMS,
    date: dates[0] ?? "", dates, notes: s.notes ?? "", readOnly: true };
}

function setMushrooms(spots) {
  mushrooms = spots.map(toMushroom);
  renderAll();
}

function addPlaces(list) {
  const ids = new Set(list.map((p) => p.id));
  places = [...places.filter((p) => !ids.has(p.id)), ...list];
  saveLocal();
  cloud?.save(list);
  renderAll();
}

function removePlace(id) {
  places = places.filter((p) => p.id !== id);
  saveLocal();
  cloud?.remove(id);
  renderAll();
}

function categories() {
  return [...new Set([...Object.keys(BASE_COLORS), ...places.map((p) => p.category)])];
}

// The reverse, for tracks I've trimmed.
function encodePolyline(coords) {
  let out = "", lastLat = 0, lastLon = 0;
  const put = (value) => {
    value = value < 0 ? ~(value << 1) : value << 1;
    while (value >= 0x20) { out += String.fromCharCode((0x20 | (value & 31)) + 63); value >>= 5; }
    out += String.fromCharCode(value + 63);
  };
  for (const [lon, lat] of coords) {
    const y = Math.round(lat * 1e5), x = Math.round(lon * 1e5);
    put(y - lastLat); put(x - lastLon);
    lastLat = y; lastLon = x;
  }
  return out;
}

// Encoded route lines from Strava, as [lon, lat] pairs.
function decodePolyline(text) {
  const coords = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let shift = 0, value = 0, byte;
    do {
      byte = text.charCodeAt(i++) - 63;
      value |= (byte & 31) << shift;
      shift += 5;
    } while (byte >= 32);
    return value & 1 ? ~(value >> 1) : value >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    coords.push([lon / 1e5, lat / 1e5]);
  }
  return coords;
}

// Route sets (like a long-distance trail) are for planning: dashed, unticked at first, and kept out of the heatmap.
const PLAN_COLORS = ["#EF6C00", "#AD1457", "#00838F", "#2E7D32"]; // Skåneleden is waymarked in orange
const SEEN_PLANS_KEY = "adventuremap.seenPlans";
const planKinds = new Map();

function planKind(name) {
  if (!planKinds.has(name)) {
    planKinds.set(name, { name, plan: true, color: PLAN_COLORS[planKinds.size % PLAN_COLORS.length] });
    const seen = new Set(readJson(SEEN_PLANS_KEY, []));
    if (!seen.has(name)) {
      hidden.add(name);
      writeJson(HIDDEN_KEY, [...hidden]);
      writeJson(SEEN_PLANS_KEY, [...seen, name]);
    }
  }
  return planKinds.get(name);
}

const allKinds = () => [...TRACK_KINDS, ...planKinds.values()];
const trackKind = (t) => t.plan ? planKind(t.plan)
  : TRACK_KINDS.find((k) => k.sports?.includes(t.sportType)) ?? TRACK_KINDS.at(-1);

// Live Strava syncs store one line; imported tracks can be several, split where the GPS lost signal.
// Every id ever stored, deleted ones included, so imports and syncs only ever add what's new.
let knownTrackIds = new Set();

function setTracks(list) {
  knownTrackIds = new Set(list.map((t) => t.id));
  tracks = list.filter((t) => !t.deleted).map((t) => ({ ...t, name: cleanTrackName(t.name ?? ""), kind: trackKind(t), lines: (t.polylines ?? [t.polyline]).filter(Boolean).map(decodePolyline) }));
  heatPoints = null;
  drawTracks();
  renderTrackKinds();
}

// Points every HEAT_STEP_M metres along a line, as [lon, lat].
function alongLine(coords) {
  const out = [];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    const length = metres({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
    for (let d = carry; d < length; d += HEAT_STEP_M) {
      const f = d / length;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    carry = (carry - length) % HEAT_STEP_M;
    if (carry < 0) carry += HEAT_STEP_M;
  }
  return out;
}

const addableCategories = () => categories().filter((c) => c !== MUSHROOMS);

const kindColor = (k) => display.colors[k.name] ?? k.color;
const sizeOf = (name) => display.sizes[name] ?? 1; // marker size for a category, line thickness for a kind of track
const TRACK_OPACITY = 0.45; // see-through by default, so paths travelled many times build up and stand out
const opacityOf = (name) => display.opacities[name] ?? (TRACK_KINDS.some((k) => k.name === name) ? TRACK_OPACITY : 0.9);
const kindFeature = (t) => ({
  type: "Feature",
  geometry: { type: "MultiLineString", coordinates: t.lines },
  properties: { id: t.id, color: kindColor(t.kind), width: sizeOf(t.kind.name), opacity: opacityOf(t.kind.name),
    name: t.name ?? "", plan: t.plan ?? "", dashed: !display.solid[t.kind.name], km: Math.round((t.distance ?? 0) / 100) / 10 },
});

function colorOf(category) {
  if (display.colors[category]) return display.colors[category];
  if (BASE_COLORS[category]) return BASE_COLORS[category];
  const extras = categories().filter((c) => !BASE_COLORS[c]);
  return EXTRA_COLORS[extras.indexOf(category) % EXTRA_COLORS.length] ?? "#616161";
}

function metaLine(p) {
  const when = p.date || p.dateText;
  if (p.cache) return `${p.cache.type} · D${p.cache.difficulty}/T${p.cache.terrain} · by ${p.cache.owner}`;
  return [p.category, when].filter(Boolean).join(" · ");
}

// Distance in metres; good enough for "is this the same spot".
function metres(a, b) {
  const x = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(x, a.lat - b.lat) * 111320;
}

function findSaved(name, lat, lon) {
  const lower = name.toLowerCase();
  return places.find((p) => p.name.toLowerCase() === lower && metres(p, { lat, lon }) < 100);
}

// --- Map ---
const view = readJson(VIEW_KEY, { center: [13, 45], zoom: 3 });
let currentStyle = styleUrl(display.base?.map);
const map = new maplibregl.Map({ container: "map", style: currentStyle, ...view });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }));
map.on("moveend", () => writeJson(VIEW_KEY, { center: map.getCenter().toArray(), zoom: map.getZoom() }));

class PinControl {
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    box.innerHTML = `<button type="button" class="place-btn" id="placeBtn" aria-label="Drop a pin" aria-pressed="false" title="Drop a pin">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg></button>`;
    box.firstElementChild.onclick = () => setPlacing(!placing);
    return box;
  }
  onRemove() {}
}
map.addControl(new PinControl());

// Hide / show the menu.
class MenuControl {
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    box.innerHTML = `<button type="button" class="menu-btn" id="menuBtn">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>`;
    box.firstElementChild.onclick = () => setMenuHidden(!$("app").classList.contains("menu-hidden"));
    return box;
  }
  onRemove() {}
}
map.addControl(new MenuControl(), "top-left");

// Mushroom mode: Svampkartan, full screen inside this app. It's the same site, so it's already signed in,
// and finds made there show up here as soon as it saves them. One installed app does both.
const MUSHROOM_MODE_KEY = "adventuremap.mushroomMode";
const MUSHROOM_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor"
  d="M12 3C6.5 3 2.5 6.6 2.5 10.2c0 .9.7 1.3 1.6 1.3h15.8c.9 0 1.6-.4 1.6-1.3C21.5 6.6 17.5 3 12 3zM9 13h6l.7 6.2A1.6 1.6 0 0 1 14.1 21h-4.2a1.6 1.6 0 0 1-1.6-1.8z"/></svg>`;

class MushroomControl {
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    box.innerHTML = `<button type="button" class="menu-btn" title="Mushroom mode" aria-label="Mushroom mode">${MUSHROOM_ICON}</button>`;
    box.firstElementChild.onclick = () => setMushroomMode(true);
    return box;
  }
  onRemove() {}
}
map.addControl(new MushroomControl(), "top-left");

function setMushroomMode(on, fromHistory = false) {
  const box = $("mushroomMode");
  if (on === !box.hidden) return;
  if (on && !$("mushroomFrame").src) $("mushroomFrame").src = "../svampkartan/"; // loaded once, then kept
  box.hidden = !on;
  writeJson(MUSHROOM_MODE_KEY, on);
  // Android's back gesture leaves mushroom mode rather than the app.
  if (on && !fromHistory) history.pushState({ mushroom: true }, "");
  if (!on && !fromHistory && history.state?.mushroom) history.back();
}
$("mushroomBack").onclick = () => setMushroomMode(false);
addEventListener("popstate", (e) => setMushroomMode(!!e.state?.mushroom, true));
if (readJson(MUSHROOM_MODE_KEY, false)) setMushroomMode(true);

function setMenuHidden(hidden) {
  $("app").classList.toggle("menu-hidden", hidden);
  const label = hidden ? "Show menu" : "Hide menu";
  $("menuBtn").title = label;
  $("menuBtn").setAttribute("aria-label", label);
  $("menuBtn").setAttribute("aria-pressed", String(hidden));
  writeJson(MENU_KEY, hidden);
  map.resize();
}
setMenuHidden(readJson(MENU_KEY, false));

function setPlacing(on) {
  placing = on;
  $("map").classList.toggle("placing", on);
  $("placeBtn").classList.toggle("active", on);
  $("placeBtn").setAttribute("aria-pressed", on);
}

const BASEMAPS = {
  topo: { tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png", "https://b.tile.opentopomap.org/{z}/{x}/{y}.png"],
    maxzoom: 17, attribution: "&copy; OpenTopoMap" },
  satellite: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    maxzoom: 18, attribution: "&copy; Esri" },
};

// Things drawn over the base map, each with a switch in the side panel.
const OVERLAYS = {
  hillshade: { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    attribution: "Elevation &copy; Mapzen and others" },
  hiking: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"],
    attribution: "Trails &copy; <a href=\"https://hiking.waymarkedtrails.org\">Waymarked Trails</a>" },
  cycling: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png"],
    attribution: "Routes &copy; <a href=\"https://cycling.waymarkedtrails.org\">Waymarked Trails</a>" },
};
const DEFAULT_BASE = { map: "", labels: true, roads: true, hillshade: false, hiking: false, cycling: false, fade: 0 };
const baseOptions = () => ({ ...DEFAULT_BASE, ...display.base });
let baseLabels = []; // the base map's own label layers, found when it loads
let baseLayerIds = new Set(); // every layer of the base style, so a style swap knows which layers are mine
let baseRoads = new Set(); // its roads and their names; paths and railways stay, being useful outdoors

// Where the run of label layers at the top of a style begins. One-way arrows sit among the roads
// lower down, so the first label layer isn't it.
function labelsStart(layers) {
  let i = layers.length;
  while (i > 0 && layers[i - 1].type === "symbol") i--;
  return i;
}

function findBaseLayers(ids) {
  const layers = map.getStyle().layers.filter((l) => ids.has(l.id));
  baseLabels = [...layers.filter((l) => l.type === "symbol").map((l) => l.id), "peak-labels"];
  baseRoads = new Set(layers.filter((l) => ["transportation", "transportation_name"].includes(l["source-layer"])
    && !/rail|path|pedestrian|pier/.test(l.id)).map((l) => l.id));
}
let currentBasemap = "";
const BASE_SWITCHES = ["labels", "roads", "hillshade", "hiking", "cycling"];

function setBasemap(name) {
  currentBasemap = name;
  if (map.getLayer("basemap")) { map.removeLayer("basemap"); map.removeSource("basemap"); }
  if (!name) return;
  map.addSource("basemap", { type: "raster", tileSize: 256, ...BASEMAPS[name] });
  // Beneath the fade and the labels, so labels stay on top and stay clickable.
  map.addLayer({ id: "basemap", type: "raster", source: "basemap" }, map.getLayer("hillshade") ? "hillshade" : "fade");
}

function setOverlay(id, on) {
  if (!on) {
    if (map.getLayer(id)) { map.removeLayer(id); map.removeSource(id); }
    return;
  }
  if (map.getLayer(id)) return;
  map.addSource(id, OVERLAYS[id]);
  if (id === "hillshade") {
    map.addLayer({ id, type: "hillshade", source: id, paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#5a4a3a" } }, "fade");
  } else {
    // Above the base map's labels but beneath my own routes and tracks.
    map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.8 } }, "plans");
  }
}

// Swaps the vector base style, keeping my own sources and layers. Mine that belong under the labels
// (raster base map, hillshade, fade) go under the new style's labels; the rest go on top as before.
function setVectorStyle(url) {
  currentStyle = url;
  const under = new Set(["basemap", "hillshade", "fade"]);
  let nextIds;
  map.setStyle(url, {
    diff: false,
    transformStyle: (previous, next) => {
      nextIds = new Set(next.layers.map((l) => l.id));
      const mine = previous.layers.filter((l) => !baseLayerIds.has(l.id));
      const layers = [...next.layers];
      layers.splice(labelsStart(layers), 0, ...mine.filter((l) => under.has(l.id)));
      layers.push(...mine.filter((l) => !under.has(l.id)));
      return { ...next, sources: { ...previous.sources, ...next.sources }, layers };
    },
  });
  map.once("style.load", () => {
    baseLayerIds = nextIds;
    findBaseLayers(nextIds);
    applyBase();
  });
}

function renderBaseControls() {
  const b = baseOptions();
  $("basemap").value = b.map;
  for (const key of BASE_SWITCHES) $(`base-${key}`).checked = b[key];
  $("baseFade").value = b.fade;
  // While folded away, the button still says what's on.
  const changes = [!b.labels && "no labels", !b.roads && "no roads", b.hillshade && "hillshade",
    b.hiking && "trails", b.cycling && "cycle routes", b.fade > 0 && "faded"].filter(Boolean);
  $("baseSummary").textContent = [$("basemap").selectedOptions[0].text, ...changes].join(" · ");
}

function applyBase() {
  renderBaseControls();
  if (!map.getLayer("fade")) return; // the map hasn't finished loading
  const b = baseOptions();
  if (currentStyle !== styleUrl(b.map)) { setVectorStyle(styleUrl(b.map)); return; } // applyBase runs again once it's loaded
  const raster = BASEMAPS[b.map] ? b.map : "";
  if (currentBasemap !== raster) setBasemap(raster);
  for (const id of Object.keys(OVERLAYS)) setOverlay(id, b[id]);
  for (const id of new Set([...baseLabels, ...baseRoads])) {
    const shown = (b.labels || !baseLabels.includes(id)) && (b.roads || !baseRoads.has(id));
    map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
  }
  map.setPaintProperty("fade", "fill-opacity", b.fade);
  map.setPaintProperty("fade", "fill-color", b.map === "dark" ? "#000" : "#fff"); // a dark map fades toward black
}

function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#2b2a26" : "#fff";
}

function placesGeoJson(category) {
  return {
    type: "FeatureCollection",
    features: hidden.has(category) ? [] : allPlaces().filter((p) => p.category === category).map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { id: p.id, name: p.name, color: colorOf(category) },
    })),
  };
}

// One map source per category, so each consolidates on its own, in its own color.
function sourceFor(category) {
  if (sourceIds.has(category)) return sourceIds.get(category);
  const id = `cat-${sourceIds.size}`;
  sourceIds.set(category, id);
  const clustered = category !== ALWAYS_VISIBLE;
  map.addSource(id, { type: "geojson", data: placesGeoJson(category), cluster: clustered, clusterRadius: 42, clusterMaxZoom: 11 });
  if (clustered) {
    map.addLayer({ id: `${id}-clusters`, type: "circle", source: id, filter: ["has", "point_count"],
      paint: { "circle-opacity": 0.9, "circle-stroke-color": "#fff", "circle-stroke-width": 2,
        "circle-radius": ["step", ["get", "point_count"], 13, 25, 17, 200, 22] } });
    map.addLayer({ id: `${id}-counts`, type: "symbol", source: id, filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true } });
  }
  map.addLayer({ id: `${id}-points`, type: "circle", source: id, filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": ["get", "color"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, clustered ? 3.5 : 7, 10, clustered ? 7 : 12],
      "circle-stroke-color": "#fff", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 10, 2] } });
  map.addLayer({ id: `${id}-labels`, type: "symbol", source: id, minzoom: 13, filter: ["!", ["has", "point_count"]],
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": "#2b2a26", "text-halo-color": "#fff", "text-halo-width": 1.4 } });
  // Always-visible places stay on top of every cluster.
  const top = sourceIds.get(ALWAYS_VISIBLE);
  if (top) [`${top}-points`, `${top}-labels`].forEach((l) => map.moveLayer(l));
  return id;
}

function drawTracks() {
  if (!map.getSource("tracks")) return;
  const shown = tracks.filter((t) => !hidden.has(t.kind.name) && !t.plan);
  map.getSource("plans").setData({
    type: "FeatureCollection",
    features: tracks.filter((t) => t.plan && !hidden.has(t.kind.name)).map(kindFeature),
  });
  const heat = trackView === "heat";
  map.getSource("tracks").setData({
    type: "FeatureCollection",
    features: shown.map(kindFeature),
  });
  if (heat && !heatPoints) {
    heatPoints = tracks.filter((t) => !t.plan).map((t) => ({ kind: t.kind.name, points: t.lines.flatMap(alongLine) }));
  }
  map.getSource("heat").setData({
    type: "FeatureCollection",
    features: heat ? heatPoints.filter((h) => !hidden.has(h.kind)).map((h) => ({
      type: "Feature", geometry: { type: "MultiPoint", coordinates: h.points }, properties: {},
    })) : [],
  });
  // Up close the heatmap gives way to the lines themselves, drawn in its hottest colour.
  map.setLayoutProperty("heat", "visibility", heat ? "visible" : "none");
  map.setPaintProperty("tracks", "line-color", heat ? HEAT_STYLES[display.heatStyle].line : ["get", "color"]);
  map.setPaintProperty("tracks", "line-opacity", heat
    ? ["interpolate", ["linear"], ["zoom"], 11.5, 0, 13, 0.3] : ["get", "opacity"]);
  const style = HEAT_STYLES[display.heatStyle];
  const width = HEAT_WIDTHS[display.heatWidth];
  map.setPaintProperty("heat", "heatmap-color", ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)",
    ...style.ramp.flatMap((color, i) => [[0.05, 0.3, 0.6, 0.85, 1][i], color])]);
  map.setPaintProperty("heat", "heatmap-radius", ["interpolate", ["exponential", 2], ["zoom"], 3, 2 * width, 9, 3 * width, 12, 6 * width]);
  $("heatOptions").hidden = !heat;
}

function drawPlaces() {
  if (!map.getLayer("peak-dots")) return; // the map hasn't finished loading
  categories().forEach(sourceFor);
  for (const [category, id] of sourceIds) {
    map.getSource(id).setData(placesGeoJson(category));
    const size = sizeOf(category);
    map.setPaintProperty(`${id}-points`, "circle-opacity", opacityOf(category));
    map.setPaintProperty(`${id}-points`, "circle-stroke-opacity", opacityOf(category));
    const clustered = category !== ALWAYS_VISIBLE;
    map.setPaintProperty(`${id}-points`, "circle-radius",
      ["interpolate", ["linear"], ["zoom"], 3, (clustered ? 3.5 : 7) * size, 10, (clustered ? 7 : 12) * size]);
    if (!clustered) continue;
    map.setPaintProperty(`${id}-clusters`, "circle-opacity", opacityOf(category));
    map.setPaintProperty(`${id}-clusters`, "circle-radius", ["step", ["get", "point_count"], 13 * size, 25, 17 * size, 200, 22 * size]);
    map.setPaintProperty(`${id}-clusters`, "circle-color", colorOf(category));
    map.setPaintProperty(`${id}-counts`, "text-color", textOn(colorOf(category)));
  }
}

map.on("load", () => {
  baseLayerIds = new Set(map.getStyle().layers.map((l) => l.id));
  findBaseLayers(baseLayerIds);
  // A white wash between the base map and its labels, to make tracks and places stand out.
  map.addSource("fade", { type: "geojson", data: { type: "Feature", properties: {},
    geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
  map.addLayer({ id: "fade", type: "fill", source: "fade", paint: { "fill-color": "#fff", "fill-opacity": 0 } },
    map.getStyle().layers[labelsStart(map.getStyle().layers)]?.id);
  map.addSource("plans", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Planning routes sit beneath my own tracks. Dashes can't vary by feature, so solid routes get a layer of their own.
  const routePaint = { "line-color": ["get", "color"], "line-opacity": ["get", "opacity"],
    "line-width": ["interpolate", ["linear"], ["zoom"], 5, ["*", 1.5, ["get", "width"]], 14, ["*", 3.5, ["get", "width"]]] };
  map.addLayer({ id: "plans", type: "line", source: "plans", filter: ["get", "dashed"],
    layout: { "line-cap": "butt", "line-join": "round" }, paint: { ...routePaint, "line-dasharray": [2, 1.5] } });
  map.addLayer({ id: "plans-solid", type: "line", source: "plans", filter: ["!", ["get", "dashed"]],
    layout: { "line-cap": "round", "line-join": "round" }, paint: routePaint });
  // Thin and see-through, so paths travelled many times build up and stand out.
  map.addSource("tracks", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "tracks", type: "line", source: "tracks", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-opacity": 0.45,
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, ["*", 1, ["get", "width"]], 14, ["*", 2.5, ["get", "width"]]] } });
  // The track picked on the map, drawn over the rest.
  map.addSource("picked", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "picked", type: "line", source: "picked", layout: { "line-cap": "round", "line-join": "round" },
    // Cyan, unlike any road on the map; while trimming, the part to be removed is red.
    paint: { "line-color": ["coalesce", ["get", "pick"], "#00B8D4"], "line-width": 6, "line-opacity": 0.9 } });
  // Heat builds where tracks overlap, from one pass through to the most worn paths. drawTracks sets its colours.
  map.addSource("heat", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "heat", type: "heatmap", source: "heat", maxzoom: 13, layout: { visibility: "none" },
    paint: {
      "heatmap-intensity": ["interpolate", ["exponential", 2], ["zoom"], 3, 0.01, 9, 0.06, 12, 0.2],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0.9, 13, 0],
    } });
  drawTracks();
  // Summits are in the tiles, but this style doesn't draw them.
  map.addLayer({ id: "peak-dots", type: "circle", source: "openmaptiles", "source-layer": "mountain_peak", minzoom: 10,
    filter: ["==", ["get", "class"], "peak"],
    paint: { "circle-radius": 3, "circle-color": "#6d5a43", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
  map.addLayer({ id: "peak-labels", type: "symbol", source: "openmaptiles", "source-layer": "mountain_peak", minzoom: 11,
    filter: ["==", ["get", "class"], "peak"],
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top" },
    paint: { "text-color": "#6d5a43", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  drawPlaces();
  applyBase();
});

// A small box rather than a point, so a fingertip can hit an icon.
const near = (p) => [[p.x - 8, p.y - 8], [p.x + 8, p.y + 8]];
const addableLayers = () => map.getStyle().layers.filter((l) => l.type === "symbol" && ADDABLE[l["source-layer"]]).map((l) => l.id);
const labelAt = (p) => map.queryRenderedFeatures(near(p), { layers: addableLayers() }).find((f) => f.properties.name);
const mineLayers = () => [...sourceIds.values()].flatMap((id) => [`${id}-points`, `${id}-clusters`]).filter((l) => map.getLayer(l));
// Exact hits first, so the box around a small dot can't steal clicks from the circle underneath.
const mineAt = (p) => map.queryRenderedFeatures(p, { layers: mineLayers() })[0]
  ?? map.queryRenderedFeatures(near(p), { layers: mineLayers() })[0];

map.on("mousemove", (e) => {
  if (placing || draft) return;
  const line = map.getLayer("plans") && map.queryRenderedFeatures(near(e.point), { layers: trackLayers() }).length;
  map.getCanvas().style.cursor = mineAt(e.point) || line || labelAt(e.point) ? "pointer" : "";
});

map.on("click", async (e) => {
  if (draft) { moveDraft(e.lngLat); return; }
  if (placing) { setPlacing(false); openForm({ lat: e.lngLat.lat, lon: e.lngLat.lng }); return; }
  const mine = mineAt(e.point);
  if (mine?.properties.cluster) {
    const zoom = await map.getSource(mine.source).getClusterExpansionZoom(mine.properties.cluster_id);
    map.easeTo({ center: mine.geometry.coordinates, zoom: zoom + 0.5 });
  } else if (mine) {
    showPlace(mine.properties.id);
  } else {
    const label = labelAt(e.point);
    if (label) showLabel(label, e.lngLat);
    else if (!showTracks(e)) popup?.remove();
  }
});

// --- Popups ---
const ROUTE_LAYERS = ["plans", "plans-solid"];

// Lines only count where they can be seen: in heatmap view my own tracks appear only up close.
function trackLayers() {
  const mine = trackView === "lines" || map.getZoom() >= 12 ? ["tracks"] : [];
  return [...mine, ...ROUTE_LAYERS].filter((l) => map.getLayer(l));
}

function tracksAt(point) {
  const ids = new Set(map.queryRenderedFeatures(near(point), { layers: trackLayers() }).map((f) => f.properties.id));
  return tracks.filter((t) => ids.has(t.id)).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

const TRACK_TYPES = { Run: "Run", Hike: "Hike", Walk: "Walk", Ride: "Ride", Sail: "Sail", Other: "Other" };
const trackDate = (t) => (t.date ?? "").slice(0, 10);

// Suunto exports are named like "suuntoapp-Running-2026-11-06T07-30-00": keep "Running 2026-11-06 07:30".
function cleanTrackName(name) {
  return name.replace(/^suuntoapp-/i, "")
    .replace(/-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})(-\d{2})?$/, " $1 $2:$3").replace(/^(\w+)-(\w+) /, "$1 $2 ").trim();
}

// Rides read better as speed; everything on foot as pace.
function paceOf(t) {
  if (!t.movingTime || !t.distance || t.plan) return "";
  if (t.kind?.name === "Rides") return `${(t.distance / t.movingTime * 3.6).toFixed(1)} km/h`;
  const perKm = t.movingTime / (t.distance / 1000);
  return `${Math.floor(perKm / 60)}:${String(Math.round(perKm % 60)).padStart(2, "0")} min/km`;
}

const trackMeta = (t) => [t.plan || t.kind.name, trackDate(t), t.distance ? `${(t.distance / 1000).toFixed(1)} km` : "", paceOf(t)]
  .filter(Boolean).join(" · ");

function showTracks(e) {
  const hits = tracksAt(e.point);
  if (!hits.length) return false;
  if (hits.length === 1) { showTrack(hits[0], e.lngLat); return true; }
  // Paths walked many times have many tracks; list them to pick from.
  const el = openPopup(e.lngLat, `<div class="pop-title">${hits.length} tracks here</div>
    <ul class="pop-list">${hits.slice(0, 30).map((t, i) => `<li><button type="button" class="link" data-i="${i}">${esc(t.name || "Untitled")}</button>
    <span class="pop-meta">${esc(trackMeta(t))}</span></li>`).join("")}</ul>
    ${hits.length > 30 ? `<div class="pop-meta">Showing the 30 most recent. Zoom in to narrow it down.</div>` : ""}`);
  el.querySelectorAll("button[data-i]").forEach((b) => { b.onclick = () => showTrack(hits[b.dataset.i], e.lngLat); });
  return true;
}

function highlightTrack(t) {
  map.getSource("picked")?.setData({ type: "FeatureCollection", features: t ? [kindFeature(t)] : [] });
}

function showTrack(t, at) {
  const el = openPopup(at, `<div class="pop-title">${esc(t.name || "Untitled")}</div>
    <div class="pop-meta">${esc(trackMeta(t))}</div>
    <div class="row"><button type="button" id="trackEdit">Edit</button>
    <button type="button" id="trackTrim">Trim</button>
    <button type="button" id="trackDelete">Delete</button></div>
    ${t.originalPolylines ? `<button type="button" class="link" id="trackRestore">Restore the untrimmed track</button>` : ""}`);
  highlightTrack(t); // after openPopup, whose closing of the previous popup clears the highlight
  popup.once("close", () => highlightTrack(null));
  el.querySelector("#trackEdit").onclick = () => editTrack(t, at);
  el.querySelector("#trackTrim").onclick = () => trimTrack(t, at);
  const restore = el.querySelector("#trackRestore");
  if (restore) restore.onclick = () => {
    const { kind, lines, originalPolylines, originalDistance, ...stored } = t;
    const doc = { ...stored, polylines: originalPolylines, distance: originalDistance ?? t.distance };
    saveTrack(doc);
    showTrack({ ...doc, kind, lines: originalPolylines.map(decodePolyline) }, at);
  };
  el.querySelector("#trackDelete").onclick = () => {
    if (!confirm(`Delete “${t.name || "this track"}”? It won't come back with a later import.`)) return;
    popup.remove();
    // A small marker stays behind with the id, so importing the same export later doesn't restore it.
    saveTrack({ id: t.id, deleted: true });
  };
}

// Each point of a track with its distance along it, so sliders can pick a stretch by distance.
function measureTrack(t) {
  let d = 0;
  return t.lines.map((line) => line.map((p, i) => {
    if (i) d += metres({ lat: line[i - 1][1], lon: line[i - 1][0] }, { lat: p[1], lon: p[0] });
    return { p, d };
  }));
}

// The parts of a track between distances a and b (inside), or outside them, as lines of 2+ points.
function stretches(measured, a, b, inside) {
  const out = [];
  for (const line of measured) {
    let run = [];
    for (const { p, d } of line) {
      if ((d >= a && d <= b) === inside) run.push(p);
      else { if (run.length > 1) out.push(run); run = []; }
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

const lineLength = (lines) => lines.reduce((sum, line) =>
  sum + line.slice(1).reduce((s, p, i) => s + metres({ lat: line[i][1], lon: line[i][0] }, { lat: p[1], lon: p[0] }), 0), 0);

function trimTrack(t, at) {
  const measured = measureTrack(t);
  const total = measured.at(-1).at(-1).d;
  const km = (m) => `${(m / 1000).toFixed(2)} km`;
  const el = openPopup(at, `<form id="trimForm">
    <div class="pop-title">Trim ${esc(t.name || "track")}</div>
    <label class="check"><input type="radio" name="trimMode" value="keep" checked> Keep only the part between</label>
    <label class="check"><input type="radio" name="trimMode" value="cut"> Remove the part between</label>
    <label for="trimFrom">From <span id="trimFromKm"></span></label><input type="range" id="trimFrom" min="0" max="1000" value="0">
    <label for="trimTo">To <span id="trimToKm"></span></label><input type="range" id="trimTo" min="0" max="1000" value="1000">
    <div class="pop-meta" id="trimResult"></div>
    <div class="row"><button type="submit" class="primary">Save</button><button type="button" id="trimCancel">Cancel</button></div></form>`);
  popup.once("close", () => highlightTrack(null));
  const q = (s) => el.querySelector(s);
  let kept = t.lines;
  const preview = () => {
    let a = q("#trimFrom").value / 1000 * total, b = q("#trimTo").value / 1000 * total;
    if (a > b) [a, b] = [b, a];
    const keep = q("input[name=trimMode]:checked").value === "keep";
    kept = stretches(measured, a, b, keep);
    const removed = stretches(measured, a, b, !keep);
    q("#trimFromKm").textContent = km(a);
    q("#trimToKm").textContent = km(b);
    q("#trimResult").textContent = kept.length ? `Keeps ${km(lineLength(kept))} of ${km(total)}` : "Nothing would be left";
    q("button[type=submit]").disabled = !kept.length;
    const feature = (lines, color) => ({ type: "Feature", properties: { pick: color }, geometry: { type: "MultiLineString", coordinates: lines } });
    map.getSource("picked")?.setData({ type: "FeatureCollection",
      features: [feature(kept, "#00B8D4"), feature(removed, "#E53935")].filter((f) => f.geometry.coordinates.length) });
  };
  el.querySelectorAll("input").forEach((input) => { input.oninput = preview; });
  preview();
  q("#trimCancel").onclick = () => showTrack(t, at);
  q("#trimForm").onsubmit = (e) => {
    e.preventDefault();
    const { kind, lines, polyline, ...stored } = t;
    // The first trim keeps the original line, so it can be restored later.
    const original = t.originalPolylines ?? t.polylines ?? [polyline];
    const doc = { ...stored, polylines: kept.map(encodePolyline), distance: Math.round(lineLength(kept)),
      originalPolylines: original, originalDistance: t.originalDistance ?? t.distance };
    saveTrack(doc);
    showTrack({ ...doc, kind, lines: kept }, at);
  };
}

function editTrack(t, at) {
  const el = openPopup(at, `<form id="trackForm">
    <label for="tName">Name</label><input id="tName" value="${esc(t.name ?? "")}">
    <label for="tDate">Date</label><input id="tDate" type="date" value="${esc(trackDate(t))}">
    ${t.plan ? "" : `<label for="tType">Type</label><select id="tType">${Object.entries(TRACK_TYPES).map(([v, label]) =>
      `<option value="${v}"${(TRACK_TYPES[t.sportType] ? t.sportType : "Other") === v ? " selected" : ""}>${label}</option>`).join("")}</select>`}
    <div class="row"><button type="submit" class="primary">Save</button><button type="button" id="tCancel">Cancel</button></div></form>`);
  highlightTrack(t);
  popup.once("close", () => highlightTrack(null));
  el.querySelector("#tCancel").onclick = () => showTrack(t, at);
  el.querySelector("#trackForm").onsubmit = (e) => {
    e.preventDefault();
    const { kind, lines, ...stored } = t;
    const updated = { ...stored, name: el.querySelector("#tName").value.trim(), date: el.querySelector("#tDate").value };
    if (!t.plan) updated.sportType = el.querySelector("#tType").value;
    saveTrack(updated);
    showTrack({ ...updated, kind: trackKind(updated), lines }, at);
  };
}

// Signed in, the account's copy updates and the map follows; signed out, only this page changes.
function saveTrack(doc) {
  if (cloud) { cloud.saveTrack(doc); return; }
  const rest = tracks.filter((t) => t.id !== doc.id).map(({ kind, lines, ...t }) => t);
  setTracks([...rest, doc]);
}

function openPopup(lngLat, html) {
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 12, maxWidth: "280px" }).setLngLat(lngLat).setHTML(html).addTo(map);
  return popup.getElement();
}

function showLabel(f, clicked) {
  const [lon, lat] = f.geometry.type === "Point" ? f.geometry.coordinates : [clicked.lng, clicked.lat];
  const name = f.properties.name;
  const kind = (f.properties.subclass || f.properties.class || "").replaceAll("_", " ");
  const saved = findSaved(name, lat, lon);
  if (saved) { showPlace(saved.id); return; }
  const suggested = ADDABLE[f.sourceLayer];
  const options = addableCategories().map((c) => `<option${c === suggested ? " selected" : ""}>${esc(c)}</option>`).join("");
  const el = openPopup([lon, lat], `<div class="pop-title">${esc(name)}</div>
    <div class="pop-meta">${esc(kind)}</div>
    <div class="row"><select id="popCategory" aria-label="Category">${options}</select>
    <button type="button" class="primary" id="popAdd">Add to my places</button></div>`);
  el.querySelector("#popAdd").onclick = () => {
    const place = { id: `p-${Date.now().toString(36)}`, lat, lon, name, category: el.querySelector("#popCategory").value,
      date: "", notes: "", link: "", source: "Map", kind, addedAt: new Date().toISOString() };
    addPlaces([place]);
    showPlace(place.id);
  };
}

function showPlace(id) {
  const p = allPlaces().find((x) => x.id === id);
  if (!p) return;
  if (p.readOnly) {
    const found = p.dates.length ? `Found ${p.dates.join(", ")}` : "Date not recorded";
    openPopup([p.lon, p.lat], `<div class="pop-title">${esc(p.name)}</div><div class="pop-meta">${esc(found)}</div>
      ${p.notes ? `<p class="pop-notes">${esc(p.notes)}</p>` : ""}
      <div class="pop-meta"><button type="button" class="link" id="popMushroom">Edit in mushroom mode</button></div>`);
    $("popMushroom") && ($("popMushroom").onclick = () => { popup.remove(); setMushroomMode(true); });
    return;
  }
  const link = /^https?:\/\//.test(p.link || "") ? `<div class="pop-meta"><a href="${esc(p.link)}" target="_blank" rel="noopener">Open link</a></div>` : "";
  const notes = p.notes ? `<p class="pop-notes">${esc(p.notes)}</p>` : "";
  const el = openPopup([p.lon, p.lat], `<div class="pop-title">${esc(p.name)}</div>
    <div class="pop-meta">${esc(metaLine(p))}</div>${link}${notes}
    <div class="row"><button type="button" id="popEdit">Edit</button>
    <button type="button" id="popDelete">Delete</button></div>`);
  el.querySelector("#popEdit").onclick = () => { popup.remove(); openForm(p, p); };
  el.querySelector("#popDelete").onclick = () => {
    if (confirm(`Delete “${p.name}”?`)) { popup.remove(); removePlace(p.id); }
  };
}

function focusPlace(p) {
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13) });
  showPlace(p.id);
}

// --- Form ---
function renderCategorySelect(selected) {
  $("fCategory").innerHTML = addableCategories().map((c) => `<option${c === selected ? " selected" : ""}>${esc(c)}</option>`).join("")
    + `<option value="${NEW_CATEGORY}">New category…</option>`;
  $("fOtherWrap").hidden = true;
}

function moveDraft(lngLat) { draft.marker.setLngLat(lngLat); showDraftPosition(); }

function showDraftPosition() {
  const { lat, lng } = draft.marker.getLngLat();
  $("fPos").value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function openForm(at, editing = null) {
  closeForm();
  setMenuHidden(false);
  const marker = new maplibregl.Marker({ draggable: true, color: "#1f6f8b" }).setLngLat([at.lon, at.lat]).addTo(map);
  marker.on("dragend", showDraftPosition);
  draft = { marker, editing };
  map.getCanvas().style.cursor = "crosshair";
  $("formTitle").textContent = editing ? "Edit place" : "New place";
  $("fName").value = editing?.name ?? "";
  renderCategorySelect(editing?.category ?? "Points of Interest");
  $("fDate").value = editing?.date ?? "";
  $("fLink").value = editing?.link ?? "";
  $("fNotes").value = editing?.notes ?? "";
  showDraftPosition();
  $("form").hidden = false;
  $("form").scrollIntoView({ block: "nearest" });
  $("fName").focus();
}

function closeForm() {
  draft?.marker.remove();
  draft = null;
  map.getCanvas().style.cursor = "";
  $("form").hidden = true;
}

$("fCategory").onchange = () => { $("fOtherWrap").hidden = $("fCategory").value !== NEW_CATEGORY; };
$("fCancel").onclick = closeForm;
$("form").onsubmit = (e) => {
  e.preventDefault();
  const custom = $("fCategory").value === NEW_CATEGORY;
  const category = custom ? $("fOther").value.trim() : $("fCategory").value;
  if (!category) { $("fOther").focus(); return; }
  const { lat, lng } = draft.marker.getLngLat();
  const place = {
    ...(draft.editing ?? { id: `p-${Date.now().toString(36)}`, source: "Pin", addedAt: new Date().toISOString() }),
    lat: +lat.toFixed(6), lon: +lng.toFixed(6),
    name: $("fName").value.trim(), category,
    date: $("fDate").value, link: $("fLink").value.trim(), notes: $("fNotes").value.trim(),
  };
  closeForm();
  addPlaces([place]);
  showPlace(place.id);
};

// --- Side panel ---
// The coloured dot is a button, so clicking it opens the style panel instead of ticking the box.
const colorPicker = (name, color) =>
  `<button type="button" class="dot" style="--c:${color}" data-style="${esc(name)}" aria-label="Style for ${esc(name)}" title="Change colour and size"></button>`;

let styling = null; // the category or kind of track the style panel is changing

function openStylePanel(button) {
  styling = button.dataset.style;
  const kind = allKinds().find((k) => k.name === styling);
  const isTrack = !!kind;
  $("styleTitle").textContent = styling;
  $("styleSizeLabel").textContent = isTrack ? "Line thickness" : "Marker size";
  $("styleColor").value = isTrack ? kindColor(kind) : colorOf(styling);
  $("styleSize").value = sizeOf(styling);
  $("styleOpacity").value = opacityOf(styling);
  $("styleDashedRow").hidden = !kind?.plan;
  $("styleDashed").checked = !display.solid[styling];
  const panel = $("stylePanel");
  panel.hidden = false;
  const at = button.getBoundingClientRect();
  panel.style.left = `${Math.min(at.left, innerWidth - panel.offsetWidth - 8)}px`;
  panel.style.top = `${Math.min(at.bottom + 6, innerHeight - panel.offsetHeight - 8)}px`;
  $("styleColor").focus();
}

function closeStylePanel() {
  $("stylePanel").hidden = true;
  styling = null;
}

const customised = () => ["colors", "sizes", "opacities", "solid"].some((k) => Object.keys(display[k]).length);

function setDisplay(change, fromAccount = false) {
  display = { ...DEFAULT_DISPLAY, ...display, ...change };
  writeJson(DISPLAY_KEY, display);
  if (!fromAccount) cloud?.saveDisplay(display);
  $("heatStyle").value = display.heatStyle;
  $("heatWidth").value = display.heatWidth;
  $("resetColors").hidden = !customised();
  renderAll();
  renderTrackKinds();
  drawTracks();
  applyBase();
}

function renderCategories() {
  const counts = {};
  allPlaces().forEach((p) => { counts[p.category] = (counts[p.category] ?? 0) + 1; });
  $("catList").innerHTML = categories().map((c) => `<li><label>
    <input type="checkbox" data-cat="${esc(c)}"${hidden.has(c) ? "" : " checked"}>
    ${colorPicker(c, colorOf(c))}<span>${esc(c)}</span>
    <span class="count">${(counts[c] ?? 0).toLocaleString("en-US")}</span></label></li>`).join("");
}

function renderTrackKinds() {
  $("trackList").innerHTML = allKinds().map((k) => `<li><label>
    <input type="checkbox" data-cat="${esc(k.name)}"${hidden.has(k.name) ? "" : " checked"}>
    ${colorPicker(k.name, kindColor(k))}<span>${esc(k.name)}</span>
    <span class="count">${tracks.filter((t) => t.kind === k).length.toLocaleString("en-US")}</span></label></li>`).join("");
}

$("trackView").value = trackView;
$("heatStyle").append(...Object.entries(HEAT_STYLES).map(([id, s]) => new Option(s.name, id)));
$("heatStyle").onchange = () => setDisplay({ heatStyle: $("heatStyle").value });
$("heatWidth").onchange = () => setDisplay({ heatWidth: $("heatWidth").value });
$("resetColors").onclick = () => setDisplay({ colors: {}, sizes: {}, opacities: {}, solid: {} });
$("styleDashed").onchange = () => setDisplay({ solid: { ...display.solid, [styling]: !$("styleDashed").checked } });
$("styleOpacity").oninput = () => setDisplay({ opacities: { ...display.opacities, [styling]: Number($("styleOpacity").value) } });
$("styleColor").oninput = () => setDisplay({ colors: { ...display.colors, [styling]: $("styleColor").value } });
$("styleSize").oninput = () => setDisplay({ sizes: { ...display.sizes, [styling]: Number($("styleSize").value) } });
$("styleDone").onclick = closeStylePanel;
$("catList").onclick = $("trackList").onclick = (e) => {
  const button = e.target.closest("button[data-style]");
  if (button) openStylePanel(button);
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && styling) closeStylePanel(); });
document.addEventListener("pointerdown", (e) => {
  if (styling && !e.target.closest("#stylePanel, button[data-style]")) closeStylePanel();
});

$("trackView").onchange = () => {
  trackView = $("trackView").value;
  writeJson(TRACK_VIEW_KEY, trackView);
  drawTracks();
};

$("catList").onchange = $("trackList").onchange = (e) => {
  const c = e.target.dataset.cat;
  if (e.target.checked) hidden.delete(c); else hidden.add(c);
  writeJson(HIDDEN_KEY, [...hidden]);
  drawPlaces();
  drawTracks();
  renderList();
};

function matchingPlaces() {
  const q = $("search").value.trim().toLowerCase();
  return allPlaces()
    .filter((p) => !hidden.has(p.category))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.notes || "").toLowerCase().includes(q))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.name.localeCompare(b.name));
}

function renderList() {
  const found = matchingPlaces();
  const shown = found.slice(0, LIST_LIMIT);
  $("placeList").replaceChildren(...shown.map((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot" style="--c:${colorOf(p.category)}"></span><span>${esc(p.name)}<small>${esc(metaLine(p))}</small></span>`;
    li.onclick = () => focusPlace(p);
    return li;
  }));
  $("listStatus").textContent = found.length > LIST_LIMIT
    ? `Showing ${LIST_LIMIT} of ${found.length.toLocaleString("en-US")}. Search to narrow the list.`
    : found.length ? "" : "No places match.";
}
$("search").oninput = renderList;

function renderAll() { drawPlaces(); renderCategories(); renderList(); }

$("baseBox").open = readJson(BASE_OPEN_KEY, false);
$("baseBox").ontoggle = () => writeJson(BASE_OPEN_KEY, $("baseBox").open);
const setBase = (change) => setDisplay({ base: { ...baseOptions(), ...change } });
$("basemap").onchange = () => setBase({ map: $("basemap").value });
for (const key of BASE_SWITCHES) $(`base-${key}`).onchange = (e) => setBase({ [key]: e.target.checked });
$("baseFade").oninput = () => setBase({ fade: Number($("baseFade").value) });

// --- Backup ---
$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ places }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `adventure-map-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// A Geocaching "My Finds" file. The date on each cache is when it was placed; the find date is in my log.
function parseFinds(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const inner = (el, tag) => el.getElementsByTagNameNS("*", tag)[0]?.textContent.trim() ?? "";
  return [...doc.getElementsByTagNameNS("*", "wpt")].map((w) => {
    const code = inner(w, "name");
    const found = [...w.getElementsByTagNameNS("*", "log")].filter((l) => inner(l, "type") === "Found it")
      .map((l) => inner(l, "date").slice(0, 10)).sort();
    return { id: `gc-${code.toLowerCase()}`, lat: Number(w.getAttribute("lat")), lon: Number(w.getAttribute("lon")),
      name: `${inner(w, "urlname")} (${code})`, category: GEOCACHES, date: found[0] ?? "", notes: "",
      link: `https://coord.info/${code}`, source: "My Finds",
      cache: { code, owner: inner(w, "owner"), type: inner(w, "type").replace("Geocache|", ""),
        difficulty: Number(inner(w, "difficulty")), terrain: Number(inner(w, "terrain")) } };
  });
}

// Only adds what's new, so a cache already here keeps any edits and only gains a missing date.
function importFinds(finds) {
  if (!finds.length) throw new Error("no geocaches in this file");
  const current = new Map(places.map((p) => [p.id, p]));
  const added = finds.filter((f) => !current.has(f.id));
  const dated = finds.filter((f) => f.date && current.has(f.id) && !current.get(f.id).date)
    .map((f) => ({ ...current.get(f.id), date: f.date }));
  addPlaces([...added, ...dated]);
  return `${finds.length.toLocaleString("en-US")} finds in the file: ${added.length.toLocaleString("en-US")} new, ${dated.length.toLocaleString("en-US")} dates filled in.`;
}

// Tracks made from a Strava export by scripts/strava_tracks_for_app.py. They're only kept while signed in.
function importTracks(list) {
  const all = list.filter((t) => t.id && t.polylines?.length);
  if (!all.length) throw new Error("no tracks in this file");
  // Tracks already here keep any edits, and deleted ones stay deleted. The same outing from another source
  // (a watch file and a Strava export) has a different id, so it's matched by day and distance instead.
  const sameOuting = (a, b) => a.date && (a.date ?? "").slice(0, 10) === (b.date ?? "").slice(0, 10)
    && Math.abs(a.distance - b.distance) <= 0.03 * Math.max(a.distance, b.distance);
  const valid = all.filter((t) => !knownTrackIds.has(t.id) && !tracks.some((x) => sameOuting(t, x)));
  // Tracks already here gain details they lack (like moving time, for pace) without losing any edits.
  const filled = all.flatMap((t) => {
    const here = tracks.find((x) => x.id === t.id || sameOuting(t, x));
    if (!here || here.movingTime || !t.movingTime) return [];
    const { kind, lines, ...stored } = here;
    return [{ ...stored, movingTime: t.movingTime }];
  });
  if (cloud && filled.length) cloud.saveTracks(filled);
  const count = (n) => `${n.toLocaleString("en-US")} ${n === 1 ? "track" : "tracks"}`;
  const pace = filled.length ? ` Added moving time, for pace, to ${count(filled.length)} already here.` : "";
  if (!valid.length) return (all.length === 1 ? "This track is already here." : `All ${count(all.length)} are already here.`) + pace;
  if (!cloud) {
    setTracks([...tracks, ...valid]);
    return `Showing ${count(valid.length)} until you reload. Sign in first to keep them.`;
  }
  cloud.saveTracks(valid);
  return `Saving ${count(valid.length)} to your account…${pace}`;
}

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const file = files[0];
  try {
    // Geocaching's GPX lists finds; any other GPX, and any FIT file, is a workout from a watch.
    const finds = /\.gpx$/i.test(file.name) && /groundspeak/i.test(await file.slice(0, 2000).text());
    if (finds) {
      $("importStatus").textContent = importFinds(parseFinds(await file.text()));
      return;
    }
    if (/\.(fit|gpx)$/i.test(file.name)) {
      await importTrackFiles(files.filter((f) => /\.(fit|gpx)$/i.test(f.name)));
      return;
    }
    const data = JSON.parse(await file.text());
    if (data.tracks) {
      $("importStatus").textContent = importTracks(data.tracks);
      return;
    }
    const list = (data.places ?? []).filter((p) => p.id && p.name && p.category && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!list.length) throw new Error("no places in this file");
    addPlaces(list);
    $("importStatus").textContent = `Imported ${list.length.toLocaleString("en-US")} places.`;
  } catch (err) {
    $("importStatus").textContent = `Import failed: ${err.message}`;
  }
};

$("heatStyle").value = display.heatStyle;
$("heatWidth").value = display.heatWidth;
$("resetColors").hidden = !customised();
renderBaseControls();
renderCategories();
renderTrackKinds();
renderList();
