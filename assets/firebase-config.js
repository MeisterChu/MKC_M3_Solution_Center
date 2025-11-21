// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAq6JLKJRa0kbaSRBclsM31QX3BHAuVtdU",
  authDomain: "m3-equipment-manager.firebaseapp.com",
  databaseURL: "https://m3-equipment-manager-default-rtdb.firebaseio.com",
  projectId: "m3-equipment-manager",
  storageBucket: "m3-equipment-manager.firebasestorage.app",
  messagingSenderId: "57982817073",
  appId: "1:57982817073:web:d7477047779d89427cd610"
};

// Initialize Firebase
let app = null;

// Export function to get or initialize Firebase app
export function getFirebaseApp() {
  if (!app) {
    app = initializeApp(firebaseConfig);
  }
  return app;
}