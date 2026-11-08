"""Find workouts in a Suunto data export that aren't among the Strava tracks, and make a file of them for Adventure Map.

Usage:  python3 scripts/suunto_tracks_for_app.py "<Suunto export folder>"
Reads the export's workouts/*.gpx and compares them with private/strava-tracks.json (from strava_tracks_for_app.py).
Writes private/suunto-tracks.json with only the missing workouts, loaded with "Import JSON or GPX" while signed in,
and private/suunto-missing.txt listing them. A workout counts as already there when a Strava track has the same day
and a distance within 3%, the same rule the app uses on import, so importing never adds an outing twice. Workouts
after the newest Strava track are left out, since the live Strava sync and Suunto sharing bring those in.
"""
import datetime
import json
import pathlib
import re
import sys

from import_tracks import ROOT, metres, simplify, split_at_jumps
from strava_tracks_for_app import encode

STRAVA = ROOT / "private" / "strava-tracks.json"
OUT = ROOT / "private" / "suunto-tracks.json"
LIST = ROOT / "private" / "suunto-missing.txt"
SPORTS = {"running": "Run", "trail_running": "Run", "orienteering": "Run", "cycling": "Ride", "hiking": "Hike",
          "walking": "Walk", "sailing": "Sail", "canoeing": "Sail"}
NAMES = {"Run": "Run", "Ride": "Ride", "Hike": "Hike", "Walk": "Walk", "Sail": "Sail", "Other": "Workout"}
POINT = re.compile(r'<trkpt\b[^>]*?lat="([^"]+)"[^>]*?lon="([^"]+)"[^>]*>(.*?)</trkpt>', re.S)
TIME = re.compile(r"<time>([^<]+)</time>")
SAME_DISTANCE = 0.03
MIN_M = 500               # shorter recordings are false starts, not outings


def read_gpx(path):
    points, times = [], []
    for lat, lon, inner in POINT.findall(path.read_text(encoding="utf-8", errors="replace")):
        p = (float(lon), float(lat))
        if abs(p[0]) <= 0.01 and abs(p[1]) <= 0.01:
            continue
        t = TIME.search(inner)
        points.append(p)
        times.append(datetime.datetime.fromisoformat(t[1].replace("Z", "+00:00")) if t else None)
    return points, times


def moving_seconds(points, times):
    """The same rule as the app: steps under 0.8 m/s or after a pause of over 5 minutes don't count."""
    total = 0
    for a, b, ta, tb in zip(points, points[1:], times, times[1:]):
        seconds = (tb - ta).total_seconds() if ta and tb else 0
        if 0 < seconds <= 300 and metres(a, b) / seconds >= 0.8:
            total += seconds
    return round(total)


def read_workout(path):
    sport_word = re.sub(r"\.\d+$", "", path.stem).rsplit("-", 1)[-1]  # "..._17.24.38-cycling.2" -> "cycling"
    sport = SPORTS.get(sport_word, "Other")
    points, times = read_gpx(path)
    lines = [s for s in split_at_jumps([points]) if len(s) > 1] if len(points) > 1 else []
    if sum(metres(a, b) for s in lines for a, b in zip(s, s[1:])) < MIN_M:
        return None
    start = next((t for t in times if t), None)
    if start is None:  # the file name holds the start time in UTC, like 2024-05-04_09.19.50-running
        start = datetime.datetime.strptime(path.stem[:19], "%Y-%m-%d_%H.%M.%S").replace(tzinfo=datetime.timezone.utc)
    date = start.date().isoformat()
    seconds = moving_seconds(points, times)
    return {"id": f"file-{round(start.timestamp())}", "name": f"{NAMES[sport]} {date} {start:%H:%M}", "sportType": sport,
            "date": date, "distance": round(sum(metres(a, b) for s in lines for a, b in zip(s, s[1:]))),
            **({"movingTime": seconds} if seconds > 60 else {}),
            "polylines": [encode(simplify(s)) for s in lines], "source": path.name}


def same_outing(a, b):
    return a["date"] == b["date"] and abs(a["distance"] - b["distance"]) <= SAME_DISTANCE * max(a["distance"], b["distance"])


def main():
    folder = pathlib.Path(sys.argv[1])
    strava = json.loads(STRAVA.read_text())["tracks"]
    by_date = {}
    for t in strava:
        by_date.setdefault(t["date"], []).append(t)
    files = sorted((folder / "workouts").glob("*.gpx"))
    workouts, no_route = {}, 0
    for path in files:
        w = read_workout(path)
        if not w:
            no_route += 1
        elif w["id"] not in workouts:  # "x.gpx" and "x.2.gpx" can be copies of one workout
            workouts[w["id"]] = w
        elif w["distance"] > workouts[w["id"]]["distance"]:
            workouts[w["id"]] = w
    # Workouts after the Strava export are left to the app's live Strava sync and Suunto sharing.
    newest = max(t["date"] for t in strava)
    later = [w for w in workouts.values() if w["date"] > newest]
    missing, near = [], []
    for w in workouts.values():
        if w["date"] > newest:
            continue
        if any(same_outing(w, t) for t in by_date.get(w["date"], [])):
            continue
        missing.append(w)
        # A Strava track on that day with another distance may be the same outing, trimmed or recorded differently.
        others = by_date.get(w["date"], [])
        if others:
            near.append((w, others))
    missing.sort(key=lambda w: w["source"])
    OUT.write_text(json.dumps({"tracks": [{k: v for k, v in w.items() if k != "source"} for w in missing]},
                              separators=(",", ":")))
    lines = [f"{w['date']}  {w['sportType']:<5} {w['distance'] / 1000:6.1f} km  {w['source']}"
             + "".join(f"   | Strava that day: {t['name']} {t['distance'] / 1000:.1f} km"
                       for t in by_date.get(w["date"], []))
             for w in missing]
    LIST.write_text("\n".join(lines) + "\n")
    years = {}
    for w in missing:
        years[w["date"][:4]] = years.get(w["date"][:4], 0) + 1
    print(f"{len(files)} GPX files, {no_route} without a GPS route over {MIN_M} m, {len(workouts)} workouts with routes")
    print(f"{len(later)} after {newest}, the newest Strava track, left out")
    print(f"{len(workouts) - len(later) - len(missing)} already among the {len(strava)} Strava tracks, {len(missing)} missing "
          f"({len(near)} of those share a day with a Strava track of another distance)")
    print("Missing by year: " + ", ".join(f"{y}: {n}" for y, n in sorted(years.items())))
    print(f"{OUT.stat().st_size // 1024} KB -> {OUT}\nList -> {LIST}")


if __name__ == "__main__":
    main()
