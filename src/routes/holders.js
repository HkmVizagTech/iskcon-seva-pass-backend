const express = require("express");
const router = express.Router();
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");
const upload = require("../middleware/upload");

// IMPORTANT: Put specific routes BEFORE parameterized routes

// QR operations (specific routes first)
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
router.get(
  "/events/:eventId/holders/export",
  protect,
  holderController.exportHolders,
);

// Event-specific routes
router.post(
  "/events/:eventId/holders",
  protect,
  authorize("super_admin", "event_admin", "campaign_manager"),
  holderController.createHolder,
);
router.get("/events/:eventId/holders", protect, holderController.getHolders);

// Holder-specific routes (parameterized routes LAST)
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
// Add this route for downloading failed import file
router.get(
  "/download-failed/:filename",
  protect,
  authorize("super_admin", "event_admin"),
  holderController.downloadFailedImport,
);

// Get category entry points for preview
router.get(
  "/category/:categoryId/entry-points",
  protect,
  holderController.getCategoryEntryPoints,
);

// Get failed imports for an event
router.get(
  "/failed-imports/:eventId",
  protect,
  require("../controllers/holderController").getFailedImports,
);

module.exports = router;
