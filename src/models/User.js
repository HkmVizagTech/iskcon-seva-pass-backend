const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: false,   // FIX: volunteers use phone login — email is optional
    unique: true,
    lowercase: true,
    trim: true,
    sparse: true,      // sparse index: allows multiple docs with no email
  },
  phone: {
    type: String,
    required: false,   // either email or phone must be present (validated at controller)
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: [
      "super_admin",
      "event_admin",
      "campaign_manager",
      "volunteer",
      "preacher",   // can log in and view only their own assigned holders/reports
      "self",
    ],
    default: "volunteer",
  },
  avatar: String,
  allowedEvents: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
    },
  ],
  allowedCategories: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },
  ],
  assignedEvents: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
    },
  ],
  assignedEntryPoints: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntryPoint",
    },
  ],
  assignedVenues: [
    {
      type: Number,  // index into Event.venue array
    },
  ],
  canOverride: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastLogin: Date,
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
