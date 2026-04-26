import { initializeApp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { getAuth }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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

export const storage = getStorage(app);
export const auth    = getAuth(app);

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
