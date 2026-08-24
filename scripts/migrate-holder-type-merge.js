// ─── Migration: merge Category into HolderType (rename-in-place) ────────────
// The merged backend binds the "HolderType" model to the legacy "categories"
// collection, so existing ObjectId references (Holder.catId, QRPass.catId)
// stay valid with NO per-document rewriting.
//
// What this script does (idempotent — safe to re-run):
//   Step 1: Copy isDefault from old "holdertypes" docs onto matching
//           "categories" docs (matched by eventId + code === catCode).
//   Step 2: Set isDefault:false on every categories doc still missing it.
//   Step 3: Clone any holdertypes doc that has NO matching category into
//           "categories" (custom types created standalone), so nothing is lost
//           when the old collection is eventually dropped.
//
// What it deliberately does NOT do:
//   - Does NOT drop "holdertypes" (keep as backup ~2 weeks after deploy).
//   - Does NOT touch Holder.holderTypeId (dangling refs are harmless once the
//     field is gone from the schema; optional manual cleanup later:
//       db.holders.updateMany({}, { $unset: { holderTypeId: "" } }))
//
// Usage:  node scripts/migrate-holder-type-merge.js [--dry-run]

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const DRY_RUN = process.argv.includes("--dry-run");
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

async function main() {
  console.log(`📡 Connecting to MongoDB${DRY_RUN ? " (dry-run)" : ""}...`);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  console.log("✅ Connected\n");

  const collections = await db.listCollections().toArray();
  const names = collections.map((c) => c.name);
  const hasCategories = names.includes("categories");
  const hasHolderTypes = names.includes("holdertypes");

  if (!hasCategories) {
    throw new Error(
      'Collection "categories" not found. Nothing to migrate — aborting.'
    );
  }
  if (!hasHolderTypes) {
    console.log('ℹ️  No "holdertypes" collection found — nothing to merge.');
    console.log("   (Already migrated, or a fresh install.)\n");
    await mongoose.disconnect();
    return;
  }

  const categories = db.collection("categories");
  const holderTypes = db.collection("holdertypes");

  // ── Index old holdertypes by eventId+code for fast matching ───────────────
  const htDocs = await holderTypes.find({}).toArray();
  console.log(`Found ${htDocs.length} legacy holder type(s), ${
    (await categories.countDocuments({}))
  } category doc(s)\n`);

  const htKey = (eventId, code) => `${eventId}_${String(code || "").toUpperCase()}`;
  const htMap = new Map();
  for (const ht of htDocs) {
    htMap.set(htKey(ht.eventId, ht.code || ht.catCode), ht);
  }

  // ── Step 1 + 2: isDefault onto every categories doc ───────────────────────
  let copied = 0;
  let defaulted = 0;
  const catDocs = await categories.find({}).toArray();
  for (const cat of catDocs) {
    const ht = htMap.get(htKey(cat.eventId, cat.catCode));
    const want = Boolean(ht?.isDefault);
    if (cat.isDefault !== want) {
      copied++;
      console.log(
        `  • ${cat.name} (${cat.catCode}) → isDefault: ${want}`
      );
      if (!DRY_RUN) {
        await categories.updateOne(
          { _id: cat._id },
          { $set: { isDefault: want } }
        );
      }
    }
  }

  const missingIsDefault = await categories.countDocuments({
    isDefault: { $exists: false },
  });
  if (missingIsDefault > 0 && !DRY_RUN) {
    await categories.updateMany(
      { isDefault: { $exists: false } },
      { $set: { isDefault: false } }
    );
    defaulted = missingIsDefault;
  }
  console.log(
    `\nStep 1-2: isDefault updated on ${copied} doc(s)${
      defaulted ? `, defaulted ${defaulted}` : ""
    }${DRY_RUN ? " (dry-run, nothing written)" : ""}`
  );

  // ── Step 3: clone orphaned holder types into categories ───────────────────
  // A holdertype with no matching category was never referenced by holders
  // via catId — but preserve it so the merged view is complete.
  const catKeys = new Set(catDocs.map((c) => htKey(c.eventId, c.catCode)));
  let cloned = 0;
  for (const ht of htDocs) {
    const key = htKey(ht.eventId, ht.code || ht.catCode);
    if (catKeys.has(key)) continue;
    cloned++;
    console.log(
      `  • Cloning orphan holder type "${ht.name}" (${ht.code}) into categories`
    );
    if (!DRY_RUN) {
      await categories.insertOne({
        eventId: ht.eventId,
        name: ht.name,
        catCode: String(ht.code || "").toUpperCase(),
        description: ht.description,
        color: ht.color || "#FF6B6B",
        icon: ht.icon || "🏷️",
        entryPoints: [],
        issuerRoleRequired: "event_admin",
        overrideAllowedBy: "event_admin",
        isCustom: true,
        isActive: ht.isActive !== false,
        isDefault: Boolean(ht.isDefault),
        createdAt: ht.createdAt || new Date(),
      });
    }
  }
  console.log(
    `Step 3: ${cloned} orphan holder type(s) cloned${
      DRY_RUN ? " (dry-run, nothing written)" : ""
    }\n`
  );

  // ── Verification summary ──────────────────────────────────────────────────
  if (!DRY_RUN) {
    const badIsDefault = await categories.countDocuments({
      isDefault: { $exists: false },
    });
    console.log("── Integrity checks ──");
    console.log(
      `categories without isDefault field : ${badIsDefault}  (expect 0)`
    );
    console.log(
      `categories total                   : ${await categories.countDocuments({})}`
    );
    console.log(
      `\n⚠️  KEEP the "holdertypes" collection as a backup for ~2 weeks.\n` +
        `   After stable operation, drop it manually:\n` +
        `   db.holdertypes.drop()`
    );
  }

  await mongoose.disconnect();
  console.log("\n✅ Migration complete");
}

main().catch(async (err) => {
  console.error("❌ Migration failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
