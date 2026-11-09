"""Find recordings in any folder of GPX, KML and KMZ files that aren't among the tracks already made.

Usage:  python3 scripts/loose_tracks_for_app.py "<folder>" [--name NAME]
Searches the folder and its subfolders. Each <trk> of a GPX file and each Placemark line of a KML or KMZ file is one
recording, so merged files and My Maps exports holding many lines are split up. A recording's date comes from its
times, or else from a date in its name (8_27_2013, 1/5/12). Recordings already among the tracks in private/ (by the
ground they cover on the same day, or any day for undated ones) and copies of each other are left out, and so are
recordings under 500 m, drives faster than 25 km/h and lines over 30 km with neither times nor a sport. Writes the
rest to private/NAME-app-tracks.json (NAME defaults to "loose"), loaded with "Import JSON or GPX" while signed in, and
lists them in private/NAME-missing.txt.
"""
import datetime
import html
import json
import pathlib
import re
import sys
import zipfile

from import_tracks import COORD, ROOT, metres, simplify, split_at_jumps
from mytracks_for_app import Known, cells, decode
from strava_tracks_for_app import encode

APP_FILES = "-app-tracks.json"
OTHERS = ["strava-tracks.json", "suunto-tracks.json"]
MIN_M, ROAD_TRIP_M, DRIVE_KMH = 500, 30000, 25   # an untimed, untyped line this long is a drive
GPX_TRK = re.compile(r"<trk\b.*?</trk>", re.S)
GPX_PT = re.compile(r"<trkpt\b([^>]*)>(.*?)</trkpt>|<trkpt\b([^>]*)/>", re.S)
ATTR = re.compile(r'(lat|lon)\s*=\s*"([^"]+)"')
TIME = re.compile(r"<time>([^<]+)</time>")
PLACEMARK = re.compile(r"<Placemark\b.*?</Placemark>", re.S)
GX_TRACK = re.compile(r"<gx:Track>(.*?)</gx:Track>", re.S)
GX = re.compile(r"<gx:coord>\s*(-?[\d.]+)\s+(-?[\d.]+)")
WHEN = re.compile(r"<when>([^<]+)</when>")
LINE = re.compile(r"<LineString>.*?</LineString>", re.S)
NAME = re.compile(r"<name>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</name>", re.S)
TYPE = re.compile(r'<Data name="type">\s*<value>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</value>', re.S)
NAME_DATE = re.compile(r"\b(\d{1,2})[_/](\d{1,2})[_/](\d{2}|\d{4})\b")
SPORTS = {"walking": "Walk", "running": "Run", "biking": "Ride", "cycling": "Ride", "hiking": "Hike", "boating": "Sail"}


def when(text):
    try:
        return datetime.datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def name_date(name):
    m = NAME_DATE.search(name)
    if not m:
        return ""
    month, day, year = int(m[1]), int(m[2]), int(m[3])
    year += 2000 if year < 100 else 0
    try:
        return datetime.date(year, month, day).isoformat()
    except ValueError:
        return ""


def read_gpx(text):
    for trk in GPX_TRK.findall(text):
        pts, times = [], []
        for attrs, body, bare in GPX_PT.findall(trk):
            a = dict(ATTR.findall(attrs or bare))
            if "lat" in a and "lon" in a:
                pts.append((float(a["lon"]), float(a["lat"])))
                t = TIME.search(body or "")
                times.append(when(t[1]) if t else None)
        name = NAME.search(trk.split("<trkseg", 1)[0])
        yield {"name": html.unescape(name[1].strip()) if name else "", "kind": "", "segs": [pts], "times": [times]}


def read_kml(text):
    for mark in PLACEMARK.findall(text):
        tracks = GX_TRACK.findall(mark)
        if tracks:
            segs = [[(float(x), float(y)) for x, y in GX.findall(t)] for t in tracks]
            times = [[when(w) for w in WHEN.findall(t)] for t in tracks]
        else:
            segs = [[(float(x), float(y)) for x, y in COORD.findall(line)] for line in LINE.findall(mark)]
            times = [[] for _ in segs]
        if not any(len(s) > 1 for s in segs):
            continue
        name, kind = NAME.search(mark), TYPE.search(mark)
        stamp = WHEN.search(mark)
        yield {"name": html.unescape(name[1].strip()) if name else "", "kind": (kind[1] if kind else "").strip().lower(),
               "segs": segs, "times": times, "stamp": when(stamp[1]) if stamp and not tracks else None}


