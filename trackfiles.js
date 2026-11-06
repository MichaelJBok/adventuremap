// Reads workout files exported from a watch app (FIT or GPX) into tracks, and receives them when shared
// to the installed app. Exporting from the Suunto app and sharing here needs no other service in between.
const FIT_EPOCH = 631065600; // FIT times count seconds from 1989-12-31, UTC
const FIT_SPORTS = { 1: "Run", 2: "Ride", 11: "Walk", 16: "Hike", 17: "Hike", 21: "Ride", 32: "Sail" };
const FIT_RECORD = 20, FIT_SESSION = 18;
const SHARE_CACHE = "adventuremap-shared"; // where the service worker leaves shared files (see sw.js)
const SIMPLIFY_M = 4; // like the importer scripts: drops points that barely change the line

// The GPS points of a FIT file, plus its start time and sport. A damaged file gives what came before the damage.
function readFit(buffer) {
  const data = new DataView(buffer);
  const points = [], times = [];
  const layouts = {};
  let start = null, sport = null, lastTime = null;
  let pos = data.getUint8(0);
  const end = pos + data.getUint32(4, true);
  const value = (fields, at, little, num) => {
    const f = fields.find((x) => x.num === num);
    if (!f) return null;
    const p = at + f.offset;
    if (f.size === 4) return f.signed ? data.getInt32(p, little) : data.getUint32(p, little);
    if (f.size === 2) return data.getUint16(p, little);
    return data.getUint8(p);
  };
  try {
    while (pos < end) {
      const header = data.getUint8(pos++);
      const compressed = header & 0x80;
      const local = compressed ? (header >> 5) & 3 : header & 15;
      if (!compressed && header & 0x40) {
        const little = data.getUint8(pos + 1) === 0;
        const number = data.getUint16(pos + 2, little);
        const count = data.getUint8(pos + 4);
        pos += 5;
        const fields = [];
        let size = 0;
        for (let i = 0; i < count; i++, pos += 3) {
          const num = data.getUint8(pos), width = data.getUint8(pos + 1), base = data.getUint8(pos + 2);
          fields.push({ num, size: width, offset: size, signed: (base & 0x1f) === 5 });
          size += width;
        }
        if (header & 0x20) { // developer fields
          const extra = data.getUint8(pos);
          for (let i = 0; i < extra; i++) size += data.getUint8(pos + 2 + 3 * i);
          pos += 1 + 3 * extra;
        }
        layouts[local] = { number, fields, size, little };
        continue;
      }
      const layout = layouts[local];
      if (layout.number === FIT_RECORD) {
        const time = value(layout.fields, pos, layout.little, 253);
        if (time !== null) lastTime = time;
        const lat = value(layout.fields, pos, layout.little, 0), lon = value(layout.fields, pos, layout.little, 1);
        if (lat !== null && lon !== null && lat !== 0x7fffffff && lon !== 0x7fffffff) {
          points.push([lon * 180 / 2 ** 31, lat * 180 / 2 ** 31]);
          times.push(lastTime === null ? NaN : (lastTime + FIT_EPOCH) * 1000);
        }
        if (start === null && lastTime !== null) start = lastTime;
      } else if (layout.number === FIT_SESSION) {
        sport = value(layout.fields, pos, layout.little, 5) ?? sport;
        const begun = value(layout.fields, pos, layout.little, 2);
        if (begun !== null) start = begun;
      }
      pos += layout.size;
    }
  } catch {} // reading past the end of a cut-off file
  return { points, times, start: start === null ? null : new Date((start + FIT_EPOCH) * 1000), sport: FIT_SPORTS[sport] ?? "Other" };
}

// The sport named in some text, such as a GPX type or name, or the message shared with a link.
const SPORT_WORDS = [["run", "Run"], ["jog", "Run"], ["löp", "Run"], ["hik", "Hike"], ["trek", "Hike"], ["vandr", "Hike"],
  ["walk", "Walk"], ["promen", "Walk"], ["cycl", "Ride"], ["bik", "Ride"], ["ride", "Ride"], ["cykl", "Ride"]];
const sportIn = (text) => SPORT_WORDS.find(([word]) => (text ?? "").toLowerCase().includes(word))?.[1];

// Distance and time spent moving: stops (under 0.8 m/s) and long pauses don't count.
function moving(points, times) {
  let metresMoving = 0, secondsMoving = 0;
  for (let i = 1; i < points.length; i++) {
    const seconds = (times[i] - times[i - 1]) / 1000;
    if (!(seconds > 0) || seconds > 300) continue;
    const m = metres({ lat: points[i - 1][1], lon: points[i - 1][0] }, { lat: points[i][1], lon: points[i][0] });
    if (m / seconds < 0.8) continue;
    metresMoving += m;
    secondsMoving += seconds;
  }
  return { metres: metresMoving, seconds: secondsMoving };
}

