const mongoose = require("mongoose");

const scanLogSchema = new mongoose.Schema({
  qrId: {
    type: String,
    required: true,
    index: true,
  },
  epId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "EntryPoint",
    required: true,
  },
  holderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Holder",
    index: true,
  },
  scannedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  stationLabel: {
    type: String,
    required: true,
  },
  scannedAt: {
    type: Date,
    default: Date.now,
  },
  result: {
    type: String,
    enum: [
      "granted",
      "already_used",
      "not_included",
      "invalid",
      "link_required",
      "expired",
      "revoked",
      "not_yet_valid",   // event hasn't started
      "capacity_full",   // station at max capacity
      "duplicate",       // dedup-blocked repeat scan
    ],
    required: true,
  },
  source: { type: String, enum: ['scanner','manual','offline'], default: 'scanner' },
  notes: { type: String },
  deviceInfo: {
    deviceId: String,
    userAgent: String,
    ipAddress: String,
    groupCount: {
      type: Number,
      default: 1,
    },
  },
  groupCount: {
    type: Number,
    default: 1,
  },
  location: {
    lat: Number,
    lng: Number,
  },
  offlineSync: {
    isOffline: {
      type: Boolean,
      default: false,
    },
    syncedAt: Date,
  },
  clientScanId: {
    type: String,
    sparse: true,
    unique: true,
    index: true,
  },
});

scanLogSchema.index({ scannedAt: -1 });
scanLogSchema.index({ epId: 1, result: 1 });

module.exports = mongoose.model("ScanLog", scanLogSchema);
