const express = require("express");
const router = express.Router();
const reportController = require("../controllers/reportController");
const { protect, authorize } = require("../middleware/auth");

// Report routes
router.get("/dashboard", protect, reportController.getDashboardStats);
router.get(
  "/events/:eventId/summary",
  protect,
  reportController.getEventSummary,
);
router.get("/events/:eventId/scan-log", protect, reportController.getScanLog);
router.get("/events/:eventId/no-shows", protect, reportController.getNoShows);
router.get(
  "/events/:eventId/capacity",
  protect,
  reportController.getCapacityReport,
);
router.get(
  "/export/:eventId",
  protect,
  authorize("super_admin", "event_admin"),
  reportController.exportReport,
);

module.exports = router;
