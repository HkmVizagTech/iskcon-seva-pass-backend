const mongoose = require("mongoose");

const paidTierSchema = new mongoose.Schema({
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
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  entryPoints: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntryPoint",
      required: true,
    },
  ],
  razorpayItemId: {
    type: String,
    required: true,
    trim: true,
  },
  is80gEligible: {
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

module.exports = mongoose.model("PaidTier", paidTierSchema);
