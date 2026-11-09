"""Make a review page for an import file of tracks, to keep, remove, rename, date and classify each one.

Usage:  python3 scripts/review_app_tracks.py private/loose-app-tracks.json [private/loose-missing.txt]
Writes private/<name>-review.html next to the file (template: scripts/app_track_review.html); serve private/ over HTTP
and open it. Choices are kept in the browser. "Download kept tracks for import" saves kept-<name>.json, which loads
with "Import JSON or GPX" while signed in. The optional list, as the *_for_app.py scripts write it, adds each track's
source file to its details.
"""
import json
import pathlib
import re
import sys

from import_tracks import ROOT
from mytracks_for_app import decode

FILE_NOTE = re.compile(r"\(([^()]+)\)\s*$")


def main():
    source = pathlib.Path(sys.argv[1])
    name = source.name.removesuffix(".json").removesuffix("-app-tracks").removesuffix("-tracks")
    tracks = json.loads(source.read_text())["tracks"]
    files = []
    if len(sys.argv) > 2:
        files = [m[1] if (m := FILE_NOTE.search(line)) else None for line in pathlib.Path(sys.argv[2]).read_text().splitlines()]
    for i, t in enumerate(tracks):
        t["segments"] = [[[round(x, 5), round(y, 5)] for x, y in decode(p)] for p in t["polylines"]]
        t["km"] = round(t["distance"] / 1000, 1)
        if i < len(files) and files[i]:
            t["file"] = files[i]
    page = (ROOT / "scripts" / "app_track_review.html").read_text()
    page = (page.replace("/*TITLE*/", f"Review {name} tracks").replace("/*KEY*/", name)
            .replace("/*OUT*/", f"kept-{name}.json")
            .replace("/*TRACKS*/", json.dumps(tracks, separators=(",", ":")).replace("</", "<\\/")))
    out = source.with_name(f"{name}-review.html")
    out.write_text(page)
    print(f"{len(tracks)} tracks -> {out}")


if __name__ == "__main__":
    main()
