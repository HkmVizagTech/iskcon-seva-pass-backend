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
const whatsappService = require("../services/whatsappService");
const { resolvePreacherFromString } = require("./preacherController");
const { deriveHolderTypeLabel } = require("../utils/holderTypeLabel");

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

// Send the QR to the holder's phone via the main system's Flaxxa integration.
// Non-fatal - WhatsApp failure must never block QR issuance.
async function trySendWhatsApp(phone, qrImage, holder, event, entryPoints) {
  try {
    await whatsappService.sendQRMessage(phone, qrImage, holder.name, event.name, {
      entryPoints: (entryPoints || []).map((ep) => ({
        name: ep.name || ep.stationLabel,
        stationLabel: ep.stationLabel || ep.name,
      })),
      validFrom: event.dateStart,
      venue: (event.venue && event.venue[0] && event.venue[0].name) || "ISKCON Temple, Visakhapatnam",
      isSponsor: false,
    });
    console.log(`[Integration] WhatsApp QR sent to ${phone} for ${event.eventCode}`);
  } catch (error) {
    console.error(`[Integration] WhatsApp send skipped for ${phone}:`, error.message);
  }
}


/**
 * POST /api/integration/generate-volunteer-qr
 *
 * Called by the third-party system when a user marks interest in an event.
 * We find the matching event by their event_id (we treat it as eventCode),
 * create/find the holder, generate a QR, and return it in their expected format.
 *
 * Request body (their format):
 *   { event_id, user_phone_number, user_email (optional) }
 *
 * Response (their expected format):
 *   { status: true, message: "QR code generated successfully", qr_code: "..." }
 */
