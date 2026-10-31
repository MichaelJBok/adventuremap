// Adventure Map: my places on a vector map. Anything named on the map can be clicked and added.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

const PLACES_KEY = "adventuremap.places";
const HIDDEN_KEY = "adventuremap.hiddenCategories";
const VIEW_KEY = "adventuremap.view";
const MENU_KEY = "adventuremap.menuHidden";
const NEW_CATEGORY = "__new__";
const LIST_LIMIT = 100;
const ALWAYS_VISIBLE = "Places"; // never consolidated into circles

const MUSHROOMS = "Mushrooms"; // read-only layer: finds are kept and edited in Svampkartan
const SVAMPKARTAN_KEY = "svampkartan.spots"; // same web address, so the same browser storage
const BASE_COLORS = { "Places": "#0288D1", "Points of Interest": "#F9A825", "Geocaches": "#7CB342", "Dive Sites": "#E65100", [MUSHROOMS]: "#8E24AA" };
const EXTRA_COLORS = ["#D81B60", "#00897B", "#6D4C41", "#3949AB", "#C0CA33", "#5E35B1"];

// Labels on the base map that can be added, and the category each one suggests.
const ADDABLE = { poi: "Points of Interest", mountain_peak: "Points of Interest", park: "Points of Interest",
  water_name: "Points of Interest", aerodrome_label: "Places", place: "Places" };

let places = readJson(PLACES_KEY, []);
let mushrooms = readJson(SVAMPKARTAN_KEY, []).map(toMushroom);
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

const addableCategories = () => categories().filter((c) => c !== MUSHROOMS);

function colorOf(category) {
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
const map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty", ...view });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));
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

function setBasemap(name) {
  if (map.getLayer("basemap")) { map.removeLayer("basemap"); map.removeSource("basemap"); }
  if (!name) return;
  map.addSource("basemap", { type: "raster", tileSize: 256, ...BASEMAPS[name] });
  // Below the labels, so they stay on top and stay clickable.
  const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer({ id: "basemap", type: "raster", source: "basemap" }, firstLabel);
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

function drawPlaces() {
  if (!map.getLayer("peak-dots")) return; // the map hasn't finished loading
  categories().forEach(sourceFor);
  for (const [category, id] of sourceIds) {
    map.getSource(id).setData(placesGeoJson(category));
    if (category === ALWAYS_VISIBLE) continue;
    map.setPaintProperty(`${id}-clusters`, "circle-color", colorOf(category));
    map.setPaintProperty(`${id}-counts`, "text-color", textOn(colorOf(category)));
  }
}

map.on("load", () => {
  // Summits are in the tiles, but this style doesn't draw them.
  map.addLayer({ id: "peak-dots", type: "circle", source: "openmaptiles", "source-layer": "mountain_peak", minzoom: 10,
    filter: ["==", ["get", "class"], "peak"],
    paint: { "circle-radius": 3, "circle-color": "#6d5a43", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
  map.addLayer({ id: "peak-labels", type: "symbol", source: "openmaptiles", "source-layer": "mountain_peak", minzoom: 11,
    filter: ["==", ["get", "class"], "peak"],
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top" },
    paint: { "text-color": "#6d5a43", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  drawPlaces();
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
  map.getCanvas().style.cursor = mineAt(e.point) || labelAt(e.point) ? "pointer" : "";
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
    else popup?.remove();
  }
});

// --- Popups ---
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
      <div class="pop-meta"><a href="../svampkartan/">Edit in Svampkartan</a></div>`);
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
function renderCategories() {
  const counts = {};
  allPlaces().forEach((p) => { counts[p.category] = (counts[p.category] ?? 0) + 1; });
  $("catList").innerHTML = categories().map((c) => `<li><label>
    <input type="checkbox" data-cat="${esc(c)}"${hidden.has(c) ? "" : " checked"}>
    <span class="dot" style="--c:${colorOf(c)}"></span><span>${esc(c)}</span>
    <span class="count">${(counts[c] ?? 0).toLocaleString("en-US")}</span></label></li>`).join("");
}

$("catList").onchange = (e) => {
  const c = e.target.dataset.cat;
  if (e.target.checked) hidden.delete(c); else hidden.add(c);
  writeJson(HIDDEN_KEY, [...hidden]);
  drawPlaces();
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

$("basemap").onchange = () => setBasemap($("basemap").value);

// --- Backup ---
$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ places }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `adventure-map-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = (data.places ?? []).filter((p) => p.id && p.name && p.category && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!list.length) throw new Error("no places in this file");
    addPlaces(list);
    $("importStatus").textContent = `Imported ${list.length.toLocaleString("en-US")} places.`;
  } catch (err) {
    $("importStatus").textContent = `Import failed: ${err.message}`;
  }
};

renderCategories();
renderList();
