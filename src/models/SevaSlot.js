const mongoose = require("mongoose");

// SevaSlot: a named seva time-slot within an event.
// sub-category code on a Holder references one of these slots.
// e.g. { eventId: KKD2026, code: "A", name: "Pratistha Abhisheka", time: "7:00 AM" }
const sevaSlotSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
    index: true,
  },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,   // A, B, C, PA, SDGP etc
  },
  name: {
    type: String,
    required: true,
    trim: true,        // e.g. "Pratistha Abhisheka"
  },
  time: {
    type: String,
    trim: true,        // e.g. "7:00 AM" — display string, not a Date
  },
  description: {
    type: String,
    trim: true,        // optional notes for the desk
  },
  sortOrder: {
    type: Number,
    default: 0,        // for display ordering
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

// unique code per event
sevaSlotSchema.index({ eventId: 1, code: 1 }, { unique: true });

// Virtual: full display label shown at scanner
// e.g. "A — Pratistha Abhisheka · 7:00 AM"
sevaSlotSchema.virtual("displayLabel").get(function () {
  const parts = [this.code, this.name];
  if (this.time) parts[1] += ` · ${this.time}`;
  return parts.join(" — ");
});

sevaSlotSchema.set("toJSON", { virtuals: true });
sevaSlotSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("SevaSlot", sevaSlotSchema);