def read(path):
    data = path.read_bytes()
    if data[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            data = z.read(next(n for n in z.namelist() if n.endswith(".kml")))
    text = data.decode("utf-8", "replace")
    return read_gpx(text) if path.suffix.lower() == ".gpx" else read_kml(text)


PART = re.compile(r"\s*\(Part\s*\d+\)\s*$", re.I)


def merge_parts(found):
    """My Tracks split long recordings into "(Part N)" lines, and converters split files into several tracks of one
    name; lines of one name and day in one file are one recording."""
    merged = {}
    for r in found:
        stamps = [t for ts in r["times"] for t in ts if t]
        key = (PART.sub("", r["name"]).strip(), min(stamps).date() if stamps else None)
        if key in merged:
            merged[key]["segs"] += r["segs"]
            merged[key]["times"] += r["times"]
        else:
            merged[key] = {**r, "name": key[0], "segs": list(r["segs"]), "times": list(r["times"])}
    return merged.values()


def moving_seconds(segs, times):
    total = 0
    for pts, ts in zip(segs, times):
        if len(ts) != len(pts):
            continue
        for a, b, ta, tb in zip(pts, pts[1:], ts, ts[1:]):
            if ta and tb:
                seconds = (tb - ta).total_seconds()
                if 0 < seconds <= 300 and metres(a, b) / seconds >= 0.8:
                    total += seconds
    return round(total)


def main():
    folder = pathlib.Path(sys.argv[1])
    label = sys.argv[sys.argv.index("--name") + 1] if "--name" in sys.argv else "loose"
    out, listing = ROOT / "private" / f"{label}-app-tracks.json", ROOT / "private" / f"{label}-missing.txt"
    known = Known()
    sources = [p for p in (ROOT / "private").glob("*" + APP_FILES) if p != out] + [ROOT / "private" / n for n in OTHERS]
    for path in sources:
        if path.exists():
            for t in json.loads(path.read_text())["tracks"]:
                known.add(t["date"], cells([decode(p) for p in t["polylines"]]))
    recordings, skipped = [], {"files": 0, "unreadable": 0, "short": 0, "drives": 0}
    for path in sorted(p for p in folder.rglob("*") if p.suffix.lower() in (".gpx", ".kml", ".kmz") and p.is_file()):
        skipped["files"] += 1
        try:
            found = list(read(path))
        except (zipfile.BadZipFile, StopIteration, ValueError, OSError):
            skipped["unreadable"] += 1
            continue
        for r in merge_parts(found):
            segs = split_at_jumps([s for s in r["segs"] if len(s) > 1])
            length = sum(metres(a, b) for s in segs for a, b in zip(s, s[1:]))
            stamps = [t for ts in r["times"] for t in ts if t]
            start = min(stamps) if stamps else r.get("stamp")
            date = start.date().isoformat() if start else name_date(r["name"])
            seconds = moving_seconds(r["segs"], r["times"])
            if length < MIN_M:
                skipped["short"] += 1
                continue
            if (r["kind"] == "driving" or (not stamps and r["kind"] not in SPORTS and length > ROAD_TRIP_M)
                    or (seconds and length / seconds * 3.6 > DRIVE_KMH and SPORTS.get(r["kind"]) != "Ride")):
                skipped["drives"] += 1
                continue
            recordings.append({**r, "file": str(path.relative_to(folder)), "segs": segs, "length": length,
                               "date": date, "start": start, "seconds": seconds,
                               "cells": cells([simplify(s) for s in segs])})
    recordings.sort(key=lambda r: -len(r["cells"]))  # the fullest copy of a recording is the one kept
    missing, matched, copies, kept = [], 0, 0, Known()
    for r in recordings:
        if known.covers(r["cells"], r["date"]):
            matched += 1
        elif kept.covers(r["cells"], r["date"]):
            copies += 1
        else:
            missing.append(r)
            kept.add(r["date"], r["cells"])
    missing.sort(key=lambda r: (not r["date"], r["date"], r["name"]))
    tracks = []
    for i, r in enumerate(missing):
        ident = f"{label}-{round(r['start'].timestamp())}" if r["start"] else f"{label}-{r['date'] or 'undated'}-{i}"
        tracks.append({"id": ident, "name": r["name"] or f"Track {r['date']}".strip(),
                       "sportType": SPORTS.get(r["kind"], "Other"), "date": r["date"], "distance": round(r["length"]),
                       **({"movingTime": r["seconds"]} if r["seconds"] > 60 else {}),
                       "polylines": [encode(simplify(s)) for s in r["segs"]]})
    out.write_text(json.dumps({"tracks": tracks}, separators=(",", ":")))
    listing.write_text("".join(f"{t['date'] or 'no date':10}  {t['sportType']:<5} {t['distance'] / 1000:6.1f} km  {t['name']}"
                               f"  ({r['file']})\n" for t, r in zip(tracks, missing)))
    print(f"{skipped['files']} files ({skipped['unreadable']} unreadable): {len(recordings) + skipped['short'] + skipped['drives']}"
          f" recordings, {skipped['short']} under {MIN_M} m, {skipped['drives']} drives, {matched} already among the tracks,"
          f" {copies} copies, {len(tracks)} missing")
    print(f"{out.stat().st_size // 1024} KB -> {out}\nList -> {listing}")


if __name__ == "__main__":
    main()
