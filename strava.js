// Live import of new tracks from Strava (Suunto -> Strava -> here). There is no server: Strava allows these
// requests straight from the browser, and the app's secret and tokens live only in the private
// users/{uid}/settings/strava document, so any signed-in device can sync without connecting again.
const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_STATE_KEY = "adventuremap.stravaState";
const STRAVA_PAGE_SIZE = 100;
const BACKFILL_DAYS = 30;   // how far back the first sync reaches
const OVERLAP_DAYS = 7;     // a watch can sync late, so each sync looks this far behind the last one
const RESYNC_AFTER = 5 * 60; // seconds; opening the app again sooner than this doesn't sync
const DAY = 24 * 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const stravaRedirectUri = () => location.origin + location.pathname;
let goToStrava = (url) => location.assign(url);

// Strava sends the visitor back here with ?code=…; take it out of the address bar straight away.
const stravaReturn = (() => {
  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  if (!state) return null;
  history.replaceState(null, "", stravaRedirectUri());
  let expected = null;
  try { expected = sessionStorage.getItem(STRAVA_STATE_KEY); sessionStorage.removeItem(STRAVA_STATE_KEY); } catch {}
  return { code: state === expected ? params.get("code") : null, denied: params.has("error") };
})();

function setStravaStatus(text) { $("stravaStatus").textContent = text; }

function renderStrava(account, signedIn) {
  const connected = !!account?.refreshToken;
  $("stravaSetup").hidden = !signedIn || connected;
  $("stravaActions").hidden = !connected;
  if (!signedIn) setStravaStatus("Sign in to connect Strava.");
  if (account?.clientId && !$("sClientId").value) $("sClientId").value = account.clientId;
}

async function stravaToken(params) {
  const res = await fetch(STRAVA_TOKEN_URL, { method: "POST", body: new URLSearchParams(params) });
  if (!res.ok) throw new Error(`Strava refused the sign-in (${res.status}). Disconnect and connect again.`);
  const t = await res.json();
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_at };
}

async function fetchActivities(token, after) {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${STRAVA_API}/athlete/activities?after=${after}&per_page=${STRAVA_PAGE_SIZE}&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) throw new Error("Strava's request limit was reached. Try again in 15 minutes.");
    if (!res.ok) throw new Error(`Strava sync failed (${res.status}).`);
    const list = await res.json();
    all.push(...list);
    if (list.length < STRAVA_PAGE_SIZE) return all;
  }
}

// Indoor activities have no route, so they have no line to draw.
const toTrack = (a) => ({ id: `strava-${a.id}`, name: a.name, sportType: a.sport_type || a.type,
  date: a.start_date, distance: a.distance, polyline: a.map.summary_polyline });

function startStrava(db, userDoc) {
  const settings = userDoc.collection("settings").doc("strava");
  const tracksCol = userDoc.collection("tracks");
  let account = null;
  let syncing = false;
  let started = false;

  async function accessToken() {
    if (account.expiresAt > nowSeconds() + 60) return account.accessToken;
    const fresh = await stravaToken({ client_id: account.clientId, client_secret: account.clientSecret,
      grant_type: "refresh_token", refresh_token: account.refreshToken });
    await settings.set(fresh, { merge: true });
    account = { ...account, ...fresh };
    return fresh.accessToken;
  }

  async function sync() {
    if (syncing || !account?.refreshToken) return;
    syncing = true;
    setStravaStatus("Syncing with Strava…");
    try {
      const startedAt = nowSeconds();
      const activities = await fetchActivities(await accessToken(), account.syncedUntil - OVERLAP_DAYS * DAY);
      const rows = activities.filter((a) => a.map?.summary_polyline).map(toTrack);
      for (let i = 0; i < rows.length; i += 400) {
        const batch = db.batch();
        rows.slice(i, i + 400).forEach((t) => batch.set(tracksCol.doc(t.id), t));
        await batch.commit();
      }
      await settings.set({ syncedUntil: startedAt, lastSyncAt: startedAt }, { merge: true });
      setStravaStatus(`Synced just now · ${rows.length} recent ${rows.length === 1 ? "track" : "tracks"} checked`);
    } catch (e) {
      setStravaStatus(e.message);
    } finally {
      syncing = false;
    }
  }

  function syncIfStale() {
    if (account?.refreshToken && nowSeconds() - (account.lastSyncAt ?? 0) > RESYNC_AFTER) sync();
  }

  async function finishConnecting(code) {
    setStravaStatus("Connecting to Strava…");
    try {
      const tokens = await stravaToken({ client_id: account.clientId, client_secret: account.clientSecret,
        code, grant_type: "authorization_code" });
      account = { ...account, ...tokens, syncedUntil: nowSeconds() - (BACKFILL_DAYS - OVERLAP_DAYS) * DAY };
      await settings.set(account, { merge: true });
      renderStrava(account, true);
      await sync();
    } catch (e) {
      setStravaStatus(e.message);
    }
  }

  $("stravaSetup").onsubmit = async (e) => {
    e.preventDefault();
    const state = crypto.randomUUID();
    try { sessionStorage.setItem(STRAVA_STATE_KEY, state); } catch {}
    const clientId = $("sClientId").value.trim();
    const clientSecret = $("sClientSecret").value.trim();
    await settings.set({ clientId, clientSecret }, { merge: true });
    $("sClientSecret").value = "";
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: stravaRedirectUri(), response_type: "code",
      approval_prompt: "auto", scope: "read,activity:read_all", state });
    goToStrava(`https://www.strava.com/oauth/authorize?${query}`);
  };
  $("stravaSync").onclick = sync;
  $("stravaDisconnect").onclick = async () => {
    await settings.delete();
    $("sClientId").value = "";
    setStravaStatus("Disconnected. Tracks already here are kept.");
  };

  const onVisible = () => { if (document.visibilityState === "visible") syncIfStale(); };
  document.addEventListener("visibilitychange", onVisible);

  const stopSettings = settings.onSnapshot((doc) => {
    account = doc.data() ?? null;
    renderStrava(account, true);
    if (started) return;
    started = true;
    if (stravaReturn?.code && account?.clientSecret) finishConnecting(stravaReturn.code);
    else if (stravaReturn) setStravaStatus(stravaReturn.denied ? "Strava access was not approved." : "That Strava sign-in didn't match. Try connecting again.");
    else syncIfStale();
  }, (e) => setStravaStatus(`Sync problem: ${e.message}`));
  const stopTracks = tracksCol.onSnapshot((snap) => setTracks(snap.docs.map((d) => d.data())),
    (e) => setStravaStatus(`Sync problem: ${e.message}`));

  return () => { stopSettings(); stopTracks(); document.removeEventListener("visibilitychange", onVisible); };
}
