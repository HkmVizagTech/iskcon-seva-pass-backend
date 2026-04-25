const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const entryPointController = require("../controllers/entryPointController");
const categoryController = require("../controllers/categoryController");
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

// Categories
router.get("/:eventId/categories", protect, categoryController.getCategories);
router.get(
  "/:eventId/categories/:catId",
  protect,
  categoryController.getCategory,
);
router.post(
  "/:eventId/categories",
  protect,
  authorize("super_admin", "event_admin"),
  categoryController.createCategory,
);
router.patch(
  "/:eventId/categories/:catId",
  protect,
  authorize("super_admin", "event_admin"),
  categoryController.updateCategory,
);
router.delete(
  "/:eventId/categories/:catId",
  protect,
  authorize("super_admin"),
  categoryController.deleteCategory,
);

// Holder Types
router.get(
  "/:eventId/holder-types",
  protect,
  holderTypeController.getHolderTypes,
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
