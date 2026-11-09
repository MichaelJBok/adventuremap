"""Find Google My Tracks recordings (KML/KMZ files from its Drive folder) that aren't among the tracks already made.

Usage:  python3 scripts/mytracks_for_app.py "<My Tracks folder>"
Compares each recording with private/early-tracks.json and private/strava-tracks.json by the ground it covers, and with
the other recordings, so copies count once. Writes the missing ones to private/mytracks-app-tracks.json, loaded with
"Import JSON or GPX" while signed in, and lists them in private/mytracks-missing.txt.
Left out like the early tracks: recordings under 500 m, drives over 30 km, and untyped tracks over 100 km.
"""
import datetime
import json
import pathlib
import re
import sys
import zipfile

from early_tracks_for_app import clean_notes
from import_tracks import CELL, COORD, ROOT, metres, simplify, split_at_jumps
from strava_tracks_for_app import encode

EARLY = ROOT / "private" / "early-tracks.json"
STRAVA = ROOT / "private" / "strava-tracks.json"
OUT = ROOT / "private" / "mytracks-app-tracks.json"
LIST = ROOT / "private" / "mytracks-missing.txt"
SPORTS = {"walking": "Walk", "running": "Run", "biking": "Ride", "boating": "Sail", "boat": "Sail", "driving": "Other"}
SAME_ROUTE = 0.8          # share of a recording's ground another track must cover for it to count as already there
MIN_M, DRIVE_M, ROAD_TRIP_M = 500, 30000, 100000
TRACK = re.compile(r"<gx:Track>(.*?)</gx:Track>", re.S)
GX = re.compile(r"<gx:coord>\s*(-?[\d.]+)\s+(-?[\d.]+)")
WHEN = re.compile(r"<when>([^<]+)</when>")
LINE = re.compile(r"<LineString>.*?</LineString>", re.S)
CDATA = r"(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?"


