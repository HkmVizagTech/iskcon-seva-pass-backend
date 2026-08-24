const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const entryPointController = require("../controllers/entryPointController");
const holderTypeController = require("../controllers/holderTypeController");
const holderController = require("../controllers/holderController");
const { protect, authorize } = require("../middleware/auth");
const upload = require("../middleware/upload");

// Event routes
router.post(
  "/",
  protect,
  authorize("super_admin", "event_admin"),
  eventController.createEvent,
);
router.get("/", protect, eventController.getEvents);
router.get("/:id", protect, eventController.getEventDetails);
router.patch(
  "/:id",
  protect,
  authorize("super_admin", "event_admin"),
  eventController.updateEvent,
);
router.post(
  "/:id/tiers",
  protect,
  authorize("super_admin", "event_admin"),
  eventController.createPaidTier,
);
router.delete(
  "/:id",
  protect,
  authorize("super_admin"),
  eventController.deleteEvent,
);
router.post(
  "/:id/activate",
  protect,
  authorize("super_admin", "event_admin"),
  eventController.activateEvent,
);
router.post(
  "/:id/deactivate",
  protect,
  authorize("super_admin", "event_admin"),
  eventController.deactivateEvent,
);

// Entry points
router.get(
  "/:eventId/entry-points",
  protect,
  entryPointController.getEntryPoints,
);
router.post(
  "/:eventId/entry-points",
  protect,
  authorize("super_admin", "event_admin"),
  entryPointController.createEntryPoint,
);
router.patch(
  "/:eventId/entry-points/:epId",
  protect,
  authorize("super_admin", "event_admin"),
  entryPointController.updateEntryPoint,
);
router.delete(
  "/:eventId/entry-points/:epId",
  protect,
  authorize("super_admin"),
  entryPointController.deleteEntryPoint,
);

// Holder Types — merged pass-type entity (absorbs the old categories CRUD)
router.get(
  "/:eventId/holder-types",
  protect,
  holderTypeController.getHolderTypes,
);
router.get(
  "/:eventId/holder-types/:htId",
  protect,
  holderTypeController.getHolderType,
);
router.post(
  "/:eventId/holder-types",
  protect,
  authorize("super_admin", "event_admin"),
  holderTypeController.createHolderType,
);
router.patch(
  "/:eventId/holder-types/:htId",
  protect,
  authorize("super_admin", "event_admin"),
  holderTypeController.updateHolderType,
);
router.delete(
  "/:eventId/holder-types/:htId",
  protect,
  authorize("super_admin"),
  holderTypeController.deleteHolderType,
);

// Holders for an event
router.post(
  "/:eventId/holders",
  protect,
  authorize("super_admin", "event_admin", "campaign_manager"),
  holderController.createHolder,
);
router.get("/:eventId/holders", protect, holderController.getHolders);
router.get("/:eventId/holders/export", protect, holderController.exportHolders);
router.post(
  "/:eventId/holders/bulk",
  protect,
  authorize("super_admin", "event_admin"),
  upload.single("file"),
  holderController.bulkImportHolders,
);

module.exports = router;

// ── Diagnostic: check community app sync configuration ──────────────────────
const { protect: _p2, authorize: _a2 } = require("../middleware/auth");
router.get("/:eventId/sync-status", _p2, _a2("super_admin","event_admin"), async (req, res) => {
  const Event = require("../models/Event");
  const event = await Event.findById(req.params.eventId).select("name thirdPartyEventId");
  if (!event) return res.status(404).json({ error: "Event not found" });

  res.json({
    eventName: event.name,
    thirdPartyEventId: event.thirdPartyEventId || null,
    syncEnabled: process.env.THIRD_PARTY_SYNC_ENABLED === "true",
    apiUrl: process.env.THIRD_PARTY_API_URL || "https://harekrishnavizag.co.in",
    willPush: !!(event.thirdPartyEventId && process.env.THIRD_PARTY_SYNC_ENABLED === "true"),
    reason: !event.thirdPartyEventId
      ? "Event has no thirdPartyEventId set"
      : process.env.THIRD_PARTY_SYNC_ENABLED !== "true"
      ? "THIRD_PARTY_SYNC_ENABLED is not set to 'true' on the server"
      : "OK — push will fire on next QR issuance",
  });
});

// ── Diagnostic: what outbound IP does Railway actually use? ─────────────────
router.get("/__diag/outbound-ip", async (req, res) => {
  try {
    const axios = require("axios");
    const r = await axios.get("https://api.ipify.org?format=json", { timeout: 8000 });
    res.json({ outboundIp: r.data.ip });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
