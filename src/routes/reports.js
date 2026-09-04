const express = require("express");
const router = express.Router();
const reportController = require("../controllers/reportController");
const { protect, authorize, requirePermission } = require("../middleware/auth");

// Every reporting endpoint is gated on the per-account `canViewReports` flag,
// so a restricted issuer cannot read event-wide totals — not even by calling
// the API directly. Only an explicit `false` denies, so existing accounts (and
// user documents predating the flag) are unaffected, and super_admin always
// passes.
//
// Deliberately NOT gated: the bahumana announcement route, which is the
// announcer role's entire purpose and carries its own role guard.
const canReport = requirePermission("canViewReports");

// Report routes
router.get("/dashboard", protect, canReport, reportController.getDashboardStats);
router.get("/analytics", protect, canReport, reportController.getAnalytics);
router.get("/events/:eventId/bahumana-announcement", protect, authorize("super_admin","event_admin","campaign_manager","announcer"), reportController.getBahumanaAnnouncement);
router.get("/analytics/export", protect, canReport, reportController.exportAnalytics);
router.get(
  "/events/:eventId/summary",
  protect,
  canReport,
  reportController.getEventSummary,
);
router.get("/events/:eventId/scan-log", protect, canReport, reportController.getScanLog);
router.get("/events/:eventId/scan-venues", protect, canReport, reportController.getScanVenues);
router.get("/events/:eventId/no-shows", protect, canReport, reportController.getNoShows);
router.get(
  "/events/:eventId/capacity",
  protect,
  canReport,
  reportController.getCapacityReport,
);
router.get(
  "/export/:eventId",
  protect,
  authorize("super_admin", "event_admin"),
  reportController.exportReport,
);
router.get(
  "/events/:eventId/holders-detail",
  protect,
  canReport,
  reportController.getHolderDetailsReport,
);

module.exports = router;
