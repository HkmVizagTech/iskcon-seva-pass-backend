const crypto = require("crypto");
const QRPass = require("../models/QRPass");
const Holder = require("../models/Holder");
const Event = require("../models/Event");
const PaidTier = require("../models/PaidTier");
const WebhookEvent = require("../models/WebhookEvent");
const qrService = require("../services/qrService");

exports.handleRazorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    // FIX: guard missing secret — previously threw TypeError crashing the handler
    if (!secret) {
      console.error("RAZORPAY_WEBHOOK_SECRET is not configured");
      return res.status(500).json({ error: "Webhook not configured" });
    }
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody
      ? req.rawBody
      : Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    const webhookEvent = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString("utf8"))
      : req.body;

    if (webhookEvent.event === "payment.captured") {
      const payment = webhookEvent.payload.payment.entity;
      const { notes = {} } = payment;
      const eventKey = `razorpay:payment.captured:${payment.id}`;

      try {
        await WebhookEvent.create({
          provider: "razorpay",
          eventKey,
          eventType: webhookEvent.event,
        });
      } catch (dupError) {
        if (dupError?.code === 11000) {
          return res.json({ received: true, duplicate: true });
        }
        throw dupError;
      }

      const [event, tier] = await Promise.all([
        Event.findById(notes.eventId),
        PaidTier.findById(notes.tierId).populate("entryPoints"),
      ]);

      if (!event || !tier) {
        return res.status(400).json({ error: "Invalid event or tier in payment metadata" });
      }

      const holder = await Holder.create({
        name: notes.name,
        phone: notes.phone,
        email: notes.email,
        eventId: notes.eventId,
        holderType: "paid",
        issuedBy: null,
      });

      const qrPass = await qrService.generateQRForPayment({
        holder,
        event,
        tier,
        paymentId: payment.id,
        deliveryMethod: notes.deliveryMethod || "whatsapp",
      });

      if (notes.deliveryMethod === "whatsapp" || notes.deliveryMethod === "email") {
        await qrService.deliverQR(qrPass, notes.deliveryMethod);
      }
    } else if (webhookEvent.event === "payment.refunded") {
      const paymentId =
        webhookEvent.payload?.refund?.entity?.payment_id ||
        webhookEvent.payload?.payment?.entity?.id;
      const refundId = webhookEvent.payload?.refund?.entity?.id;
      const eventKey = `razorpay:payment.refunded:${refundId || paymentId || "unknown"}`;

      try {
        await WebhookEvent.create({
          provider: "razorpay",
          eventKey,
          eventType: webhookEvent.event,
        });
      } catch (dupError) {
        if (dupError?.code === 11000) {
          return res.json({ received: true, duplicate: true });
        }
        throw dupError;
      }

      if (paymentId) {
        await QRPass.updateMany({ paymentId }, { status: "revoked" });
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
};

exports.handleWhatsAppWebhook = async (req, res) => {
  try {
    // Flaxxa WAPI webhook payload format:
    // { message_id, status, phone, error_code, error_message, timestamp }
    // status values: "sent", "delivered", "read", "failed"
    const body = req.body;

    // Support both Flaxxa format and legacy Twilio format
    const messageId = body.message_id || body.MessageSid;
    const rawStatus = body.status || body.MessageStatus;
    const phone = body.phone || body.From;
    const errorCode = body.error_code;
    const errorMessage = body.error_message;

    if (rawStatus) {
      const deliveryStatus =
        ["delivered", "read"].includes(rawStatus) ? "delivered" :
        rawStatus === "failed" ? "failed" : "sent";

      // Log every delivery status update for diagnostics
      console.log("📬 WhatsApp delivery update:", JSON.stringify({
        messageId, status: rawStatus, deliveryStatus, phone,
        errorCode, errorMessage,
      }));

      // #131005 = recipient not on WhatsApp or blocked business messages
      // #131026 = message undeliverable
      // Log clearly so admin can see in Railway logs
      if (deliveryStatus === "failed") {
        console.error(`❌ WhatsApp delivery FAILED for ${phone}:`,
          `error ${errorCode} — ${errorMessage || "unknown reason"}`);
      }

      // Update QRPass delivery status by matching message_id
      // Flaxxa sends message_id which we store as deliveryMessageId
      // Fall back to phone lookup if no message_id match
      const Holder = require("../models/Holder");

      let updated = false;
      if (messageId) {
        const result = await QRPass.updateOne(
          { deliveryMessageId: messageId },
          { $set: {
            deliveryStatus,
            ...(deliveryStatus === "failed" ? {
              deliveryError: `${errorCode}: ${errorMessage || "delivery failed"}`,
            } : {}),
            ...(deliveryStatus === "delivered" ? { deliveredAt: new Date() } : {}),
          }},
        );
        updated = result.modifiedCount > 0;
      }

      // Fall back to phone-based lookup
      if (!updated && phone) {
        const normalised = phone.replace(/[^\d]/g, "");
        const holder = await Holder.findOne({ phone: normalised }).select("_id");
        if (holder) {
          await QRPass.updateMany(
            { holderId: holder._id, status: "active" },
            { $set: {
              deliveryStatus,
              ...(deliveryStatus === "failed" ? {
                deliveryError: `${errorCode}: ${errorMessage || "delivery failed"}`,
              } : {}),
            }},
          );
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("WhatsApp webhook error:", error.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
};

exports.verifyWhatsAppWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
};
