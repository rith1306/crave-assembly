# Crave Assembly

## Project Overview

A food-ordering web app for a sample restaurant. Customers browse the menu, add items to a cart, sign in with Google, place an order and track its status live. An admin manages the menu, orders and home page content. Payments are simulated.

Built for college project brief **P05**.

**Live site:** https://crave-assembly.web.app/

## Technology Stack

- HTML, CSS, vanilla JavaScript (ES modules, no framework or build step)
- Firebase Authentication (Google sign-in)
- Cloud Firestore (database)
- Firebase Hosting, deployed automatically from GitHub

## Prerequisites

- **To use the live site:** a web browser and a Google account
- **To set up your own copy:** a Firebase project (free Spark plan) and VS Code with the Live Server extension

## Run Instructions (live site)

1. Open https://crave-assembly.web.app/
2. **Customer:** browse the menu, add items to the cart, click checkout and sign in with any Google account to place an order. The order status updates live.
3. **Admin:** sign in with the admin account given in the submission document. An **Admin** link appears in the navbar and opens the dashboard (orders, order archive, menu, home page).

## Setup Instructions (your own copy)

1. **Firebase:** create a project, enable **Google** sign-in under Authentication, and create a **Firestore** database.
2. **Config:** register a web app in Firebase, then create `firebase-config.js` next to `app.js`:
   ```js
   export const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
3. **Rules:** in Firestore → Rules, publish:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       function isAdmin() {
         return request.auth != null
           && exists(/databases/$(database)/documents/admins/$(request.auth.token.email.lower()));
       }
       match /admins/{email} {
         allow get: if request.auth != null && request.auth.token.email.lower() == email;
         allow list, write: if false;
       }
       match /menu/{id} { allow read: if true; allow write: if isAdmin(); }
       match /settings/{id} { allow read: if true; allow write: if isAdmin(); }
       match /orders/{id} {
         allow create: if request.auth != null
           && request.resource.data.userId == request.auth.uid
           && request.resource.data.status == 'placed';
         allow read: if request.auth != null
           && (resource.data.userId == request.auth.uid || isAdmin());
         allow update: if isAdmin();
         allow delete: if false;
       }
     }
   }
   ```
4. **First admin:** in Firestore, create a collection `admins` with a document whose ID is the admin's Gmail in lowercase and a field `role` = `admin`.
5. **Run locally:** open the folder in VS Code, right-click `index.html` → **Open with Live Server**, and visit **http://localhost:5500** (use `localhost`, not `127.0.0.1`).
6. **Deploy (optional):** install the Firebase CLI (`npm install -g firebase-tools`), run `firebase login` and `firebase init hosting` (public directory `.`), then `firebase deploy --only hosting`. Add your `.web.app` domain under Authentication → Settings → Authorized domains.
