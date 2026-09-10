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

const firebaseConfig = {
    apiKey:            "AIzaSyDTIREBdTGkVc1cWJRrG9q7YN_fv0XMr5w",
    authDomain:        "school-grade-tracker.firebaseapp.com",
    projectId:         "school-grade-tracker",
    storageBucket:     "school-grade-tracker.firebasestorage.app",
    messagingSenderId: "326406075140",
    appId:             "1:326406075140:web:cff69a1ea0c20a66b21651"
};

const app = initializeApp(firebaseConfig);

// Only true when the app is opened as http://localhost:xxxx or
// http://127.0.0.1:xxxx — i.e. served locally for manual testing against
// `firebase emulators:start`. connectusonline.org (and any other real host)
// never matches this, so production always takes the path below untouched.
const USE_EMULATORS = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

let db, auth, functions;

if (USE_EMULATORS) {
    // Deliberately NOT using persistentLocalCache here: IndexedDB-cached data
    // from a real production session (or a previous emulator run) can bleed
    // into what looks like a clean local test otherwise. Emulator data is
    // thrown away on every restart anyway, so there's nothing worth caching.
    db = initializeFirestore(app, {});
    connectFirestoreEmulator(db, '127.0.0.1', 8080);

    auth = getAuth(app);
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

    functions = getFunctions(app);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);

    console.log('%cFirebase running against LOCAL EMULATORS (firestore:8080, auth:9099, functions:5001).', 'color: orange; font-weight: bold;');
} else {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
        })
    });
    auth = getAuth(app);
    functions = getFunctions(app);
}

export { db, auth, functions };
export const storage = getStorage(app);

// App Check disabled during local development.
// Re-enable on production by uncommenting below.
//
// import { initializeAppCheck, ReCaptchaV3Provider }
//     from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
// initializeAppCheck(app, {
//     provider: new ReCaptchaV3Provider('6LfJsMosAAAAALY9ywfvWy_PxU1Z42DT0C62IIH0'),
//     isTokenAutoRefreshEnabled: true
// });

if (!USE_EMULATORS) {
    console.log("Firebase initialized with Auth and offline caching.");
}
