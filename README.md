# Adventure Map

A personal map of places visited, geocache finds and dive sites. Click anything named on the map to
add it to your places, or drop a pin for spots the map doesn't name.

Your places are stored in your browser's local storage, and in a private Firestore collection once you
sign in. They are never included in this repository. Use **Export JSON** for a backup.

- `index.html`, `app.js`: the app (MapLibre, OpenFreeMap vector tiles, OpenStreetMap data)
- `sync.js`: Google sign-in and Firestore sync, sharing Svampkartan's Firebase project
- Mushroom finds are a read-only layer, read from Svampkartan's `users/{uid}/spots` while signed in
- `strava.js`: fetches new activities from Strava into `users/{uid}/tracks`; the Strava app's secret and tokens are kept in the private `users/{uid}/settings/strava` document
- `scripts/import_kmz.py`: converts a Google My Maps KMZ export to `private/adventure-places.json`, loaded with **Import JSON**

To run it locally, serve this folder over HTTP, for example `python3 -m http.server`.

Map data: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [OpenFreeMap](https://openfreemap.org/).
