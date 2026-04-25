const mongoose = require("mongoose");

const holderTypeSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {
    type: String,
    required: true,
    uppercase: true,
  },
  description: String,
  icon: {
    type: String,
    default: "👤",
  },
  color: {
    type: String,
    default: "#FF6B6B",
  },
  isDefault: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("HolderType", holderTypeSchema);
