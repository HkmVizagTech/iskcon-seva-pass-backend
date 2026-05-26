const express = require("express");
const router = express.Router();
const scanController = require("../controllers/scanController");
const { protect, authorize } = require("../middleware/auth");

// Scan routes
router.post(
  "/",
  protect,
  authorize("super_admin", "event_admin", "volunteer"),
  scanController.scanQR,
);
router.get("/station/:epId/stats", protect, scanController.getStationStats);
router.get("/events/:eventId/recent", protect, scanController.getRecentScans);
router.get(
  "/holder/:holderId/history",
  protect,
  scanController.getHolderScanHistory,
);

// Recent scans — for dashboard live feed widget (no eventId filter)
router.get("/recent", protect, scanController.getRecentScans);

// Offline sync
router.post("/sync", protect, scanController.syncOfflineScans);

module.exports = router;
