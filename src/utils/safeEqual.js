const crypto = require("crypto");

// Constant-time string comparison. Hashing both sides first gives equal-length
// buffers, so timingSafeEqual neither throws on length mismatch nor leaks length.
const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb);
};

module.exports = { safeEqual };
