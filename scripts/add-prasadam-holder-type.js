// ─── Backfill: add the "Prasadam Coupon" (PR) pass type to existing events ──
//
// New events get Prasadam Coupon automatically from eventController.createEvent
// (linked to the "Special Prasadam" entry point created alongside it). This
// script adds both to events that already existed before this pass type was
// introduced — e.g. so the Vaikuntham app's "I will attend + opt Prasadam"
// flow (POST /api/integration/prasadam/qr) has something correctly scoped to
// issue against for events created before today.
//
// Unlike scripts/add-patron-holder-type.js (which only links to entry points
// that already exist and skips an event with none), this script actively
// CREATES the "Prasadam Coupon" entry point for an event that doesn't have
// one yet — a prasadam counter should exist everywhere, not just where an
// admin happened to add one by hand.
//
// By default it targets CURRENT and UPCOMING events only (dateEnd >= now) —
// completed festivals are left alone, since adding a pass type to a finished
// event only clutters the dashboard. Pass --all to include past events too.
//
// Idempotent — safe to re-run:
//   - an event that already has a PR type is skipped and reported
//   - an event that already has a "prasadam_coupon"-type entry point reuses it
//     rather than creating a duplicate counter
//
// A coupon is linked ONLY to the "Prasadam Coupon" counter lane
// (type "prasadam_coupon"), never to the general "Special Prasadam" counter
// (type "prasadam") that Sponsor/Donor/Volunteer/Patron passes scan at —
// same split as eventController.createEvent and
// prasadamIntegrationController.resolvePrasadamCategory.
//
// NOTE: events that ALREADY have a PR type (scoped to the old general
// "prasadam" counter) are re-scoped by scripts/add-prasadam-coupon-entry-point.js,
// which also moves already-issued coupon QR passes onto the coupon counter.
// This script only covers events that have no PR type yet.
//
// Usage:
//   node scripts/add-prasadam-holder-type.js --dry-run     # report only
//   node scripts/add-prasadam-holder-type.js               # current + upcoming
//   node scripts/add-prasadam-holder-type.js --all         # include past events

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const Event = require("../src/models/Event");
const EntryPoint = require("../src/models/EntryPoint");
const HolderType = require("../src/models/HolderType");

const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_PAST = process.argv.includes("--all");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

// Must match the Prasadam Coupon entry in eventController.createEvent, the
// auto-create fallback in prasadamIntegrationController.resolvePrasadamCategory,
// and the re-scope backfill scripts/add-prasadam-coupon-entry-point.js.
const PRASADAM_EP = {
  name: "Prasadam Coupon",
  stationLabel: "Prasadam Coupon Counter",
  type: "prasadam_coupon",
};
const PRASADAM_TYPE = {
  name: "Prasadam Coupon",
  catCode: "PR",
  color: "#16A34A",
  icon: "🍛",
  isDefault: true,
  isActive: true,
};

async function main() {
  console.log(
    `📡 Connecting to MongoDB${DRY_RUN ? " (dry-run — nothing will be written)" : ""}...`,
  );
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected\n");

  const now = new Date();
  const filter = INCLUDE_PAST ? {} : { dateEnd: { $gte: now } };

  const events = await Event.find(filter)
    .select("_id name eventCode dateStart dateEnd")
    .sort({ dateStart: 1 })
    .lean();

  console.log(
    `Found ${events.length} ${INCLUDE_PAST ? "" : "current/upcoming "}event(s)\n`,
  );

  const created = [];
  const skipped = [];
  const entryPointsCreated = [];

  for (const event of events) {
    const label = `${event.eventCode || "?"} — ${event.name || "(unnamed)"}`;

    const existing = await HolderType.findOne({
      eventId: event._id,
      catCode: "PR",
    }).lean();
    if (existing) {
      skipped.push(label);
      console.log(`  ⏭  ${label} — already has a PR pass type`);
      continue;
    }

    let prasadamEP = await EntryPoint.findOne({
      eventId: event._id,
      type: "prasadam_coupon",
    }).lean();

    let epNote = `existing entry point "${prasadamEP?.name}"`;
    if (!prasadamEP) {
      if (DRY_RUN) {
        epNote = `would create entry point "${PRASADAM_EP.name}"`;
      } else {
        prasadamEP = await EntryPoint.create({ ...PRASADAM_EP, eventId: event._id });
        entryPointsCreated.push(label);
        epNote = `created entry point "${prasadamEP.name}"`;
      }
    }

    if (DRY_RUN) {
      created.push(label);
      console.log(`  +  ${label} — would add Prasadam Coupon [${epNote}]`);
      continue;
    }

    try {
      await HolderType.create({
        ...PRASADAM_TYPE,
        eventId: event._id,
        entryPoints: [prasadamEP._id],
      });
      created.push(label);
      console.log(`  ✅ ${label} — Prasadam Coupon added [${epNote}]`);
    } catch (e) {
      // Unique index is { eventId, catCode } — a concurrent run or a manually
      // created PR type lands here rather than aborting the whole backfill.
      if (e.code === 11000) {
        skipped.push(label);
        console.log(`  ⏭  ${label} — PR created concurrently, skipped`);
      } else {
        console.error(`  ❌ ${label} — ${e.message}`);
      }
    }
  }

  console.log(
    `\n${DRY_RUN ? "Would add" : "Added"}: ${created.length}   ` +
      `Already present: ${skipped.length}   ` +
      `New entry points ${DRY_RUN ? "that would be " : ""}created: ${entryPointsCreated.length}`,
  );

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
