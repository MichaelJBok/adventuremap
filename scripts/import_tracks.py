"""Collect old tracks from a Google Fusion Tables Takeout and a Strava export into one review file.

Usage:  python3 scripts/import_tracks.py "<Fusion Tables folder>" "<Strava export.zip>"
Writes private/early-tracks.json and private/track-review.html, a page to open and review them on a map.
The private/ folder is git-ignored so tracks never reach a public repository.

Fusion tables overlap heavily. My Tracks split long recordings into "(Part N)" rows, so parts are joined back
into one track. The same recording in several tables is kept once, as its most detailed copy. Routes
repeated on different days are separate outings and are all kept, as is every Strava activity.
"""
import csv
import datetime
import gzip
import hashlib
import html
import json
import math
import pathlib
import re
import struct
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "private" / "early-tracks.json"
REVIEW = ROOT / "private" / "track-review.html"
PART = re.compile(r"\s*\(Part\s*(\d+)\)", re.I)
LINE = re.compile(r"<LineString>.*?</LineString>", re.S)
COORD = re.compile(r"(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)")
CELL = 0.0004             # about 40 m; two tracks match when they cover the same cells
SAME_ROUTE = 0.9          # share of the shorter track's cells that must match
SIMPLIFY_M = 4            # drops points that barely change the line
JUMP_M = 3000             # a gap this long between fixes is lost signal, so the line is broken there
MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()
ACTIVITIES = (("biking", "Ride"), ("bike", "Ride"), ("running", "Run"), ("hiking", "Hike"), ("walking", "Walk"),
              ("driving", "Drive"), ("boating", "Boat"))
STRAVA_TYPES = {"Run": "Run", "Ride": "Ride", "Hike": "Hike", "Walk": "Walk", "Sail": "Boat", "Canoe": "Boat"}
TRKPT = re.compile(r"<trkpt\b([^>]*)>")
FIT_RECORD = 20           # FIT message number for a recorded point
FIT_LAT, FIT_LON = 0, 1   # its latitude and longitude fields
FIT_NO_VALUE = 0x7FFFFFFF
SEMICIRCLE = 180 / 2 ** 31
csv.field_size_limit(10 ** 9)


def metres(a, b):
    x = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    return 6371000 * math.hypot(x, math.radians(b[1] - a[1]))


def simplify(pts):
    """Douglas-Peucker, iterative so long tracks can't overflow the stack."""
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        a, b = pts[lo], pts[hi]
        scale = math.cos(math.radians(a[1]))
        dx, dy = (b[0] - a[0]) * scale, b[1] - a[1]
        size = math.hypot(dx, dy) or 1e-12
        far, far_i = 0, None
        for i in range(lo + 1, hi):
            px, py = (pts[i][0] - a[0]) * scale, pts[i][1] - a[1]
            d = abs(px * dy - py * dx) / size * 111320
            if d > far:
                far, far_i = d, i
        if far > SIMPLIFY_M:
            keep.add(far_i)
            stack += [(lo, far_i), (far_i, hi)]
    return [pts[i] for i in sorted(keep)]


def to_date(month, day, year):
    year = int(year)
    year += 2000 if year < 100 else 0
    try:
        return datetime.date(year, int(month), int(day)).isoformat()
    except ValueError:
        return None


def find_date(text):
    text = text or ""
    m = re.search(r"(?<!\d)(20[01]\d)-(\d\d)-(\d\d)", text)
    if m:
        return to_date(m[2], m[3], m[1])
    m = re.search(r"(?<!\d)(\d{1,2})-([A-Z]{3})-(\d\d)(?!\d)", text, re.I)
    if m and m[2].lower() in MONTHS:
        return to_date(MONTHS.index(m[2].lower()) + 1, m[1], m[3])
    m = re.search(r"(?<![\d/.-])(1[0-5])(0[1-9]|1[0-2])([0-3]\d)(?![\d/.-])", text)  # 140530
    if m:
        return to_date(m[2], m[3], m[1])
    m = re.search(r"(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)", text)
    return to_date(m[1], m[2], m[3]) if m else None


def activity(description):
    m = re.search(r"Activity type:\s*([^<\n]*)", description)
    found = m[1].lower() if m else ""
    return next((kind for word, kind in ACTIVITIES if word in found), "")


def clean_notes(description):
    m = re.search(r"Description:\s*([^<\n]*?)(?:Total distance|<|\n|$)", description)
    note = html.unescape(m[1]).strip() if m else ""
    if note in ("", "-"):
        note = html.unescape(re.sub(r"<[^>]+>", " ", description.split("<p>")[0])).strip()
    return "" if note in ("Path", "-") or note.startswith("Created by") else note[:300]


