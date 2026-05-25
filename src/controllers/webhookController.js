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
    // Handle WhatsApp status updates (Twilio / Flaxxa status callback)
    const { From, MessageStatus, MessageSid } = req.body;

    // FIX: QRPass has no "delivery" subdoc — update deliveryStatus directly
    // Match by the phone number stored on the holder
    if (From && MessageStatus) {
      const normalised = From.replace(/[^\d]/g, "");
      const Holder = require("../models/Holder");
      const holder = await Holder.findOne({ phone: normalised }).select("_id");
      if (holder) {
        const status = ["delivered", "read"].includes(MessageStatus) ? "delivered"
                     : MessageStatus === "failed" ? "failed" : "sent";
        await QRPass.updateMany(
          { holderId: holder._id, status: "active" },
          { $set: { deliveryStatus: status } },
        );
      }
    }

    res.json({ received: true });
  } catch (error) {
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
