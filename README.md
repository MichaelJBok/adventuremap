# Adventure Map

A personal map of places visited, geocache finds and dive sites. Click anything named on the map to
add it to your places, or drop a pin for spots the map doesn't name.

Your places are stored in your browser's local storage, and in a private Firestore collection once you
sign in. They are never included in this repository. Use **Export JSON** for a backup: one file with your places, tracks (route sets included), deleted tracks and display settings, which **Import file** restores.

- `index.html`, `app.js`: the app (MapLibre, OpenFreeMap vector tiles, OpenStreetMap data)
- `sync.js`: Google sign-in and Firestore sync, sharing Svampkartan's Firebase project
- Mushroom finds are a read-only layer, read from Svampkartan's `users/{uid}/spots` while signed in
- Mushroom mode (the mushroom button) shows Svampkartan full screen inside this app, so one installed app does both
- `strava.js`: fetches new activities from Strava into `users/{uid}/tracks`; the Strava app's secret and tokens are kept in the private `users/{uid}/settings/strava` document
- `scripts/import_kmz.py`: converts a Google My Maps KMZ export to `private/adventure-places.json`, loaded with **Import JSON**
- `scripts/import_tracks.py`: collects tracks from a Google Fusion Tables Takeout and a Strava export into `private/`, with `private/track-review.html` for reviewing them on a map (template: `scripts/track_review.html`)
- `scripts/early_tracks_for_app.py`: turns `private/early-tracks.json` (or the review page's kept tracks) into `private/early-app-tracks.json` for import, leaving out Strava copies, fragments and drives
- `scripts/mytracks_for_app.py`: reads Google My Tracks KML/KMZ files (its Drive folder) and writes the recordings not already among the early or Strava tracks to `private/mytracks-app-tracks.json`, with a list in `private/mytracks-missing.txt`
- `scripts/fit_tracks_for_app.py`: reads a Google Takeout of Fit and writes the workouts started in the Fit app (and My Tracks recordings after its Drive folder) that aren't among the other tracks to `private/fit-app-tracks.json`, with a list in `private/fit-missing.txt`; Fit's own walk and ride detection is left out unless `--auto KM` is given
- `scripts/strava_tracks_for_app.py`: turns a Strava account export into `private/strava-tracks.json`; import it while signed in to save the tracks to `users/{uid}/tracks`. Tracks show as lines or as a heatmap
- `scripts/suunto_tracks_for_app.py`: reads a Suunto data export (Account settings → Export data) and writes the workouts missing from `private/strava-tracks.json` to `private/suunto-tracks.json`, with a list in `private/suunto-missing.txt`; import it the same way
- `scripts/route_set_for_app.py`: turns trail GPX files (for example Skåneleden's) into a planning route set in `private/`; it shows as a dashed layer, unticked at first and left out of the heatmap
- **Import file** also reads a Geocaching "My Finds" GPX file, adding only new finds
- `trackfiles.js`, `sw.js`: workout files (FIT or GPX) exported from a watch app can be imported, dropped on the map, or shared to the installed app on Android, which the service worker receives

To run it locally, serve this folder over HTTP, for example `python3 -m http.server`.

Map data: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [OpenFreeMap](https://openfreemap.org/).
