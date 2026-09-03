const mongoose = require("mongoose");
const { ENTRY_POINT_TYPES } = require("../utils/entryPointTypes");

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
  // The darshan gate is now "jhulan". "darshan" stays in the enum as a legacy
  // alias so entry points on PAST events (which the rename migration leaves
  // alone) still validate when saved. See utils/entryPointTypes.js — match
  // with JHULAN_TYPES rather than a bare === "jhulan".
  type: {
    type: String,
    enum: ENTRY_POINT_TYPES,
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
