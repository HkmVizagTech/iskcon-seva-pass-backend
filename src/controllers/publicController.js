// ─── Public (unauthenticated) controller ──────────────────────────────────
// Self-service pass check for devotees at the venue.
//
// WHY THIS EXISTS: not every donor receives their QR on WhatsApp (wrong
// number on record, delivery failure, message buried in a busy inbox). Rather
// than each of them queueing at the helpdesk to find out whether they are on
// the list at all, they can check their own mobile number here first, then
// collect the pass at the counter.
//
// ── SECURITY NOTES — read before changing the response shape ───────────────
//
// 1. This endpoint is public and unauthenticated, so it is a phone-number
//    enumeration oracle BY DESIGN: anyone can type numbers and learn whether
//    that number belongs to a devotee on the list. That is accepted (the
//    payoff is a shorter helpdesk queue), and mitigated by the hard rate
//    limit in routes/public.js. Keep the disclosed fields to the minimum
//    below — do not add phone, email, preacher, amount or tier.
//
// 2. It must NEVER return the qrId. qrService.validateQR accepts a bare
//    qrId string as a valid QR (the non-JWT fallback path used by
//    re-rendered passes), so a leaked qrId can simply be encoded into a QR
//    code by anyone and scanned at the gate. Leaking a qrId here is
//    equivalent to leaking a working pass. Same for payloadSigned.
//
// The devotee is told only "you are on the list, collect at the helpdesk".
// Staff at the counter verify identity and hand over (or issue) the pass.

const Event = require("../models/Event");
const Holder = require("../models/Holder");

// Same normalisation as the integration controller: store/lookup as a
// 12-digit number with the country code.
function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
}

// The festival currently running (dateStart <= now <= dateEnd). If two
// overlap, the most recently started one wins — that is the one people are
// standing at. Returns null when nothing is running, which the page turns
// into a friendly "no festival right now" message rather than "not found",
// so a devotee checking a day early is not told they are missing.
async function findActiveEvent() {
  const now = new Date();
  return Event.findOne({
    dateStart: { $lte: now },
    dateEnd: { $gte: now },
  })
    .sort({ dateStart: -1 })
    .select("_id name")
    .lean();
}

/**
 * POST /api/public/pass-lookup
 * Body: { phone: "9876543210" }
 *
 * Response (found):
 *   { status: true, found: true, event: { name },
 *     holder: { name, passType, venue, sevaSlot } }
 * Response (not found):
 *   { status: true, found: false, event: { name } }
 * Response (nothing running):
 *   { status: true, found: false, noActiveEvent: true }
 */
exports.passLookup = async (req, res) => {
  try {
    const raw = req.body?.phone ?? req.body?.user_phone_number ?? "";
    const digits = String(raw).replace(/\D/g, "");

    if (digits.length < 10) {
      return res.status(400).json({
        status: false,
        message: "Please enter your 10-digit mobile number.",
      });
    }

    const phone = normalisePhone(digits);

    const event = await findActiveEvent();
    if (!event) {
      return res.json({ status: true, found: false, noActiveEvent: true });
    }

    const holder = await Holder.findOne({ eventId: event._id, phone })
      .select("name catId sevaSlotId venueName")
      .populate("catId", "name")
      .populate("sevaSlotId", "name time displayLabel")
      .lean();

    if (!holder) {
      return res.json({
        status: true,
        found: false,
        event: { name: event.name },
      });
    }

    const slot = holder.sevaSlotId;
    const slotLabel = slot
      ? slot.displayLabel || [slot.name, slot.time].filter(Boolean).join(" · ")
      : "";

    return res.json({
      status: true,
      found: true,
      event: { name: event.name },
      holder: {
        name: holder.name || "",
        passType: holder.catId?.name || "",
        venue: holder.venueName || "",
        sevaSlot: slotLabel,
      },
    });
  } catch (error) {
    console.error("[Public] passLookup error:", error);
    return res.status(500).json({
      status: false,
      message: "Something went wrong. Please check at the helpdesk.",
    });
  }
};
