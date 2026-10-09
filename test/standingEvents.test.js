// Run: QR_SECRET_KEY=x node --test test/standingEvents.test.js
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";
const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const Event = require("../src/models/Event");
const EntryPoint = require("../src/models/EntryPoint");
const HolderType = require("../src/models/HolderType");
const User = require("../src/models/User");
const { parseStandingEvents, ensureStandingEvent } = require("../src/migrations/standingEvents");

let db;
const reset = (admins = 1) => {
  db = { events: [], eps: [], hts: [], admins: Array.from({ length: admins }, () => ({ _id: new mongoose.Types.ObjectId(), role: "super_admin" })) };
};
const find = (list, f) => list.find((d) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v))) || null;
Event.findOne = async (f) => find(db.events, f);
Event.create = async (d) => { const e = { _id: new mongoose.Types.ObjectId(), ...d }; db.events.push(e); return e; };
EntryPoint.findOne = async (f) => find(db.eps, f);
EntryPoint.create = async (d) => { const e = { _id: new mongoose.Types.ObjectId(), ...d }; db.eps.push(e); return e; };
HolderType.findOne = async (f) => find(db.hts, f);
HolderType.create = async (d) => { db.hts.push(d); return d; };
User.findOne = () => { const r = Promise.resolve(db.admins[0] || null); r.sort = () => Promise.resolve(db.admins[0] || null); return r; };

const quiet = () => {};

test("creates the event, coupon counter and PR type once; re-run creates nothing", async () => {
  reset();
  const first = await ensureStandingEvent({ code: "PRASADAM", name: "Weekend Prasadam", log: quiet });
  assert.deepStrictEqual(first, ["event PRASADAM", "Prasadam Coupon counter", "pass type PR"]);
  assert.strictEqual(db.events[0].eventCode, "PRASADAM");
  assert.ok(db.events[0].dateEnd > new Date("2090-01-01"));
  assert.strictEqual(db.eps[0].type, "prasadam_coupon");
  assert.strictEqual(String(db.hts[0].entryPoints[0]), String(db.eps[0]._id));
  const again = await ensureStandingEvent({ code: "PRASADAM", name: "Weekend Prasadam", log: quiet });
  assert.deepStrictEqual(again, []);
  assert.strictEqual(db.events.length + db.eps.length + db.hts.length, 3);
});

test("existing event without counter/type gets only the missing parts", async () => {
  reset();
  db.events.push({ _id: new mongoose.Types.ObjectId(), eventCode: "PRASADAM" });
  const out = await ensureStandingEvent({ code: "PRASADAM", name: "x", log: quiet });
  assert.deepStrictEqual(out, ["Prasadam Coupon counter", "pass type PR"]);
  assert.strictEqual(db.events.length, 1);
});

test("no super_admin: skipped safely", async () => {
  reset(0);
  assert.deepStrictEqual(await ensureStandingEvent({ code: "PRASADAM", name: "x", log: quiet }), []);
  assert.strictEqual(db.events.length, 0);
});

test("STANDING_EVENTS parsing", () => {
  assert.deepStrictEqual(parseStandingEvents(undefined), [{ code: "PRASADAM", name: "Weekend Prasadam" }]);
  assert.deepStrictEqual(parseStandingEvents("none"), []);
  assert.deepStrictEqual(parseStandingEvents("prasadam:Sunday Feast, FOLK26"), [{ code: "PRASADAM", name: "Sunday Feast" }, { code: "FOLK26", name: "Weekend Prasadam" }]);
  assert.deepStrictEqual(parseStandingEvents("bad code!"), []);
});
