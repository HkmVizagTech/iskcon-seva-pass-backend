// Shared label derivation for the denormalized Holder.holderType string.
// After the HolderType/Category merge, new holders derive this label from
// their type's catCode so reports grouping by holderType stays meaningful.
// The migration script (scripts/migrate-holder-type-merge.js) backfills
// existing records using the same mapping.

const CODE_MAP = {
  SP: "sponsor",
  DN: "donor",
  VL: "volunteer",
  GN: "general",
  VP: "vip",
  INV: "invitee",
  PR: "prasadam",
};

// Accepts either a resolved HolderType document ({ catCode, name }) or a raw
// code string. Falls back to the type name, then "custom".
function deriveHolderTypeLabel(typeOrCode) {
  if (!typeOrCode) return "custom";
  if (typeof typeOrCode === "string") {
    const code = typeOrCode.toUpperCase();
    return CODE_MAP[code] || typeOrCode.toLowerCase();
  }
  const code = (typeOrCode.catCode || "").toUpperCase();
  if (code && CODE_MAP[code]) return CODE_MAP[code];
  const name = (typeOrCode.name || "").trim();
  return name ? name.toLowerCase() : "custom";
}

module.exports = { CODE_MAP, deriveHolderTypeLabel };
