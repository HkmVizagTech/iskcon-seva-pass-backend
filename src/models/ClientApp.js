const mongoose = require("mongoose");

// A registered consumer of the central QR system (Vaikuntham community app, the
// Seva Pass devotee app, FOLK, ...). Each has its own API key, so one can be
// limited, rotated or switched off without touching the others.
const clientAppSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Short stable id, used to namespace the client's session refs ("vaikuntham:42").
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: /^[a-z0-9][a-z0-9-]{1,30}$/,
  },
  description: String,
  keyHash: { type: String, required: true, unique: true },
  keyHint: String,
  status: { type: String, enum: ["active", "disabled"], default: "active" },

  scopes: [String],
  // Event codes this client may use; ["*"] = every event.
  allowedEvents: { type: [String], default: ["*"] },
  // Pass type codes (catCode) this client may issue; ["*"] = every type.
  allowedPassTypes: { type: [String], default: ["*"] },
  rateLimitPerMin: { type: Number, default: 300, min: 1, max: 6000 },

  lastUsedAt: Date,
  keyRotatedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
});

clientAppSchema.pre("save", function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model("ClientApp", clientAppSchema);
