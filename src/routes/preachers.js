const express = require("express");
const router = express.Router();
const preacherController = require("../controllers/preacherController");
const { protect, authorize } = require("../middleware/auth");

// ─── Public ───────────────────────────────────────────────────────────────────
router.post("/login", preacherController.preacherLogin);

// ─── Preacher's own dashboard (requires preacher login) ───────────────────────
router.get("/me/holders", protect, authorize("preacher"), preacherController.getMyHolders);
router.get("/me/stats", protect, authorize("preacher"), preacherController.getMyStats);

// ─── Admin: manage preachers ──────────────────────────────────────────────────
router.post(
  "/",
  protect,
  authorize("super_admin", "event_admin"),
  preacherController.createPreacher,
);
router.get(
  "/",
  protect,
  authorize("super_admin", "event_admin", "campaign_manager"),
  preacherController.getPreachers,
);
router.get(
  "/:id",
  protect,
  authorize("super_admin", "event_admin"),
  preacherController.getPreacher,
);
router.patch(
  "/:id",
  protect,
  authorize("super_admin", "event_admin"),
  preacherController.updatePreacher,
);
router.delete(
  "/:id",
  protect,
  authorize("super_admin"),
  preacherController.deletePreacher,
);
router.post(
  "/:id/reset-password",
  protect,
  authorize("super_admin", "event_admin"),
  preacherController.resetPreacherPassword,
);

module.exports = router;
