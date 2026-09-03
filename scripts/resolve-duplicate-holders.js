// ─── Resolve duplicate holder records before the uniqueness migration ───────
// scripts/migrate-holder-unique-index.js refuses to build the new unique index
// while any (eventId, phone, catId, subCategory) group holds more than one
// holder. This script reports those groups in full and can resolve the
// unambiguous ones.
//
// WHY THEY EXIST: the old `{ eventId, phone }` unique index declared in
// models/Holder.js was never actually built — MongoDB refuses to create a
// unique index on a collection that already contains duplicates, and it does
// so silently at startup. So duplicates accumulated despite the schema
// claiming they couldn't.
//
// HOW EACH GROUP IS CLASSIFIED
//   no-pass    no holder in the group has an active QR pass.
//              → keep the oldest record, drop the rest. Nothing is in
//                circulation, so this is safe.
//   safe       exactly ONE holder has an active QR pass.
//              → keep that one, drop the rest. The live pass is untouched.
//   conflict   TWO OR MORE holders have active passes that have been SCANNED.
//              → NOT resolved automatically. Two real passes are in the wild
//                for the same number/type/category and only you can say which
//                should survive.
//
// Losing records are handled conservatively: their QR passes are set to
// "revoked" (never deleted, so the scan history and audit trail survive), and
// the duplicate holder rows are removed. Everything removed is written to a
// timestamped JSON backup FIRST, so the change can be reconstructed.
//
// Usage:
//   node scripts/resolve-duplicate-holders.js                  # report only
//   node scripts/resolve-duplicate-holders.js --json=dups.json # + full dump
//   node scripts/resolve-duplicate-holders.js --apply          # fix safe groups
//
// Always read the report before using --apply. Re-run
// migrate-holder-unique-index.js --dry-run afterwards to confirm 0 groups.

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const jsonArg = process.argv.find((a) => a.startsWith("--json="));
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

