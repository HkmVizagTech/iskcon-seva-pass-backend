// ─── Rename the darshan gate to Jhulan ──────────────────────────────────────
// Updates entry points on CURRENT AND UPCOMING events (dateEnd >= now):
//     type          "darshan"        → "jhulan"
//     name          "Darshan"        → "Jhulan"        (any casing)
//     stationLabel  "Darshan Queue"  → "Jhulan Queue"  (any casing)
//
// Past events are left alone by default, so historical reports still read the
// way they did at the time. Pass --all to include them.
//
// SAFE FOR ISSUED PASSES: the signed QR payload stores only entry-point ID
// fragments (qrService.createPayload → `p`), never names or types, and scan
// validation resolves entry points live from the database. Renaming changes
// what people SEE; it cannot invalidate a pass already in circulation.
//
// Custom names are preserved. A gate named "Darshan Hall 2" becomes
// "Jhulan Hall 2"; one named "Main Deity Viewing" keeps its name and only its
// `type` changes. Only the word Darshan/darshan is substituted, never the
// whole string.
//
// Idempotent — re-running finds nothing left to do. A backup of every affected
// row's previous values is written before anything changes.
//
// Usage:
//   node scripts/rename-darshan-to-jhulan.js --dry-run     # always first
//   node scripts/rename-darshan-to-jhulan.js
//   node scripts/rename-darshan-to-jhulan.js --all         # past events too

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config({ path: path.join(__dirname, "../.env") });

const { JHULAN, JHULAN_LEGACY } = require("../src/utils/entryPointTypes");

const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_PAST = process.argv.includes("--all");
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

// Replaces the word Darshan wherever it appears, keeping the rest of the label
// and matching the original capitalisation of the first letter.
function relabel(text) {
  if (!text) return text;
  return String(text).replace(/darshan/gi, (m) =>
    m[0] === m[0].toUpperCase() ? "Jhulan" : "jhulan",
  );
}

async function main() {
  console.log(`📡 Connecting to MongoDB${DRY_RUN ? " (dry run)" : ""}...`);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const events = db.collection("events");
  const eps = db.collection("entrypoints");
  console.log("✅ Connected\n");

  const now = new Date();
  const eventFilter = INCLUDE_PAST ? {} : { dateEnd: { $gte: now } };
  const scopedEvents = await events
    .find(eventFilter)
    .project({ name: 1, eventCode: 1, dateEnd: 1 })
    .toArray();

  console.log(
    `Scope: ${scopedEvents.length} ${INCLUDE_PAST ? "" : "current/upcoming "}event(s)` +
    `${INCLUDE_PAST ? "" : "  (pass --all to include past events)"}\n`,
  );

  if (scopedEvents.length === 0) {
    console.log("Nothing in scope.");
    await mongoose.disconnect();
    return;
  }

  const evName = new Map(scopedEvents.map((e) => [String(e._id), e.eventCode || e.name]));
  const eventIds = scopedEvents.map((e) => e._id);

  // Anything whose type is still the legacy value, OR whose labels still say
  // Darshan (e.g. a gate someone already retyped but never renamed).
  const affected = await eps.find({
    eventId: { $in: eventIds },
    $or: [
      { type: JHULAN_LEGACY },
      { name: /darshan/i },
      { stationLabel: /darshan/i },
    ],
  }).toArray();

  if (affected.length === 0) {
    console.log("✅ Nothing to rename — already done, or no darshan gates in scope.");
    await mongoose.disconnect();
    return;
  }

  const plan = affected.map((ep) => ({
    _id: ep._id,
    event: evName.get(String(ep.eventId)) || String(ep.eventId),
    before: { type: ep.type, name: ep.name, stationLabel: ep.stationLabel },
    after: {
      type: ep.type === JHULAN_LEGACY ? JHULAN : ep.type,
      name: relabel(ep.name),
      stationLabel: relabel(ep.stationLabel),
    },
  }));

  console.log(`${affected.length} entry point(s) to update:\n`);
  console.log(`${"EVENT".padEnd(12)}${"TYPE".padEnd(22)}${"NAME".padEnd(34)}STATION LABEL`);
  console.log("─".repeat(110));
  for (const p of plan) {
    const t = p.before.type === p.after.type ? p.before.type : `${p.before.type} → ${p.after.type}`;
    const n = p.before.name === p.after.name ? p.before.name || "—" : `${p.before.name} → ${p.after.name}`;
    const s = p.before.stationLabel === p.after.stationLabel
      ? p.before.stationLabel || "—"
      : `${p.before.stationLabel} → ${p.after.stationLabel}`;
    console.log(`${p.event.slice(0, 11).padEnd(12)}${t.padEnd(22)}${n.slice(0, 33).padEnd(34)}${s}`);
  }
  console.log("─".repeat(110));

  if (DRY_RUN) {
    console.log("\n🔍 Dry run — nothing changed. Re-run without --dry-run to apply.");
    await mongoose.disconnect();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(__dirname, `jhulan-rename-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date(), plan }, null, 2));
  console.log(`\n💾 Backup of previous values → ${backupPath}`);

  let updated = 0;
  for (const p of plan) {
    const set = {};
    if (p.after.type !== p.before.type) set.type = p.after.type;
    if (p.after.name !== p.before.name) set.name = p.after.name;
    if (p.after.stationLabel !== p.before.stationLabel) set.stationLabel = p.after.stationLabel;
    if (Object.keys(set).length === 0) continue;
    await eps.updateOne({ _id: p._id }, { $set: set });
    updated++;
  }

  console.log(`\n✅ ${updated} entry point(s) renamed to Jhulan.`);

  const legacyLeft = await eps.countDocuments({ type: JHULAN_LEGACY });
  if (legacyLeft > 0) {
    console.log(
      `\nℹ️  ${legacyLeft} entry point(s) elsewhere still have type "${JHULAN_LEGACY}" ` +
      `(past events).\n   That is intentional — every filter matches both spellings. ` +
      `Use --all to convert them too.`,
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n❌ Failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
