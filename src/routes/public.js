const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const publicController = require("../controllers/publicController");

// ─── Public routes — NO authentication ────────────────────────────────────
// Everything mounted here is reachable by anyone on the internet. Add a route
// only when it is safe to expose unauthenticated, and keep every response
// minimal (see the security notes in controllers/publicController.js).

// The lookup tells the caller whether a phone number belongs to a devotee on
// the list, so without a limit it could be used to enumerate donors. 20 tries
// per 10 minutes per IP is far more than a devotee needs (they know their own
// number) and far too slow to sweep a number range.
//
// NOTE: relies on `app.set("trust proxy", 1)` in index.js so that req.ip is
// the real client IP behind Railway's proxy and not the proxy itself —
// without it every visitor would share a single bucket.
const lookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    status: false,
    message:
      "Too many checks from this device. Please wait a few minutes, or ask at the helpdesk.",
  },
});

// POST /api/public/pass-lookup  { phone }
router.post("/pass-lookup", lookupLimiter, publicController.passLookup);

module.exports = router;
