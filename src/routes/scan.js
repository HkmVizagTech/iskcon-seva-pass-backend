const express = require("express");
const router = express.Router();
const scanController = require("../controllers/scanController");
const { protect, authorize, requirePermission } = require("../middleware/auth");

// Read-only scan views are gated on the per-account `canViewScanFeed` flag so a
// restricted issuer cannot watch live gate activity. Only an explicit `false`
// denies; super_admin always passes.
//
// Performing a scan (POST / and /sync) is already restricted by role below and
// "issuer" is deliberately absent from that list.
const canScanFeed = requirePermission("canViewScanFeed");

// Scan routes
router.post(
  "/",
  protect,
  authorize("super_admin", "event_admin", "volunteer"),
  scanController.scanQR,
);
router.get("/station/:epId/stats", protect, canScanFeed, scanController.getStationStats);
router.get("/events/:eventId/recent", protect, canScanFeed, scanController.getRecentScans);
router.get(
  "/holder/:holderId/history",
  protect,
  canScanFeed,
  scanController.getHolderScanHistory,
);

// Recent scans — for dashboard live feed widget (no eventId filter)
router.get("/recent", protect, canScanFeed, scanController.getRecentScans);

// Offline sync
router.post(
  "/sync",
  protect,
  authorize("super_admin", "event_admin", "volunteer"),
  scanController.syncOfflineScans,
);

module.exports = router;
