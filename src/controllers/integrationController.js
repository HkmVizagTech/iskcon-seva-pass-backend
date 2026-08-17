// ─── Integration controller ────────────────────────────────────────────────
// Handles the inbound endpoint from the third-party system:
//   POST /api/integration/generate-volunteer-qr
//
// When someone marks interest on their platform, they call this endpoint.
// We create/find the holder in our system and return the QR code.

const Event = require("../models/Event");
const Category = require("../models/Category");
const EntryPoint = require("../models/EntryPoint");
const Holder = require("../models/Holder");
const HolderType = require("../models/HolderType");
const QRPass = require("../models/QRPass");
const qrService = require("../services/qrService");
const thirdPartyService = require("../services/thirdPartyService");
const whatsappService = require("../services/whatsappService");

// Helper: normalise phone
function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
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

    // ── Find the default "General Public" category for this event ──────────
    const category = await Category.findOne({
      eventId: event._id,
      $or: [
        { catCode: "GN" },
        { name: /general/i },
        { name: /volunteer/i },
      ],
    }).populate("entryPoints");

    if (!category) {
      return res.status(400).json({
        status: false,
        message: "No suitable category found for this event. Please configure a General Public or Volunteer category.",
      });
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
    // Resolve holder type for integration-issued holders.
    // Uses the event "Invitee" type when it exists (INTEGRATION_HOLDER_TYPE
    // overrides the name/code), else the event default type, else none.
    // Non-fatal: a missing type falls back to the old "self" behaviour.
    let holderTypeId = null;
    let holderTypeLabel = "self";
    try {
      const typeName = (process.env.INTEGRATION_HOLDER_TYPE || "invitee").trim();
      let holderType = await HolderType.findOne({
        eventId: event._id,
        isActive: true,
        $or: [{ code: typeName.toUpperCase() }, { name: new RegExp("^" + typeName + "$", "i") }],
      });
      if (!holderType) {
        holderType = await HolderType.findOne({ eventId: event._id, isDefault: true, isActive: true });
      }
      if (holderType) {
        holderTypeId = holderType._id;
        holderTypeLabel = holderType.name;
      }
    } catch (e) {
      console.warn("[Integration] holder type lookup failed:", e.message);
    }
    const holderData = {
      eventId: event._id,
      catId: category._id,
      phone,
      email: user_email || undefined,
      // Name defaults to phone if not provided — can be updated later
      name: user_email ? user_email.split("@")[0] : `Devotee ${phone.slice(-4)}`,
      holderType: holderTypeLabel,
      holderTypeId,
      source: "third_party",   // mark origin
      issuedBy: null,
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
 * GET /api/integration/events/:eventCode/venues
 *
 * Returns the distinct venue objects attached to an event.
 * The Seva Pass app uses this to present venue options when issuing passes.
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
