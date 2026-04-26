import { initializeApp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { getAuth }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ── Firebase config ───────────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey:            "AIzaSyDTIREbDTGkVc1cWJRrG9q7YN_fv0XMr5w",
    authDomain:        "school-grade-tracker.firebaseapp.com",
    projectId:         "school-grade-tracker",
    storageBucket:     "school-grade-tracker.firebasestorage.app",
    messagingSenderId: "326406075140",
    appId:             "1:326406075140:web:cff69a1ea0c20a66b21651"
};

// ── Initialize app ────────────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);

// ── Firestore with offline caching ────────────────────────────────────────────
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

// ── Storage ───────────────────────────────────────────────────────────────────
export const storage = getStorage(app);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const auth = getAuth(app);

// ── App Check ────────────────────────────────────────────────────────────────
// DISABLED during local development — re-enable on production.
// To re-enable:
//   1. Uncomment the two imports at the top
//   2. Uncomment the initializeAppCheck block below
//   3. Remove the debug script tag from all login HTML files
//
// import { initializeAppCheck, ReCaptchaV3Provider }
//     from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
//
// initializeAppCheck(app, {
//     provider: new ReCaptchaV3Provider('6LfJsMosAAAAALY9ywfvWy_PxU1Z42DT0C62IIH0'),
//     isTokenAutoRefreshEnabled: true
// });

console.log("Firebase initialized with Auth and offline caching.");
