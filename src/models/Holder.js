const mongoose = require("mongoose");

const holderSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  // References the merged HolderType doc (legacy field name kept for
  // compatibility with existing records, QR IDs and API consumers).
  catId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "HolderType",
    required: false,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    required: true,
  },
  // Reference to the SevaSlot record for this holder.
  // Populated from the event's seva slots — gives name + time.
  // Seva slot — the TIMING/seating (e.g. Pratistha Abhisheka · 7:00 AM).
  // Independent of bahumana tier — a tier-A sponsor may attend any slot.
  sevaSlotId: { type: mongoose.Schema.Types.ObjectId, ref: "SevaSlot" },

  // Category tier — A / B / C / NONE. For sponsors drives bahumana gift/kit.
  // Applies to any pass type (sponsors, donors, invitees, etc.).
  // Part of the uniqueness key (see index below), so "no category" MUST always
  // store as undefined — never as "" or "NONE". Otherwise two passes that are
  // both "no category" index as different values and both slip through.
  subCategory: {
    type: String,
    trim: true,
    uppercase: true,
    set: (v) => {
      const s = (v === null || v === undefined ? "" : String(v))
        .trim()
        .toUpperCase();
      return !s || s === "NONE" || s === "N/A" || s === "-" ? undefined : s;
    },
  },

  source: {
    type: String,
    enum: ["admin", "bulk_import", "third_party", "self"],
    default: "admin",
  }, // track where this holder was created from

  preacher: String,           // free-text name (from CSV import / legacy)
  preacherId: {               // reference to User with role "preacher" (when selected from dropdown)
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
    default: null,
  },
  venueName: String,
  email: {
    type: String,
    lowercase: true,
    trim: true,
  },
  whatsappNumber: String,
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
  },
  holderType: {
    type: String,
    default: "custom",
  },
  lifetimeDonation: {
    type: Number,
    default: 0,
  },
  donorEligibilityStatus: {
    type: String,
    enum: ["qualified", "review_required", "not_applicable"],
    default: "not_applicable",
  },
  idProof: {
    type: {
      type: String,
      enum: ["aadhar", "pan", "passport", "voter_id"],
    },
    number: String,
    verified: Boolean,
  },
  photo: String,
  notes: String,
  issuedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },
  issuedAt: {
    type: Date,
    default: Date.now,
  },
  overrideReason: String,
  // Custom rich-text instruction (HTML) shown alongside the QR pass on the
  // community app — set via the dashboard's rich text editor (single Issue
  // QR) or Instruction1/Instruction2/... columns (bulk import). Optional.
  instruction: String,
  customFields: mongoose.Schema.Types.Mixed,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

holderSchema.index({ preacherId: 1 }); // for scoped preacher reports

// ── Uniqueness: one pass per number per (holder type + category) per event ───
// A single number MAY hold several passes for the same event, as long as each
// is a different holder type or a different category:
//     Sponsor category A  +  Sponsor category B   → both allowed
//     Sponsor category A  +  Donor / Volunteer     → both allowed
//     Sponsor category A  +  Sponsor category A    → blocked (E11000)
// Holder types with no category (volunteer, general public) have subCategory
// undefined, which indexes as null — so they still get exactly one pass each.
// Seva slot is deliberately NOT in the key: it is timing/seating only.
// Replaces the old { eventId, phone } unique index, which allowed only one
// holder record per number per event and made the above impossible.
holderSchema.index(
  { eventId: 1, phone: 1, catId: 1, subCategory: 1 },
  { unique: true, name: "uniq_event_phone_type_category" },
);
// Non-unique: still needed for "find every pass on this number" lookups.
holderSchema.index({ eventId: 1, phone: 1 });
holderSchema.index({ eventId: 1 });

module.exports = mongoose.model("Holder", holderSchema);