// Judged from moving speed when nothing names the sport.
function sportFromSpeed(points, times) {
  const { metres: metresMoving, seconds: secondsMoving } = moving(points, times);
  if (secondsMoving < 300) return "Other";
  const kmh = metresMoving / secondsMoving * 3.6;
  return kmh < 6.8 ? "Walk" : kmh < 18 ? "Run" : "Ride";
}

function readGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const trkpts = [...doc.getElementsByTagNameNS("*", "trkpt")];
  const pts = trkpts.length ? trkpts : [...doc.getElementsByTagNameNS("*", "rtept")]; // some apps export a route instead
  const times = pts.map((p) => Date.parse(p.getElementsByTagNameNS("*", "time")[0]?.textContent ?? ""));
  const time = times.find((t) => !isNaN(t));
  const tagText = (tag) => [...doc.getElementsByTagNameNS("*", tag)].map((e) => e.textContent).join(" ");
  const points = pts.map((p) => [Number(p.getAttribute("lon")), Number(p.getAttribute("lat"))]);
  const kept = points.map((p, i) => [p, times[i]]).filter(([[x, y]]) => x || y);
  return {
    points: kept.map(([p]) => p),
    times: kept.map(([, t]) => t),
    start: time === undefined ? null : new Date(time),
    sport: sportIn(tagText("type")) ?? sportIn(`${tagText("name")} ${tagText("desc")} ${tagText("keywords")}`)
      ?? sportFromSpeed(kept.map(([p]) => p), kept.map(([, t]) => t)),
    name: doc.getElementsByTagNameNS("*", "trk")[0]?.getElementsByTagNameNS("*", "name")[0]?.textContent.trim(),
  };
}

// Douglas-Peucker, iterative so long recordings can't overflow the stack.
function simplifyLine(pts) {
  if (pts.length < 3) return pts;
  const keep = new Set([0, pts.length - 1]);
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    const [a, b] = [pts[lo], pts[hi]];
    const scale = Math.cos((a[1] * Math.PI) / 180);
    const dx = (b[0] - a[0]) * scale, dy = b[1] - a[1];
    const size = Math.hypot(dx, dy) || 1e-12;
    let far = 0, farAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = (Math.abs((pts[i][0] - a[0]) * scale * dy - (pts[i][1] - a[1]) * dx) / size) * 111320;
      if (d > far) { far = d; farAt = i; }
    }
    if (far > SIMPLIFY_M) { keep.add(farAt); stack.push([lo, farAt], [farAt, hi]); }
  }
  return [...keep].sort((x, y) => x - y).map((i) => pts[i]);
}

// A track from a FIT or GPX file. Its id comes from the start time, so sharing the same file twice adds it once.
async function readTrackFile(file, hint = "") {
  // Judged by content, since a shared file's name may lack its extension: FIT files carry ".FIT" at byte 8.
  const buffer = await file.arrayBuffer();
  const fit = buffer.byteLength >= 12 && new TextDecoder().decode(new Uint8Array(buffer, 8, 4)) === ".FIT";
  const read = fit ? readFit(buffer) : readGpx(new TextDecoder().decode(buffer));
  // Text shared alongside a link (like "my running workout") names the sport when the file doesn't.
  if (read.sport === "Other" || !fit) read.sport = sportIn(hint) ?? read.sport;
  // Suunto names exports like "suuntoapp-Running-2026-11-06T07-30-00", which names the sport too.
  if (read.sport === "Other") read.sport = sportIn(read.name) ?? "Other";
  if (read.points.length < 2) {
    // Show the start of what arrived, since a share can carry a link or message instead of a workout file.
    const sample = fit ? "" : new TextDecoder().decode(buffer.slice(0, 300)).replace(/\s+/g, " ").trim();
    throw new Error(`“${file.name}” has no GPS route that could be read.${sample ? ` It contained: “${sample}”` : ""}`);
  }
  // A gap of over 3 km between fixes is lost signal, so the line breaks there instead of jumping.
  const lines = [[read.points[0]]];
  for (let i = 1; i < read.points.length; i++) {
    const [a, b] = [read.points[i - 1], read.points[i]];
    if (metres({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }) > 3000) lines.push([]);
    lines.at(-1).push(b);
  }
  const kept = lines.filter((l) => l.length > 1).map(simplifyLine);
  const start = read.start && !isNaN(read.start) ? read.start : null;
  const date = start ? start.toISOString().slice(0, 10) : "";
  const { seconds } = moving(read.points, read.times ?? []);
  const name = cleanTrackName(read.name ?? "");
  return {
    id: start ? `file-${Math.round(start.getTime() / 1000)}` : `file-${file.name}-${read.points.length}`,
    name: name || [read.sport === "Other" ? "Workout" : read.sport, date].filter(Boolean).join(" "),
    sportType: read.sport, date, distance: Math.round(lineLength(kept)), polylines: kept.map(encodePolyline),
    ...(seconds > 60 ? { movingTime: Math.round(seconds) } : {}),
  };
}

