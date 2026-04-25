const mongoose = require("mongoose");

const qrPassSchema = new mongoose.Schema({
  qrId: {
    type: String,
    required: true,
    unique: true,
  },
  holderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Holder",
    required: true,
  },
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  catId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
  },
  entryPoints: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntryPoint",
    },
  ],
  payloadSigned: {
    type: String,
    required: true,
  },
  validFrom: {
    type: Date,
    required: true,
  },
  validUntil: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    enum: ["active", "used", "revoked", "expired"],
    default: "active",
  },
  paymentId: String,
  paymentAmount: Number,
  deliveryMethod: {
    type: String,
    enum: ["whatsapp", "email", "print", "screen", "none"],
    default: "none",
  },
  deliveredAt: Date,
  deliveryStatus: {
    type: String,
    enum: ["pending", "sent", "delivered", "failed"],
    default: "pending",
  },
  redemptionHistory: [
    {
      epId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "EntryPoint",
      },
      scannedAt: Date,
      scannedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      stationLabel: String,
      result: {
        type: String,
        enum: [
          "granted",
          "already_used",
          "not_included",
          "invalid",
          "link_required",
        ],
      },
    },
  ],
  version: {
    type: Number,
    default: 1,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: Date,
});

qrPassSchema.pre("save", function () {
  this.updatedAt = new Date();
});
// At the bottom of qrPassSchema, before module.exports

qrPassSchema.index({ qrId: 1, status: 1 }); // covers validateQR's findOne exactly
qrPassSchema.index({ holderId: 1 }); // for holder lookups
qrPassSchema.index({ eventId: 1 }); // for event lookups
qrPassSchema.index({ "redemptionHistory.epId": 1 }); // speeds up history .some() at DB level if needed later

module.exports = mongoose.model("QRPass", qrPassSchema);
