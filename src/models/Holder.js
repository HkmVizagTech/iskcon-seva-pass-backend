const mongoose = require("mongoose");

const holderSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  catId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: false,
  },
  holderTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "HolderType",
    required: false,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    required: true,
  },
  preacher: String,
  venueName: String,
  email: {
    type: String,
    lowercase: true,
    trim: true,
  },
  whatsappNumber: String,
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
  },
  holderType: {
    type: String,
    default: "custom",
  },
  lifetimeDonation: {
    type: Number,
    default: 0,
  },
  donorEligibilityStatus: {
    type: String,
    enum: ["qualified", "review_required", "not_applicable"],
    default: "not_applicable",
  },
  idProof: {
    type: {
      type: String,
      enum: ["aadhar", "pan", "passport", "voter_id"],
    },
    number: String,
    verified: Boolean,
  },
  photo: String,
  notes: String,
  issuedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },
  issuedAt: {
    type: Date,
    default: Date.now,
  },
  overrideReason: String,
  customFields: mongoose.Schema.Types.Mixed,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// FIX: unique index prevents race-condition duplicate QR passes
// Two concurrent imports for the same phone+event will now get a clear E11000
// instead of silently creating duplicate records
holderSchema.index({ eventId: 1, phone: 1 }, { unique: true });
holderSchema.index({ eventId: 1 });

module.exports = mongoose.model("Holder", holderSchema);
