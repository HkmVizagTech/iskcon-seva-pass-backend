// ─── Prasadam Coupon lane backfill (idempotent, safe to run every boot) ─────
//
// The prasadam counter has two lanes:
//   - "prasadam"           → general counter (Sponsor/Donor/Volunteer/Patron)
//   - "prasadam_coupon"    → coupon counter (Prasadam Coupon "PR" passes)
//
// EventController.createEvent now creates BOTH entry points from the start, but
// every event created before this split has:
//   - no "prasadam_coupon" entry point, and
//   - its PR holder type + every already-issued coupon QR scoped to the single
//     general "prasadam" counter.
//
// Since scanning resolves every QR by qrId against the DB (the signed JWT
// payload is never used for entry-point checks), re-scoping the DB arrays fully
// migrates already-issued coupons to the coupon counter — no QR needs to be
// re-issued, re-encoded or re-downloaded by any devotee.
//
// This module:
//   1. creates the "prasadam_coupon" entry point for events that lack one,
//   2. re-scopes the PR holder type so NEW coupons issue under the coupon lane,
//   3. moves every existing PR QR pass onto the coupon lane and OFF the general
//      "prasadam" lane (so one coupon can never be served twice / at the wrong
//      counter).
//
// Idempotent: safe to run on every deploy. Target = current & upcoming events;
// pass includePast:true to also handle completed festivals.

const Event = require("../models/Event");
const EntryPoint = require("../models/EntryPoint");
const HolderType = require("../models/HolderType");
const QRPass = require("../models/QRPass");
const { PRASADAM_COUPON } = require("../utils/entryPointTypes");

const COUPON_EP = {
  name: "Prasadam Coupon",
  stationLabel: "Prasadam Coupon Counter",
  type: PRASADAM_COUPON,
};

async function runPrasadamCouponBackfill({ includePast = false, dryRun = false, log = console } = {}) {
  const filter = includePast ? {} : { dateEnd: { $gte: new Date() } };
  const events = await Event.find(filter)
    .select("_id name eventCode dateEnd")
    .sort({ dateStart: 1 })
    .lean();

  log.log(`[Backfill] Prasadam coupon lanes: checking ${events.length} ${includePast ? "" : "current/upcoming "}event(s)${dryRun ? " (dry-run — nothing will be written)" : ""}`);

  const summary = { eventsScanned: events.length, couponEpsCreated: 0, typesRescoped: 0, passesMoved: 0, reusedEps: 0, eventsSkipped: 0 };

  for (const event of events) {
    const label = `${event.eventCode || "?"} — ${event.name || "(unnamed)"}`;
    try {
      const prType = await HolderType.findOne({
        eventId: event._id,
        $or: [{ catCode: "PR" }, { name: /prasad/i }],
      })
        .select("_id entryPoints")
        .lean();

      // No PR type → no coupons on record; nothing to re-scope. The type is
      // created lazily by the integration (or with the event) already pointing
      // at the coupon lane, so this event needs no migration.
      if (!prType) {
        summary.eventsSkipped += 1;
        continue;
      }

      let couponEP = await EntryPoint.findOne({
        eventId: event._id,
        type: PRASADAM_COUPON,
      }).select("_id").lean();

      if (couponEP) {
        summary.reusedEps += 1;
      } else {
        summary.couponEpsCreated += 1;
        if (!dryRun) {
          couponEP = await EntryPoint.create({ ...COUPON_EP, eventId: event._id });
        } else {
          // Placeholder so the per-pass audit below still reports every pass
          // that would be moved onto the (not-yet-existing) coupon lane.
          couponEP = { _id: "new" };
        }
        log.log(`  + ${label} — ${dryRun ? "would create" : "created"} "${COUPON_EP.name}" entry point`);
      }

      const couponEpIdString = couponEP._id.toString();
      const currentTypeEps = (prType.entryPoints || []).map((id) => id.toString());
      if (!(currentTypeEps.length === 1 && currentTypeEps[0] === couponEpIdString)) {
        summary.typesRescoped += 1;
        log.log(`  ↪ ${label} — ${dryRun ? "would re-scope" : "re-scoped"} PR holder type to coupon lane`);
        if (!dryRun) {
          await HolderType.updateOne(
            { _id: prType._id },
            { $set: { entryPoints: [couponEP._id] } },
          );
        }
      }

      // Remove the general prasadam counter from every existing coupon pass and
      // put the coupon lane in. Two separate updates keep Mongo 4.x happy (a
      // $pull + $addToSet on the SAME array field conflict in one write).
      const generalPrasadamIds = (
        await EntryPoint.find({ eventId: event._id, type: "prasadam" }).select("_id").lean()
      ).map((ep) => ep._id);

      if (dryRun) {
        const count = await QRPass.countDocuments({
          catId: prType._id,
          $or: [
            { entryPoints: { $in: generalPrasadamIds } },
            { entryPoints: { $ne: couponEP._id } },
          ],
        });
        summary.passesMoved += count;
        if (count > 0) {
          log.log(`  ⇢ ${label} — ${count} existing coupon pass(es) would be moved to coupon lane`);
        }
        continue;
      }

      if (generalPrasadamIds.length > 0) {
        const pulled = await QRPass.updateMany(
          { catId: prType._id, entryPoints: { $in: generalPrasadamIds } },
          { $pull: { entryPoints: { $in: generalPrasadamIds } } },
        );
        summary.passesMoved += pulled.modifiedCount || 0;
      }
      const added = await QRPass.updateMany(
        { catId: prType._id, entryPoints: { $ne: couponEP._id } },
        { $addToSet: { entryPoints: couponEP._id } },
      );
      summary.passesMoved += added.modifiedCount || 0;
    } catch (err) {
      log.error(`  ❌ ${label} — ${err.message}`);
    }
  }

  log.log(
    `[Backfill] Done — ${summary.couponEpsCreated} coupon EP(s) ${dryRun ? "to be " : ""}created, ` +
      `${summary.reusedEps} reused, ${summary.typesRescoped} PR type(s) to be re-scoped, ` +
      `${summary.passesMoved} existing coupon pass(es) ${dryRun ? "to be moved" : "moved"} to coupon lane, ` +
      `${summary.eventsSkipped} event(s) with no PR type skipped`,
  );
  return summary;
}

module.exports = { runPrasadamCouponBackfill };