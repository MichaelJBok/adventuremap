"""Turn the early tracks (Google Fusion Tables and old KML) into a file of tracks for Adventure Map.

Usage:  python3 scripts/early_tracks_for_app.py [kept-early-tracks.json]
Reads private/early-tracks.json from import_tracks.py, or the "Download kept tracks" file from the review page, which
carries its removals and corrections. Writes private/early-app-tracks.json, loaded with "Import JSON or GPX" while signed in.
Left out: Strava activities (strava_tracks_for_app.py brings those in), fragments of a fuller track on the same day,
and drives and road trips, which aren't outings.
"""
import json
import re
import pathlib
import sys

from import_tracks import ROOT
from strava_tracks_for_app import encode

SOURCE = ROOT / "private" / "early-tracks.json"
OUT = ROOT / "private" / "early-app-tracks.json"
SPORTS = {"Run": "Run", "Ride": "Ride", "Hike": "Hike", "Walk": "Walk", "Boat": "Sail"}
BOAT = re.compile(r"boat|div|sail", re.I)
DRIVE_KM = 30             # My Tracks often marked short hikes as driving, so only longer "drives" are drives
ROAD_TRIP_KM = 100        # an untyped track this long is a road trip


STATS = re.compile(r"^(Name:|Total distance|Distance\b|Description\s*$|Description\s+Distance)", re.I)
LABEL = re.compile(r"^(ACTIVE LOG[\d ]*|Segment \d+|[\d/:. -]+(AM|PM)?|\d{1,2}-[A-Za-z]{3}-\d\d[\d ]*)$", re.I)


def clean_notes(t):
    """Old recorders filled the description with their own stats or file labels; only what was written is kept."""
    note = t.get("notes") or ""
    m = re.search(r"Description:\s*(.*?)\s*(?:Total distance|$)", note, re.S)
    if m:
        note = m[1]
    elif STATS.match(note):
        note = ""
    note = re.sub(r"^-\s*", "", note.strip()).strip()
    if note in ("", "-") or LABEL.match(note) or "(Part " in note or note.lower() in t["name"].lower():
        return ""
    return note


def is_drive(t):
    if BOAT.search(t["name"]):
        return False
    return (t["activity"] == "Drive" and t["km"] > DRIVE_KM) or (not t["activity"] and t["km"] > ROAD_TRIP_KM)


def sport(t):
    return "Sail" if BOAT.search(t["name"]) and t["activity"] in ("Drive", "Boat", "") else SPORTS.get(t["activity"], "Other")


def main():
    source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE
    found = json.loads(source.read_text())
    early = [t for t in found if not t["id"].startswith("strava-")]
    fragments = [t for t in early if t.get("partOf")]
    drives = [t for t in early if is_drive(t) and not t.get("partOf")]
    kept = [t for t in early if not t.get("partOf") and not is_drive(t)]
    tracks = [{"id": t["id"], "name": t["name"], "sportType": sport(t), "date": t["date"] or "",
               "distance": round(t["km"] * 1000), **({"notes": clean_notes(t)} if clean_notes(t) else {}),
               "polylines": [encode(s) for s in t["segments"] if len(s) > 1]}
              for t in kept]
    OUT.write_text(json.dumps({"tracks": tracks}, separators=(",", ":")))
    print(f"{len(early)} early tracks: {len(tracks)} kept ({sum(not t['date'] for t in tracks)} undated), "
          f"{len(fragments)} fragments and {len(drives)} drives or road trips left out")
    for t in fragments:
        print(f"  fragment: {t['name']} ({t['date']}, {t['km']} km), part of {t['partOf']}")
    for t in drives:
        print(f"  drive or road trip: {t['name']} ({t['date'] or 'no date'}, {t['km']} km)")
    print(f"{OUT.stat().st_size // 1024} KB -> {OUT}")


if __name__ == "__main__":
    main()
