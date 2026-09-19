// ─── Standalone re-scope: move already-issued Prasadam coupons to the coupon lane ──
//
// The prasadam counter now has two lanes with separate entry points:
//   - "prasadam"           → general counter (Sponsor/Donor/Volunteer/Patron passes)
//   - "prasadam_coupon"    → coupon counter (Prasadam Coupon "PR" passes)
//
// Events created before this split point their PR holder type — and every
// already-issued coupon QR pass — at the single general "prasadam" counter.
// This script (and the equivalent auto-run inside src/index.js on every boot)
// moves existing coupons onto the coupon lane WITHOUT re-issuing any QR: scans
// resolve each QR by qrId against the DB, so re-scoping the DB entryPoints
// array is all that is needed. The signed JWT inside the QR is never consulted
// for entry-point checks.
//
// Also run automatically (current & upcoming events) on every app start via
// src/migrations/prasadamCouponBackfill.js, so a deploy applies it even when
// nobody can reach the database directly. This script exists for manual runs —
// especially --all for completed events and --dry-run for an audit.
//
// Idempotent — safe to re-run:
//   - an event without a PR (coupon) pass type is skipped and reported
//   - an event that already has a "prasadam_coupon"-type entry point reuses it
//   - coupon passes already on the coupon lane are left untouched
//
// Usage:
//   node scripts/add-prasadam-coupon-entry-point.js --dry-run   # report only
//   node scripts/add-prasadam-coupon-entry-point.js             # current + upcoming
//   node scripts/add-prasadam-coupon-entry-point.js --all       # include past events

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const { runPrasadamCouponBackfill } = require("../src/migrations/prasadamCouponBackfill");

const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_PAST = process.argv.includes("--all");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

async function main() {
  console.log(
    `📡 Connecting to MongoDB${DRY_RUN ? " (dry-run — nothing will be written)" : ""}...`,
  );
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected\n");

  await runPrasadamCouponBackfill({ includePast: INCLUDE_PAST, dryRun: DRY_RUN });

  await mongoose.disconnect();
  console.log("\n👋 Done");
}

main().catch(async (err) => {
  console.error("\n❌ Backfill failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});