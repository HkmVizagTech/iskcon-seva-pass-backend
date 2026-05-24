const express = require("express");
const router = express.Router();
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");
const upload = require("../middleware/upload");

// IMPORTANT: Specific routes MUST come before parameterised catch-alls
// FIX: /download-failed/:filename and /failed-imports/:eventId were after
// /:holderId, so Express matched them as holder IDs and returned 404.

// QR operations
router.get("/qr/:qrId", protect, holderController.getQRDetails);
router.patch(
  "/qr/:qrId/revoke",
  protect,
  authorize("super_admin", "event_admin"),
  holderController.revokeQR,
);
router.post(
  "/qr/:qrId/resend",
  protect,
  authorize("super_admin", "event_admin", "campaign_manager"),
  holderController.resendQR,
);

// Bulk operations
router.post(
  "/bulk/:eventId",
  protect,
  authorize("super_admin", "event_admin"),
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
  authorize("super_admin", "event_admin", "campaign_manager"),
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
