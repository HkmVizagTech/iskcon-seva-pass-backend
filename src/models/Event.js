const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  eventCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
  },
  description: String,
  dateStart: {
    type: Date,
    required: true,
  },
  dateEnd: {
    type: Date,
    required: true,
  },
  // Scan window — when QRs are valid at the gate.
  // If not set, falls back to dateStart/dateEnd.
  // Allows gate to open before the ceremony starts.
  scanStart: { type: Date },
  scanEnd:   { type: Date },
  venue: [
    {
      name: String,
      address: String,
      coordinates: {
        lat: Number,
        lng: Number,
      },
    },
  ],
  bannerImage: String,
  donorThreshold: {
    type: Number,
    default: 0,
  },
  settings: {
    freezeNewIssuances: {
      type: Boolean,
      default: false,
    },
    allowSelfRegistration: {
      type: Boolean,
      default: false,
    },
    lockBahumanaToSuperAdmin: {
      type: Boolean,
      default: false,
    },
    extendedValidityHours: {
      type: Number,
      default: 0,
    },
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: Date,
});

// FIX: Only ONE pre-save hook (was duplicated, causing it to run twice)
eventSchema.pre("save", function () {
  this.updatedAt = new Date();
});

// Computed status based on dates (virtual — cannot be filtered in DB queries;
// use date range queries in getEvents instead)
eventSchema.virtual("status").get(function () {
  const now = new Date();
  if (now < this.dateStart) return "upcoming";
  if (now >= this.dateStart && now <= this.dateEnd) return "active";
  return "completed";
});
eventSchema.set("toJSON", { virtuals: true });
eventSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Event", eventSchema);
