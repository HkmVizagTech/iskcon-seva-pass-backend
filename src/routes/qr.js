const express = require("express");
const router = express.Router();
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");

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
