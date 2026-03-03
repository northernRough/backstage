# backstage — Setup Guide

## What this is

A shared cultural events diary. Log gigs, theatre, dance, exhibitions, comedy, and opera. Track what you've seen, what you've booked, and what you're interested in. Build up profiles on artists and venues over time.

---

## Step 1: Create Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → name it `backstage`
3. Disable Google Analytics (not needed) → Create project

### Enable Realtime Database
1. In left sidebar → **Build** → **Realtime Database**
2. Click **Create database**
3. Choose **Europe West** (closest to you in London)
4. Start in **test mode** (you'll lock it down later)

### Get your config
1. Click the gear icon → **Project settings**
2. Scroll to **Your apps** → click `</>` (web)
3. Register app with nickname `backstage`
4. Copy the `firebaseConfig` object

---

## Step 2: Add your config

Open `js/firebase-config.js` and replace the placeholder values with your actual config:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "backstage-xxxxx.firebaseapp.com",
  databaseURL: "https://backstage-xxxxx-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "backstage-xxxxx",
  storageBucket: "backstage-xxxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456..."
};
```

---

## Step 3: Deploy to Netlify

1. Go to [netlify.com](https://netlify.com) → Log in
2. Drag the entire `backstage` folder onto the deploy area
3. Netlify gives you a URL like `https://amazing-name-123.netlify.app`
4. Share that URL with your group

To update the app later: just drag the folder again, or connect to a GitHub repo for automatic deploys.

---

## Step 4: Import your history

1. Visit `your-netlify-url/import.html`
2. Either:
   - **Paste** your Notes content and let the parser extract events
   - **Add manually** one at a time with full control
3. The parser expects lines like: `Artist — Venue — Date — Rating`

---

## Database rules (optional, for later)

Once you're happy, lock down the database so only your app can read/write. In Firebase Console → Realtime Database → Rules:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

For now, test mode (open read/write) is fine for a private family app.

---

## File structure

```
backstage/
├── index.html          ← Main app
├── import.html         ← History import tool
├── css/
│   └── style.css
└── js/
    ├── firebase-config.js   ← ⚠️ Put your config here
    └── app.js
```

---

## What's in v1

- ✅ Three users (one admin, two standard)
- ✅ Log events: Artist + Venue + Date + Type + Who attended + Per-person ratings + Notes
- ✅ Status: Past / Booked / Interested
- ✅ Feed view: all past events, filterable by person and type
- ✅ Upcoming view: booked and interested events
- ✅ Artist profiles: aggregate ratings, notes, full history
- ✅ Venue profiles: aggregate ratings, venue notes (e.g. "sit in the balcony"), history
- ✅ Autocomplete for artist/venue names
- ✅ Admin-only delete
- ✅ Import tool for existing Notes history

## What's next (v2 ideas)

- Artist lookup: pull top tracks from Spotify/Last.fm when adding a new artist
- Email scanning: parse venue newsletters to surface new listings
- Friends network: extend to your wider circle
- Push notifications: remind when a booked event is coming up
