"""Turn GPX files of trails into a route set for Adventure Map, for planning rather than tracks I've done.

Usage:  python3 scripts/route_set_for_app.py "<set name>" <file.gpx> [...]
Writes private/<set name>-routes.json, which you load with "Import JSON or GPX" while signed in. The set
shows as its own dashed layer under Tracks, unticked at first, and stays out of the heatmap.
Each named track in the files (usually a stage) becomes one route, so re-importing replaces rather than repeats.
"""
import json
import pathlib
import re
import sys

from import_tracks import ROOT, metres, simplify
from strava_tracks_for_app import encode

TRK = re.compile(r"<trk>(.*?)</trk>", re.S)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("å", "a").replace("ä", "a").replace("ö", "o")).strip("-")


def main():
    plan, files = sys.argv[1], sys.argv[2:]
    routes = {}
    for path in files:
        for trk in TRK.findall(pathlib.Path(path).read_text(encoding="utf-8", errors="replace")):
            name = re.search(r"<name>(.*?)</name>", trk)
            name = name[1].strip() if name else pathlib.Path(path).stem
            for seg in re.findall(r"<trkseg>(.*?)</trkseg>", trk, re.S):
                points = [(float(m[1] or m[4]), float(m[2] or m[3])) for m in re.finditer(
                    r'<trkpt\s+(?:lon="([^"]+)"\s+lat="([^"]+)"|lat="([^"]+)"\s+lon="([^"]+)")', seg)]
                if len(points) >= 2:
                    routes.setdefault(name, []).append(points)
    out = []
    for name, segs in sorted(routes.items(), key=lambda r: [int(n) if n.isdigit() else n for n in re.split(r"(\d+)", r[0])]):
        length = sum(metres(a, b) for s in segs for a, b in zip(s, s[1:]))
        out.append({"id": f"plan-{slug(plan)}-{slug(name)}", "name": name, "plan": plan, "sportType": "Hike",
                    "distance": round(length), "polylines": [encode(simplify(s)) for s in segs]})
    path = ROOT / "private" / f"{slug(plan)}-routes.json"
    path.write_text(json.dumps({"tracks": out}, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(out)} routes, {sum(r['distance'] for r in out) // 1000} km, {path.stat().st_size // 1024} KB -> {path}")


if __name__ == "__main__":
    main()
