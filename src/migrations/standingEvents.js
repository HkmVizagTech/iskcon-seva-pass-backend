// ─── Standing events (idempotent, safe to run every boot) ────────────────────
//
// A standing event (e.g. PRASADAM) is permanent: every dated session's coupons
// are issued into it with their own validity window (see utils/sessionWindow.js),
// so nobody has to create an event per weekend. This makes sure each one exists
// with its "Prasadam Coupon" counter and "PR" pass type, creating only what is
// missing — re-running changes nothing that exists.
//
// Which events: env STANDING_EVENTS, a comma list of CODE or CODE:Name
// (default "PRASADAM:Weekend Prasadam"; set it to "none" to turn this off).

const Event = require("../models/Event");
const EntryPoint = require("../models/EntryPoint");
const HolderType = require("../models/HolderType");
const User = require("../models/User");
const { PRASADAM_COUPON } = require("../utils/entryPointTypes");

const DEFAULT = "PRASADAM:Weekend Prasadam";

function parseStandingEvents(raw = process.env.STANDING_EVENTS) {
  const value = raw === undefined || raw === null || String(raw).trim() === "" ? DEFAULT : String(raw).trim();
  if (value.toLowerCase() === "none") return [];
  return value.split(",").map((part) => {
    const [code, ...name] = part.split(":");
    return { code: String(code).trim().toUpperCase(), name: name.join(":").trim() || "Weekend Prasadam" };
  }).filter((e) => /^[A-Z0-9]{2,20}$/.test(e.code));
}

// Returns a list of what was created, e.g. ["event PRASADAM", "counter", "pass type PR"].
async function ensureStandingEvent({ code, name, adminEmail = null, dryRun = false, log = console.log }) {
  const created = [];
  let event = await Event.findOne({ eventCode: code });
  if (!event) {
    const admin = adminEmail
      ? await User.findOne({ email: String(adminEmail).toLowerCase() })
      : await User.findOne({ role: "super_admin" }).sort({ createdAt: 1 });
    if (!admin) {
      log(`Standing event ${code}: no super_admin to record as creator — skipped`);
      return created;
    }
    created.push(`event ${code}`);
    if (!dryRun) {
      event = await Event.create({
        name,
        eventCode: code,
        description: "Standing event: coupons carry their own date window.",
        dateStart: new Date(),
        dateEnd: new Date("2099-12-31T18:29:59.999Z"),
        createdBy: admin._id,
      });
    }
  }
  if (!event) return created; // dry run of a new event

  let ep = await EntryPoint.findOne({ eventId: event._id, type: PRASADAM_COUPON });
  if (!ep) {
    created.push("Prasadam Coupon counter");
    if (!dryRun) {
      ep = await EntryPoint.create({
        eventId: event._id,
        name: "Prasadam Coupon",
        stationLabel: "Prasadam Coupon Counter",
        type: PRASADAM_COUPON,
      });
    }
  }

  const ht = await HolderType.findOne({ eventId: event._id, catCode: "PR" });
  if (!ht && ep) {
    created.push("pass type PR");
    if (!dryRun) {
      await HolderType.create({
        eventId: event._id,
        name: "Prasadam Coupon",
        catCode: "PR",
        color: "#16A34A",
        icon: "🍛",
        entryPoints: [ep._id],
      });
    }
  }
  if (created.length) log(`Standing event ${code}: ${dryRun ? "would create" : "created"} ${created.join(", ")}`);
  return created;
}

async function runStandingEvents() {
  for (const e of parseStandingEvents()) {
    await ensureStandingEvent(e);
  }
}

module.exports = { parseStandingEvents, ensureStandingEvent, runStandingEvents };
