const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");

// Razorpay webhook (no auth - uses signature verification)
router.post(
  "/razorpay",
  express.raw({ type: "application/json" }),
  webhookController.handleRazorpayWebhook,
);

// WhatsApp status webhook
router.post("/whatsapp", webhookController.handleWhatsAppWebhook);
router.get("/whatsapp", webhookController.verifyWhatsAppWebhook);

module.exports = router;
