"""Turn a Strava account export into a file of tracks for Adventure Map.

Usage:  python3 scripts/strava_tracks_for_app.py "<Strava export.zip>"
Writes private/strava-tracks.json, which you load with "Import JSON or GPX" while signed in.
Each track keeps Strava's id, so importing a newer export, or a live sync, never adds it twice. Importing
again also fills in details that tracks already in the account lack, such as moving time.
"""
import json
import pathlib
import sys

from import_tracks import ROOT, read_strava, simplify

OUT = ROOT / "private" / "strava-tracks.json"
SPORTS = {"Run": "Run", "Ride": "Ride", "Hike": "Hike", "Walk": "Walk", "Boat": "Sail"}


def encode(points):
    """Google's encoded polyline format, the same one Strava uses for its route lines."""
    out, last = [], (0, 0)
    for lon, lat in points:
        here = (round(lat * 1e5), round(lon * 1e5))
        for value in (here[0] - last[0], here[1] - last[1]):
            value = ~(value << 1) if value < 0 else value << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        last = here
    return "".join(out)


def main():
    found, skipped = read_strava(pathlib.Path(sys.argv[1]))
    tracks = [{"id": t["id"], "name": t["name"], "sportType": SPORTS.get(t["activity"], "Other"), "date": t["date"],
               "distance": round(t["km"] * 1000), "movingTime": t["movingTime"],
               "polylines": [encode(simplify(s)) for s in t["segments"]]}
              for t in found]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"tracks": tracks}, separators=(",", ":")))
    print(f"{len(tracks)} tracks ({skipped} activities had no route), {OUT.stat().st_size // 1024} KB -> {OUT}")


if __name__ == "__main__":
    main()
