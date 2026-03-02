# Backstage — Project Brief for Claude Code

## What this is

Backstage is a shared cultural events diary for Nick (admin), Denise, and Ben. It tracks gigs, theatre, dance, exhibitions, comedy, and opera — both past events and upcoming plans. The goal is to build up profiles on artists and venues over time, with per-person ratings and shared visibility across the three users.

## Tech stack

- Vanilla HTML/CSS/JS (no framework)
- Firebase Realtime Database (backend)
- Hosted on Netlify
- Mobile-first design

## Firebase project

- Project: `backstage-c3575`
- Database URL: `https://backstage-c3575-default-rtdb.europe-west1.firebasedatabase.app`
- Region: Europe West

## File structure

```
backstage/
├── index.html          ← Main app
├── import.html         ← History import tool
├── css/
│   └── style.css       ← All styles
└── js/
    ├── firebase-config.js   ← Firebase initialisation
    └── app.js               ← All app logic
```

## Users

Three hardcoded users — no auth system, just a selection screen on load:
- **Nick** — admin (can delete events)
- **Denise**
- **Ben**

## Data model (Firebase Realtime Database)

### `/events/{id}`
```json
{
  "artist": "Kamasi Washington",
  "venue": "Barbican",
  "date": "2024-03-15",
  "type": "Gig",
  "status": "Past",
  "attendees": { "nick": true, "denise": true },
  "ratings": { "nick": 5, "denise": 4 },
  "notes": "Incredible set, stood ovation",
  "addedBy": "nick",
  "createdAt": 1710000000000
}
```

**status** values: `Past` | `Booked` | `Interested`

**type** values: `Gig` | `Theatre` | `Dance` | `Exhibition` | `Comedy` | `Opera`

### `/artists/{name}`
```json
{
  "name": "Kamasi Washington",
  "notes": "Free-form notes about this artist"
}
```

### `/venues/{name}`
```json
{
  "name": "Barbican",
  "notes": "Sit in the stalls, avoid the rear balcony"
}
```

## Key behaviours

- Artist and venue pages aggregate ratings across all past events
- Each person's rating is stored separately on an event (not averaged at write time)
- Autocomplete on artist/venue inputs pulls from existing event data
- Nick is the only user who can delete events
- Artist/venue keys in Firebase have special characters replaced with `_`

## Design system

- **Aesthetic**: Dark editorial — like a high-end listings magazine
- **Fonts**: Playfair Display (headings, italic), DM Sans (body)
- **Colours**:
  - Background: `#0e0e0e`
  - Surface: `#161616`, `#1f1f1f`
  - Border: `#2a2a2a`
  - Accent: `#e8a030` (amber)
  - Text: `#f0ece4` (primary), `#9a948a` (mid), `#5a5550` (dim)
  - Green: `#4a9460`, Blue: `#4a78c4`, Red: `#c94040`
- **Radius**: 12px cards, 8px inputs
- **Mobile-first**: designed for phone use primarily

## Current features (v1)

- Login screen with user selection
- Four tabs: Feed, Upcoming, Artists, Venues
- Feed: past events filtered by person and event type
- Upcoming: booked and interested events
- Artist profiles: aggregate rating, notes, event history
- Venue profiles: aggregate rating, venue-specific notes, event history
- Add event modal (bottom sheet): type, artist, venue, date, status, attendees, per-person ratings, notes
- Autocomplete for artist and venue fields
- Import tool (`import.html`): bulk paste parser + manual entry

## Planned features (v2)

- **Artist lookup**: when adding a new artist, pull bio/top tracks from Spotify or Last.fm API
- **Email scanning**: parse venue newsletters (Ronnie Scott's, Roundhouse, Jazz Cafe, V&A etc) to surface new listings automatically
- **Notifications/triggers**: prompt engagement when something relevant comes up
- **Friends network**: extend shared visibility beyond Nick/Denise/Ben to a wider circle
- **Suggest to others**: flag an upcoming event so friends can book too

## Venue memberships (context for v2 email feature)

Nick has memberships/subscriptions at:
- Ronnie Scott's
- Roundhouse
- Victoria & Albert Museum
- Jazz Cafe
- Various theatre groups

These send early-access and listing emails that are currently easy to miss.

## Deployment

- Netlify (drag-and-drop or CLI)
- No build step required — pure static files
- To redeploy: `netlify deploy --prod` from the project folder (if Netlify CLI installed)