def read_rows(folder):
    for path in sorted(folder.glob("*/*.csv")):
        table = re.sub(r" - [0-9a-f]{5}$", "", path.parent.name)
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            for row in csv.DictReader(f):
                segs = []
                for line in LINE.findall(row.get("geometry") or ""):
                    pts = [(float(x), float(y)) for x, y in COORD.findall(line)]
                    pts = [p for p in pts if abs(p[0]) > 0.01 or abs(p[1]) > 0.01]
                    if len(pts) >= 2:
                        segs.append(pts)
                if segs:
                    yield table, (row.get("name") or "").strip(), row.get("description") or "", segs


def split_at_jumps(segs):
    out = []
    for seg in segs:
        run = [seg[0]]
        for a, b in zip(seg, seg[1:]):
            if metres(a, b) > JUMP_M:
                out.append(run)
                run = []
            run.append(b)
        out.append(run)
    return [s for s in out if len(s) >= 2]


def distinct_segments(parts):
    """A table can hold a recording several times over, whole and in parts, so drop points already covered."""
    segs = [s for _, ss in parts for s in ss]
    kept, seen = [], set()
    for i in sorted(range(len(segs)), key=lambda i: -len(segs[i])):
        points = set(segs[i])
        if len(points & seen) < 0.9 * len(points):
            kept.append(i)
            seen |= points
    return [segs[i] for i in sorted(kept)]


def build(rows):
    """Join the (Part N) rows of each table, turning rows into whole recordings."""
    groups = {}
    for table, name, description, segs in rows:
        part = PART.search(name)
        base = PART.sub(" ", name).strip() if part else name
        base = re.sub(r"\s+", " ", base)
        # "Path" rows have no real name, so they can't be joined with each other.
        key = (table, base, id(segs)) if base.lower() in ("", "path") else (table, base)
        g = groups.setdefault(key, {"table": table, "name": base, "parts": [], "description": ""})
        g["parts"].append((int(part[1]) if part else 0, segs))
        if len(description) > len(g["description"]):
            g["description"] = description

    tracks = []
    for g in groups.values():
        g["parts"].sort(key=lambda p: p[0])
        segs = split_at_jumps(distinct_segments(g["parts"]))
        length = sum(metres(a, b) for s in segs for a, b in zip(s, s[1:]))
        if not segs or length < 50:
            continue
        name, table = g["name"], g["table"]
        recorded = re.search(r"Recorded:\s*([^<\n]+)", g["description"])
        date = find_date(name) or find_date(recorded[1] if recorded else "") or find_date(table)
        cells = {(round(p[0] / CELL), round(p[1] / CELL)) for s in segs for p in s}
        tracks.append({"name": name if name.lower() not in ("", "path") else "Unnamed track", "table": table, "date": date,
                       "activity": activity(g["description"]), "notes": clean_notes(g["description"]),
                       "km": round(length / 1000, 2), "points": sum(len(s) for s in segs),
                       "segments": segs, "cells": cells})
    return tracks


def merge_copies(tracks):
    """The same recording is the same route on the same day, or a route with no date to tell them apart."""
    tracks.sort(key=lambda t: (-t["points"], t["date"] is None, t["name"]))
    kept = []
    for t in tracks:
        for k in kept:
            if t["date"] and k["date"] and t["date"] != k["date"] or from_strava(t) and from_strava(k):
                continue
            small, big = sorted((t["cells"], k["cells"]), key=len)
            if len(small) >= SAME_ROUTE * len(big) and len(small & big) >= SAME_ROUTE * len(small):
                k["copies"] += 1
                k["tables"].add(t["table"])
                k["date"] = k["date"] or t["date"]
                k["activity"] = k["activity"] or t["activity"]
                k["notes"] = k["notes"] or t["notes"]
                if re.search("[a-z]{3}", t["name"]) and not re.search("[a-z]{3}", k["name"]):
                    k["name"] = t["name"]
                break
        else:
            kept.append({**t, "copies": 1, "tables": {t["table"]}})
    return kept