exports.generateVolunteerQR = async (req, res) => {
  try {
    const { event_id, user_phone_number, user_email } = req.body;
    // Optional preacher attribution — sent by the Seva Pass app when a
    // devotee/preacher issues a pass, so it appears under their "My Passes".
    // preacher = display name (also used for CSV-style matching),
    // preacherId = main-system User _id of the role:"preacher" account.
    const preacher = (req.body.preacher || "").trim();
    const preacherId = req.body.preacherId || null;

    // Resolve the preacher string (short code like MKGD, or exact name) to the
    // actual preacher account — same matching used by CSV imports. When matched,
    // the holder links by preacherId; the raw string is kept otherwise.
    let resolvedPreacher = null;
    if (preacher) {
      try {
        resolvedPreacher = await resolvePreacherFromString(preacher);
      } catch (e) {
        resolvedPreacher = null;
      }
    }
    const finalPreacherName = resolvedPreacher?.preacherName || preacher || "";
    const finalPreacherId = resolvedPreacher?.preacherId || preacherId || null;

    // ── Validate input ──────────────────────────────────────────────────────
    if (!event_id) {
      return res.status(400).json({
        status: false,
        message: "event_id is required",
      });
    }
    if (!user_phone_number) {
      return res.status(400).json({
        status: false,
        message: "user_phone_number is required",
      });
    }

    const phone = normalisePhone(String(user_phone_number));
    if (!phone) {
      return res.status(400).json({
        status: false,
        message: "Invalid phone number",
      });
    }

    // ── Find event by eventCode or _id ─────────────────────────────────────
    const event = await Event.findOne({
      $or: [
        { eventCode: String(event_id).toUpperCase() },
        { _id: String(event_id).match(/^[0-9a-fA-F]{24}$/) ? event_id : null },
      ],
    });

    if (!event) {
      return res.status(404).json({
        status: false,
        message: `Event not found for event_id: ${event_id}`,
      });
    }

    // ── Check if holder already has an active pass ──────────────────────────
    const existingHolder = await Holder.findOne({ eventId: event._id, phone });
    if (existingHolder) {
      // Backfill preacher attribution if the request carries it and the holder
      // was created without one (e.g. issued before this feature shipped).
      if (finalPreacherName || finalPreacherId) {
        const backfill = {};
        if (finalPreacherName && !existingHolder.preacher) backfill.preacher = finalPreacherName;
        if (finalPreacherId && !existingHolder.preacherId) backfill.preacherId = finalPreacherId;
        if (Object.keys(backfill).length > 0) {
          existingHolder.set(backfill);
          await existingHolder.save();
        }
      }
      const existingPass = await QRPass.findOne({
        holderId: existingHolder._id,
        status: "active",
      });
      if (existingPass) {
        // Already issued — regenerate QR image and return it
        const payload = qrService.createPayload(
          { ...existingHolder.toObject(), qrId: existingPass.qrId },
          event,
          null,
          [],
        );
        const { image: qrImage } = await qrService.generateQRCode(payload);
        await trySendWhatsApp(phone, qrImage, existingHolder, event, []);
        return res.json({
          status: true,
          message: "QR code already exists — returning existing pass",
          qr_code: qrImage,
          qr_id: existingPass.qrId,
        });
      }
    }

    // ── Resolve the category this QR is issued under, in priority order: ──
    //   1. Explicitly requested category (catCode or name) — sent by the
    //      Seva Pass app when the devotee picks a pass type.
    //   2. An "Invitee" category (code INV or name matching "invitee") — the
    //      default type for the Seva Pass app flow.
    //   3. Legacy fallbacks: General Public (GN) → name "general" → "volunteer".
    const requestedCategory = (req.body.category || "").trim();
    const category = await resolveCategory(event._id, requestedCategory);

    if (!category) {
      return res.status(400).json({
        status: false,
        message: "No suitable category found for this event. Please configure an Invitee or General Public category.",
      });
    }

    // ── Enforce devotee-app category limits ─────────────────────────────────
    // If the event has devoteeAppCategories with a limit for this category,
    // count existing third-party holders under this category and reject if full.
    if (event.devoteeAppCategories && event.devoteeAppCategories.length > 0) {
      const rule = event.devoteeAppCategories.find(
        (d) => d.catCode === (category.catCode || "").toUpperCase()
      );
      if (!rule) {
        return res.status(403).json({
          status: false,
          message: `Category "${category.name}" is not available for the devotee app on this event.`,
        });
      }
      if (rule.limit != null) {
        const used = await Holder.countDocuments({
          eventId: event._id,
          catId: category._id,
          source: "third_party",
        });
        if (used >= rule.limit) {
          return res.status(403).json({
            status: false,
            message: `Category "${category.name}" has reached its limit of ${rule.limit} passes (${used} issued).`,
          });
        }
      }
    }

    // ── Filter entry points by venue if provided ──────────────────────────
    // The Seva Pass app sends venue name; we match it against location.building.
    const requestedVenue = (req.body.venue || "").trim();
    let entryPoints = category.entryPoints || [];
    if (requestedVenue && entryPoints.length > 0) {
      const venueRe = new RegExp(requestedVenue, "i");
      const filtered = entryPoints.filter((ep) => ep.location && ep.location.building && venueRe.test(ep.location.building));
      // Only narrow down if the venue matched something — otherwise keep all
      if (filtered.length > 0) {
        entryPoints = filtered;
      }
    }

    // ── Create or update holder ─────────────────────────────────────────────
    // holderType is a denormalized label derived from the resolved pass type
    // (shared codeMap) so legacy reports grouping by the string keep working.
    const holderData = {
      eventId: event._id,
      catId: category._id,
      phone,
      email: user_email || undefined,
      // Name defaults to phone if not provided — can be updated later
      name: req.body.name || (user_email ? user_email.split("@")[0] : `Devotee ${phone.slice(-4)}`),
      holderType: deriveHolderTypeLabel(category),
      source: "third_party",   // mark origin
      issuedBy: null,
      // Preacher attribution — links this pass to the devotee who issued it.
      ...(finalPreacherName ? { preacher: finalPreacherName } : {}),
      ...(finalPreacherId ? { preacherId: finalPreacherId } : {}),
    };

    let holder;
    try {
      holder = await Holder.create(holderData);
    } catch (e) {
      if (e.code === 11000) {
        // Race condition — holder was just created by another request
        holder = await Holder.findOne({ eventId: event._id, phone });
        if (!holder) throw e;
      } else {
        throw e;
      }
    }

    // ── Generate QR pass ────────────────────────────────────────────────────
    const qrId = await qrService.generateQRId(event.eventCode, category.catCode);

    const payload = qrService.createPayload(
      { ...holder.toObject(), qrId },
      event,
      category,
      entryPoints,
    );
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

    console.log(
      `[Integration] QR generated for ${phone} at event ${event.eventCode} via third-party`,
    );

    // Deliver the QR to the holder's phone (non-fatal)
    await trySendWhatsApp(phone, qrImage, holder, event, entryPoints);

    // Push to community mobile app (non-fatal, fire-and-forget)
    const qrPass = { qrId };
    thirdPartyService.pushHolder({ holder, qrPass, qrImageBase64: qrImage, event }).catch(() => {});
    const catCode = (category.catCode || "").toUpperCase();
    if (["SP", "DN", "INV"].includes(catCode)) {
      thirdPartyService.pushSevaSponsor({ holder, event, qrPass, catCode, categoryName: category.name }).catch(() => {});
    } else if (catCode === "VL") {
      thirdPartyService.pushStoreQrCode({ holder, event, qrPass }).catch(() => {});
    }

    // Return in their expected format
    return res.status(200).json({
      status: true,
      message: "QR code generated successfully",
      qr_code: qrImage,
      qr_id: qrId,
    });
  } catch (error) {
    console.error("[Integration] generateVolunteerQR error:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to generate QR code",
    });
  }
};

