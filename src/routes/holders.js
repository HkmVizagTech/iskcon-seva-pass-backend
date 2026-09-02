const express = require("express");
const router = express.Router();
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");
const upload = require("../middleware/upload");

// "issuer" is a limited pass-issuing account. It reaches the same issue routes
// as a campaign_manager; WHAT it may actually issue (which holder types, which
// delivery methods) is enforced per-account in utils/issuePermissions.js, not
// by this role list.
const CAN_ISSUE = ["super_admin", "event_admin", "campaign_manager", "issuer"];

// IMPORTANT: Specific routes MUST come before parameterised catch-alls
// FIX: /download-failed/:filename and /failed-imports/:eventId were after
// /:holderId, so Express matched them as holder IDs and returned 404.

// QR operations
router.get("/qr/:qrId", protect, holderController.getQRDetails);
router.post(
  "/qr/:qrId/retry-community-sync",
  protect,
  authorize("super_admin", "event_admin", "campaign_manager"),
  holderController.retryCommunitySync,
);
router.patch(
  "/qr/:qrId/revoke",
  protect,
  authorize("super_admin", "event_admin"),
  holderController.revokeQR,
);
router.post(
  "/qr/:qrId/resend",
  protect,
  authorize(...CAN_ISSUE),
  holderController.resendQR,
);

// Bulk operations — an issuer may bulk import, but the same per-account
// holder-type and delivery-method allow-lists are enforced in the controller
// before the file is parsed.
router.post(
  "/bulk/:eventId",
  protect,
  authorize(...CAN_ISSUE),
  upload.single("file"),
  holderController.bulkImportHolders,
);

// FIX: moved before /:holderId to prevent route collision
router.get(
  "/download-failed/:filename",
  protect,
  authorize("super_admin", "event_admin"),
  holderController.downloadFailedImport,
);

// FIX: moved before /:holderId
router.get(
  "/category/:categoryId/entry-points",
  protect,
  holderController.getCategoryEntryPoints,
);

// FIX: moved before /:holderId
router.get(
  "/failed-imports/:eventId",
  protect,
  holderController.getFailedImports,
);

// Event-specific routes
router.post(
  "/events/:eventId/holders",
  protect,
  authorize(...CAN_ISSUE),
  holderController.createHolder,
);
router.get("/events/:eventId/holders", protect, holderController.getHolders);
router.get(
  "/events/:eventId/holders/export",
  protect,
  holderController.exportHolders,
);

// Parameterised catch-all routes LAST
router.get("/:holderId", protect, holderController.getHolderDetails);
router.patch(
  "/:holderId",
  protect,
  authorize("super_admin", "event_admin"),
  holderController.updateHolder,
);
router.delete(
  "/:holderId",
  protect,
  authorize("super_admin"),
  holderController.deleteHolder,
);

module.exports = router;
