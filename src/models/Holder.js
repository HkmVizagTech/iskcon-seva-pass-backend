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
  // Which specific day (within a multi-day event) this holder's own
  // seva/program falls on — set via the bulk sheet's "Date" column.
  // Overrides the event's overall dateStart for THIS holder's QR pass and
  // WhatsApp date display. Null means "use the event's dateStart" (default).
  sevaDate: Date,
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
  // Distinguishes a DELIBERATE second pass for the same number + holder type +
  // category from an accidental duplicate. 1 for the first (and for anything
  // issued without explicit intent), 2+ for each additional pass the admin
  // consciously issues. Part of the uniqueness key — see the index below.
  passSeq: {
    type: Number,
    default: 1,
    min: 1,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

holderSchema.index({ preacherId: 1 }); // for scoped preacher reports

// ── Uniqueness ───────────────────────────────────────────────────────────────
// A number may hold as many passes as it legitimately needs — a different
// holder type, a different category, or a SECOND pass of the same type and
// category (the donor who sponsors twice at tier A).
//
// What must still be prevented is the ACCIDENTAL duplicate: a double-clicked
// submit, a re-run import, two concurrent requests. Those are indistinguishable
// from a deliberate second pass in the data, so `passSeq` is the discriminator:
//
//     Sponsor A (seq 1)  +  Sponsor B (seq 1)        → allowed, different category
//     Sponsor A (seq 1)  +  Donor (seq 1)            → allowed, different type
//     Sponsor A (seq 1)  +  Sponsor A (seq 2)        → allowed, DELIBERATE extra
//     Sponsor A (seq 1)  +  Sponsor A (seq 1)        → blocked (E11000)
//
// Anything issued without explicit intent gets seq 1 and therefore collides,
// so a race or a stray double-submit is still caught by the database. Issuing
// an additional pass on purpose sets seq = max + 1 and inserts cleanly.
//
// Holder types with no category (volunteer, general public) have subCategory
// undefined, which indexes as null — the same rules apply.
// Seva slot is deliberately NOT in the key: it is timing/seating only.
holderSchema.index(
  { eventId: 1, phone: 1, catId: 1, subCategory: 1, passSeq: 1 },
  { unique: true, name: "uniq_event_phone_type_category_seq" },
);
// Non-unique: still needed for "find every pass on this number" lookups.
holderSchema.index({ eventId: 1, phone: 1 });
holderSchema.index({ eventId: 1 });

module.exports = mongoose.model("Holder", holderSchema);
