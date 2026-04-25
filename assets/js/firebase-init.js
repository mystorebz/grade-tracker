// Import the functions you need from the Firebase SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js"; // <-- NEW

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDTIREbDTGkVc1cWJRrG9q7YN_fv0XMr5w",
  authDomain: "school-grade-tracker.firebaseapp.com",
  projectId: "school-grade-tracker",
  storageBucket: "school-grade-tracker.firebasestorage.app",
  messagingSenderId: "326406075140",
  appId: "1:326406075140:web:cff69a1ea0c20a66b21651"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore WITH offline caching enabled
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Initialize Storage and export it
export const storage = getStorage(app); // <-- NEW

console.log("Firebase initialized successfully with offline caching and storage!");
