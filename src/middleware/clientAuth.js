const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const ClientApp = require("../models/ClientApp");
const Event = require("../models/Event");
const { SCOPES, hashKey } = require("../utils/clientKeys");
const { safeEqual } = require("../utils/safeEqual");

const LEGACY_LIMIT_PER_MIN = 600;
const TOUCH_EVERY_MS = 5 * 60 * 1000;
let warnedLegacy = false;

const wildcard = (list) => !Array.isArray(list) || list.length === 0 || list.includes("*");

// Identity of the caller: a registered client app, or the old shared
// INTEGRATION_API_KEY (kept so existing callers keep working while they move to
// their own key; it acts as an unrestricted client named "legacy").
async function identify(req) {
  const header = req.headers["x-api-key"] || "";
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const provided = String(header || bearer || "").trim();
  if (!provided) return null;

  const app = await ClientApp.findOne({ keyHash: hashKey(provided), status: "active" }).lean();
  if (app) {
    if (!app.lastUsedAt || Date.now() - new Date(app.lastUsedAt).getTime() > TOUCH_EVERY_MS) {
      ClientApp.updateOne({ _id: app._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    return {
      id: String(app._id),
      slug: app.slug,
      name: app.name,
      scopes: app.scopes || [],
      allowedEvents: app.allowedEvents,
      allowedPassTypes: app.allowedPassTypes,
      rateLimitPerMin: app.rateLimitPerMin || 300,
      legacy: false,
    };
  }

  const shared = process.env.INTEGRATION_API_KEY;
  if (shared && safeEqual(provided, shared)) {
    if (!warnedLegacy) {
      warnedLegacy = true;
      console.warn("⚠️  A caller is using the shared INTEGRATION_API_KEY — give each app its own key (POST /api/clients).");
    }
    return {
      id: "legacy",
      slug: "legacy",
      name: "Shared integration key",
      scopes: Object.keys(SCOPES),
      allowedEvents: ["*"],
      allowedPassTypes: ["*"],
      rateLimitPerMin: LEGACY_LIMIT_PER_MIN,
      legacy: true,
    };
  }
  return null;
}

// Per-client request ceiling (after authentication, so the key is the identity).
const perClientLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (req.client ? req.client.rateLimitPerMin : 60),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => (req.client ? `client:${req.client.id}` : ipKeyGenerator(req.ip)),
  message: { status: false, message: "Too many requests for this API key. Please slow down." },
});

// Authenticates the caller as a client app and requires `scope`.
//   router.post("/x", ...clientAuth("passes:issue"), handler)
// `scope` may also be a list: any one of them is enough.
function clientAuth(scope) {
  const needed = scope ? (Array.isArray(scope) ? scope : [scope]) : [];
  for (const s of needed) if (!SCOPES[s]) throw new Error(`Unknown client scope: ${s}`);
  const authenticate = async (req, res, next) => {
    try {
      const client = await identify(req);
      if (!client) return res.status(401).json({ status: false, message: "Invalid API key" });
      if (needed.length && !needed.some((s) => client.scopes.includes(s))) {
        return res.status(403).json({ status: false, message: `This API key is not allowed to use '${needed.join("' or '")}'` });
      }
      req.client = client;
      next();
    } catch (err) {
      console.error("clientAuth error:", err.message);
      res.status(500).json({ status: false, message: "Authentication failed" });
    }
  };
  return [authenticate, perClientLimiter];
}

const eventAllowed = (client, eventCode) =>
  !client || wildcard(client.allowedEvents) ||
  client.allowedEvents.map((c) => String(c).toUpperCase()).includes(String(eventCode).toUpperCase());

const passTypeAllowed = (client, catCode) =>
  !client || wildcard(client.allowedPassTypes) ||
  client.allowedPassTypes.map((c) => String(c).toUpperCase()).includes(String(catCode).toUpperCase());

// Rejects a request that names an event this client may not use. The event can
// be named by code, by the third-party id or by _id, so it is resolved first and
// compared by its real code. Unknown events fall through to the controller's 404.
async function guardClientEvent(req, res, next) {
  try {
    if (!req.client || wildcard(req.client.allowedEvents)) return next();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const raw = req.params.eventCode || body.event_id || body.eventId || req.query.event_id;
    if (raw === undefined || raw === null || typeof raw === "object" || String(raw).trim() === "") return next();
    const ref = String(raw).trim();
    const event = await Event.findOne({
      $or: [
        { eventCode: ref.toUpperCase() },
        { thirdPartyEventId: ref },
        { _id: /^[0-9a-fA-F]{24}$/.test(ref) ? ref : null },
      ],
    }).select("eventCode").lean();
    if (event && !eventAllowed(req.client, event.eventCode)) {
      return res.status(403).json({ status: false, message: "This API key is not allowed to use that event" });
    }
    next();
  } catch (err) {
    console.error("guardClientEvent error:", err.message);
    res.status(500).json({ status: false, message: "Authorization failed" });
  }
}

module.exports = { clientAuth, guardClientEvent, eventAllowed, passTypeAllowed, wildcard };
