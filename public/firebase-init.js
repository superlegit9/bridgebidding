// Fill this in with YOUR Firebase project's config (Project settings ->
// General -> Your apps -> SDK setup and configuration -> Config).
// This is safe to expose publicly - it is not a secret, it just tells the
// SDK which project to talk to. Access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyCem5EbVUeKJUihyEppP1iPEh6aYNNvKhc",
  authDomain: "coaching-u26.firebaseapp.com",
  projectId: "coaching-u26",
  storageBucket: "coaching-u26.firebasestorage.app",
  messagingSenderId: "928921692411",
  appId: "1:928921692411:web:b95f23533ee39461db685e",
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
