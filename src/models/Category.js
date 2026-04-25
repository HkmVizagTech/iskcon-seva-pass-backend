const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  catCode: {
    type: String,
    required: true,
    uppercase: true,
  },
  description: String,
  color: {
    type: String,
    default: "#FF6B6B",
  },
  icon: String,
  holderTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "HolderType",
    required: true,
  },
  entryPoints: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntryPoint",
    },
  ],
  issuerRoleRequired: {
    type: String,
    enum: ["super_admin", "event_admin", "campaign_manager"],
    default: "event_admin",
  },
  overrideAllowedBy: {
    type: String,
    enum: ["super_admin", "event_admin", "none"],
    default: "event_admin",
  },
  isCustom: {
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

module.exports = mongoose.model("Category", categorySchema);
