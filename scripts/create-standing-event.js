// ─── Create a STANDING event: one permanent event that serves many dated sessions ──
//
// The server also does this on every boot for env STANDING_EVENTS (default
// PRASADAM) — see src/migrations/standingEvents.js. This script is for manual
// runs (another code, a dry run). Idempotent: creates only what is missing —
// the event, its "Prasadam Coupon Counter" and the PR pass type.
//
// Usage:
//   node scripts/create-standing-event.js --code PRASADAM --name "Weekend Prasadam" [--admin you@example.com] [--dry-run]

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const { ensureStandingEvent } = require("../src/migrations/standingEvents");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
};
const DRY_RUN = process.argv.includes("--dry-run");
const CODE = String(arg("code", "PRASADAM")).trim().toUpperCase();

if (!/^[A-Z0-9]{2,20}$/.test(CODE)) {
  console.error("--code must be 2-20 letters/digits (it is part of every QR id)");
  process.exit(1);
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(process.env.MONGODB_URI);
  const created = await ensureStandingEvent({ code: CODE, name: arg("name", "Weekend Prasadam"), adminEmail: arg("admin", null), dryRun: DRY_RUN });
  if (!created.length) console.log(`Standing event ${CODE}: everything already exists`);
  console.log(`\nNext: dashboard → Volunteers — assign the "Prasadam Coupon Counter" of ${CODE} to the counter volunteers.`);
}

main()
  .catch((e) => {
    console.error("Failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
