const mongoose = require("mongoose");

const entryPointSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  stationLabel: {
    type: String,
    required: true,
  },
  description: String,
  type: {
    type: String,
    enum: [
      "venue_entry",
      "darshan",
      "prasadam",
      "bahumana",
      "vip_seat",
      "custom",
    ],
    default: "custom",
  },
  linkedEpId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "EntryPoint",
    default: null,
  },
  // Shared redemption group — entry points with the SAME redemptionGroupId are
  // treated as ONE logical entrance: the pass is scanned only once across all
  // of them (e.g. two Bahumana desks, one per venue, that count as a single
  // combined scan). null = standalone (each EP scanned independently).
  redemptionGroupId: {
    type: String,
    default: null,
    index: true,
  },
  allowGroupCount: {
    type: Boolean,
    default: false,
  },
  multiEntryAllowed: {
    type: Boolean,
    default: false,
  },
  isPaid: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // ── Capacity tracking (FIX: were missing from schema) ──
  maxCapacity: {
    type: Number,
    default: null,
  },
  currentCount: {
    type: Number,
    default: 0,
  },
  location: {
    building: String,
    floor: String,
    coordinates: {
      lat: Number,
      lng: Number,
    },
  },
  qrCodeForStation: String,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

entryPointSchema.index({ eventId: 1 });

module.exports = mongoose.model("EntryPoint", entryPointSchema);
