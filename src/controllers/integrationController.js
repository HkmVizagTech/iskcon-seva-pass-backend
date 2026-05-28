// ─── Integration controller ────────────────────────────────────────────────
// Handles the inbound endpoint from the third-party system:
//   POST /api/integration/generate-volunteer-qr
//
// When someone marks interest on their platform, they call this endpoint.
// We create/find the holder in our system and return the QR code.

const Event = require("../models/Event");
const Category = require("../models/Category");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const qrService = require("../services/qrService");
const thirdPartyService = require("../services/thirdPartyService");

// Helper: normalise phone
function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
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

    // ── Create or update holder ─────────────────────────────────────────────
    const holderData = {
      eventId: event._id,
      catId: category._id,
      phone,
      email: user_email || undefined,
      // Name defaults to phone if not provided — can be updated later
      name: user_email ? user_email.split("@")[0] : `Devotee ${phone.slice(-4)}`,
      holderType: "self",
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
    const entryPoints = category.entryPoints || [];

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
