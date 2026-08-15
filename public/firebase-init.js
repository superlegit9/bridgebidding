// Fill this in with YOUR Firebase project's config (Project settings ->
// General -> Your apps -> SDK setup and configuration -> Config).
// This is safe to expose publicly - it is not a secret, it just tells the
// SDK which project to talk to. Access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Resolve once we have a stable anonymous uid (persists across reloads in
// the same browser via IndexedDB, so a player doesn't lose their seat by
// refreshing the page).
export const ready = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      resolve(user.uid);
    } else {
      signInAnonymously(auth).catch((e) => {
        console.error("Anonymous sign-in failed:", e);
        alert("Could not connect (sign-in failed). Check your Firebase config in firebase-init.js and that Anonymous auth is enabled in the Firebase console.");
      });
    }
  });
});
