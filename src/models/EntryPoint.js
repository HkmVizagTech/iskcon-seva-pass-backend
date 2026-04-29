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

module.exports = mongoose.model("EntryPoint", entryPointSchema);
