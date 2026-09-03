// ─── Backfill: sponsor/donor/invitee passes whose community-app sync failed ─
// Context: the community app's Laravel endpoint (harekrishnavizag.co.in)
// rate-limits per IP. Before the fix in src/services/thirdPartyService.js,
// every Sponsor/Donor/Invitee pass fired TWO requests (seva-sponsor, plus a
// store-qr-code push that always failed anyway — see SKIP_SPONSOR_STORE_QR
// in src/controllers/holderController.js) with no pacing between rows during
// a bulk import, so a chunk of a large import got "429 Too Many Attempts"
// and QRPass.communityAppSync was left unsuccessful for those rows — the
// pass itself was issued fine, it just never showed up in the community app.
//
// Going forward this can't recur (calls are throttled + retried, and the
// doomed second call is gone). This script is the one-time catch-up for
// passes that were already affected before that fix went live: it re-runs
// ONLY pushSevaSponsor (never pushStoreQrCode) for anything not yet synced.
// Safe to re-run — their seva-sponsor endpoint dedupes on the devotee+donor
// pair, so resending an already-successful one is a harmless no-op on their
// side (this script skips those anyway).
//
// Usage:
//   node scripts/resend-community-app-failures.js --event=SKJ26
//       Report only — lists what WOULD be resent, with each one's last
//       recorded failure reason. Nothing is sent.
//
//   node scripts/resend-community-app-failures.js --event=SKJ26 --apply
//       Actually resends. Paced automatically by thirdPartyService's own
//       throttle (min ~400ms between requests), so this can take a while
//       for a large backlog — that's expected, let it finish.
//
//   node scripts/resend-community-app-failures.js --event=SKJ26 --apply --only=9876543210,9123456789
//       Limit to specific phone numbers (bare 10-digit or 91-prefixed —
//       matched against the holder's stored phone either way).
//
//   node scripts/resend-community-app-failures.js --event=SKJ26 --types=SP,DN,INV,VL
//       Widen beyond the default SP/DN/INV if General/Volunteer passes also
//       need a catch-up. VL uses a different push (pushStoreQrCode, which is
//       the CORRECT call for actual volunteers, unlike the sponsor case).

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, "../.env") });

const Event = require("../src/models/Event");
const HolderType = require("../src/models/HolderType");
const QRPass = require("../src/models/QRPass");
const User = require("../src/models/User");
// Never referenced directly below, but QRPass.holderId has `ref: "Holder"` —
// .populate("holderId") needs the Holder schema registered with Mongoose
// first, or it throws MissingSchemaError. This require does that.
require("../src/models/Holder");
const thirdPartyService = require("../src/services/thirdPartyService");

const APPLY = process.argv.includes("--apply");
const eventArg = process.argv.find((a) => a.startsWith("--event="));
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const typesArg = process.argv.find((a) => a.startsWith("--types="));

const bare10 = (p) => String(p || "").replace(/^91/, "").slice(-10);
const onlyPhones = onlyArg
  ? new Set(onlyArg.slice(7).split(",").map((p) => bare10(p.trim())).filter(Boolean))
  : null;
const wantedTypes = (typesArg ? typesArg.slice(8) : "SP,DN,INV")
  .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

async function resolvePreacherPhone(preacherId) {
  if (!preacherId) return undefined;
  const u = await User.findById(preacherId).select("phone").lean();
  return u?.phone || undefined;
}

async function main() {
  if (!eventArg) {
    console.error("Usage: node scripts/resend-community-app-failures.js --event=<eventCode> [--apply] [--only=phone1,phone2] [--types=SP,DN,INV]");
    process.exit(1);
  }
  const eventCode = eventArg.slice(8).toUpperCase();

  console.log(`📡 Connecting to MongoDB${APPLY ? "" : " (report only — pass --apply to actually resend)"}...`);
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected\n");

  const event = await Event.findOne({ eventCode });
  if (!event) {
    console.error(`Event with code "${eventCode}" not found.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  if (!event.thirdPartyEventId) {
    console.error(`Event "${eventCode}" has no thirdPartyEventId mapped — nothing to sync.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const types = await HolderType.find({ eventId: event._id, catCode: { $in: wantedTypes } })
    .select("_id catCode name");
  if (types.length === 0) {
    console.error(`No holder types matching [${wantedTypes.join(", ")}] found for "${eventCode}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const typeMap = new Map(types.map((t) => [String(t._id), t]));

  const passes = await QRPass.find({
    eventId: event._id,
    catId: { $in: types.map((t) => t._id) },
    status: "active",
    "communityAppSync.success": { $ne: true },
  }).populate("holderId");

  const targets = passes.filter((p) => {
    if (!p.holderId) return false; // orphaned pass, shouldn't happen — skip defensively
    if (onlyPhones && !onlyPhones.has(bare10(p.holderId.phone))) return false;
    return true;
  });

  console.log(
    `Found ${targets.length} pass(es) of type [${wantedTypes.join(", ")}] for "${eventCode}" ` +
    `not yet synced to the community app${onlyPhones ? ` (filtered to ${onlyPhones.size} phone(s))` : ""}.\n`,
  );

  if (targets.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let okCount = 0, failCount = 0;

  for (const p of targets) {
    const h = p.holderId;
    const type = typeMap.get(String(p.catId));
    const label = `${h.name} (${h.phone}) — ${type?.catCode || "?"}${h.subCategory ? " " + h.subCategory : ""} — qrId ${p.qrId}`;

    if (!APPLY) {
      const prevReason = p.communityAppSync?.reason || "(never attempted)";
      console.log(`  would resend: ${label}\n      last result: ${prevReason}`);
      continue;
    }

    try {
      const preacherPhone = await resolvePreacherPhone(h.preacherId);
      const result = await thirdPartyService.pushSevaSponsor({
        holder: h, event, qrPass: p, catCode: type?.catCode || "",
        categoryName: type?.name || "",
        subCategory: h.subCategory || "",
        preacherPhone,
        sevaSlotName: "",
        instruction: h.instruction || "",
      });
      p.communityAppSync = {
        attempted: !!result.attempted,
        success: !!result.success,
        skipped: !!result.skipped,
        reason: result.reason || null,
        responseBody: result.responseBody || null,
        attemptedAt: new Date(),
      };
      await p.save();
      if (result.success) okCount++; else failCount++;
      console.log(`  ${result.success ? "✅ OK" : "❌ still failing"}: ${label}${result.reason ? " — " + result.reason : ""}`);
    } catch (e) {
      failCount++;
      console.log(`  ❌ error: ${label} — ${e.message}`);
    }
  }

  console.log(APPLY ? `\nDone. ${okCount} synced, ${failCount} still failing.` : `\n(Report only — nothing was sent. Re-run with --apply.)`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
