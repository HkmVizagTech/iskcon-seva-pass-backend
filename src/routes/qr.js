const express = require("express");
const router = express.Router();
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");

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
