import { initializeApp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { getAuth, connectAuthEmulator }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, connectFunctionsEmulator }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { getDatabase, connectDatabaseEmulator }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey:            "AIzaSyDTIREBdTGkVc1cWJRrG9q7YN_fv0XMr5w",
    authDomain:        "school-grade-tracker.firebaseapp.com",
    projectId:         "school-grade-tracker",
    storageBucket:     "school-grade-tracker.firebasestorage.app",
    messagingSenderId: "326406075140",
    appId:             "1:326406075140:web:cff69a1ea0c20a66b21651"
};

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

export const storage   = getStorage(app);
export const auth      = getAuth(app);
export const functions = getFunctions(app);

// Realtime Database — added for Phase 2 Exams (examPresence live proctoring
// node). Firestore has no server-side disconnect detection; RTDB's
// onDisconnect() is the only piece of this stack that can distinguish "the
// student's socket actually died" from "nothing has written anything
// recently," which is why this exists alongside Firestore rather than
// folding presence into a Firestore heartbeat doc (see
// docs/phase2-exams-architecture.md, section 5, item 4).
export const rtdb = getDatabase(app);

// ── LOCAL EMULATOR SWITCH ────────────────────────────────────────
// Only takes effect when this page is actually being viewed from
// localhost/127.0.0.1 (e.g. running `npx serve` in this folder).
// connectusonline.org, and every other real host, is never
// "localhost" — so this block is 100% inert in production and
// cannot affect real users or real data.
if (typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    connectDatabaseEmulator(rtdb, '127.0.0.1', 9000);
    console.log('[firebase-init] Localhost detected — using local emulators (Firestore 8080, Auth 9099, Functions 5001, Database 9000), not production.');
}

// App Check disabled during local development.
// Re-enable on production by uncommenting below.
//
// import { initializeAppCheck, ReCaptchaV3Provider }
//     from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
// initializeAppCheck(app, {
//     provider: new ReCaptchaV3Provider('6LfJsMosAAAAALY9ywfvWy_PxU1Z42DT0C62IIH0'),
//     isTokenAutoRefreshEnabled: true
// });

console.log("Firebase initialized with Auth and offline caching.");
