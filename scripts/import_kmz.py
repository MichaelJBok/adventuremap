"""Convert a Google My Maps KMZ export into an AdventureMap import file.

Usage:  python3 scripts/import_kmz.py [Adventure.kmz]
Writes private/adventure-places.json, which you load with "Import JSON" in the app.
The private/ folder is git-ignored so your places never reach a public repository.

Each map layer becomes a category, except that all "Geocaches (...)" layers become one Geocaches
category. Those layers overlap, so each GC code is kept once, preferring the newest layer.
"""
import datetime
import hashlib
import html
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"k": "http://www.opengis.net/kml/2.2"}
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "private" / "adventure-places.json"
MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()
# "Valkyrien's Spyd by MaMiFKa, Multi-cache (2/1)"
CACHE = re.compile(r"^(.*) by (.*), ([^,]+?) \(([\d.]+)/([\d.]+)\)\s*$", re.S)
CACHE_TYPES = {"Unknown Cache": "Unknown (Mystery) Cache"}


def full_year(yy):
    return 2000 + yy if yy <= datetime.date.today().year % 100 else 1900 + yy


def iso(year, month, day):
    try:
        return datetime.date(year, month, day).isoformat()
    except ValueError:
        return ""


def parse_date(text):
    """Best-effort ISO date. Ambiguous a/b/yy reads as US month/day, the map's usual style."""
    text = text.strip()
    if m := re.match(r"^(\d\d)(\d\d)(\d\d)(?:\s*-\s*\d{6})?$", text):  # 221018, or a 221018-221020 range
        return iso(full_year(int(m[1])), int(m[2]), int(m[3]))
    if m := re.match(r"^(\d{4})(\d\d)(\d\d)$", text):  # 20220710
        return iso(int(m[1]), int(m[2]), int(m[3]))
    if m := re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$", text):
        a, b, year = int(m[1]), int(m[2]), int(m[3])
        year = full_year(year) if year < 100 else year
        return iso(year, a, b) if a <= 12 else iso(year, b, a)
    if m := re.match(r"^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$", text):
        if m[2].lower() in MONTHS:
            return iso(int(m[3]), MONTHS.index(m[2].lower()) + 1, int(m[1]))
    return ""


def clean(text):
    text = re.sub(r"<br\s*/?>", "\n", text or "", flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def read_placemark(p):
    lon, lat, *_ = (p.findtext(".//k:coordinates", "", NS)).strip().split(",")
    data = {d.get("name"): d.findtext("k:value", "", NS) or "" for d in p.findall(".//k:Data", NS)}
    return {
        "name": clean(p.findtext("k:name", "", NS)) or "Unnamed",
        "lat": round(float(lat), 6), "lon": round(float(lon), 6),
        "description": p.findtext("k:description", "", NS) or "",
        "data": data,
    }


def to_cache(row, layer):
    place = {
        "id": "gc-" + row["name"].lower(),
        "lat": row["lat"], "lon": row["lon"],
        "name": row["name"], "category": "Geocaches",
        "date": "", "notes": "",
        "link": f"https://coord.info/{row['name']}",
        "source": layer,
    }
    if m := CACHE.match(clean(row["description"])):
        place["name"] = f"{m[1].strip()} ({row['name']})"
        place["cache"] = {"code": row["name"], "owner": m[2].strip(), "type": CACHE_TYPES.get(m[3], m[3]),
                          "difficulty": float(m[4]), "terrain": float(m[5])}
    return place


def to_place(row, layer):
    data = row["data"]
    date_text = data.get("Date", "").strip()
    links = (data.get("Album", "") + " " + data.get("gx_media_links", "")).split()
    place = {
        "id": "kml-" + hashlib.sha1(f"{layer}|{row['name']}|{row['lat']}|{row['lon']}".encode()).hexdigest()[:16],
        "lat": row["lat"], "lon": row["lon"],
        "name": row["name"], "category": layer,
        "date": parse_date(date_text),
        "notes": clean(data.get("description", row["description"])),
        "link": links[0] if links else "",
        "source": layer,
    }
    if date_text and not place["date"]:
        place["dateText"] = date_text
    return place


def main(path):
    with zipfile.ZipFile(path) as z:
        doc = ET.fromstring(z.read("doc.kml")).find("k:Document", NS)
    places, caches, moved, per_layer = [], {}, [], {}
    for folder in doc.findall("k:Folder", NS):
        layer = folder.findtext("k:name", "", NS).strip()
        rows = [read_placemark(p) for p in folder.findall("k:Placemark", NS)]
        per_layer[layer] = per_layer.get(layer, 0) + len(rows)
        if not layer.startswith("Geocaches"):
            places += [to_place(r, layer) for r in rows]
            continue
        for r in rows:
            c = to_cache(r, layer)
            old = caches.get(c["id"])
            if old and (old["lat"], old["lon"]) != (c["lat"], c["lon"]):
                moved.append(c["id"])
            if not old or c["source"] >= old["source"]:  # layer names end in yymmdd, so text order is date order
                caches[c["id"]] = c

    everything = places + list(caches.values())
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"places": everything}, ensure_ascii=False, separators=(",", ":")))

    for layer, n in per_layer.items():
        print(f"{layer}: {n} rows")
    print(f"Geocaches: {len(caches)} unique of {sum(n for k, n in per_layer.items() if k.startswith('Geocaches'))} rows,"
          f" {len(moved)} with differing coordinates between layers")
    undated = [p for p in places if p.get("dateText")]
    print(f"Dates parsed: {sum(1 for p in places if p['date'])}; kept as text only: {len(undated)}")
    print("  unparsed:", sorted({p["dateText"] for p in undated})[:25])
    print("  no cache details:", [c["id"] for c in caches.values() if "cache" not in c][:10])
    print(f"Wrote {len(everything)} places ({OUT.stat().st_size // 1024} KB) to {OUT}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / "Adventure.kmz")
