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
  status: {
    type: String,
    enum: ["draft", "active", "completed", "cancelled"],
    default: "draft",
  },
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

eventSchema.pre("save", function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model("Event", eventSchema);
