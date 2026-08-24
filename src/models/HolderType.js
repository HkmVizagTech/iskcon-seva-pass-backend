const mongoose = require("mongoose");

// MERGED MODEL — HolderType absorbed Category (rename-in-place).
// Bound to the legacy "categories" collection so every existing ObjectId
// reference (Holder.catId, QRPass.catId, $lookup from "categories") stays
// valid without any data migration. The old separate holdertypes collection
// is retired by scripts/migrate-holder-type-merge.js.
//
// NOTE: field names catCode/catId are legacy naming kept for API/DB
// compatibility — the entity itself is now the single pass-type concept.
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
  icon: {
    type: String,
    default: "🏷️",
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
  isDefault: {
    type: Boolean,
    default: false,
  },
  categories: {
    type: [String],
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Unique catCode per event — prevents duplicate QR ID collisions.
// Carried over from the original Category schema index on this collection.
holderTypeSchema.index({ eventId: 1, catCode: 1 }, { unique: true });

module.exports = mongoose.model("HolderType", holderTypeSchema, "categories");