/**
 * POST /api/integration/generate-volunteer-qr/bulk
 *
 * Bulk version — accepts an array of holders and returns per-holder results.
 * Shares event + category lookup once for efficiency.
 *
 * Request body:
 *   { event_id, category?, venue?, preacher?, preacherId?, holders: [{ name?, user_phone_number, user_email? }, ...] }
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

    const event = await Event.findOne({
      $or: [
        { eventCode: String(event_id).toUpperCase() },
        { _id: String(event_id).match(/^[0-9a-fA-F]{24}$/) ? event_id : null },
      ],
    });
    if (!event) {
      return res.status(404).json({ status: false, message: `Event not found for event_id: ${event_id}` });
    }

    const requestedCategory = (req.body.category || "").trim();
    const category = await resolveCategory(event._id, requestedCategory);
    if (!category) {
      return res.status(400).json({ status: false, message: "No suitable category found for this event." });
    }

    if (event.devoteeAppCategories && event.devoteeAppCategories.length > 0) {
      const rule = event.devoteeAppCategories.find(
        (d) => d.catCode === (category.catCode || "").toUpperCase()
      );
      if (!rule) {
        return res.status(403).json({
          status: false,
          message: `Category "${category.name}" is not available for the devotee app on this event.`,
        });
      }
    }

    const requestedVenue = (req.body.venue || "").trim();
    let entryPoints = category.entryPoints || [];
    if (requestedVenue && entryPoints.length > 0) {
      const venueRe = new RegExp(escapeRegExp(requestedVenue), "i");
      const filtered = entryPoints.filter((ep) => ep.location && ep.location.building && venueRe.test(ep.location.building));
      if (filtered.length > 0) entryPoints = filtered;
    }

    const preacher = (req.body.preacher || "").trim();
    const preacherId = req.body.preacherId || null;
    let resolvedPreacher = null;
    if (preacher) {
      try { resolvedPreacher = await resolvePreacherFromString(preacher); } catch (e) { /* ignore */ }
    }
    const finalPreacherName = resolvedPreacher?.preacherName || preacher || "";
    const finalPreacherId = resolvedPreacher?.preacherId || preacherId || null;

    const results = [];
    for (const h of holders) {
      try {
        const phoneRaw = h.user_phone_number || h.phone || "";
        const phone = normalisePhone(String(phoneRaw));
        if (!phone) {
          results.push({ success: false, error: "Invalid phone number", input: h });
          continue;
        }

        const existingHolder = await Holder.findOne({ eventId: event._id, phone });
        if (existingHolder) {
          const existingPass = await QRPass.findOne({ holderId: existingHolder._id, status: "active" });
          if (existingPass) {
            const payload = qrService.createPayload(
              { ...existingHolder.toObject(), qrId: existingPass.qrId },
              event, null, [],
            );
            const { image: qrImage } = await qrService.generateQRCode(payload);
            results.push({
              success: true, reused: true,
              name: existingHolder.name, phone,
              qr_id: existingPass.qrId, qr_code: qrImage,
            });
            continue;
          }
        }

        const holderName = h.name || h.user_email?.split("@")[0] || `Devotee ${phone.slice(-4)}`;
        let holder;
        try {
          holder = await Holder.create({
            eventId: event._id, catId: category._id, phone,
            email: h.user_email || undefined,
            name: holderName, holderType: deriveHolderTypeLabel(category),
            source: "third_party", issuedBy: null,
            ...(finalPreacherName ? { preacher: finalPreacherName } : {}),
            ...(finalPreacherId ? { preacherId: finalPreacherId } : {}),
          });
        } catch (e) {
          if (e.code === 11000) {
            holder = await Holder.findOne({ eventId: event._id, phone });
            if (!holder) { results.push({ success: false, error: e.message, input: h }); continue; }
          } else { throw e; }
        }

        const qrId = await qrService.generateQRId(event.eventCode, category.catCode);
        const payload = qrService.createPayload({ ...holder.toObject(), qrId }, event, category, entryPoints);
        const { image: qrImage, signedPayload } = await qrService.generateQRCode(payload);

        await QRPass.create({
          qrId, holderId: holder._id, eventId: event._id, catId: category._id,
          entryPoints: entryPoints.map((ep) => ep._id),
          payloadSigned: signedPayload,
          validFrom: event.dateStart, validUntil: event.dateEnd,
          deliveryMethod: "third_party", deliveryStatus: "sent", deliveredAt: new Date(),
        });

        // Push to community mobile app (non-fatal, fire-and-forget)
        const qrPassObj = { qrId };
        thirdPartyService.pushHolder({ holder, qrPass: qrPassObj, qrImageBase64: qrImage, event }).catch(() => {});
        const catCode = (category.catCode || "").toUpperCase();
        if (["SP", "DN", "INV"].includes(catCode)) {
          thirdPartyService.pushSevaSponsor({ holder, event, qrPass: qrPassObj, catCode, categoryName: category.name }).catch(() => {});
        } else if (catCode === "VL") {
          thirdPartyService.pushStoreQrCode({ holder, event, qrPass: qrPassObj }).catch(() => {});
        }

        results.push({
          success: true, reused: false,
          name: holder.name, phone,
          qr_id: qrId, qr_code: qrImage,
        });
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
