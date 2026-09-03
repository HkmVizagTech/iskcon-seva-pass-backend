// ─── Integration controller ────────────────────────────────────────────────
// Handles the inbound endpoint from the third-party system:
//   POST /api/integration/generate-volunteer-qr
//
// When someone marks interest on their platform, they call this endpoint.
// We create/find the holder in our system and return the QR code.

const Event = require("../models/Event");
const HolderType = require("../models/HolderType");
const EntryPoint = require("../models/EntryPoint");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const qrService = require("../services/qrService");
const thirdPartyService = require("../services/thirdPartyService");
const { deriveHolderTypeLabel } = require("../utils/holderTypeLabel");
// Same resolver the CSV importer uses: short code first, then name.
const { resolvePreacherFromString } = require("./preacherController");

// Helper: escape regex special chars for safe name matching
function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper: normalise phone
function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
}

// Helper: the UTC instant of today's midnight in IST (Asia/Kolkata, UTC+5:30).
// Computed explicitly rather than via the server's local timezone, so the
// "one fresh pass per day" boundary is the same whether the process runs in
// IST, UTC, or anything else.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}
// Resolve the merged pass type a QR is issued under, in priority order:
//   1. requested (catCode or exact name) — from the Seva Pass app's pass-type picker
//   2. an "Invitee" type (catCode INV / name matching "invitee")
//   3. legacy defaults: General Public (GN) → name "general" → name "volunteer"
async function resolveCategory(eventId, requested) {
  const attempts = [];
  if (requested) {
    attempts.push({ catCode: requested.toUpperCase() });
    attempts.push({ name: new RegExp(`^${escapeRegExp(requested)}$`, "i") });
    // Partial / fuzzy match — "VIP" matches "VIP Guest", "Don" matches "Donor", etc.
    attempts.push({ catCode: new RegExp(requested.toUpperCase(), "i") });
    attempts.push({ name: new RegExp(requested, "i") });
  }
  attempts.push({ catCode: "INV" });
  attempts.push({ name: /^invitee$/i });
  attempts.push({ catCode: "GN" });
  attempts.push({ name: /general/i });
  attempts.push({ name: /volunteer/i });

  for (const q of attempts) {
    const holderType = await HolderType.findOne({ eventId, ...q }).populate("entryPoints");
    if (holderType) return holderType;
  }
  return null;
}

// Resolve the VOLUNTEER pass type for /generate-volunteer-qr.
//
// Deliberately separate from resolveCategory(): that helper's fallback chain
// starts at Invitee (INV), so calling it with no requested type silently
// issued every volunteer an INV pass — wrong catCode in the QR ID, holderType
// "invitee" on the Holder, and a bogus seva-sponsor push to the community app.
// This resolver only ever lands on a volunteer type, and returns null (→ a
// clear 400) rather than guessing when the event has none configured.
async function resolveVolunteerCategory(eventId, requested) {
  const attempts = [];
  if (requested) {
    attempts.push({ catCode: String(requested).toUpperCase() });
    attempts.push({ name: new RegExp(`^${escapeRegExp(requested)}$`, "i") });
  }
  attempts.push({ catCode: "VL" });
  attempts.push({ name: /^volunteer/i });
  attempts.push({ name: /volunteer/i });

  for (const q of attempts) {
    const holderType = await HolderType.findOne({ eventId, ...q }).populate("entryPoints");
    if (holderType) return holderType;
  }
  return null;
}

/**
 * POST /api/integration/generate-volunteer-qr
 *
 * Bulk QR generation — called by the mobile app when a devotee selects
 * volunteers and taps "Generate QR".
 *
 * Request body:
 *   { event_id, holders: [{ user_phone_number, name? }, ...], category? }
 *
 * `category` is optional (catCode or exact type name). Omitted — the normal
 * case — passes are issued under the event's Volunteer type (catCode "VL").
 *
 * Safe to call any number of times a day. Per holder the outcome is one of:
 *   reused:   true  — existing pass not yet scanned, or already scanned TODAY,
 *                     returned as-is (same QR for repeat taps within a day)
 *   reissued: true  — previous pass was last scanned on an earlier day, so it
 *                     was expired and a fresh QR minted (the day-2 path)
 *   both false      — brand new holder, first pass
 *
 * Net effect: at most one new volunteer QR per person per IST calendar day,
 * and only for volunteers who actually scanned on a previous day.
 *
 * Max 200 holders per call.
 */
