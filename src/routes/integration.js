const express = require("express");
const router = express.Router();
const integrationController = require("../controllers/integrationController");
const prasadamController = require("../controllers/prasadamIntegrationController");

// ─── API key middleware ───────────────────────────────────────────────────────
// The third-party system authenticates using an API key in the
// X-API-Key header OR as a Bearer token in Authorization.
// Set INTEGRATION_API_KEY env var to the shared secret.
const requireApiKey = (req, res, next) => {
  const expectedKey = process.env.INTEGRATION_API_KEY;

  if (!expectedKey) {
    console.error("INTEGRATION_API_KEY is not set");
    return res.status(503).json({ status: false, message: "Integration not configured" });
  }

  const header = req.headers["x-api-key"] || "";
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const provided = header || bearer;

  if (!provided || provided !== expectedKey) {
    return res.status(401).json({ status: false, message: "Invalid API key" });
  }

  next();
};

// ─── Public health check ──────────────────────────────────────────────────────
router.get("/status", integrationController.status);

// ─── Events list (used by Seva Pass app to sync) ─────────────────────────────
// GET /api/integration/events
router.get("/events", requireApiKey, integrationController.getAllEvents);

// ─── Venues for an event ──────────────────────────────────────────────────────
// GET /api/integration/events/:eventCode/venues
router.get("/events/:eventCode/venues", requireApiKey, integrationController.getEventVenues);

// ─── Entry points for an event (optionally filtered by ?venue=<name>) ─────────
// GET /api/integration/events/:eventCode/entry-points
router.get("/events/:eventCode/entry-points", requireApiKey, integrationController.getEventEntryPoints);

// ─── Categories (pass types) for an event ─────────────────────────────────────
// GET /api/integration/events/:eventCode/categories
router.get("/events/:eventCode/categories", requireApiKey, integrationController.getEventCategories);

// ─── Update which categories the devotee app may use ──────────────────────────
// PATCH /api/integration/events/:eventCode/devotee-categories
router.patch("/events/:eventCode/devotee-categories", requireApiKey, integrationController.updateDevoteeCategories);

// ─── Bulk volunteer QR generation (public — no auth) ────────────────────────
// POST /api/integration/generate-volunteer-qr
// The mobile app calls this when a devotee selects volunteers and taps "Generate QR"
router.post(
  "/generate-volunteer-qr",
  integrationController.generateVolunteerQRBulk,
);

// ─── Seva Pass app — dedicated single-holder QR endpoint ───────────────────
// POST /api/integration/seva-pass/issue
// Accepts the Seva Pass app's flat format and issues a single QR pass.
router.post("/seva-pass/issue", requireApiKey, integrationController.sevaPassIssue);

// Preacher management via integration API
router.post("/preachers", requireApiKey, integrationController.createPreacher);
router.get("/preachers", requireApiKey, integrationController.listPreachers);
router.delete("/preachers/:id", requireApiKey, integrationController.deletePreacher);

// ─── Prasadam Coupon integration (community app) ─────────────────────────────
// Matches events by our own MongoDB Event _id, shared directly with the
// community app — no eventCode translation needed.
router.post("/prasadam/qr", requireApiKey, prasadamController.issueSingle);
router.post("/prasadam/qr/bulk", requireApiKey, prasadamController.issueBulk);

// ─── QR pass details (live status + scan history) ────────────────────────────
// GET /api/integration/qr/:qrId
// Returns flat { status, redemptionHistory } — used by the Seva Pass app to
// show real-time scan status on pass cards and detail modals.
router.get("/qr/:qrId", requireApiKey, integrationController.getQRDetails);

module.exports = router;
