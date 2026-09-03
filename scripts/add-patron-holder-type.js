// ─── Backfill: add the "Patron" (PAT) pass type to existing events ──────────
//
// New events get Patron automatically from eventController.createEvent. This
// script adds it to events that already existed when the type was introduced.
//
// By default it targets CURRENT and UPCOMING events only (dateEnd >= now) —
// completed festivals are left alone, since adding a pass type to a finished
// event only clutters the dashboard. Pass --all to include past events too.
//
// Entry points are matched by TYPE, not by name, so it works regardless of
// what each event calls its gates:
//     venue_entry  (main entry)  +  jhulan  +  prasadam
// The legacy "darshan" spelling is matched too, so events created before the
// jhulan rename still get their gates linked.
// Every matching entry point is linked, so multi-venue events get all of
// their jhulan/prasadam desks rather than just the first.
//
// Idempotent — safe to re-run:
//   - an event that already has a PAT type is skipped and reported
//   - an event with no matching entry points is reported and skipped, rather
//     than creating a pass type that grants access to nothing
//
// Usage:
//   node scripts/add-patron-holder-type.js --dry-run     # report only
//   node scripts/add-patron-holder-type.js               # current + upcoming
//   node scripts/add-patron-holder-type.js --all         # include past events

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

// Must match the Patron entry in eventController.createEvent.
const PATRON = {
  name: "Patron",
  catCode: "PAT",
  color: "#6366F1",
  icon: "👑",
  isDefault: true,
  isActive: true,
};
// JHULAN_TYPES covers both "jhulan" and the legacy "darshan".
const { JHULAN_TYPES } = require("../src/utils/entryPointTypes");
const PATRON_EP_TYPES = ["venue_entry", ...JHULAN_TYPES, "prasadam"];

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
  const noEntryPoints = [];

  for (const event of events) {
    const label = `${event.eventCode || "?"} — ${event.name || "(unnamed)"}`;

    const existing = await HolderType.findOne({
      eventId: event._id,
      catCode: "PAT",
    }).lean();
    if (existing) {
      skipped.push(label);
      console.log(`  ⏭  ${label} — already has a PAT pass type`);
      continue;
    }

    const eps = await EntryPoint.find({
      eventId: event._id,
      type: { $in: PATRON_EP_TYPES },
    })
      .select("_id name type")
      .lean();

    if (eps.length === 0) {
      noEntryPoints.push(label);
      console.log(
        `  ⚠  ${label} — no main entry / darshan / prasadam entry points, skipped`,
      );
      continue;
    }

    const epSummary = eps.map((ep) => ep.name || ep.type).join(", ");

    if (DRY_RUN) {
      created.push(label);
      console.log(`  +  ${label} — would add Patron [${epSummary}]`);
      continue;
    }

    try {
      await HolderType.create({
        ...PATRON,
        eventId: event._id,
        entryPoints: eps.map((ep) => ep._id),
      });
      created.push(label);
      console.log(`  ✅ ${label} — Patron added [${epSummary}]`);
    } catch (e) {
      // Unique index is { eventId, catCode } — a concurrent run or a manually
      // created PAT type lands here rather than aborting the whole backfill.
      if (e.code === 11000) {
        skipped.push(label);
        console.log(`  ⏭  ${label} — PAT created concurrently, skipped`);
      } else {
        console.error(`  ❌ ${label} — ${e.message}`);
      }
    }
  }

  console.log(
    `\n${DRY_RUN ? "Would add" : "Added"}: ${created.length}   ` +
      `Already present: ${skipped.length}   ` +
      `No entry points: ${noEntryPoints.length}`,
  );

  if (noEntryPoints.length > 0) {
    console.log(
      `\n⚠  These events need main entry / darshan / prasadam entry points ` +
        `before Patron can be added — create them in the dashboard, then ` +
        `re-run this script:`,
    );
    for (const l of noEntryPoints) console.log(`     ${l}`);
  }

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