def fit_points(data):
    """Read the GPS points of a FIT file. A damaged file gives the points before the damage."""
    points, layouts = [], {}
    pos, end = data[0], data[0] + int.from_bytes(data[4:8], "little")
    try:
        while pos < end:
            header = data[pos]
            pos += 1
            local = (header >> 5) & 3 if header & 0x80 else header & 15
            if header & 0x80 or not header & 0x40:
                number, size, lat, lon, order = layouts[local]
                if number == FIT_RECORD and lat is not None and lon is not None:
                    y, x = struct.unpack_from(order + "i", data, pos + lat)[0], struct.unpack_from(order + "i", data, pos + lon)[0]
                    if FIT_NO_VALUE not in (y, x):
                        points.append((x * SEMICIRCLE, y * SEMICIRCLE))
                pos += size
                continue
            order = "<" if data[pos + 1] == 0 else ">"
            number = struct.unpack_from(order + "H", data, pos + 2)[0]
            count = data[pos + 4]
            pos += 5
            size, lat, lon = 0, None, None
            for _ in range(count):
                field, width = data[pos], data[pos + 1]
                lat = size if field == FIT_LAT and width == 4 else lat
                lon = size if field == FIT_LON and width == 4 else lon
                size += width
                pos += 3
            if header & 0x20:  # developer fields
                count = data[pos]
                size += sum(data[pos + 2 + 3 * i] for i in range(count))
                pos += 1 + 3 * count
            layouts[local] = (number, size, lat, lon, order)
    except (IndexError, KeyError, struct.error):
        pass
    return points


def gpx_points(text):
    points = []
    for attrs in TRKPT.findall(text):
        lat, lon = re.search(r'lat="([^"]+)"', attrs), re.search(r'lon="([^"]+)"', attrs)
        if lat and lon:
            points.append((float(lon[1]), float(lat[1])))
    return points


def read_strava(path):
    """Each activity keeps Strava's id, so a later export or a live sync can't add it twice."""
    tracks, skipped = [], 0
    with zipfile.ZipFile(path) as z, z.open("activities.csv") as f:
        for row in csv.DictReader(line.decode("utf-8") for line in f):
            filename = row["Filename"]
            points = []
            if filename:
                data = z.read(filename)
                data = gzip.decompress(data) if filename.endswith(".gz") else data
                points = gpx_points(data.decode("utf-8", "replace")) if ".gpx" in filename else fit_points(data)
            segs = split_at_jumps([[p for p in points if abs(p[0]) > 0.01 or abs(p[1]) > 0.01]]) if points else []
            if not segs:
                skipped += 1
                continue
            date = datetime.datetime.strptime(row["Activity Date"], "%b %d, %Y, %I:%M:%S %p").date().isoformat()
            tracks.append({"id": f"strava-{row['Activity ID']}", "name": row["Activity Name"], "table": "Strava", "date": date,
                           "activity": STRAVA_TYPES.get(row["Activity Type"], ""), "notes": row["Activity Description"][:300],
                           "km": round(sum(metres(a, b) for s in segs for a, b in zip(s, s[1:])) / 1000, 2),
                           "points": sum(len(s) for s in segs), "segments": segs,
                           "cells": {(round(p[0] / CELL), round(p[1] / CELL)) for s in segs for p in s}})
    return tracks, skipped


def from_strava(t):
    return t["table"] == "Strava"


def main():
    tracks, skipped = [], 0
    for source in map(pathlib.Path, sys.argv[1:]):
        if source.suffix == ".zip":
            found, none = read_strava(source)
            tracks += found
            skipped += none
        else:
            tracks += build(read_rows(source))
    kept = merge_copies(tracks)
    # A short fragment of a fuller track on the same day is worth a look, but isn't certain enough to drop.
    by_date = {}
    for t in kept:
        by_date.setdefault(t["date"], []).append(t)
    for t in kept:
        for k in by_date[t["date"]] if t["date"] else []:
            if k is not t and not (from_strava(t) and from_strava(k)) and len(t["cells"]) < len(k["cells"]) \
                    and len(t["cells"] & k["cells"]) >= SAME_ROUTE * len(t["cells"]):
                t["partOf"] = k["name"]
                break
    out = []
    for t in sorted(kept, key=lambda t: (t["date"] or "9999", t["name"])):
        segs = [[[round(x, 5), round(y, 5)] for x, y in simplify(s)] for s in t["segments"]]
        key = json.dumps(t["segments"][0][:50])
        out.append({"id": t.get("id") or "early-" + hashlib.sha1(key.encode()).hexdigest()[:12], "name": t["name"], "date": t["date"],
                    "activity": t["activity"], "notes": t["notes"], "km": t["km"], "copies": t["copies"],
                    "tables": sorted(t["tables"]), "partOf": t.get("partOf"), "segments": segs})
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    page = (ROOT / "scripts" / "track_review.html").read_text()
    REVIEW.write_text(page.replace("/*TRACKS*/", json.dumps(out, separators=(",", ":")).replace("</", "<\\/")))
    undated = sum(not t["date"] for t in out)
    print(f"{len(tracks)} recordings with routes ({skipped} Strava activities had none), {len(out)} after merging copies "
          f"({undated} undated, {sum(bool(t['partOf']) for t in out)} possible fragments)")
    print(f"{sum(len(s) for t in out for s in t['segments'])} points kept, {OUT.stat().st_size // 1024} KB -> {OUT}")


if __name__ == "__main__":
    main()