async function main() {
  console.log(`📡 Connecting to MongoDB${APPLY ? "" : " (report only)"}...`);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const holders = db.collection("holders");
  const passes = db.collection("qrpasses");
  const events = db.collection("events");
  const types = db.collection("categories"); // HolderType is bound to "categories"
  console.log("✅ Connected\n");

  const groups = await holders.aggregate([
    {
      $group: {
        _id: { eventId: "$eventId", phone: "$phone", catId: "$catId", subCategory: "$subCategory" },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (groups.length === 0) {
    console.log("✅ No duplicate groups. Run migrate-holder-unique-index.js.");
    await mongoose.disconnect();
    return;
  }

  // Look up display names once rather than per group.
  const evNames = new Map(
    (await events.find({}).project({ name: 1, eventCode: 1 }).toArray())
      .map((e) => [String(e._id), e.eventCode || e.name]),
  );
  const typeNames = new Map(
    (await types.find({}).project({ name: 1, catCode: 1 }).toArray())
      .map((t) => [String(t._id), t.catCode || t.name]),
  );

  const report = [];

  for (const g of groups) {
    const docs = await holders.find({ _id: { $in: g.ids } }).toArray();
    const enriched = [];

    for (const h of docs) {
      const hp = await passes.find({ holderId: h._id }).toArray();
      const active = hp.filter((p) => p.status === "active");
      const grantedCount = hp.reduce(
        (n, p) => n + (p.redemptionHistory || []).filter((r) => r.result === "granted").length, 0,
      );
      const lastScan = hp
        .flatMap((p) => (p.redemptionHistory || []).filter((r) => r.result === "granted" && r.scannedAt))
        .map((r) => new Date(r.scannedAt))
        .sort((a, b) => b - a)[0];
      enriched.push({
        holder: h,
        passes: hp,
        activeCount: active.length,
        grantedCount,
        lastScan,
        // "In circulation" = an active pass that someone has actually used.
        live: active.length > 0 && grantedCount > 0,
      });
    }

    const withActive = enriched.filter((e) => e.activeCount > 0);
    const liveOnes = enriched.filter((e) => e.live);

    let verdict, keep = null;
    if (withActive.length === 0) {
      verdict = "no-pass";
      keep = enriched.slice().sort(
        (a, b) => new Date(a.holder.createdAt || 0) - new Date(b.holder.createdAt || 0),
      )[0];
    } else if (liveOnes.length > 1) {
      verdict = "conflict";
    } else if (withActive.length === 1) {
      verdict = "safe";
      keep = withActive[0];
    } else if (liveOnes.length === 1) {
      // Several active passes but only one has ever been scanned — that is the
      // one in people's hands.
      verdict = "safe";
      keep = liveOnes[0];
    } else {
      // Multiple active, none ever scanned: keep the oldest, revoke the rest.
      verdict = "safe";
      keep = withActive.slice().sort(
        (a, b) => new Date(a.holder.createdAt || 0) - new Date(b.holder.createdAt || 0),
      )[0];
    }

    report.push({ group: g, enriched, verdict, keep });
  }

  // ── Print ─────────────────────────────────────────────────────────────────
  const order = { conflict: 0, safe: 1, "no-pass": 2 };
  report.sort((a, b) => order[a.verdict] - order[b.verdict]);

  for (const r of report) {
    const k = r.group._id;
    const tag = { conflict: "⛔ NEEDS YOUR DECISION", safe: "✅ auto-resolvable", "no-pass": "✅ auto-resolvable (nothing issued)" }[r.verdict];
    console.log("─".repeat(100));
    console.log(
      `${tag}\n` +
      `  event ${evNames.get(String(k.eventId)) || k.eventId}` +
      `   type ${typeNames.get(String(k.catId)) || k.catId}` +
      `   category ${k.subCategory ?? "(none)"}   phone ${k.phone}`,
    );
    for (const e of r.enriched) {
      const isKeep = r.keep && String(r.keep.holder._id) === String(e.holder._id);
      const mark = r.verdict === "conflict" ? "  ?" : isKeep ? "KEEP" : "DROP";
      console.log(
        `   ${mark}  ${String(e.holder._id)}  ${(e.holder.name || "").slice(0, 24).padEnd(25)}` +
        `created ${fmt(e.holder.createdAt)}  src=${(e.holder.source || "?").padEnd(12)}` +
        `passes=${e.passes.length} active=${e.activeCount} scans=${e.grantedCount}` +
        (e.lastScan ? `  last ${fmt(e.lastScan)}` : ""),
      );
      for (const p of e.passes) {
        console.log(`         └ ${p.qrId}  ${p.status}${isKeep || r.verdict === "conflict" ? "" : "  → will be revoked"}`);
      }
    }
  }
  console.log("─".repeat(100));

  const conflicts = report.filter((r) => r.verdict === "conflict");
  const fixable = report.filter((r) => r.verdict !== "conflict");
  console.log(
    `\n${report.length} duplicate group(s): ` +
    `${fixable.length} auto-resolvable, ${conflicts.length} need your decision.`,
  );

  if (jsonArg) {
    const out = path.resolve(process.cwd(), jsonArg.slice("--json=".length));
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`📄 Full dump written to ${out}`);
  }

  if (!APPLY) {
    console.log(
      "\n🔍 Report only — nothing changed." +
      (fixable.length ? "\n   Re-run with --apply to resolve the auto-resolvable groups." : ""),
    );
    if (conflicts.length) {
      console.log(
        "   The ⛔ groups have two or more SCANNED passes in circulation. Decide\n" +
        "   which holder survives, revoke the other's pass in the dashboard, then\n" +
        "   re-run this script.",
      );
    }
    await mongoose.disconnect();
    return;
  }

  if (fixable.length === 0) {
    console.log("\nNothing to apply — every remaining group needs a human decision.");
    await mongoose.disconnect();
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  // Back up everything that will be touched BEFORE touching it.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(__dirname, `duplicate-holders-backup-${stamp}.json`);
  const doomed = [];
  for (const r of fixable) {
    for (const e of r.enriched) {
      if (String(r.keep.holder._id) !== String(e.holder._id)) {
        doomed.push({ holder: e.holder, passes: e.passes });
      }
    }
  }
  fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date(), removed: doomed }, null, 2));
  console.log(`\n💾 Backup of ${doomed.length} holder record(s) → ${backupPath}`);
  console.log("   Keep this file. It is the only copy of what was removed.\n");

  let revoked = 0, deleted = 0;
  for (const d of doomed) {
    // Revoke rather than delete the passes: the scan history is an audit trail.
    const res = await passes.updateMany(
      { holderId: d.holder._id, status: { $ne: "revoked" } },
      { $set: { status: "revoked", updatedAt: new Date() } },
    );
    revoked += res.modifiedCount;
    await holders.deleteOne({ _id: d.holder._id });
    deleted++;
    console.log(`   removed holder ${d.holder._id} (${d.holder.name || "?"}) — ${res.modifiedCount} pass(es) revoked`);
  }

  console.log(`\n✅ ${deleted} duplicate holder(s) removed, ${revoked} pass(es) revoked.`);
  if (conflicts.length) {
    console.log(`⚠️  ${conflicts.length} group(s) still need your decision — see the ⛔ entries above.`);
    console.log("   The uniqueness migration will keep refusing until those are resolved.");
  } else {
    console.log("👉 Now run: node scripts/migrate-holder-unique-index.js --dry-run");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n❌ Failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
