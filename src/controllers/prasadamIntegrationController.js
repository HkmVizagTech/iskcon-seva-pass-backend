// ─── Prasadam Coupon Integration ────────────────────────────────────────────
// Called by the Vaikuntham app when a devotee taps "I will attend" and opts
// in for prasadam. Returns a coupon QR scoped to the prasadam counter.
//
// Endpoints:
//   POST /api/integration/prasadam/qr          — single holder (the live one)
//   POST /api/integration/prasadam/qr/bulk     — multiple holders (unused for
//                                                now; kept for later)
//
// Auth: same requireApiKey middleware as the rest of /api/integration/*

const mongoose = require("mongoose");
const Event = require("../models/Event");
const HolderType = require("../models/HolderType");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const qrService = require("../services/qrService");
const thirdPartyService = require("../services/thirdPartyService");
const { deriveHolderTypeLabel } = require("../utils/holderTypeLabel");
const { PRASADAM_COUPON } = require("../utils/entryPointTypes");

function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
}

// Resolve the event from whatever identifier the caller sends.
//
// FIX: this used to demand a 24-character Mongo ObjectId and reject anything
// else with a 400. The Vaikuntham app actually sends the SHORT EVENT CODE
// ("SKJ26") — the same code this system uses, which is exactly why no
// translation table is needed between the two systems. A strict _id check
// meant every real call from the app failed before it ever reached the QR
// logic.
//
// Same $or matching as integrationController.sevaPassIssue and
// generateVolunteerQRBulk, so every integration endpoint resolves an event
// identically: the event code is the normal case, and a caller holding the
// Mongo _id or a thirdPartyEventId still works.
async function resolveEvent(eventId) {
  if (!eventId) return null;
  const raw = String(eventId).trim();
  return Event.findOne({
    $or: [
      { eventCode: raw.toUpperCase() },
      { thirdPartyEventId: raw },
      { _id: /^[0-9a-fA-F]{24}$/.test(raw) ? raw : null },
    ],
  });
}

// Resolve (or create-on-first-use) the Prasadam pass type for an event.
// Looks for catCode "PR" or a name containing "prasad". If none exists,
// creates one automatically so the integration works without manual setup —
// this is the fallback path for events created before "Prasadam Coupon"
// became one of eventController.createEvent's 8 default pass types (see
// scripts/add-prasadam-holder-type.js for the one-time backfill onto events
// that already existed when this was added).
async function resolvePrasadamCategory(event) {
  let category = await HolderType.findOne({
    eventId: event._id,
    $or: [{ catCode: "PR" }, { name: /prasad/i }],
  }).populate("entryPoints");

  if (category) return category;

  // FIX: a coupon must be scoped to the Prasadam COUPON counter lane
  // (type "prasadam_coupon"), never to the general "Special Prasadam"
  // counter (type "prasadam") that Sponsor/Donor/Volunteer/Patron passes
  // scan at. Otherwise a coupon carries the same entry point as a sponsor
  // pass and a volunteer on either counter cannot tell the two apart.
  // Every new event already gets a "Prasadam Coupon" entry point from
  // createEvent, and scripts/add-prasadam-coupon-entry-point.js backfills
  // existing events (and already-issued coupon QR passes) onto it.
  let prasadamEP = await EntryPoint.findOne({ eventId: event._id, type: PRASADAM_COUPON });
  if (!prasadamEP) {
    prasadamEP = await EntryPoint.create({
      eventId: event._id,
      name: "Prasadam Coupon",
      stationLabel: "Prasadam Coupon Counter",
      type: PRASADAM_COUPON,
    });
  }

  category = await HolderType.create({
    eventId: event._id,
    name: "Prasadam Coupon",
    catCode: "PR",
    color: "#16A34A",
    icon: "🍛",
    entryPoints: [prasadamEP._id],
  });
  return category.populate("entryPoints");
}

