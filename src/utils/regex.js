// Escape user input before embedding it in a RegExp (prevents ReDoS / invalid-pattern 500s).
const escapeRegex = (s) => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { escapeRegex };
