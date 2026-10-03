const crypto = require("crypto");

// What a client app may be allowed to do. Add new capabilities here and gate the
// matching route with clientAuth("<scope>").
const SCOPES = {
  "events:read": "List events, venues, entry points and pass types",
  "events:write": "Change which pass types the devotee app may use",
  "passes:issue": "Issue passes (seva pass, volunteer QR, generic session passes)",
  "passes:read": "Read a pass's status and scan history",
  "passes:scan": "Scan passes at a counter (the app names who scanned)",
  "prasadam:issue": "Issue prasadam coupons",
  "preachers:manage": "Create, list and remove preachers",
};

// Keys are high-entropy random tokens, so a plain SHA-256 is enough to store them;
// the clear key is shown once at creation and never kept.
const KEY_PREFIX = "skp_live_";

function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(30).toString("base64url");
}

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

// First characters, enough to recognise a key in a list without revealing it.
const keyHint = (key) => String(key).slice(0, KEY_PREFIX.length + 4);

module.exports = { SCOPES, KEY_PREFIX, generateKey, hashKey, keyHint };
