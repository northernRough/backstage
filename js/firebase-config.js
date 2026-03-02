// =============================================
// FIREBASE CONFIGURATION
// Replace with your own Firebase project config
// =============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBCvrtbO1Fuvig0lhCm0_92GpoEi4xyhl0",
  authDomain: "backstage-c3575.firebaseapp.com",
  databaseURL: "https://backstage-c3575-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "backstage-c3575",
  storageBucket: "backstage-c3575.firebasestorage.app",
  messagingSenderId: "569056670551",
  appId: "1:569056670551:web:e3aab716dc01b9ed410412"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
