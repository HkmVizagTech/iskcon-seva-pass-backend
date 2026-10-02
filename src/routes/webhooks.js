const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");
const { safeEqual } = require("../utils/safeEqual");

// Optional shared secret for the WhatsApp provider callback (X-Webhook-Secret
// header, or ?secret= for providers that can only configure a URL). When
// WHATSAPP_WEBHOOK_SECRET is unset the endpoint stays open, as before.
let warnedNoSecret = false;
const verifyWhatsAppSecret = (req, res, next) => {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === "production" && !warnedNoSecret) {
      warnedNoSecret = true;
      console.warn("WHATSAPP_WEBHOOK_SECRET not set: /api/webhooks/whatsapp is unauthenticated");
    }
    return next();
  }
  const provided = req.get("x-webhook-secret") || req.query.secret || "";
  if (typeof provided !== "string" || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }
  next();
};

// Razorpay webhook (no auth - uses signature verification)
router.post(
  "/razorpay",
  express.raw({ type: "application/json" }),
  webhookController.handleRazorpayWebhook,
);

// WhatsApp status webhook
router.post("/whatsapp", verifyWhatsAppSecret, webhookController.handleWhatsAppWebhook);
router.get("/whatsapp", webhookController.verifyWhatsAppWebhook);

module.exports = router;