exports.generateVolunteerQRBulk = async (req, res) => {
  try {
    const { event_id, holders } = req.body;

    if (!event_id) {
      return res.status(400).json({ status: false, message: "event_id is required" });
    }
    if (!Array.isArray(holders) || holders.length === 0) {
      return res.status(400).json({ status: false, message: "holders must be a non-empty array" });
    }
    if (holders.length > 200) {
      return res.status(400).json({ status: false, message: "Maximum 200 holders per bulk request" });
    }

    const eventIdStr = String(event_id).toUpperCase();
    const event = await Event.findOne({
      $or: [
        { eventCode: eventIdStr },
        { thirdPartyEventId: event_id },
        { _id: String(event_id).match(/^[0-9a-fA-F]{24}$/) ? event_id : null },
      ],
    });
    if (!event) {
      return res.status(404).json({ status: false, message: `Event not found for event_id: ${event_id}` });
    }

    // This endpoint issues VOLUNTEER passes — resolve the volunteer pass type,
    // never the generic fallback chain (which starts at Invitee).
    // `category` in the body is optional and lets the app override the type.
    const category = await resolveVolunteerCategory(event._id, req.body.category);
    if (!category) {
      return res.status(400).json({
        status: false,
        message:
          `No volunteer pass type configured for event ${event.eventCode}. ` +
          `Add a pass type with catCode "VL" (or a type named "Volunteer") to this event.`,
      });
    }

    const entryPoints = category.entryPoints || [];

    const results = [];
    for (const h of holders) {
      try {
        const phoneRaw = h.user_phone_number || h.phone || "";
        const phone = normalisePhone(String(phoneRaw));
        if (!phone) {
          results.push({ success: false, error: "Invalid phone number", input: h });
          continue;
        }

        // ── Reuse vs reissue ──────────────────────────────────────────────
        // A volunteer's pass dies at an entry point the moment it is scanned
        // there: validateQR/redeemQR reject any further scan whose
        // redemptionHistory already holds a "granted" entry for that epId,
        // and that check has NO date component. So yesterday's pass is dead
        // weight — the app would show a QR the gate refuses.
        //
        // Rotate on a DAY boundary, not on "has ever been scanned":
        //   never scanned      → reuse (nothing consumed yet)
        //   scanned today      → reuse (today's pass is still the live one —
        //                        reissuing here would hand back a clean
        //                        history and let the volunteer re-enter a
        //                        gate they already used this morning)
        //   scanned, not today → expire it, mint a fresh QR for today
        //
        // Scoped to this endpoint, so only VOLUNTEER passes ever rotate.
        // Sponsor/donor/invitee passes are issued elsewhere and untouched.
        let reissued = false;
        // Scoped to THIS pass type (and its "no category" slot) so a devotee
        // who already holds a sponsor or donor pass on the same number still
        // gets their volunteer pass. Volunteer passes carry no category.
        const existingHolder = await Holder.findOne({
          eventId: event._id,
          phone,
          catId: category._id,
          subCategory: { $in: [null, ""] },
        });
        if (existingHolder) {
          const existingPass = await QRPass.findOne({ holderId: existingHolder._id, status: "active" });
          if (existingPass) {
            const granted = (existingPass.redemptionHistory || []).filter(
              (rh) => rh.result === "granted" && rh.scannedAt,
            );
            const dayStartMs = istDayStart().getTime();
            const usedToday = granted.some((rh) => new Date(rh.scannedAt).getTime() >= dayStartMs);

            if (granted.length === 0 || usedToday) {
              results.push({
                success: true, reused: true,
                name: existingHolder.name, phone,
                qr_id: existingPass.qrId,
              });
              continue;
            }
            // "expired" (not "used") so the scanner shows "Pass has expired"
            // if someone presents yesterday's screenshot at the gate.
            existingPass.status = "expired";
            await existingPass.save();
            reissued = true;
            console.log(
              `[Integration] volunteer QR reissue for ${phone}: retired ${existingPass.qrId} ` +
              `(${granted.length} scan(s), last ${granted[granted.length - 1].scannedAt.toISOString()})`,
            );
          }
        }

        const holderName = h.name || `Devotee ${phone.slice(-4)}`;
        let holder = existingHolder;
        if (!holder) {
          try {
            holder = await Holder.create({
              eventId: event._id, catId: category._id, phone,
              name: holderName, holderType: deriveHolderTypeLabel(category),
              source: "third_party", issuedBy: null,
            });
          } catch (e) {
            if (e.code === 11000) {
              holder = await Holder.findOne({
                eventId: event._id, phone,
                catId: category._id, subCategory: { $in: [null, ""] },
              });
              if (!holder) { results.push({ success: false, error: e.message, input: h }); continue; }
            } else { throw e; }
          }
        }
        // NOTE: the old catId-realignment branch is gone — existingHolder is
        // now looked up by catId, so it can only ever be this pass type.

        const qrId = await qrService.generateQRId(event.eventCode, category.catCode);
        const payload = qrService.createPayload({ ...holder.toObject(), qrId }, event, category, entryPoints);
        const { signedPayload } = await qrService.generateQRCode(payload);

        await QRPass.create({
          qrId, holderId: holder._id, eventId: event._id, catId: category._id,
          entryPoints: entryPoints.map((ep) => ep._id),
          payloadSigned: signedPayload,
          validFrom: event.dateStart, validUntil: event.dateEnd,
          deliveryMethod: "third_party", deliveryStatus: "sent", deliveredAt: new Date(),
        });

        // Push to community mobile app (non-fatal, fire-and-forget)
        const qrPassObj = { qrId };
        thirdPartyService.pushHolder({ holder, qrPass: qrPassObj, qrImageBase64: null, event }).catch(() => {});
        // Only fires if the caller explicitly overrode `category` to a
        // sponsor/donor/invitee type. A volunteer pass (VL) must NOT be
        // pushed as a seva-sponsor — it goes out via store-qr-code below.
        const catCode = (category.catCode || "").toUpperCase();
        if (["SP", "DN", "INV"].includes(catCode)) {
          thirdPartyService.pushSevaSponsor({ holder, event, qrPass: qrPassObj, catCode, categoryName: category.name }).catch(() => {});
        }

        results.push({
          success: true, reused: false, reissued,
          name: holder.name, phone,
          qr_id: qrId,
        });
      } catch (e) {
        results.push({ success: false, error: e.message, input: h });
      }
    }

    // Batch push all QR strings to community app in one call
    const qrEntries = results
      .filter((r) => r.success && r.qr_id && r.phone)
      .map((r) => ({ phone: r.phone, qrId: r.qr_id }));
    if (qrEntries.length > 0) {
      thirdPartyService.pushStoreQrCodeBulk(qrEntries, event).catch((e) => {
        console.error("[Integration] bulk store-qr-code push failed:", e.message);
      });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;

    return res.status(200).json({
      status: true,
      message: `Processed ${results.length} holders — ${succeeded} succeeded, ${failed} failed`,
      // Echo the pass type the QRs were issued under so the caller can verify
      // it is the volunteer category and not a silent fallback.
      category: { code: category.catCode, name: category.name },
      total: results.length,
      succeeded,
      failed,
      results,
    });
  } catch (error) {
    console.error("[Integration] generateVolunteerQRBulk error:", error);
    return res.status(500).json({ status: false, message: "Failed to process bulk QR generation" });
  }
};

/**
 * GET /api/integration/status
 * Health check — lets the third party verify our API is reachable.
 */
exports.status = (req, res) => {
  res.json({
    status: true,
    message: "ISKCON Seva Pass API is operational",
    timestamp: new Date().toISOString(),
  });
};

/**
 * GET /api/integration/qr/:qrId
 *
 * Returns live QR pass status and redemption history for integration partners.
 * Protected by requireApiKey (x-api-key header) — no JWT needed.
 * Returns a flat response so the Seva Pass app can enrich pass lists with
 * scanned status without needing JWT authentication.
 */
exports.getQRDetails = async (req, res) => {
  try {
    const { qrId } = req.params;
    if (!qrId) {
      return res.status(400).json({ status: false, message: "qrId is required" });
    }

    const qrPass = await QRPass.findOne({ qrId })
      .populate("holderId", "name phone email")
      .populate("eventId", "name eventCode")
      .populate("catId", "name catCode")
      .populate("entryPoints", "name stationLabel")
      .lean();

    if (!qrPass) {
      return res.status(404).json({ status: false, message: "QR pass not found" });
    }

    return res.json({
      status: qrPass.status || "active",
      redemptionHistory: qrPass.redemptionHistory || [],
      qrId: qrPass.qrId,
      holder: qrPass.holderId || null,
      event: qrPass.eventId || null,
      category: qrPass.catId || null,
      entryPoints: qrPass.entryPoints || [],
      validFrom: qrPass.validFrom || null,
      validUntil: qrPass.validUntil || null,
    });
  } catch (error) {
    console.error("[Integration] getQRDetails error:", error);
    return res.status(500).json({ status: false, message: "Failed to fetch QR details" });
  }
};

/**
 * GET /api/integration/events
 *
 * Returns all events. Used by the Seva Pass app to sync events so the admin
 * doesn't have to re-create them manually.
 *
 * Query params:
 *   ?status=upcoming|active|completed  — filter by date-derived status
 *   ?search=RATHYATRA                  — search by name or eventCode
 */
exports.getAllEvents = async (req, res) => {
  try {
    const { status, search } = req.query;
    const query = {};
    const now = new Date();

    if (status === "upcoming") {
      query.dateStart = { $gt: now };
    } else if (status === "active") {
      query.dateStart = { $lte: now };
      query.dateEnd = { $gte: now };
    } else if (status === "completed") {
      query.dateEnd = { $lt: now };
    }

    if (search) {
      const re = new RegExp(search, "i");
      query.$or = [{ name: re }, { eventCode: re }];
    }

    const events = await Event.find(query)
      .select("name eventCode dateStart dateEnd venue description")
      .sort({ dateStart: -1 });

    res.json(events);
  } catch (error) {
    console.error("[Integration] getAllEvents error:", error);
    res.status(500).json({ status: false, message: "Failed to fetch events" });
  }
};

/**
 * GET /api/integration/events/:eventCode/categories
 *
 * Returns the categories (pass types) configured for an event, with their
 * entry points. The Seva Pass app uses this to let the devotee pick the pass
 * type after selecting an event.
 */
exports.getEventCategories = async (req, res) => {
  try {
    const { eventCode } = req.params;
    const event = await Event.findOne({ eventCode: eventCode.toUpperCase() }).select("_id devoteeAppCategories");
    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    // If the event has devoteeAppCategories configured, only return those.
    // If empty/missing, return ALL active categories (backward compatible).
    // Pass ?all=true to bypass filter (used by admin ConfigureModal).
    const bypassFilter = req.query.all === 'true' || req.query.all === '1';
    const allowedCodes = (event.devoteeAppCategories || []).map((d) => d.catCode);
    const filter = { eventId: event._id, isActive: true };
    if (!bypassFilter && allowedCodes.length > 0) {
      filter.catCode = { $in: allowedCodes };
    }

    const categories = await HolderType.find(filter)
      .populate("entryPoints", "name stationLabel type")
      .select("name catCode entryPoints")
      .sort({ catCode: 1 });

    // Attach limit info from devoteeAppCategories if configured.
    const limitMap = {};
    for (const d of event.devoteeAppCategories || []) {
      limitMap[d.catCode] = { limit: d.limit, name: d.name };
    }

    // Count how many third-party passes exist per category for this event.
    const Holder = require("../models/Holder");
    const passCounts = await Holder.aggregate([
      { $match: { eventId: event._id, source: "third_party" } },
      {
        $lookup: {
          from: "categories",
          localField: "catId",
          foreignField: "_id",
          as: "cat",
        },
      },
      { $unwind: { path: "$cat", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$cat.catCode",
          count: { $sum: 1 },
        },
      },
    ]);

    const countMap = {};
    for (const row of passCounts) {
      if (row._id) countMap[row._id] = row.count;
    }

    const result = categories.map((c) => {
      const obj = {
        _id: c._id,
        name: c.name,
        catCode: c.catCode,
        entryPoints: c.entryPoints,
      };
      if (allowedCodes.length > 0 && limitMap[c.catCode]) {
        const info = limitMap[c.catCode];
        const used = countMap[c.catCode] || 0;
        obj.limit = info.limit;
        obj.used = used;
        obj.remaining = info.limit != null ? Math.max(0, info.limit - used) : null;
      }
      return obj;
    });

    res.json(result);
  } catch (error) {
    console.error("[Integration] getEventCategories error:", error);
    res.status(500).json({ status: false, message: "Failed to fetch categories" });
  }
};

/**
 * PATCH /api/integration/events/:eventCode/devotee-categories
 *
 * Update the devoteeAppCategories array on an event.
 * The Seva Pass app admin uses this to configure which pass types
 * devotees can issue from the app, and with what limits.
 *
 * Body: { categories: [{ catCode, name, limit }] }
 *   - catCode (required): the category code (e.g. "INV", "GN")
 *   - name (optional): display label
 *   - limit (optional): max passes for this category (null = unlimited)
 * Pass null to clear all restrictions (all categories shown).
 */
exports.updateDevoteeCategories = async (req, res) => {
  try {
    const { eventCode } = req.params;
    const { categories } = req.body || {};

    const event = await Event.findOne({ eventCode: eventCode.toUpperCase() }).select("_id");
    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    // Validate categories array
    if (categories !== null && !Array.isArray(categories)) {
      return res.status(400).json({ status: false, message: "categories must be an array or null" });
    }

    const update = {};
    if (categories === null) {
      // Clear the field — all categories will be shown
      update.$unset = { devoteeAppCategories: 1 };
    } else {
      // Validate each entry
      const cleaned = [];
      for (const c of categories) {
        if (!c.catCode) continue;
        cleaned.push({
          catCode: String(c.catCode).toUpperCase(),
          name: c.name || "",
          limit: c.limit != null ? Number(c.limit) : null,
        });
      }
      update.$set = { devoteeAppCategories: cleaned };
    }

    await Event.findByIdAndUpdate(event._id, update);
    res.json({ status: true, message: "Devotee categories updated" });
  } catch (error) {
    console.error("[Integration] updateDevoteeCategories error:", error);
    res.status(500).json({ status: false, message: "Failed to update devotee categories" });
  }
};

/**
 * GET /api/integration/events/:eventCode/venues
 */
exports.getEventVenues = async (req, res) => {
  try {
    const { eventCode } = req.params;
    const event = await Event.findOne({ eventCode: eventCode.toUpperCase() }).select("venue");

    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    const venues = (event.venue || []).map((v) => ({
      name: v.name,
      address: v.address,
      coordinates: v.coordinates,
    }));

    res.json(venues);
  } catch (error) {
    console.error("[Integration] getEventVenues error:", error);
    res.status(500).json({ status: false, message: "Failed to fetch venues" });
  }
};

/**
 * GET /api/integration/events/:eventCode/entry-points?venue=<venueName>
 *
 * Returns entry points for an event, optionally filtered by venue.
 * Venue filtering works by matching entryPoint.location.building against
 * the venue name (case-insensitive regex).
 *
 * The Seva Pass app uses this to know which entry points a pass grants
 * access to at a given venue.
 */
exports.getEventEntryPoints = async (req, res) => {
  try {
    const { eventCode } = req.params;
    const { venue } = req.query;

    const event = await Event.findOne({ eventCode: eventCode.toUpperCase() }).select("_id");
    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    const query = { eventId: event._id, isActive: true };

    if (venue) {
      query["location.building"] = new RegExp(venue, "i");
    }

    const entryPoints = await EntryPoint.find(query)
      .select("name stationLabel type location description")
      .sort({ type: 1, name: 1 });

    res.json(entryPoints);
  } catch (error) {
    console.error("[Integration] getEventEntryPoints error:", error);
    res.status(500).json({ status: false, message: "Failed to fetch entry points" });
  }
};

// ─── Seva Pass app — dedicated single-holder QR endpoint ───────────────────
// POST /api/integration/seva-pass/issue
//
// Dedicated for the Seva Pass app (devotee-facing). Accepts flat format
// and issues a single QR pass. Does NOT interfere with
// /generate-volunteer-qr used by other consumers.
//
// Request body:
//   { event_id, user_phone_number, user_email?, name?, venue?, category?,
//     preacher?, preacherId? }
// Response:
//   { status: true, message, qr_code: <base64 PNG data URL>, qr_id }

exports.sevaPassIssue = async (req, res) => {
  try {
    const {
      event_id, user_phone_number, user_email, venue,
      category: categoryParam, name: holderName, preacher, preacherId,
    } = req.body;

    if (!event_id) {
      return res.status(400).json({ status: false, message: "event_id is required" });
    }
    if (!user_phone_number) {
      return res.status(400).json({ status: false, message: "user_phone_number is required" });
    }

    const phone = normalisePhone(String(user_phone_number));
    if (!phone) {
      return res.status(400).json({ status: false, message: "Invalid phone number" });
    }

    const eventIdStr = String(event_id).toUpperCase();
    const event = await Event.findOne({
      $or: [
        { eventCode: eventIdStr },
        { thirdPartyEventId: event_id },
        { _id: String(event_id).match(/^[0-9a-fA-F]{24}$/) ? event_id : null },
      ],
    });
    if (!event) {
      return res.status(404).json({ status: false, message: `Event not found for event_id: ${event_id}` });
    }

    // ── Resolve category: prefer the one sent by the Seva Pass app ─────────
    // Resolved BEFORE the duplicate check, because "already has a pass" is now
    // scoped to a pass type, not to the number alone.
    const category = await resolveCategory(event._id, categoryParam);
    if (!category) {
      return res.status(400).json({
        status: false,
        message: "No suitable category found for this event. Please configure a General Public or Volunteer category.",
      });
    }

    // ── Check if holder already has an active pass OF THIS TYPE ─────────────
    // Scoped to catId + "no category", matching the
    // uniq_event_phone_type_category index on Holder. A number that already
    // holds e.g. a Sponsor category A pass still gets its own pass here — only
    // a second pass of the SAME type and category returns the existing one.
    const existingHolder = await Holder.findOne({
      eventId: event._id,
      phone,
      catId: category._id,
      subCategory: { $in: [null, ""] },
    });
    if (existingHolder) {
      const existingPass = await QRPass.findOne({ holderId: existingHolder._id, status: "active" });
      if (existingPass) {
        const existingCategory = await HolderType.findById(existingPass.catId).populate("entryPoints").lean();
        const entryPoints = existingCategory?.entryPoints || [];
        const payload = qrService.createPayload(
          { ...existingHolder.toObject(), qrId: existingPass.qrId },
          event, existingCategory, entryPoints,
        );
        const { image: qrImage } = await qrService.generateQRCode(payload);
        return res.json({
          status: true,
          message: "QR code already exists — returning existing pass",
          qr_code: qrImage,
          qr_id: existingPass.qrId,
        });
      }
    }

    const entryPoints = category.entryPoints || [];

    // ── Create or update holder ─────────────────────────────────────────────
    let holderTypeId = null;
    let holderTypeLabel = "self";
    try {
      const typeName = (process.env.INTEGRATION_HOLDER_TYPE || "invitee").trim();
      let holderType = await HolderType.findOne({
        eventId: event._id, isActive: true,
        $or: [{ code: typeName.toUpperCase() }, { name: new RegExp("^" + typeName + "$", "i") }],
      });
      if (!holderType) {
        holderType = await HolderType.findOne({ eventId: event._id, isDefault: true, isActive: true });
      }
      if (holderType) { holderTypeId = holderType._id; holderTypeLabel = holderType.name; }
    } catch (e) {
      console.warn("[SevaPass] holder type lookup failed:", e.message);
    }

    const resolvedName = (holderName && holderName.trim())
      ? holderName.trim()
      : (user_email ? user_email.split("@")[0] : `Devotee ${phone.slice(-4)}`);

    // The app sends `preacher` as the DEVOTEE SHORT CODE (e.g. "NTHD"), and
    // usually no id. Resolve it to the actual preacher User so the pass is
    // linked by reference and not only by a matching string — string matching
    // breaks the moment someone is renamed.
    let resolvedPreacherId = preacherId || null;
    let resolvedPreacherLabel = preacher ? String(preacher).trim() : "";
    if (!resolvedPreacherId && resolvedPreacherLabel) {
      try {
        const hit = await resolvePreacherFromString(resolvedPreacherLabel);
        if (hit?.preacherId) {
          resolvedPreacherId = hit.preacherId;
          // Keep the code the app sent in `preacher` — it is what the CSV
          // column holds too, so both sources look the same in reports.
        } else {
          console.warn(
            `[SevaPass] preacher code "${resolvedPreacherLabel}" did not match ` +
            `any preacher — storing it as free text only`,
          );
        }
      } catch (e) {
        console.warn("[SevaPass] preacher resolution failed:", e.message);
      }
    }

    const holderData = {
      eventId: event._id, catId: category._id, phone,
      email: user_email || undefined,
      name: resolvedName,
      holderType: holderTypeLabel, holderTypeId,
      source: "third_party",
      issuedBy: resolvedPreacherId || null,
      // FIX: this used to write `thirdPartyAttribution`, which is NOT a field
      // on the Holder schema — Mongoose strict mode silently dropped it, so
      // every preacher attribution the Seva Pass app sent was thrown away and
      // the pass never showed up in that preacher's own list.
      //
      // Written to the two fields that exist and that
      // preacherController.getMyHolders actually queries.
      ...(resolvedPreacherId ? { preacherId: resolvedPreacherId } : {}),
      ...(resolvedPreacherLabel ? { preacher: resolvedPreacherLabel } : {}),
    };

    let holder = existingHolder || null;
    try {
      // existingHolder here means "record exists for this number+type but its
      // pass is revoked/expired" — re-use it, since a second insert for the
      // same number+type+category is rejected by the unique index.
      if (holder) {
        holder.set(holderData);
        await holder.save();
      } else {
        holder = await Holder.create(holderData);
      }
    } catch (e) {
      if (e.code === 11000) {
        holder = await Holder.findOne({
          eventId: event._id, phone,
          catId: category._id, subCategory: { $in: [null, ""] },
        });
        if (!holder) throw e;
        if (resolvedName && holder.name !== resolvedName) {
          holder.name = resolvedName;
          // Same fix as above — real fields, not the phantom one.
          if (resolvedPreacherLabel) holder.preacher = resolvedPreacherLabel;
          if (resolvedPreacherId) {
            holder.preacherId = resolvedPreacherId;
            holder.issuedBy = resolvedPreacherId;
          }
          await holder.save();
        }
      } else { throw e; }
    }

    // ── Generate QR pass ────────────────────────────────────────────────────
    const qrId = await qrService.generateQRId(event.eventCode, category.catCode);
    const payload = qrService.createPayload(
      { ...holder.toObject(), qrId }, event, category, entryPoints,
    );
    const { image: qrImage, signedPayload } = await qrService.generateQRCode(payload);

    const allowedVenues = (() => {
      if (!venue || typeof venue !== "string" || !venue.trim()) return [];
      const eventNames = (Array.isArray(event.venue) ? event.venue : [])
        .map((v) => String(v?.name || "").trim()).filter(Boolean);
      const match = eventNames.find((n) => n.toLowerCase() === String(venue).trim().toLowerCase());
      return match ? [match] : [];
    })();

    await QRPass.create({
      qrId, holderId: holder._id, eventId: event._id, catId: category._id,
      entryPoints: entryPoints.map((ep) => ep._id),
      payloadSigned: signedPayload,
      validFrom: event.dateStart, validUntil: event.dateEnd,
      deliveryMethod: "third_party", deliveryStatus: "sent", deliveredAt: new Date(),
      allowedVenues,
    });

    // Push to community mobile app (non-fatal, fire-and-forget)
    const qrPassObj = { qrId };
    thirdPartyService.pushHolder({ holder, qrPass: qrPassObj, qrImageBase64: qrImage, event }).catch(() => {});
    const catCode = (category.catCode || "").toUpperCase();
    if (["SP", "DN", "INV"].includes(catCode)) {
      thirdPartyService.pushSevaSponsor({ holder, event, qrPass: qrPassObj, catCode, categoryName: category.name }).catch(() => {});
    }

    const venueLabel = venue ? ` at ${venue}` : "";
    console.log(`[SevaPass] QR generated for ${phone} (${resolvedName}) at event ${event.eventCode} [${category.catCode}]${venueLabel}`);

    return res.status(200).json({
      status: true, message: "QR code generated successfully",
      qr_code: qrImage, qr_id: qrId,
    });
  } catch (error) {
    console.error("[SevaPass] sevaPassIssue error:", error);
    return res.status(500).json({ status: false, message: "Failed to generate QR code" });
  }
};

// ─── Preacher management via integration API ─────────────────────────────────
const User = require("../models/User");

/**
 * POST /api/integration/preachers
 * Create a preacher on the main system.
 */
exports.createPreacher = async (req, res) => {
  try {
    const { name, email, phone, password, shortCode } = req.body;

    if (!name || !password || !shortCode) {
      return res.status(400).json({ status: false, message: "name, password, and shortCode are required" });
    }
    if (!email && !phone) {
      return res.status(400).json({ status: false, message: "email or phone is required" });
    }

    const cleanCode = String(shortCode).trim().toUpperCase();
    if (cleanCode.length < 2 || cleanCode.length > 10 || !/^[A-Z0-9]+$/.test(cleanCode)) {
      return res.status(400).json({ status: false, message: "shortCode must be 2-10 alphanumeric characters" });
    }

    // Check uniqueness
    const existingCode = await User.findOne({ shortCode: cleanCode });
    if (existingCode) {
      return res.status(409).json({ status: false, message: `Short code "${cleanCode}" already exists` });
    }
    if (email) {
      const existingEmail = await User.findOne({ email: String(email).trim().toLowerCase() });
      if (existingEmail) {
        return res.status(409).json({ status: false, message: "Email already exists" });
      }
    }

    const preacher = await User.create({
      name: name.trim(),
      email: email ? String(email).trim().toLowerCase() : undefined,
      phone: phone ? String(phone).trim() : undefined,
      password,
      shortCode: cleanCode,
      role: "preacher",
      isActive: true,
    });

    return res.status(201).json({
      status: true,
      message: "Preacher created",
      preacher: { id: preacher._id, name: preacher.name, shortCode: preacher.shortCode },
    });
  } catch (error) {
    console.error("[Integration] createPreacher error:", error);
    return res.status(500).json({ status: false, message: "Failed to create preacher" });
  }
};

/**
 * GET /api/integration/preachers
 * List all active preachers.
 */
exports.listPreachers = async (req, res) => {
  try {
    const preachers = await User.find({ role: "preacher" })
      .select("name email phone shortCode isActive createdAt")
      .sort({ createdAt: -1 })
      .lean();
    return res.json(preachers);
  } catch (error) {
    console.error("[Integration] listPreachers error:", error);
    return res.status(500).json({ status: false, message: "Failed to list preachers" });
  }
};

/**
 * DELETE /api/integration/preachers/:id
 * Soft-delete a preacher (set isActive: false).
 */
exports.deletePreacher = async (req, res) => {
  try {
    const { id } = req.params;
    const filter = /^[0-9a-fA-F]{24}$/.test(id)
      ? { _id: id }
      : { shortCode: String(id).toUpperCase() };

    const preacher = await User.findOneAndUpdate(
      { ...filter, role: "preacher" },
      { isActive: false },
      { new: true }
    );
    if (!preacher) {
      return res.status(404).json({ status: false, message: "Preacher not found" });
    }
    return res.json({ status: true, message: "Preacher deactivated" });
  } catch (error) {
    console.error("[Integration] deletePreacher error:", error);
    return res.status(500).json({ status: false, message: "Failed to delete preacher" });
  }
};
