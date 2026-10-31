// Private sync of my places across devices: Google sign-in + Firestore.
// Shares Svampkartan's Firebase project. Places live in users/{uid}/places, which only that signed-in
// person can read or write (the project's rules cover everything under users/{uid}).
// This config identifies the project; it is not a secret.
const firebaseConfig = {
  apiKey: "AIzaSyD4RrmR7AgmICbQ9lvTIGM8-ErGRFIIILk",
  authDomain: "svampkarta-37df1.firebaseapp.com",
  projectId: "svampkarta-37df1",
  storageBucket: "svampkarta-37df1.firebasestorage.app",
  messagingSenderId: "296371444791",
  appId: "1:296371444791:web:2fe95f3e05bb66c7a7f3b2",
};
const UPLOADED_KEY = "adventuremap.uploadedTo"; // accounts this device has already sent its local places to

(function () {
  const setStatus = (text) => { $("syncStatus").textContent = text; };
  if (!window.firebase) {
    setStatus("Sync is unavailable right now. Your places are still saved on this device.");
    return;
  }
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  // Keeps a copy on the device so the app works without signal; writes sync when back online.
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  const clean = (s) => JSON.parse(JSON.stringify(s)); // Firestore rejects undefined values
  const showError = (e) => setStatus(e.code === "permission-denied"
    ? "The database refused access. Check that the Firestore rules are published."
    : `Sync problem: ${e.message}`);

  function writeAll(col, list) {
    const commits = [];
    for (let i = 0; i < list.length; i += 400) {
      const batch = db.batch();
      list.slice(i, i + 400).forEach((p) => batch.set(col.doc(p.id), clean(p)));
      commits.push(batch.commit());
    }
    return Promise.all(commits);
  }

  function renderAccount(user) {
    $("signInBtn").hidden = !!user;
    $("signOutBtn").hidden = !user;
    $("accountText").textContent = user
      ? `Signed in as ${user.email}. Your places are private and synced.`
      : "Sign in to keep your places private and synced across your devices.";
  }

  $("signInBtn").onclick = async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await auth.signInWithRedirect(provider);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        setStatus(`Sign-in failed: ${e.message}`);
      }
    }
  };
  $("signOutBtn").onclick = () => auth.signOut();

  let unsubscribe = null;
  auth.onAuthStateChanged((user) => {
    unsubscribe?.();
    unsubscribe = null;
    renderAccount(user);
    if (!user) {
      if (cloud) {
        // Just signed out: don't leave this account's places behind on the device.
        cloud = null;
        places = [];
        saveLocal(); renderAll();
      }
      setStatus("");
      return;
    }

    const col = db.collection("users").doc(user.uid).collection("places");
    cloud = {
      save: (list) => { writeAll(col, list).catch(showError); },
      remove: (id) => { col.doc(id).delete().catch(showError); },
    };

    // First sign-in on this device: send up the places saved here before sync.
    const uploaded = new Set(readJson(UPLOADED_KEY, []));
    let uploading = false;
    if (!uploaded.has(user.uid)) {
      const local = [...places];
      const markDone = () => { uploading = false; uploaded.add(user.uid); writeJson(UPLOADED_KEY, [...uploaded]); };
      if (local.length) {
        uploading = true;
        setStatus(`Uploading ${local.length} places from this device…`);
        writeAll(col, local).then(markDone).catch(showError);
      } else {
        markDone();
      }
    }

    setStatus("Loading your places…");
    unsubscribe = col.onSnapshot({ includeMetadataChanges: true }, (snap) => {
      if (uploading && snap.empty) return; // nothing up there yet: keep the local copy until the upload lands
      places = snap.docs.map((d) => d.data());
      saveLocal(); renderAll();
      setStatus(snap.metadata.hasPendingWrites
        ? "Saved on this device. Will sync when you're online."
        : snap.metadata.fromCache ? `Offline · ${places.length} places on this device` : `Synced · ${places.length} places`);
    }, showError);
  });
})();
