const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const identifierOf = (req) => {
  const b = req.body || {};
  const raw = b.email || b.phone || b.username || b.token || "";
  return String(typeof raw === "object" ? "" : raw).trim().toLowerCase().slice(0, 100);
};

const base = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
};

// Credential endpoints: 10 attempts / 15 min per IP + account identifier, plus a
// looser per-IP ceiling so one address cannot sweep many accounts. Successful
// logins are not counted, so a venue sharing one IP is not locked out.
const authLimiters = (message = "Too many attempts. Please try again later.") => [
  rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${identifierOf(req)}`,
    message: { error: message },
  }),
  rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: 100,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: message },
  }),
];

// Forgot / reset password: every request counts (nothing is "successful" to skip).
const passwordResetLimiters = () => [
  rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${identifierOf(req)}`,
    message: { error: "Too many attempts. Please try again later." },
  }),
  rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: 50,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: "Too many attempts. Please try again later." },
  }),
];

// Generous ceiling for machine-to-machine / unauthenticated surfaces.
const generalLimiter = (limit = 600) =>
  rateLimit({
    ...base,
    windowMs: 60 * 1000,
    limit,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { status: false, message: "Too many requests. Please slow down." },
  });

module.exports = { authLimiters, passwordResetLimiters, generalLimiter };
