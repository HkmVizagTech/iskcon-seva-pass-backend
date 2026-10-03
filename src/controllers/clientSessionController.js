// ─── Session-wide changes from a client app ──────────────────────────────────
// A client issues session passes with a session_ref (see utils/sessionWindow.js).
// When it later cancels or moves that session, every pass it already issued for
// it must follow — otherwise cancelled coupons still scan, and moved ones scan
// at the old time.
//
//   POST /api/integration/sessions/revoke  { event_id, session_ref }
//   POST /api/integration/sessions/window  { event_id, session_ref, valid_for_date?, valid_from?, valid_until? }
//
// Only the calling client's own sessions are touched (session keys are
// namespaced per client).

const Event = require("../models/Event");
const QRPass = require("../models/QRPass");
const { parseSessionWindow } = require("../utils/sessionWindow");

const str = (v, max) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "");

async function target(req, res) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const eventRef = str(b.event_id, 60);
  const ref = str(b.session_ref, 64);
  if (!eventRef) { res.status(400).json({ status: false, message: "event_id is required" }); return null; }
  if (!ref) { res.status(400).json({ status: false, message: "session_ref is required" }); return null; }
  const event = await Event.findOne({
    $or: [
      { eventCode: eventRef.toUpperCase() },
      { thirdPartyEventId: eventRef },
      { _id: /^[0-9a-fA-F]{24}$/.test(eventRef) ? eventRef : null },
    ],
  }).select("_id eventCode").lean();
  if (!event) { res.status(404).json({ status: false, message: `Event not found: ${eventRef}` }); return null; }
  return { event, body: b, ref, sessionKey: `${req.client.slug}:${ref}` };
}

const collectedFilter = { redemptionHistory: { $elemMatch: { result: "granted" } } };

exports.revoke = async (req, res) => {
  try {
    const t = await target(req, res);
    if (!t) return;
    const filter = { eventId: t.event._id, sessionKey: t.sessionKey, status: "active" };
    const collected = await QRPass.countDocuments({ ...filter, ...collectedFilter });
    const out = await QRPass.updateMany(filter, { $set: { status: "revoked", updatedAt: new Date() } });
    res.json({ status: true, session_ref: t.ref, revoked: out.modifiedCount || 0, already_collected: collected });
  } catch (error) {
    console.error("[Integration] session revoke error:", error);
    res.status(500).json({ status: false, message: "Could not cancel the session's passes" });
  }
};

exports.window = async (req, res) => {
  try {
    const t = await target(req, res);
    if (!t) return;
    const win = parseSessionWindow({ ...t.body, session_ref: t.ref });
    if (!win) return res.status(400).json({ status: false, message: "valid_for_date or valid_until is required" });
    if (win.error) return res.status(400).json({ status: false, message: win.error });
    const out = await QRPass.updateMany(
      { eventId: t.event._id, sessionKey: t.sessionKey, status: { $ne: "revoked" } },
      { $set: { validFrom: win.validFrom, validUntil: win.validUntil, updatedAt: new Date() } },
    );
    res.json({
      status: true, session_ref: t.ref, updated: out.modifiedCount || 0,
      valid_from: win.validFrom, valid_until: win.validUntil,
    });
  } catch (error) {
    console.error("[Integration] session window error:", error);
    res.status(500).json({ status: false, message: "Could not move the session" });
  }
};
