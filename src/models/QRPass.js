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
    ref: "HolderType",
  },
  entryPoints: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntryPoint",
    },
  ],
  // Optional list of venue NAMES at which this pass is valid. When empty/null,
  // the pass is valid at every venue of its event (backward compatible with all
  // existing passes). When set, scan validation restricts scanning to these
  // venues only. e.g. ["Kailash Gardens"] or ["Kailash Gardens","Main Temple"].
  allowedVenues: [String],
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
    enum: ["whatsapp", "email", "print", "screen", "none", "third_party", "both", "mobile", "mobile_whatsapp"],
    default: "none",
  },
  deliveredAt: Date,
  // Community app (harekrishnavizag.co.in) push tracking — set after every
  // attempt so failures are visible without needing server log access.
  communityAppSync: {
    attempted: { type: Boolean, default: false },
    success: { type: Boolean, default: false },
    skipped: { type: Boolean, default: false },
    reason: String,
    responseBody: String,
    attemptedAt: Date,
    // Second leg for SP/DN/INV: store-qr-code registration of the raw qrcode
    // string (seva-sponsor dedupes on devotee+donor pair only, so extra QRs
    // for the same phone would otherwise never reach their app).
    qrStoreSync: {
      attempted: Boolean,
      success: Boolean,
      skipped: Boolean,
      reason: String,
      responseBody: String,
      attemptedAt: Date,
    },
  },
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
      // Venue (name) where this redemption physically happened. Optional;
      // set only when the scanner provides a venue. Used to enforce
      // "once at each venue" for per-venue entry points.
      venue: String,
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