// Core single-holder issuance logic — reused by both single and bulk endpoints.
async function issuePrasadamQR(event, category, { name, phone, email, quantity }) {
  const normPhone = normalisePhone(phone);
  if (!normPhone) {
    return { success: false, error: "Invalid or missing phone number", input: { name, phone } };
  }

  // Echo the number back in the caller's own format rather than the 91-prefixed
  // one. No other integration endpoint 91-prefixes what it returns, so doing it
  // here made prasadam the odd one out and confused the app team — they send
  // 9951141915 and got 919951141915 back.
  //
  // normPhone is still what gets stored, looked up and deduplicated on; only
  // the response echoes what the caller typed.
  const echoPhone = String(phone).trim();

  // Display fields for the app, named to match the seva-sponsor push so the
  // same pass-display code can render a prasadam coupon without a special
  // case. `holder` is read from the pass type itself, so renaming it in the
  // dashboard changes what the app shows. `category` carries the A/B/C tier
  // for sponsors and a prasadam coupon has no tier, so it is null here.
  const displayHolder = category?.name || "Prasadam Coupon";
  const displayCategory = null;

  // One coupon QR per phone per event (re-use if already issued, same as
  // the existing volunteer integration behaviour).
  const existingHolder = await Holder.findOne({ eventId: event._id, phone: normPhone, catId: category._id });
  if (existingHolder) {
    const existingPass = await QRPass.findOne({ holderId: existingHolder._id, status: "active" });
    if (existingPass) {
      // Nothing to build here: the pass already exists and qr_id is the whole
      // answer. This branch used to re-render the QR PNG on every repeat call
      // purely to put it in the response — pure waste now that the image is
      // not returned, so the payload/QR generation is gone entirely and a
      // repeat call is just two indexed lookups.
      return {
        success: true,
        reused: true,
        name: existingHolder.name,
        phone: echoPhone,
        // qr_id is the thing to convert into a QR/display — same as every
        // other integration flow (sevaPassIssue, generateVolunteerQRBulk).
        // The scanner already accepts a QR that encodes just this bare id
        // (see qrService.validateQR's qrId-only fallback), no signed token
        // needed on the caller's side.
        qr_id: existingPass.qrId,
        holder: displayHolder,
        category: displayCategory,
      };
    }
  }

  const holder = await Holder.create({
    eventId: event._id,
    catId: category._id,
    phone: normPhone,
    email: email || undefined,
    name: name || `Devotee ${normPhone.slice(-4)}`,
    holderType: deriveHolderTypeLabel(category),
    source: "third_party",
    customFields: quantity ? { prasadamQuantity: quantity } : undefined,
  });

  const qrId = await qrService.generateQRId(event.eventCode, category.catCode);
  const entryPoints = category.entryPoints || [];
  const payload = qrService.createPayload({ ...holder.toObject(), qrId }, event, category, entryPoints);
  // qrImage is still needed here even though it is not returned: payloadSigned
  // goes on the QRPass, and the community-app push below sends the image.
  const { image: qrImage, signedPayload } = await qrService.generateQRCode(payload);

  await QRPass.create({
    qrId,
    holderId: holder._id,
    eventId: event._id,
    catId: category._id,
    entryPoints: entryPoints.map((ep) => ep._id),
    payloadSigned: signedPayload,
    validFrom: event.dateStart,
    validUntil: event.dateEnd,
    deliveryMethod: "third_party",
    deliveryStatus: "sent",
    deliveredAt: new Date(),
  });

  // Push to community mobile app (non-fatal, fire-and-forget)
  const qrPassObj = { qrId };
  thirdPartyService.pushHolder({ holder, qrPass: qrPassObj, qrImageBase64: qrImage, event }).catch(() => {});

  return {
    success: true,
    reused: false,
    name: holder.name,
    phone: echoPhone,
    qr_id: qrId,
    holder: displayHolder,
    category: displayCategory,
  };
}

/**
 * POST /api/integration/prasadam/qr
 * Body: { event_id, phone, name?, email?, quantity? }
 * event_id is the event code shared with the Vaikuntham app, e.g. "SKJ26".
 * Only event_id and phone are required.
 */