// The Suunto app's export shares a download link rather than the file itself. Its server (Sports Tracker,
// which runs the Suunto app's backend) lets this page download from it, so the link is followed here.
const WORKOUT_LINK = /https:\/\/[\w.-]*(sports-tracker\.com|suunto\.com)\/[^\s"'<>]+/i;

async function fetchLinkedWorkout(text) {
  const link = text.match(WORKOUT_LINK)?.[0];
  if (!link) return null;
  const res = await fetch(link);
  if (!res.ok) throw new Error(`The Suunto link didn't give a workout (error ${res.status}). Links from an export may expire, so try exporting again.`);
  const name = res.headers.get("content-disposition")?.match(/filename="?([^";]+)/)?.[1] ?? "suunto workout";
  const file = new File([await res.blob()], name);
  file.hint = text.replace(WORKOUT_LINK, ""); // the rest of the shared message
  return file;
}

// Imports watch files, then shows the newest on the map so it's clear what arrived.
async function importTrackFiles(files) {
  const found = [], failed = [];
  for (const file of files) {
    try {
      found.push(await readTrackFile(file, file.hint));
    } catch (e) {
      // A small text file may just hold a link to the workout.
      const linked = file.size < 5000 ? await fetchLinkedWorkout(await file.text()).catch((err) => err) : null;
      if (linked instanceof File) {
        try { found.push(await readTrackFile(linked, linked.hint)); } catch (err) { failed.push(err.message); }
      } else failed.push(linked instanceof Error ? linked.message : e.message);
    }
  }
  let message = failed.join(" ");
  try {
    if (found.length) message = [importTracks(found), message].filter(Boolean).join(" ");
  } catch (e) {
    message = `The track couldn't be saved: ${e.message}`;
  }
  $("importStatus").textContent = message;
  const newest = found.sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!newest) {
    // The side panel is often hidden on a phone, so the result always shows on the map.
    openPopup(map.getCenter(), `<div class="pop-title">Nothing was added</div><p class="pop-notes">${esc(message)}</p>`);
    return message;
  }
  const t = { ...newest, kind: trackKind(newest), lines: newest.polylines.map(decodePolyline) };
  const pts = t.lines.flat();
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  openPopup([(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2],
    `<div class="pop-title">${esc(t.name)}</div><div class="pop-meta">${esc(trackMeta(t))}</div><p class="pop-notes">${esc(message)}</p>`);
  highlightTrack(t);
  popup.once("close", () => highlightTrack(null));
  return message;
}

// Files shared to the installed app wait in a cache until the account is ready to store them.
let sharedWaiting = new URLSearchParams(location.search).has("shared");
if (sharedWaiting) history.replaceState(null, "", location.pathname);

async function takeSharedFiles() {
  if (!sharedWaiting) return;
  sharedWaiting = false;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files = [];
    let words = "";
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response.headers.get("x-text")) { words = await response.text(); await cache.delete(request); continue; }
      files.push(new File([await response.blob()], decodeURIComponent(response.headers.get("x-name") ?? "shared file")));
      await cache.delete(request);
    }
    const linked = !files.length && words ? await fetchLinkedWorkout(words) : null;
    if (linked) files.push(linked);
    if (files.length) await importTrackFiles(files);
    else openPopup(map.getCenter(), `<div class="pop-title">No file arrived</div>
      <p class="pop-notes">The share opened Adventure Map, but no file came with it${words ? `, only this: “${esc(words.slice(0, 300))}”` : ""}.
      In the Suunto app, export the workout as GPX or FIT, then share that file.</p>`);
  } catch (e) {
    openPopup(map.getCenter(), `<div class="pop-title">The shared file couldn't be read</div><p class="pop-notes">${esc(e.message)}</p>`);
  }
}

// Called by sync.js once sign-in has settled and my tracks have loaded (or there's no account).
function accountReady(signedIn) {
  if (!sharedWaiting) return;
  if (signedIn) takeSharedFiles();
  else openPopup(map.getCenter(), `<div class="pop-title">Sign in to save shared tracks</div>
    <div class="pop-meta">The shared file is waiting. Sign in, and it will be added.</div>`);
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// On a computer, workout files can be dropped straight onto the map.
const dropZone = $("map");
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); });
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter((f) => /\.(fit|gpx)$/i.test(f.name));
  if (files.length) importTrackFiles(files);
});
