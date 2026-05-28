const express = require("express");
const router = express.Router();
const integrationController = require("../controllers/integrationController");

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

// ─── Inbound from third-party (they call us) ─────────────────────────────────
// POST /api/integration/generate-volunteer-qr
// Their user marks interest → we generate QR → return it
router.post(
  "/generate-volunteer-qr",
  requireApiKey,
  integrationController.generateVolunteerQR,
);

module.exports = router;