exports.issueSingle = async (req, res) => {
  try {
    // req.body is undefined when the request body arrived in a format no
    // mounted parser understands. Only express.json and express.urlencoded
    // are mounted (see src/index.js) — there is no multer — so a caller
    // sending multipart/form-data lands here with nothing parsed.
    //
    // Without this guard the destructure below throws, which the catch turns
    // into an opaque 500 "Failed to generate Prasadam coupon QR" that tells
    // the caller nothing about what they actually did wrong.
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        status: false,
        message:
          "Request body could not be read. Send JSON with Content-Type: " +
          "application/json (application/x-www-form-urlencoded also works). " +
          "multipart/form-data is not supported.",
      });
    }

    const { event_id, name, phone, email, quantity } = req.body;

    if (!event_id) {
      return res.status(400).json({ status: false, message: "event_id is required" });
    }
    if (!phone) {
      return res.status(400).json({ status: false, message: "phone is required" });
    }

    const event = await resolveEvent(event_id);
    if (!event) {
      return res.status(404).json({ status: false, message: `Event not found for event_id: ${event_id}` });
    }

    const category = await resolvePrasadamCategory(event);
    const result = await issuePrasadamQR(event, category, { name, phone, email, quantity });

    if (!result.success) {
      return res.status(400).json({ status: false, message: result.error });
    }

    return res.status(200).json({
      status: true,
      message: result.reused ? "Prasadam coupon already exists — returning existing pass" : "Prasadam coupon QR generated successfully",
      // qr_id is the id the caller renders as a QR. The base64 qr_code image
      // this used to return as well was dropped on request: it made every
      // response several KB for something the app can draw itself from the
      // id, and the scanner only ever reads the id anyway. Putting it back
      // is a one-line change if a caller ever genuinely needs the PNG.
      qr_id: result.qr_id,
      name: result.name,
      phone: result.phone,
      // Named to match the seva-sponsor push so the app's existing pass-display
      // code can render this without a prasadam-specific branch. category is
      // null by design — that slot holds the A/B/C tier for sponsors.
      holder: result.holder,
      category: result.category,
    });
  } catch (error) {
    console.error("[Integration:Prasadam] issueSingle error:", error);
    return res.status(500).json({ status: false, message: "Failed to generate Prasadam coupon QR" });
  }
};

/**
 * POST /api/integration/prasadam/qr/bulk
 * Body: { event_id, holders: [{ name, phone, email?, quantity? }, ...] }
 * Max 500 holders per call.
 *
 * NOT currently used by the Vaikuntham app — it issues one coupon at a time
 * through issueSingle above. Kept working (and on the same event resolution)
 * in case a bulk import is ever needed.
 */
exports.issueBulk = async (req, res) => {
  try {
    // Same unparsed-body guard as issueSingle above.
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        status: false,
        message:
          "Request body could not be read. Send JSON with Content-Type: " +
          "application/json (application/x-www-form-urlencoded also works). " +
          "multipart/form-data is not supported.",
      });
    }

    const { event_id, holders } = req.body;

    if (!event_id) {
      return res.status(400).json({ status: false, message: "event_id is required" });
    }
    if (!Array.isArray(holders) || holders.length === 0) {
      return res.status(400).json({ status: false, message: "holders must be a non-empty array" });
    }
    if (holders.length > 500) {
      return res.status(400).json({ status: false, message: "Maximum 500 holders per bulk request" });
    }

    const event = await resolveEvent(event_id);
    if (!event) {
      return res.status(404).json({ status: false, message: `Event not found for event_id: ${event_id}` });
    }

    const category = await resolvePrasadamCategory(event);

    const results = [];
    for (const h of holders) {
      try {
        const r = await issuePrasadamQR(event, category, h);
        results.push(r);
      } catch (e) {
        results.push({ success: false, error: e.message, input: h });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;

    return res.status(200).json({
      status: true,
      message: `Processed ${results.length} holders — ${succeeded} succeeded, ${failed} failed`,
      total: results.length,
      succeeded,
      failed,
      results,
    });
  } catch (error) {
    console.error("[Integration:Prasadam] issueBulk error:", error);
    return res.status(500).json({ status: false, message: "Failed to process bulk Prasadam coupons" });
  }
};
