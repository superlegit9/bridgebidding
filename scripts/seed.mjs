// One-time (or re-run-on-change) script to upload data/hands.json into
// Firestore under /sets/{setId}/hands/{index}.
//
// Usage:
//   1. In the Firebase console, generate a service account key:
//      Project settings -> Service accounts -> Generate new private key.
//      Save it as scripts/service-account.json (gitignored - do not commit).
//   2. npm install firebase-admin  (from the scripts/ folder, or project root)
//   3. node scripts/seed.mjs

import { readFileSync } from 'fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, 'service-account.json'), 'utf8')
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const data = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'hands.json'), 'utf8')
);

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  let setOrder = 0;
  for (const set of data.sets) {
    const setId = slug(set.name);
    console.log(`Seeding set "${set.name}" (${setId}) - ${set.hands.length} hands`);
    await db.collection('sets').doc(setId).set({
      name: set.name,
      order: setOrder++,
      handCount: set.hands.length,
      handNums: set.hands.map((h) => h.num), // original numbering has gaps (bad rows excluded)
    });
    const batchSize = 400;
    for (let i = 0; i < set.hands.length; i += batchSize) {
      const batch = db.batch();
      const chunk = set.hands.slice(i, i + batchSize);
      for (const hand of chunk) {
        const ref = db.collection('sets').doc(setId).collection('hands').doc(String(hand.num));
        batch.set(ref, hand);
      }
      await batch.commit();
      console.log(`  wrote ${Math.min(i + batchSize, set.hands.length)}/${set.hands.length}`);
    }
  }
  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
