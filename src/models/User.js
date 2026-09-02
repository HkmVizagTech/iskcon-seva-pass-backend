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
  // Short code for preachers (e.g. MKGD for Mukunda Gauranga Dasa)
  // Used in CSV imports to identify the preacher column value
  shortCode: {
    type: String,
    uppercase: true,
    trim: true,
    sparse: true,  // allows multiple null values (non-preachers)
    index: true,
  },

  role: {
    type: String,
    enum: [
      "super_admin",
      "event_admin",
      "campaign_manager",
      // Limited pass-issuing account. WHAT it may issue is governed by
      // allowedHolderTypeCodes / allowedDeliveryMethods below, not by the role
      // itself — the role only marks the account as restricted and drives the
      // dashboard's navigation gating.
      "issuer",
      "volunteer",
      "preacher",   // can log in and view only their own assigned holders/reports
      "announcer",  // can only see the bahumana announcement view for their assigned event
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
  // ── Per-account issue restrictions (enforced in utils/issuePermissions.js) ──
  // An EMPTY array means "no restriction", so every existing account keeps
  // working unchanged and no data migration is needed.
  //
  // Allow-listed by catCode ("INV", "SP", "DN", "VL", "GN") rather than by
  // HolderType ObjectId, because HolderType rows are per-event — an ObjectId
  // allow-list would silently stop working as soon as a new event is created.
  // Replaces the former `allowedCategories`, which was declared with a broken
  // `ref: "Category"` (no such model) and was never read or written anywhere.
  allowedHolderTypeCodes: {
    type: [String],
    default: [],
    set: (v) =>
      (Array.isArray(v) ? v : [])
        .map((c) => String(c || "").trim().toUpperCase())
        .filter(Boolean),
  },
  // Subset of the assignable delivery methods — see ASSIGNABLE_DELIVERY_METHODS
  // in utils/issuePermissions.js. Empty = any.
  allowedDeliveryMethods: {
    type: [String],
    default: [],
  },
  // Turns `allowedEvents` (above) from a label into a hard limit: the account
  // can only see and issue for the events listed there.
  //
  // Opt-in, default false, because allowedEvents has been stored-but-ignored
  // for a long time — enforcing it unconditionally would silently re-scope
  // existing accounts that happen to have an event assigned. New issuer
  // accounts are created with it on.
  restrictToAllowedEvents: {
    type: Boolean,
    default: false,
  },
  // Section access. Default true so existing accounts are unaffected; set false
  // to lock a restricted issuer out. super_admin always bypasses these.
  canViewAllHolders: {
    type: Boolean,
    default: true,   // false = sees only the passes this account issued
  },
  canViewReports: {
    type: Boolean,
    default: true,
  },
  canViewScanFeed: {
    type: Boolean,
    default: true,
  },
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
  canManualEntry: {
    type: Boolean,
    default: false,
  },
  canBahumanaView: {
    type: Boolean,
    default: false,   // can see the bahumana announcement view
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
