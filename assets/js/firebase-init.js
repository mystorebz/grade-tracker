import { initializeApp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getStorage }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

import { getAuth }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { initializeAppCheck, ReCaptchaV3Provider }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";

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

// ── App Check (reCAPTCHA v3) ──────────────────────────────────────────────────
// Replace YOUR_RECAPTCHA_V3_SITE_KEY with the key from Firebase Console
// Set self.FIREBASE_APPCHECK_DEBUG_TOKEN = true in browser console for local testing
initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('YOUR_RECAPTCHA_V3_SITE_KEY'),
    isTokenAutoRefreshEnabled: true
});

console.log("Firebase initialized with Auth, App Check, and offline caching.");
