// ─── Prasadam Coupon Integration ────────────────────────────────────────────
// Separate from generateVolunteerQR (which matches by eventCode for a
// different third-party). This one matches by our own MongoDB Event _id
// directly, since the community app shares the same event _id with us.
//
// Endpoints:
//   POST /api/integration/prasadam/qr          — single holder
//   POST /api/integration/prasadam/qr/bulk     — multiple holders
//
// Auth: same requireApiKey middleware as the rest of /api/integration/*

const mongoose = require("mongoose");
const Event = require("../models/Event");
const Category = require("../models/Category");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const qrService = require("../services/qrService");

function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
}

function isValidObjectId(id) {
  return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
}

// Resolve (or create-on-first-use) the Prasadam category for an event.
// Looks for catCode "PR" or a name containing "prasad". If none exists,
// creates one automatically so the integration works without manual setup.
async function resolvePrasadamCategory(event) {
  let category = await Category.findOne({
    eventId: event._id,
    $or: [{ catCode: "PR" }, { name: /prasad/i }],
  }).populate("entryPoints");

  if (category) return category;

  // Auto-create a minimal Prasadam category + a default entry point reference.
  // No entryPoints attached — the QR will carry no gate restriction unless
  // the temple later assigns one via the dashboard (Events → Categories).
  category = await Category.create({
    eventId: event._id,
    name: "Prasadam Coupon",
    catCode: "PR",
    color: "#16A34A",
    icon: "🍛",
    holderTypeId: null,
    entryPoints: [],
  });
  return category;
}

// Core single-holder issuance logic — reused by both single and bulk endpoints.
async function issuePrasadamQR(event, category, { name, phone, email, quantity }) {
  const normPhone = normalisePhone(phone);
  if (!normPhone) {
    return { success: false, error: "Invalid or missing phone number", input: { name, phone } };
  }

  // One coupon QR per phone per event (re-use if already issued, same as
  // the existing volunteer integration behaviour).
  const existingHolder = await Holder.findOne({ eventId: event._id, phone: normPhone, catId: category._id });
  if (existingHolder) {
    const existingPass = await QRPass.findOne({ holderId: existingHolder._id, status: "active" });
    if (existingPass) {
      const payload = qrService.createPayload(
        { ...existingHolder.toObject(), qrId: existingPass.qrId },
        event, category, category.entryPoints || [],
      );
      const { image: qrImage } = await qrService.generateQRCode(payload);
      return {
        success: true,
        reused: true,
        name: existingHolder.name,
        phone: normPhone,
        qr_id: existingPass.qrId,
        qr_code: qrImage,
      };
    }
  }

  const holder = await Holder.create({
    eventId: event._id,
    catId: category._id,
    phone: normPhone,
    email: email || undefined,
    name: name || `Devotee ${normPhone.slice(-4)}`,
    holderType: "self",
    source: "third_party",
    customFields: quantity ? { prasadamQuantity: quantity } : undefined,
  });

  const qrId = await qrService.generateQRId(event.eventCode, category.catCode);
  const entryPoints = category.entryPoints || [];
  const payload = qrService.createPayload({ ...holder.toObject(), qrId }, event, category, entryPoints);
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

  return {
    success: true,
    reused: false,
    name: holder.name,
    phone: normPhone,
    qr_id: qrId,
    qr_code: qrImage,
  };
}

/**
 * POST /api/integration/prasadam/qr
 * Body: { event_id, name, phone, email?, quantity? }
 * event_id MUST be our MongoDB Event _id (shared with the community app).
 */
exports.issueSingle = async (req, res) => {
  try {
    const { event_id, name, phone, email, quantity } = req.body;

    if (!event_id || !isValidObjectId(event_id)) {
      return res.status(400).json({ status: false, message: "Valid event_id (Mongo ObjectId) is required" });
    }
    if (!phone) {
      return res.status(400).json({ status: false, message: "phone is required" });
    }

    const event = await Event.findById(event_id);
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
      qr_code: result.qr_code,
      qr_id: result.qr_id,
      name: result.name,
      phone: result.phone,
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
 */
exports.issueBulk = async (req, res) => {
  try {
    const { event_id, holders } = req.body;

    if (!event_id || !isValidObjectId(event_id)) {
      return res.status(400).json({ status: false, message: "Valid event_id (Mongo ObjectId) is required" });
    }
    if (!Array.isArray(holders) || holders.length === 0) {
      return res.status(400).json({ status: false, message: "holders must be a non-empty array" });
    }
    if (holders.length > 500) {
      return res.status(400).json({ status: false, message: "Maximum 500 holders per bulk request" });
    }

    const event = await Event.findById(event_id);
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
