// ─── Migration: widen the Holder uniqueness key ──────────────────────────────
// OLD:  unique { eventId, phone }
//         → only ONE holder record per number per event, so a number could
//           never hold both a "Sponsor category A" pass and a "Sponsor
//           category B" / Donor / Volunteer pass.
// NEW:  unique { eventId, phone, catId, subCategory }  (uniq_event_phone_type_category)
//         → one pass per number per (holder type + category) per event.
//           Sponsor A twice          → blocked
//           Sponsor A then Sponsor B → allowed
//           Sponsor A then Donor     → allowed
//           Volunteer twice          → blocked (volunteers carry no category)
//
// What this script does (idempotent — safe to re-run):
//   Step 1: Normalise subCategory — unset "" / "NONE" / "N/A" / "-" so that
//           "no category" is stored as a MISSING field everywhere. The unique
//           index reads a missing field as null; if some rows held "" and
//           others held nothing, two "no category" passes would index as
//           different values and both would be allowed through.
//   Step 2: Report any group that would violate the new index. There should be
//           none (the old index was strictly narrower, so it already forbade
//           every collision the new one forbids), but we check before touching
//           indexes rather than after.
//   Step 3: Drop the old unique { eventId, phone } index.
//   Step 4: Create the new unique compound index, plus a NON-unique
//           { eventId, phone } index to keep "all passes on this number"
//           lookups fast.
//
// Run this BEFORE (or immediately alongside) deploying the new backend. Until
// it runs, the old unique index is still in force and second passes on a
// number keep failing with E11000, whatever the app code says.
//
// Usage:  node scripts/migrate-holder-unique-index.js [--dry-run]

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const DRY_RUN = process.argv.includes("--dry-run");
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

const NEW_INDEX_NAME = "uniq_event_phone_type_category";
const NEW_INDEX_KEY = { eventId: 1, phone: 1, catId: 1, subCategory: 1 };
const BLANK_CATEGORIES = ["", " ", "NONE", "N/A", "-", "none", "n/a"];

async function main() {
  console.log(`📡 Connecting to MongoDB${DRY_RUN ? " (dry-run)" : ""}...`);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const holders = db.collection("holders");
  console.log("✅ Connected\n");

  // ── Step 1: normalise blank subCategory values ────────────────────────────
  const blankFilter = { subCategory: { $in: BLANK_CATEGORIES } };
  const blankCount = await holders.countDocuments(blankFilter);
  console.log(`Step 1 — blank subCategory values to unset: ${blankCount}`);
  if (blankCount > 0 && !DRY_RUN) {
    const r = await holders.updateMany(blankFilter, { $unset: { subCategory: "" } });
    console.log(`         unset on ${r.modifiedCount} document(s)`);
  }

  // Also normalise casing/whitespace on the values we keep, so "a" and "A"
  // don't index as two different categories.
  const messy = await holders
    .find({ subCategory: { $exists: true, $type: "string" } })
    .project({ subCategory: 1 })
    .toArray();
  const needsCasing = messy.filter((d) => {
    const clean = String(d.subCategory).trim().toUpperCase();
    return clean !== d.subCategory;
  });
  console.log(`Step 1b — subCategory values needing trim/uppercase: ${needsCasing.length}`);
  if (needsCasing.length > 0 && !DRY_RUN) {
    for (const d of needsCasing) {
      await holders.updateOne(
        { _id: d._id },
        { $set: { subCategory: String(d.subCategory).trim().toUpperCase() } },
      );
    }
    console.log(`          normalised ${needsCasing.length} document(s)`);
  }

  // ── Step 2: pre-flight collision check against the NEW key ────────────────
  const collisions = await holders
    .aggregate([
      {
        $group: {
          _id: {
            eventId: "$eventId",
            phone: "$phone",
            catId: "$catId",
            subCategory: "$subCategory",
          },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  console.log(`\nStep 2 — groups that would violate the new index: ${collisions.length}`);
  if (collisions.length > 0) {
    for (const c of collisions) {
      console.log(
        `         phone=${c._id.phone} event=${c._id.eventId} ` +
          `type=${c._id.catId} category=${c._id.subCategory ?? "(none)"} ` +
          `→ ${c.count} holders: ${c.ids.join(", ")}`,
      );
    }
    throw new Error(
      "Duplicate holder groups found. Resolve these by hand (keep the record " +
        "with the live QR pass, delete or re-categorise the others), then re-run.",
    );
  }

  // ── Step 3 + 4: swap the indexes ──────────────────────────────────────────
  const existing = await holders.indexes();
  const oldUnique = existing.find(
    (ix) =>
      ix.unique &&
      Object.keys(ix.key).length === 2 &&
      ix.key.eventId === 1 &&
      ix.key.phone === 1,
  );
  const alreadyNew = existing.find((ix) => ix.name === NEW_INDEX_NAME);

  console.log(`\nStep 3 — old unique { eventId, phone } index: ${oldUnique ? oldUnique.name : "not present"}`);
  console.log(`Step 4 — new ${NEW_INDEX_NAME} index: ${alreadyNew ? "already present" : "will be created"}`);

  if (DRY_RUN) {
    console.log("\n🔍 Dry run — no index changes applied.");
    await mongoose.disconnect();
    return;
  }

  if (!alreadyNew) {
    await holders.createIndex(NEW_INDEX_KEY, { unique: true, name: NEW_INDEX_NAME });
    console.log(`         created ${NEW_INDEX_NAME}`);
  }

  // Drop the old one only AFTER the new one exists, so there is never a window
  // with no uniqueness protection at all.
  if (oldUnique) {
    await holders.dropIndex(oldUnique.name);
    console.log(`         dropped ${oldUnique.name}`);
  }

  // Non-unique replacement for "every pass on this number" lookups.
  const hasPlainLookup = (await holders.indexes()).some(
    (ix) =>
      !ix.unique &&
      Object.keys(ix.key).length === 2 &&
      ix.key.eventId === 1 &&
      ix.key.phone === 1,
  );
  if (!hasPlainLookup) {
    await holders.createIndex({ eventId: 1, phone: 1 });
    console.log("         created non-unique { eventId, phone }");
  }

  console.log("\n✅ Migration complete. Final indexes on holders:");
  for (const ix of await holders.indexes()) {
    console.log(`   ${ix.name}${ix.unique ? " (unique)" : ""} — ${JSON.stringify(ix.key)}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n❌ Migration failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
