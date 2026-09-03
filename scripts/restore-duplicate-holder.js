// ─── Undo one removal made by resolve-duplicate-holders.js ──────────────────
// Reads a duplicate-holders-backup-*.json and puts a holder record back,
// restoring the QR passes that were revoked along with it.
//
// Use this when the resolver treated two genuinely DIFFERENT holders that
// happen to share a phone number as duplicates — e.g. two satsang centres
// under one office contact number.
//
// NOTE: restoring re-creates the condition that
// migrate-holder-unique-index.js refuses to build the unique index over. After
// restoring you must make the two records distinguishable — give them separate
// phone numbers, or put them in different categories — before the migration
// will pass. That is the point: the index cannot express "two different people,
// same number, same pass type, same category".
//
// Usage:
//   node scripts/restore-duplicate-holder.js --backup=scripts/duplicate-holders-backup-....json --list
//   node scripts/restore-duplicate-holder.js --backup=... --holder=69f34aedef2581ad5abe1df7 [--dry-run]
//   node scripts/restore-duplicate-holder.js --backup=... --all-with-live-passes [--dry-run]

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config({ path: path.join(__dirname, "../.env") });

const argOf = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const DRY_RUN = process.argv.includes("--dry-run");
const LIST = process.argv.includes("--list");
const ALL_LIVE = process.argv.includes("--all-with-live-passes");
const BACKUP = argOf("backup");
const HOLDER = argOf("holder");
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

// The backup stores what the driver gave us, so ObjectIds and Dates arrive as
// strings after a JSON round-trip. Put them back as real BSON types, or the
// restored document won't match any query the app makes.
const OID_KEYS = new Set([
  "_id", "eventId", "catId", "holderId", "issuedBy", "preacherId",
  "sevaSlotId", "holderTypeId", "epId", "scannedBy",
]);
const DATE_KEYS = new Set([
  "createdAt", "updatedAt", "issuedAt", "validFrom", "validUntil",
  "deliveredAt", "scannedAt", "attemptedAt",
]);
const isOid = (v) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);

function revive(value, key) {
  if (Array.isArray(value)) return value.map((v) => revive(v, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v, k);
    return out;
  }
  if (OID_KEYS.has(key) && isOid(value)) return new mongoose.Types.ObjectId(value);
  if (DATE_KEYS.has(key) && typeof value === "string" && !isNaN(Date.parse(value))) {
    return new Date(value);
  }
  return value;
}

async function main() {
  if (!BACKUP) throw new Error("--backup=<path to duplicate-holders-backup-*.json> is required");
  const backupPath = path.resolve(process.cwd(), BACKUP);
  if (!fs.existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);

  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const removed = backup.removed || [];
  console.log(`📄 ${backupPath}`);
  console.log(`   ${removed.length} removed record(s), taken ${backup.createdAt}\n`);

  if (LIST) {
    for (const r of removed) {
      const states = (r.passes || []).map((p) => `${p.qrId}:${p.status}`).join(" ") || "no passes";
      const hadLive = (r.passes || []).some((p) => p.status === "active");
      console.log(
        `${hadLive ? "LIVE" : "    "}  ${r.holder._id}  ` +
        `${String(r.holder.name || "?").slice(0, 26).padEnd(28)}${r.holder.phone}  ${states}`,
      );
    }
    console.log("\nLIVE = had an active pass when it was removed (restore these first).");
    return;
  }

  const targets = ALL_LIVE
    ? removed.filter((r) => (r.passes || []).some((p) => p.status === "active"))
    : removed.filter((r) => String(r.holder._id) === String(HOLDER));

  if (!targets.length) {
    throw new Error(
      HOLDER
        ? `Holder ${HOLDER} is not in this backup. Use --list to see what is.`
        : "Nothing to restore. Pass --holder=<id> or --all-with-live-passes.",
    );
  }

  console.log(`📡 Connecting to MongoDB${DRY_RUN ? " (dry run)" : ""}...`);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const holders = db.collection("holders");
  const passes = db.collection("qrpasses");
  console.log("✅ Connected\n");

  for (const t of targets) {
    const doc = revive(t.holder, null);
    const exists = await holders.findOne({ _id: doc._id });
    console.log(`${doc.name || "?"}  (${doc._id})  phone ${doc.phone}`);

    if (exists) {
      console.log("   holder already present — skipping the insert");
    } else if (DRY_RUN) {
      console.log("   would re-insert the holder record");
    } else {
      await holders.insertOne(doc);
      console.log("   ✅ holder re-inserted");
    }

    // Restore only the passes that were ACTIVE at backup time. Anything already
    // revoked before the resolver ran stays revoked — that was a real decision
    // someone made earlier, not something we broke.
    for (const p of (t.passes || []).filter((x) => x.status === "active")) {
      if (DRY_RUN) {
        console.log(`   would set ${p.qrId} back to active`);
        continue;
      }
      const res = await passes.updateOne(
        { qrId: p.qrId },
        { $set: { status: "active", updatedAt: new Date() } },
      );
      console.log(
        res.matchedCount
          ? `   ✅ ${p.qrId} set back to active`
          : `   ⚠️  ${p.qrId} not found in qrpasses — re-inserting from backup`,
      );
      if (!res.matchedCount) await passes.insertOne(revive(p, null));
    }
    console.log("");
  }

  if (DRY_RUN) {
    console.log("🔍 Dry run — nothing changed.");
  } else {
    console.log("✅ Restore complete.");
    console.log(
      "\n⚠️  These records will now block migrate-holder-unique-index.js again.\n" +
      "   Make them distinguishable first — a separate phone number for each, or\n" +
      "   different categories — then re-run the migration dry run.",
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n❌ Failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
