// ─── Entry point types ───────────────────────────────────────────────────────
// The temple's darshan gate is now called JHULAN, across the whole system.
//
// "darshan" is deliberately still ACCEPTED rather than deleted:
//   • Entry points belonging to past events keep type "darshan" — the rename
//     migration only touches current and upcoming events, so historical
//     reports still read the way they did at the time. Dropping the value
//     from the schema enum would make those rows fail validation the moment
//     anyone opened and saved one.
//   • Every filter below matches BOTH values, so a past event's gates keep
//     working exactly as before.
//
// Write "jhulan" for anything new. Match with JHULAN_TYPES, never with a bare
// === "jhulan", or legacy rows silently stop matching.

// Canonical value for new entry points.
const JHULAN = "jhulan";

// Legacy alias, retained for historical rows only. Do not write this.
const JHULAN_LEGACY = "darshan";

// Use this wherever you mean "the jhulan/darshan gate".
const JHULAN_TYPES = [JHULAN, JHULAN_LEGACY];

// Full schema enum, in display order.
const ENTRY_POINT_TYPES = [
  "venue_entry",
  JHULAN,
  JHULAN_LEGACY, // legacy — historical rows only
  "prasadam",
  "bahumana",
  "vip_seat",
  "custom",
];

/** True when this entry point is the jhulan gate, under either spelling. */
function isJhulan(type) {
  return JHULAN_TYPES.includes(String(type || "").toLowerCase());
}

module.exports = {
  JHULAN,
  JHULAN_LEGACY,
  JHULAN_TYPES,
  ENTRY_POINT_TYPES,
  isJhulan,
};
