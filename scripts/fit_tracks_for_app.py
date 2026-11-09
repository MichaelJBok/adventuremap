"""Find Google Fit workouts (from a Google Takeout of Fit) that aren't among the tracks already made.

Usage:  python3 scripts/fit_tracks_for_app.py "<folder holding one or more Takeout*/Fit folders>" [--auto KM]
Fit's "All sessions" records say which app made each session. Workouts started in the Fit app are kept, and My Tracks
recordings newer than its Drive folder; copies of Strava workouts are left to the Strava export, and the walks and rides
Fit detected by itself are left out, unless --auto is given with the shortest distance
in km to keep. Each workout's route comes from the TCX file of the same start in "Activities".
Workouts already among the early, My Tracks, Strava or Suunto tracks on the same day are left out. Writes the rest to
private/fit-app-tracks.json, loaded with "Import JSON or GPX" while signed in, and lists them in private/fit-missing.txt.
"""
import datetime
import json
import pathlib
import re
import sys

from import_tracks import ROOT, metres, simplify, split_at_jumps
from mytracks_for_app import Known, cells, decode
from strava_tracks_for_app import encode

OUT = ROOT / "private" / "fit-app-tracks.json"
LIST = ROOT / "private" / "fit-missing.txt"
OTHERS = ["early-app-tracks.json", "mytracks-app-tracks.json", "strava-tracks.json", "suunto-tracks.json"]
FIT_APP, MY_TRACKS = "com.google.android.apps.fitness", "com.google.android.maps.mytracks"
DRIVE_KMH = 25            # faster than this on foot is a drive (Fit calls every My Tracks recording a walk)
RIDE_DRIVE_KMH = 40
SPORTS = {"running": "Run", "biking": "Ride", "walking": "Walk", "hiking": "Hike", "mountain_biking": "Ride",
          "road_biking": "Ride", "jogging": "Run", "sailing": "Sail", "kayaking": "Sail", "rowing": "Sail"}
NAMES = {"Run": "Run", "Ride": "Ride", "Walk": "Walk", "Hike": "Hike", "Sail": "Sail", "Other": "Workout"}
POINT = re.compile(r"<Trackpoint>(.*?)</Trackpoint>", re.S)
TIME = re.compile(r"<Time>([^<]+)</Time>")
LAT = re.compile(r"<LatitudeDegrees>([^<]+)</LatitudeDegrees>")
LON = re.compile(r"<LongitudeDegrees>([^<]+)</LongitudeDegrees>")
MIN_M = 500


def when(text):
    return datetime.datetime.fromisoformat(text.strip().replace("Z", "+00:00"))


def read_tcx(path):
    points, times = [], []
    for block in POINT.findall(path.read_text(encoding="utf-8", errors="replace")):
        t, lat, lon = TIME.search(block), LAT.search(block), LON.search(block)
        if not (t and lat and lon):
            continue
        p = (float(lon[1]), float(lat[1]))
        if abs(p[0]) > 0.01 or abs(p[1]) > 0.01:
            points.append(p)
            times.append(when(t[1]))
    return points, times


def moving_seconds(points, times):
    total = 0
    for a, b, ta, tb in zip(points, points[1:], times, times[1:]):
        seconds = (tb - ta).total_seconds()
        if 0 < seconds <= 300 and metres(a, b) / seconds >= 0.8:
            total += seconds
    return round(total)


def main():
    folder = pathlib.Path(sys.argv[1])
    auto_m = float(sys.argv[sys.argv.index("--auto") + 1]) * 1000 if "--auto" in sys.argv else None
    known = Known()
    for name in OTHERS:
        path = ROOT / "private" / name
        if path.exists():
            for t in json.loads(path.read_text())["tracks"]:
                known.add(t["date"], cells([decode(p) for p in t["polylines"]]))
    # Fit keeps copies of what Strava and My Tracks recorded; their own exports are the originals. My Tracks
    # recordings after the newest one from its Drive folder are only here, so those are kept.
    mytracks = ROOT / "private" / "mytracks-app-tracks.json"
    mytracks_end = max((t["date"] for t in json.loads(mytracks.read_text())["tracks"]), default="") if mytracks.exists() else ""
    sessions, routes = [], {}
    for fit in sorted(folder.glob("**/Fit")):
        routes.update({p.name.split("_PT")[0]: p for p in (fit / "Activities").glob("*.tcx")})
        sessions += [(p, json.loads(p.read_text())) for p in sorted((fit / "All sessions").glob("*.json"))]
    counts = {"automatic": 0, "copied from Strava or My Tracks": 0, "no route": 0, "short": 0, "drives": 0,
              "already there": 0, "copies": 0}
    found, kept = [], Known()
    for path, s in sessions:
        app = (s.get("application") or {}).get("packageName", "")
        distance = next((a.get("floatValue", 0) for a in s.get("aggregate", [])
                         if a["metricName"] == "com.google.distance.delta"), 0)
        if app == MY_TRACKS and s["startTime"][:10] > mytracks_end:
            pass
        elif app == MY_TRACKS or (app != FIT_APP and app != "com.google.android.gms"):
            counts["copied from Strava or My Tracks"] += 1
            continue
        elif app != FIT_APP and (auto_m is None or distance < auto_m):
            counts["automatic"] += 1
            continue
        tcx = routes.get(path.name.rsplit("_", 1)[0])
        points, times = read_tcx(tcx) if tcx else ([], [])
        lines = [s for s in split_at_jumps([points]) if len(s) > 1] if len(points) > 1 else []
        length = sum(metres(a, b) for line in lines for a, b in zip(line, line[1:]))
        if not lines:
            counts["no route"] += 1
            continue
        if length < MIN_M:
            counts["short"] += 1
            continue
        sport = SPORTS.get(s.get("fitnessActivity", ""), "Other")
        seconds = moving_seconds(points, times)
        if seconds and length / seconds * 3.6 > (RIDE_DRIVE_KMH if sport == "Ride" else DRIVE_KMH):
            counts["drives"] += 1
            continue
        start = when(s["startTime"])
        date = start.date().isoformat()
        simple = [simplify(line) for line in lines]
        c = cells(simple)  # simplified, like the tracks it's matched against, so GPS jitter isn't new ground
        if known.covers(c, date):
            counts["already there"] += 1
            continue
        if kept.covers(c, date):
            counts["copies"] += 1
            continue
        kept.add(date, c)
        found.append({"id": f"fit-{round(start.timestamp())}", "name": s.get("name") or f"{NAMES[sport]} {date}",
                      "sportType": sport, "date": date, "distance": round(length),
                      **({"movingTime": seconds} if seconds > 60 else {}),
                      "polylines": [encode(line) for line in simple]})
    found.sort(key=lambda t: t["id"])
    OUT.write_text(json.dumps({"tracks": found}, separators=(",", ":")))
    LIST.write_text("".join(f"{t['date']}  {t['sportType']:<5} {t['distance'] / 1000:6.1f} km  {t['name']}\n" for t in found))
    years = {}
    for t in found:
        years[t["date"][:4]] = years.get(t["date"][:4], 0) + 1
    print(f"{len(sessions)} sessions: " + ", ".join(f"{n} {k}" for k, n in counts.items()) + f", {len(found)} missing")
    print("Missing by year: " + ", ".join(f"{y}: {n}" for y, n in sorted(years.items())))
    print(f"{OUT.stat().st_size // 1024} KB -> {OUT}\nList -> {LIST}")


if __name__ == "__main__":
    main()
