// Run: QR_SECRET_KEY=throwaway-test-secret node --test test/prasadamSessions.test.js
// The Vaikuntham bug: a devotee claiming coupons for two different dates must
// get two different QRs, while asking again for the same date returns the same one.
// In-memory fakes stand in for MongoDB.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const Event = require("../src/models/Event");
const HolderType = require("../src/models/HolderType");
const Holder = require("../src/models/Holder");
const QRPass = require("../src/models/QRPass");
const qrService = require("../src/services/qrService");
const thirdPartyService = require("../src/services/thirdPartyService");
const ctrl = require("../src/controllers/prasadamIntegrationController");

const EVENT = { _id: new mongoose.Types.ObjectId(), eventCode: "PRASADAM", dateStart: new Date("2026-10-01"), dateEnd: new Date("2099-01-01") };
const CATEGORY = { _id: new mongoose.Types.ObjectId(), catCode: "PR", name: "Prasadam Coupon", entryPoints: [{ _id: new mongoose.Types.ObjectId() }] };

let holders, passes, pushes;
function reset() { holders = []; passes = []; pushes = 0; }

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (v === null) return doc[k] === undefined || doc[k] === null;
  return String(doc[k]) === String(v);
});

Event.findOne = async () => EVENT;
HolderType.findOne = () => ({ populate: async () => CATEGORY });
Holder.findOne = async (f) => holders.find((h) => matches(h, f)) || null;
Holder.create = async (d) => { const h = { _id: new mongoose.Types.ObjectId(), ...d }; holders.push(h); return h; };
QRPass.findOne = async (f) => passes.find((p) => matches(p, f)) || null;
let seq = 0;
qrService.createQRPassWithUniqueId = async ({ holder, passFields }) => {
  const qrId = `ISK-PRASADAM-PR-FAKE${String.fromCharCode(65 + (++seq % 26)).repeat(2)}${"AB".repeat(3)}`.slice(0, 29);
  const p = { _id: new mongoose.Types.ObjectId(), qrId, holderId: holder._id, status: "active", ...passFields, save: async function () { return this; } };
  passes.push(p);
  return { qrId, qrPass: p, qrImage: "img", signedPayload: "jwt" };
};
thirdPartyService.pushHolder = async () => { pushes++; };

async function issue(body) {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, ...b }; return this; } };
  await ctrl.issueSingle({ body: { event_id: "PRASADAM", phone: "9951141915", name: "Devotee", ...body } }, res);
  return out;
}

const day = (offset) => new Date(Date.now() + offset * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

test("same session twice -> same QR; next session -> a fresh QR for the same person", async () => {
  reset();
  const d1 = day(1), d2 = day(8);
  const a1 = await issue({ valid_for_date: d1, session_ref: "42" });
  const a2 = await issue({ valid_for_date: d1, session_ref: "42" });
  const b1 = await issue({ valid_for_date: d2, session_ref: "57" });

  assert.strictEqual(a1.status, true);
  assert.match(a1.message, /generated/);
  assert.strictEqual(a2.qr_id, a1.qr_id, "same session reuses the QR");
  assert.match(a2.message, /already exists/);
  assert.notStrictEqual(b1.qr_id, a1.qr_id, "a later session must not return last week's (used) QR");
  assert.strictEqual(holders.length, 1, "one person, one Holder");
  assert.strictEqual(passes.length, 2, "one pass per session");
  assert.ok(passes.every((p) => p.windowed === true));
  assert.strictEqual(a1.session_ref, "42");
  assert.ok(new Date(a1.valid_until) > new Date(a1.valid_from));
});

test("date-only sessions are keyed by the date", async () => {
  reset();
  const d1 = day(2);
  const x = await issue({ valid_for_date: d1 });
  const y = await issue({ valid_for_date: d1 });
  const z = await issue({ valid_for_date: day(9) });
  assert.strictEqual(x.qr_id, y.qr_id);
  assert.notStrictEqual(x.qr_id, z.qr_id);
  assert.strictEqual(passes[0].sessionKey, `legacy:date:${d1}`, "no registered client -> namespaced as legacy");
});

test("re-asking after the office moves the session follows the new window", async () => {
  reset();
  const d = day(3);
  const first = await issue({ valid_for_date: d, session_ref: "9", valid_until: new Date(Date.now() + 3 * 864e5 + 6 * 3600e3).toISOString() });
  const again = await issue({ valid_for_date: d, session_ref: "9", valid_until: new Date(Date.now() + 3 * 864e5 + 9 * 3600e3).toISOString() });
  assert.strictEqual(again.qr_id, first.qr_id);
  assert.notStrictEqual(again.valid_until, first.valid_until);
  assert.strictEqual(passes.length, 1);
});

test("a revoked coupon is not silently re-issued for that session", async () => {
  reset();
  const d = day(2);
  await issue({ valid_for_date: d, session_ref: "5" });
  passes[0].status = "revoked";
  const r = await issue({ valid_for_date: d, session_ref: "5" });
  assert.strictEqual(r.code, 400);
  assert.match(r.message, /cancelled/);
});

test("no session fields: exactly the old behaviour (one QR per phone per event)", async () => {
  reset();
  const a = await issue({});
  const b = await issue({});
  assert.strictEqual(a.qr_id, b.qr_id);
  assert.strictEqual(passes.length, 1);
  assert.strictEqual(passes[0].windowed, undefined);
  assert.strictEqual(a.valid_until, undefined);
});

test("bad session input is a clear 400", async () => {
  reset();
  assert.match((await issue({ valid_for_date: "yesterday" })).message, /YYYY-MM-DD/);
  assert.match((await issue({ valid_for_date: day(-3) })).message, /already ended/);
  assert.match((await issue({ session_ref: "7" })).message, /needs valid_for_date/);
  assert.strictEqual(passes.length, 0);
});
