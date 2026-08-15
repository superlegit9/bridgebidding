# Second Hand — bidding practice

A two-player bidding-practice app. One partner starts a session (names +
which set of hands to practice), the other joins with the name they were
given, and they bid a live auction together, hand by hand, with the
opposing hands and reference material hidden until the auction ends.

## What's in here

```
data/
  prepare_data.py     - re-run this if you edit bidding_practice.ods
  hands.json           - the cleaned, parsed dataset (76 hands, 3 sets)
  issues_report.md     - 9 rows excluded (bad card counts) + every
                          spot/honor-card displacement that was applied
public/
  index.html, style.css, app.js, auction.js, firebase-init.js
  -> the whole client app. Static files - host them anywhere.
scripts/
  seed.mjs, package.json - uploads hands.json into Firestore, once
firestore.rules          - Firestore security rules
```

## 1. Create a Firebase project

1. https://console.firebase.google.com -> Add project (free "Spark" plan
   is enough for two people bidding practice hands).
2. **Build -> Firestore Database -> Create database** (start in
   production mode - the rules file below handles access).
3. **Build -> Authentication -> Get started -> Sign-in method -> Anonymous
   -> Enable.** This is what lets the app tell the two partners' browsers
   apart without a full login system.
4. **Project settings (gear icon) -> General -> Your apps -> Web (</>)
   icon** -> register an app (no need for Firebase Hosting unless you
   want it) -> copy the `firebaseConfig` object shown.

## 2. Wire up the client

Open `public/firebase-init.js` and paste your `firebaseConfig` values in
place of the `YOUR_...` placeholders.

## 3. Deploy the security rules

Easiest via the Firebase console: **Firestore Database -> Rules** tab,
paste in the contents of `firestore.rules`, click **Publish**.

(Or with the CLI: `npm i -g firebase-tools`, `firebase login`,
`firebase init firestore` in this folder pointing at your project, then
`firebase deploy --only firestore:rules`.)

## 4. Seed the hand data

1. **Project settings -> Service accounts -> Generate new private key.**
   Save the downloaded file as `scripts/service-account.json` (this file
   is a secret - don't commit or share it).
2. `cd scripts && npm install && node seed.mjs`

This uploads the 3 sets (FFB, Takeout doubles, Constructive sequences —
76 hands total) into Firestore under `/sets`. Re-run it any time you edit
`bidding_practice.ods` and re-run `data/prepare_data.py`.

## 5. Run it

`public/` is a plain static site — no build step. Easiest options:

- Quick local test: `cd public && python3 -m http.server 8080`, open
  `http://localhost:8080`.
- Real hosting for you and your partner to use from anywhere: drop the
  `public/` folder's contents onto any static host (Firebase Hosting,
  Netlify, GitHub Pages, Vercel, etc.) — just make sure `firebase-init.js`
  has your real config first.

## How a session works

1. **Start a session**: enter your name, your partner's name, and pick a
   set. You get a 6-character code and land straight in hand 1 as South.
2. **Your partner joins**: they choose "Join a session," enter that code
   and *the exact name you typed for them*. That's the only credential —
   matching that name is what lets them in.
3. Seats **strictly alternate every hand** — whoever is South on hand 1
   is North on hand 2, South on hand 3, and so on.
4. Each of you only sees your own hand. The bidding box only lights up
   on your turn. Opponents (the `(bid)` notation in the source data) are
   assumed to always pass once your live bidding starts — you're only
   ever bidding against your partner's hand and the auction history.
5. The auction ends the moment one of you passes your partner's actual
   bid (or, if neither of you ever bids anything, once both have passed —
   a fully passed-out hand). At that instant both hands, the suggested
   sequence, and the notes unlock for both of you.
6. Either of you can hit **Next hand** to move on together.

## Data-cleaning notes (for your reference)

- **Sets** were detected from rows where column A holds text instead of
  a number (e.g. "Takeout doubles") — the very first set's name comes
  from the column header itself ("FFB").
- **Spot-card duplicates** (ranks 2–9) between a hand's S and N cards
  were fixed by editing the **N hand only**: search forward from the
  duplicated rank (wrapping 9→2) for the first rank not already used in
  either hand's copy of that suit.
- **Honor duplicates** (T/J/Q/K/A appearing in both S and N in the same
  suit) were shifted to `9` first, falling back to the same forward
  search if 9 was already taken.
- **9 rows had a hand with the wrong card count** (not 13) — these were
  left out of `hands.json` entirely rather than guessed at. See
  `issues_report.md` for the exact rows (by original spreadsheet row
  number) so you can fix them in `bidding_practice.ods` and re-run
  `prepare_data.py` if you want them included.
- The **"Suggested"** column is shown as plain reference text after the
  reveal (not turned into an interactive table) since a few rows contain
  alternate lines separated by "OR" or "/" that don't reduce to one
  sequence.

## Security note

Two-player hand secrecy is enforced by (a) the client simply not
rendering the other seat's hand until the auction ends, and (b) Firebase
Anonymous Auth giving each joining browser a stable identity used to
gate writes to session state. The hand data itself lives in `/sets`,
which is world-readable (needed so both clients can load hands without a
server). That's adequate for two trusted partners sharing a session code
— it is **not** hardened against a partner who deliberately reads the
raw Firestore data to peek. If that matters to you, the fix is to move
`sHand`/`nHand` into per-seat subdocuments gated by uid in the rules
(happy to build that out if you want it).