def read_kml(path):
    data = path.read_bytes()
    if data[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            data = z.read(next(n for n in z.namelist() if n.endswith(".kml")))
    return data.decode("utf-8", "replace")


def parse(text):
    tour = re.search(r'<Placemark id="tour">(.*?)</Placemark>', text, re.S)
    body = tour[1] if tour else text
    segs, times = [], []
    for track in TRACK.findall(body):
        pts = [(float(x), float(y)) for x, y in GX.findall(track)]
        segs.append(pts)
        times.append([datetime.datetime.fromisoformat(w.strip().replace("Z", "+00:00")) for w in WHEN.findall(track)])
    if not segs:  # older files hold plain lines without times
        segs = [[(float(x), float(y)) for x, y in COORD.findall(line)] for line in LINE.findall(body)]
        times = [[] for _ in segs]
    name = re.search(r"<name>" + CDATA + r"</name>", body, re.S)
    notes = re.search(r"<description>" + CDATA + r"</description>", body, re.S)
    kind = re.search(r'<Data name="type"><value>' + CDATA + r"</value>", body, re.S)
    stamp = WHEN.search(text)
    start = next((t[0] for t in times if t), None)
    if start is None and stamp:
        start = datetime.datetime.fromisoformat(stamp[1].strip().replace("Z", "+00:00"))
    return {"name": (name[1] if name else "").strip(), "notes": (notes[1] if notes else "").strip(),
            "kind": (kind[1] if kind else "").strip().lower(), "start": start, "segs": segs, "times": times}


def moving_seconds(segs, times):
    total = 0
    for pts, ts in zip(segs, times):
        if len(ts) != len(pts):
            continue
        for a, b, ta, tb in zip(pts, pts[1:], ts, ts[1:]):
            seconds = (tb - ta).total_seconds()
            if 0 < seconds <= 300 and metres(a, b) / seconds >= 0.8:
                total += seconds
    return round(total)


def cells(segs):
    """The ground a line covers, filled in between points so simplified and full lines compare fairly."""
    out = set()
    for s in segs:
        for a, b in zip(s, s[1:]):
            n = max(1, int(metres(a, b) / 20))
            for k in range(n + 1):
                out.add((round((a[0] + (b[0] - a[0]) * k / n) / CELL), round((a[1] + (b[1] - a[1]) * k / n) / CELL)))
    return out


class Known:
    """Tracks already made, found again by the ground they cover. A route walked again on another day is another
    outing, so a match needs the same day, give or take one for time zones, unless one side has no date."""

    def __init__(self):
        self.dates, self.index = [], {}

    def add(self, date, track_cells):
        i = len(self.dates)
        self.dates.append(date or "")
        for cell in track_cells:
            self.index.setdefault(cell, []).append(i)

    def covers(self, track_cells, date, share=SAME_ROUTE):
        counts = {}
        for cell in track_cells:
            for i in self.index.get(cell, ()):
                counts[i] = counts.get(i, 0) + 1
        return any(n >= share * len(track_cells) and near(date, self.dates[i]) for i, n in counts.items())


def near(a, b):
    if not a or not b:
        return True
    return abs((datetime.date.fromisoformat(a[:10]) - datetime.date.fromisoformat(b[:10])).days) <= 1


def decode(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        values = []
        for _ in range(2):
            result = shift = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 31) << shift
                shift += 5
                if b < 32:
                    break
            values.append(~(result >> 1) if result & 1 else result >> 1)
        lat, lon = lat + values[0], lon + values[1]
        pts.append((lon / 1e5, lat / 1e5))
    return pts


def main():
    folder = pathlib.Path(sys.argv[1])
    known = Known()
    for t in json.loads(EARLY.read_text()):
        if not t["id"].startswith("strava-"):
            known.add(t["date"], cells(t["segments"]))
    for t in json.loads(STRAVA.read_text())["tracks"]:
        known.add(t["date"], cells([decode(p) for p in t["polylines"]]))
    recordings, skipped = [], {"short": 0, "drive": 0, "unreadable": 0}
    for path in sorted(folder.glob("*.km[lz]")):
        try:
            r = parse(read_kml(path))
        except (zipfile.BadZipFile, StopIteration, ValueError):
            skipped["unreadable"] += 1
            continue
        segs = [s for s in split_at_jumps([s for s in r["segs"] if len(s) > 1]) if len(s) > 1] if r["segs"] else []
        length = sum(metres(a, b) for s in segs for a, b in zip(s, s[1:]))
        if length < MIN_M:
            skipped["short"] += 1
            continue
        if (r["kind"] == "driving" and length > DRIVE_M) or (r["kind"] not in SPORTS and length > ROAD_TRIP_M):
            skipped["drive"] += 1
            continue
        # Compared as simplified lines, like the tracks they're matched against, so GPS jitter isn't new ground.
        recordings.append({**r, "file": path.name, "segs": segs, "length": length,
                           "cells": cells([simplify(s) for s in segs])})
    # The longest copy of a recording is kept; a shorter one inside it is the same outing.
    recordings.sort(key=lambda r: -len(r["cells"]))
    missing, matched, copies, kept = [], 0, 0, Known()
    for r in recordings:
        date = r["start"].date().isoformat() if r["start"] else ""
        if known.covers(r["cells"], date):
            matched += 1
        elif kept.covers(r["cells"], date):
            copies += 1
        else:
            missing.append(r)
            kept.add(date, r["cells"])
    missing.sort(key=lambda r: (r["start"] is None, r["start"] or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)))
    tracks = []
    for r in missing:
        date = r["start"].date().isoformat() if r["start"] else ""
        seconds = moving_seconds(r["segs"], r["times"])
        notes = clean_notes({"notes": r["notes"], "name": r["name"]})
        tracks.append({"id": f"mytracks-{round(r['start'].timestamp())}" if r["start"] else f"mytracks-{r['file']}",
                       "name": r["name"] or f"Track {date}".strip(), "sportType": SPORTS.get(r["kind"], "Other"),
                       "date": date, "distance": round(r["length"]), **({"movingTime": seconds} if seconds > 60 else {}),
                       **({"notes": notes} if notes else {}), "polylines": [encode(simplify(s)) for s in r["segs"]]})
    OUT.write_text(json.dumps({"tracks": tracks}, separators=(",", ":")))
    LIST.write_text("".join(f"{t['date'] or 'no date':10}  {t['sportType']:<5} {t['distance'] / 1000:6.1f} km  {t['name']}\n"
                            for t in tracks))
    years = {}
    for t in tracks:
        years[t["date"][:4] or "none"] = years.get(t["date"][:4] or "none", 0) + 1
    print(f"{len(recordings) + sum(skipped.values())} files: {skipped['short']} under {MIN_M} m, {skipped['drive']} drives, "
          f"{skipped['unreadable']} unreadable, {matched} already among the tracks, {copies} copies, {len(tracks)} missing")
    print("Missing by year: " + ", ".join(f"{y}: {n}" for y, n in sorted(years.items())))
    print(f"{OUT.stat().st_size // 1024} KB -> {OUT}\nList -> {LIST}")


if __name__ == "__main__":
    main()
