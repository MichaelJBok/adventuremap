"""Find Google Fit workouts (from a Google Takeout of Fit) that aren't among the tracks already made.

Usage:  python3 scripts/fit_tracks_for_app.py "<folder holding one or more Takeout*/Fit folders>" [--auto KM]
Fit's "All sessions" records say which app made each session. Workouts started in the Fit app are kept, and My Tracks
recordings newer than its Drive folder; copies of Strava workouts are left to the Strava export. Of the walks and runs
Fit detected by itself, walks of 8 km or more are kept, and runs from before the first Strava track; the rest are
everyday walks, commutes or rougher copies of Strava runs. --auto KM keeps every detected session from that distance.
Each workout's route comes from the TCX file of the same start in "Activities".
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
AUTO = "com.google.android.gms"   # Fit's own detection of walks, runs and rides
AUTO_WALK_M = 8000
AUTO_WALK_KMH = 7         # a detected "walk" faster than this overall, stops included, was partly a ride or a bus
AUTO_RUN_M = 2000
AUTO_SAME_ROUTE = 0.5     # a detected session sharing half its ground with a track that day is that outing, roughly


def keep_detected(sport, length, elapsed, date, strava_start, auto_m):
    if auto_m is not None:
        return length >= auto_m
    if sport in ("Walk", "Hike"):
        return length >= AUTO_WALK_M and elapsed and length / elapsed * 3.6 <= AUTO_WALK_KMH
    return sport == "Run" and length >= AUTO_RUN_M and date < strava_start


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
    known, strava_start = Known(), "9999"
    for name in OTHERS:
        path = ROOT / "private" / name
        if path.exists():
            for t in json.loads(path.read_text())["tracks"]:
                known.add(t["date"], cells([decode(p) for p in t["polylines"]]))
                if name.startswith("strava"):
                    strava_start = min(strava_start, t["date"])
    # Fit keeps copies of what Strava and My Tracks recorded; their own exports are the originals. My Tracks
    # recordings after the newest one from its Drive folder are only here, so those are kept.
    mytracks = ROOT / "private" / "mytracks-app-tracks.json"
    mytracks_end = max((t["date"] for t in json.loads(mytracks.read_text())["tracks"]), default="") if mytracks.exists() else ""
    sessions, routes = [], {}
    for fit in sorted(folder.glob("**/Fit")):
        routes.update({p.name.split("_PT")[0]: p for p in (fit / "Activities").glob("*.tcx")})
        sessions += [(p, json.loads(p.read_text())) for p in sorted((fit / "All sessions").glob("*.json"))]
    counts = {"automatic, left out": 0, "copied from Strava or My Tracks": 0, "no route": 0, "short": 0, "drives": 0,
              "already there": 0, "copies": 0}
    found, kept = [], Known()
    # Workouts started on purpose go first, so a detected session on the same day never stands in for one.
    app_of = lambda s: (s.get("application") or {}).get("packageName", "")
    sessions.sort(key=lambda ps: app_of(ps[1]) == AUTO)
    for path, s in sessions:
        app = app_of(s)
        detected = app == AUTO
        if app == MY_TRACKS and s["startTime"][:10] > mytracks_end:
            pass
        elif app == MY_TRACKS or (app != FIT_APP and not detected):
            counts["copied from Strava or My Tracks"] += 1
            continue
        tcx = routes.get(path.name.rsplit("_", 1)[0])
        points, times = read_tcx(tcx) if tcx else ([], [])
        lines = [s for s in split_at_jumps([points]) if len(s) > 1] if len(points) > 1 else []
        length = sum(metres(a, b) for line in lines for a, b in zip(line, line[1:]))
        sport = SPORTS.get(s.get("fitnessActivity", ""), "Other")
        start = when(s["startTime"])
        date = start.date().isoformat()
        elapsed = float(str(s.get("duration", "0")).rstrip("s") or 0)
        if detected and not keep_detected(sport, length, elapsed, date, strava_start, auto_m):
            counts["automatic, left out"] += 1
            continue
        if not lines:
            counts["no route"] += 1
            continue
        if length < MIN_M:
            counts["short"] += 1
            continue
        seconds = moving_seconds(points, times)
        if seconds and length / seconds * 3.6 > (RIDE_DRIVE_KMH if sport == "Ride" else DRIVE_KMH):
            counts["drives"] += 1
            continue
        simple = [simplify(line) for line in lines]
        c = cells(simple)  # simplified, like the tracks it's matched against, so GPS jitter isn't new ground
        share = AUTO_SAME_ROUTE if detected else None
        if known.covers(c, date, *([share] if share else [])):
            counts["already there"] += 1
            continue
        if kept.covers(c, date, *([share] if share else [])):
            counts["copies"] += 1
            continue
        kept.add(date, c)
        found.append({"id": f"fit-{round(start.timestamp())}", "name": s.get("name") or f"{NAMES[sport]} {date}",
                      "sportType": sport, "date": date, "distance": round(length),
                      # Detected sessions have points minutes apart, too few for a believable moving time.
                      **({"movingTime": seconds} if seconds > 60 and not detected else {}),
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
