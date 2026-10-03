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
  // A volunteer account — or, for scans made inside a registered client app
  // (e.g. the community app's prasadam scanners), that app plus the person
  // the app says scanned.
  scannedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: function () { return !this.client; },
  },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "ClientApp" },
  externalScanner: { ref: String, name: String, phone: String },
  stationLabel: {
    type: String,
    required: true,
  },
  // Venue (name) where this scan physically happened. Optional; set only when
  // the scanner provides a venue. Lets admins report where each pass used.
  venue: String,
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
      "stale",           // offline scan too old to redeem (logged only)
    ],
    required: true,
  },
  source: { type: String, enum: ['scanner','manual','offline','client'], default: 'scanner' },
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
