const mongoose = require("mongoose");

const webhookEventSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
    enum: ["razorpay", "whatsapp"],
  },
  eventKey: {
    type: String,
    required: true,
    unique: true,
  },
  eventType: {
    type: String,
    required: true,
  },
  receivedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("WebhookEvent", webhookEventSchema);
