const express = require("express");
const router = express.Router();
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");

// Mobile app: Issue QR code by phone + event
// POST /api/qr/issue
// Body: { volunteer_mobile_number, event_id }
// Response: JSON with signed QR token string (app converts to QR locally)
router.post("/issue", async (req, res) => {
  try {
    const { volunteer_mobile_number, event_id } = req.body;

    if (!volunteer_mobile_number || !event_id) {
      return res.status(400).json({
        error: "Missing required fields: volunteer_mobile_number, event_id",
      });
    }

    const Holder = require("../models/Holder");
    const QRPass = require("../models/QRPass");

    // Normalize phone number (remove +, spaces, dashes, etc)
    const normalizedPhone = String(volunteer_mobile_number)
      .replace(/[\+\s\-\(\)]/g, "");
    const phoneDigits = normalizedPhone.length === 10 ? "91" + normalizedPhone : normalizedPhone;

    // Find holder by phone and event
    const holder = await Holder.findOne({
      phone: phoneDigits,
      eventId: event_id,
    });

    if (!holder) {
      return res.status(404).json({
        error: "Volunteer not found for this event",
      });
    }

    // Find QR pass for this holder
    const qrPass = await QRPass.findOne({
      holderId: holder._id,
      eventId: event_id,
    }).select("payloadSigned status qrId holderId")
      .populate("holderId", "name phone");

    if (!qrPass) {
      return res.status(404).json({
        error: "QR code not generated yet for this volunteer",
      });
    }

    if (qrPass.status !== "active") {
      return res.status(410).json({
        error: `QR code is ${qrPass.status}`,
        qrId: qrPass.qrId,
      });
    }

    res.json({
      qrToken: qrPass.payloadSigned,
      qrId: qrPass.qrId,
      holderName: qrPass.holderId?.name || null,
      status: qrPass.status,
    });
  } catch (error) {
    console.error("Issue QR error:", error);
    res.status(500).json({ error: "Failed to issue QR code" });
  }
});

// Public hosted QR image — used in emails (Gmail strips data: URIs) and
// anywhere a stable URL is needed. The PNG encodes the signed JWT payload.
router.get("/:qrId/image", async (req, res) => {
  try {
    const QRPass = require("../models/QRPass");
    const QRCode = require("qrcode");
    const pass = await QRPass.findOne({ qrId: String(req.params.qrId).toUpperCase() })
      .select("payloadSigned status");
    if (!pass || !pass.payloadSigned) return res.status(404).json({ error: "Not found" });
    const png = await QRCode.toBuffer(pass.payloadSigned, {
      errorCorrectionLevel: "M", margin: 2, width: 400,
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: "Failed to render QR" });
  }
});

router.get("/:qrId", protect, holderController.getQRDetails);
router.post("/:qrId/manual-entry", protect, holderController.manualEntry);
router.patch(
  "/:qrId/revoke",
  protect,
  authorize("super_admin", "event_admin"),
  holderController.revokeQR,
);
router.post(
  "/:qrId/resend",
  protect,
  authorize("super_admin", "event_admin", "campaign_manager"),
  holderController.resendQR,
);

module.exports = router;
