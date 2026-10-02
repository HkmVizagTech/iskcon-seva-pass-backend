// ─── Create a STANDING event: one permanent event that serves many dated sessions ──
//
// A standing event (e.g. weekend prasadam) is created once. Each coupon issued
// into it carries its own validity window (valid_for_date / valid_until /
// session_ref on POST /api/integration/prasadam/qr), so nobody has to create a
// new event for every Saturday or Sunday. Its own dates only need to span the
// period it will be used; the event's gate window is ignored for windowed
// coupons.
//
// Creates, idempotently (re-running changes nothing that exists):
//   - the Event (dateStart now, dateEnd 2099-12-31)
//   - a "Prasadam Coupon" counter entry point (type prasadam_coupon) that
//     volunteers get assigned to in the dashboard
//   - the "Prasadam Coupon" (PR) pass type pointing at that counter
//
// Usage:
//   node scripts/create-standing-event.js --code PRASADAM --name "Weekend Prasadam" --admin you@example.com
//   node scripts/create-standing-event.js --code PRASADAM --dry-run
//
// --admin  email of the super_admin recorded as creator (default: first super_admin)

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const Event = require("../src/models/Event");
const EntryPoint = require("../src/models/EntryPoint");
const HolderType = require("../src/models/HolderType");
const User = require("../src/models/User");
const { PRASADAM_COUPON } = require("../src/utils/entryPointTypes");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
};
const DRY_RUN = process.argv.includes("--dry-run");
const CODE = String(arg("code", "PRASADAM")).trim().toUpperCase();
const NAME = arg("name", "Weekend Prasadam");
const ADMIN_EMAIL = arg("admin", null);

if (!/^[A-Z0-9]{2,20}$/.test(CODE)) {
  console.error("--code must be 2-20 letters/digits (it is part of every QR id)");
  process.exit(1);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);
  console.log(`Connected${DRY_RUN ? " (dry-run: nothing is written)" : ""}`);

  let event = await Event.findOne({ eventCode: CODE });
  if (event) {
    console.log(`Event ${CODE} already exists ("${event.name}") — reusing`);
  } else {
    const admin = ADMIN_EMAIL
      ? await User.findOne({ email: ADMIN_EMAIL.toLowerCase() })
      : await User.findOne({ role: "super_admin" });
    if (!admin) throw new Error("No super_admin found; pass --admin <email>");
    console.log(`Creating event ${CODE} "${NAME}" (creator ${admin.email})`);
    if (!DRY_RUN) {
      event = await Event.create({
        name: NAME,
        eventCode: CODE,
        description: "Standing event: coupons carry their own date window.",
        dateStart: new Date(),
        dateEnd: new Date("2099-12-31T18:29:59.999Z"),
        createdBy: admin._id,
      });
    }
  }
  if (!event) return console.log("Dry run: counter and pass type would be created next.");

  let ep = await EntryPoint.findOne({ eventId: event._id, type: PRASADAM_COUPON });
  if (ep) {
    console.log(`Coupon counter exists: "${ep.stationLabel}"`);
  } else {
    console.log("Creating the Prasadam Coupon counter");
    if (!DRY_RUN) {
      ep = await EntryPoint.create({
        eventId: event._id,
        name: "Prasadam Coupon",
        stationLabel: "Prasadam Coupon Counter",
        type: PRASADAM_COUPON,
      });
    }
  }

  let ht = await HolderType.findOne({ eventId: event._id, catCode: "PR" });
  if (ht) {
    console.log(`Pass type PR exists: "${ht.name}"`);
  } else if (ep) {
    console.log("Creating the Prasadam Coupon (PR) pass type");
    if (!DRY_RUN) {
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

  console.log("\nDone. Next:");
  console.log(`  1. Dashboard → Volunteers: assign the "Prasadam Coupon Counter" of ${CODE} to the counter volunteers.`);
  console.log(`  2. Community app (server page → Seva Pass): set the prasadam event code to ${CODE}.`);
}

main()
  .catch((e) => {
    console.error("Failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
