const express = require("express");
const router = express.Router();
const integrationController = require("../controllers/integrationController");
const prasadamController = require("../controllers/prasadamIntegrationController");
const { clientAuth, guardClientEvent } = require("../middleware/clientAuth");

// ─── Client authentication ────────────────────────────────────────────────────
// Every caller is a registered client app (see /api/clients) with its own API
// key, scopes, event allowlist and rate limit. The key goes in X-API-Key or as a
// Bearer token. The old shared INTEGRATION_API_KEY still works as an
// unrestricted "legacy" client so existing callers keep running until they are
// given their own key.
//   auth(scope)  — key + scope.   guarded(scope) — also checks the event named
//   in the URL (:eventCode) or body (event_id) against the client's allowlist.
const auth = (scope) => clientAuth(scope);
const guarded = (scope) => [...clientAuth(scope), guardClientEvent];

// ─── Public health check ──────────────────────────────────────────────────────
router.get("/status", integrationController.status);

// ─── Events list (used by Seva Pass app to sync) ─────────────────────────────
// GET /api/integration/events
router.get("/events", ...auth("events:read"), integrationController.getAllEvents);

// ─── Venues for an event ──────────────────────────────────────────────────────
// GET /api/integration/events/:eventCode/venues
router.get("/events/:eventCode/venues", ...guarded("events:read"), integrationController.getEventVenues);

// ─── Entry points for an event (optionally filtered by ?venue=<name>) ─────────
// GET /api/integration/events/:eventCode/entry-points
router.get("/events/:eventCode/entry-points", ...guarded("events:read"), integrationController.getEventEntryPoints);

// ─── Categories (pass types) for an event ─────────────────────────────────────
// GET /api/integration/events/:eventCode/categories
router.get("/events/:eventCode/categories", ...guarded("events:read"), integrationController.getEventCategories);

// ─── Update which categories the devotee app may use ──────────────────────────
// PATCH /api/integration/events/:eventCode/devotee-categories
router.patch("/events/:eventCode/devotee-categories", ...guarded("events:write"), integrationController.updateDevoteeCategories);

// ─── Bulk volunteer QR generation ───────────────────────────────────────────
// POST /api/integration/generate-volunteer-qr
// The mobile app calls this when a devotee selects volunteers and taps "Generate QR"
router.post("/generate-volunteer-qr", ...guarded("passes:issue"), integrationController.generateVolunteerQRBulk);

// ─── Seva Pass app — dedicated single-holder QR endpoint ───────────────────
// POST /api/integration/seva-pass/issue
// Accepts the Seva Pass app's flat format and issues a single QR pass.
router.post("/seva-pass/issue", ...guarded("passes:issue"), integrationController.sevaPassIssue);

// Preacher management via integration API
router.post("/preachers", ...auth("preachers:manage"), integrationController.createPreacher);
router.get("/preachers", ...auth("preachers:manage"), integrationController.listPreachers);
router.delete("/preachers/:id", ...auth("preachers:manage"), integrationController.deletePreacher);

// ─── Generic session passes (any purpose) ────────────────────────────────────
// POST /api/integration/passes
// Body: { event_id, type?, phone, name?, email?,
//         valid_for_date?, valid_from?, valid_until?, session_ref? }
// Issues a pass of any pass type (catCode, default "PR") for an event, optionally
// scoped to a dated session on a standing event. Prasadam coupons, one-day
// entry passes, ... all go through here.
router.post("/passes", ...guarded("passes:issue"), prasadamController.issuePass);

// ─── Prasadam Coupon integration (Vaikuntham app) ────────────────────────────
// Matches events by the short event code (e.g. "SKJ26"), the same code the
// Vaikuntham app uses — see prasadamIntegrationController.resolveEvent.
// Each call writes a Holder + QRPass row, so it needs a key with the
// prasadam:issue scope.
router.post("/prasadam/qr", ...guarded("prasadam:issue"), prasadamController.issueSingle);
router.post("/prasadam/qr/bulk", ...guarded("prasadam:issue"), prasadamController.issueBulk);

// ─── QR pass details (live status + scan history) ────────────────────────────
// GET /api/integration/qr/:qrId
// Returns flat { status, redemptionHistory } — used by client apps to show
// real-time scan status on pass cards and detail modals.
router.get("/qr/:qrId", ...auth("passes:read"), integrationController.getQRDetails);

module.exports = router;
