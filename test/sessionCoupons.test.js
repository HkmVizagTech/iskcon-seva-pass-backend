// Run: QR_SECRET_KEY=throwaway-test-secret node --test test/sessionCoupons.test.js
// No database: model finders used by validateQR are stubbed.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const qrService = require("../src/services/qrService");
const QRPass = require("../src/models/QRPass");
const EntryPoint = require("../src/models/EntryPoint");
const Event = require("../src/models/Event");
const { parseSessionWindow } = require("../src/utils/sessionWindow");

const NOW = new Date("2026-10-10T06:00:00Z"); // Sat 11:30 IST

// ── parseSessionWindow ──────────────────────────────────────────────────────
test("no session fields -> not session-scoped (legacy behaviour)", () => {
  assert.strictEqual(parseSessionWindow({}, NOW), null);
  assert.strictEqual(parseSessionWindow({ event_id: "X", phone: "1" }, NOW), null);
});

test("valid_for_date covers the whole IST day; session_ref becomes the key", () => {
  const w = parseSessionWindow({ valid_for_date: "2026-10-11", session_ref: 42 }, NOW);
  assert.strictEqual(w.sessionKey, "42");
  assert.strictEqual(w.sessionRef, "42");
  assert.strictEqual(w.validFrom.toISOString(), "2026-10-10T18:30:00.000Z"); // 00:00 IST
  assert.strictEqual(w.validUntil.toISOString(), "2026-10-11T18:29:59.999Z"); // 23:59:59.999 IST
});

test("without session_ref the key is the date", () => {
  const w = parseSessionWindow({ valid_for_date: "2026-10-11" }, NOW);
  assert.strictEqual(w.sessionKey, "date:2026-10-11");
  assert.strictEqual(w.sessionRef, null);
});

test("valid_until narrows the day; valid_from overrides the start", () => {
  const w = parseSessionWindow(
    { valid_for_date: "2026-10-11", valid_from: "2026-10-11T04:00:00Z", valid_until: "2026-10-11T09:30:00Z" },
    NOW,
  );
  assert.strictEqual(w.validFrom.toISOString(), "2026-10-11T04:00:00.000Z");
  assert.strictEqual(w.validUntil.toISOString(), "2026-10-11T09:30:00.000Z");
});

test("rejects bad input", () => {
  const err = (b) => parseSessionWindow(b, NOW).error;
  assert.match(err({ session_ref: "9" }), /needs valid_for_date or valid_until/);
  assert.match(err({ valid_for_date: "11-10-2026" }), /YYYY-MM-DD/);
  assert.match(err({ valid_for_date: "2026-02-31" }), /real calendar date/);
  assert.match(err({ valid_for_date: "2026-10-09" }), /already ended/);
  assert.match(err({ valid_for_date: "2026-10-11", valid_until: "2026-10-10T00:00:00Z" }), /after valid_from/);
  assert.match(err({ valid_from: "2026-10-11T00:00:00Z" }), /valid_for_date or valid_until/);
  assert.match(err({ valid_for_date: "2026-10-11", valid_until: "2027-03-01T00:00:00Z" }), /31 days/);
  assert.match(err({ valid_for_date: "2026-10-11", valid_until: "garbage" }), /valid_until is not/);
});

// ── validateQR on session coupons ───────────────────────────────────────────
const EP_ID = new mongoose.Types.ObjectId();
const EVENT_ID = new mongoose.Types.ObjectId();
const OPAQUE_ID = "ISK-PRASADAM-PR-ABCDEFGHJKLM";

const fakeQuery = (value) => {
  const q = new Proxy({}, { get: (_, prop) => (prop === "lean" ? async () => value : () => q) });
  return q;
};

function setup({ pass, event }) {
  const o = { p: QRPass.findOne, e: EntryPoint.findById, v: Event.findById };
  QRPass.findOne = () => fakeQuery(pass);
  EntryPoint.findById = () => fakeQuery({ _id: EP_ID, eventId: EVENT_ID, type: "prasadam_coupon", multiEntryAllowed: false });
  Event.findById = () => fakeQuery(event);
  return () => { QRPass.findOne = o.p; EntryPoint.findById = o.e; Event.findById = o.v; };
}

// Times are relative to the real clock: validateQR refuses an offline "scan time"
// later than now, so fixed future dates would be clamped.
const H = 3600e3;
const ago = (h) => new Date(Date.now() - h * H);

// Standing event: year-long, so the event window alone would accept any day.
const standingEvent = {
  name: "Weekend Prasadam",
  dateStart: ago(24 * 30),
  dateEnd: new Date(Date.now() + 300 * 24 * H),
};

// A session that ran from 48h ago to 24h ago
const couponPass = (extra = {}) => ({
  eventId: EVENT_ID,
  entryPoints: [EP_ID],
  status: "active",
  redemptionHistory: [],
  holderId: { name: "Devotee", catId: { catCode: "PR", name: "Prasadam Coupon" } },
  catId: { catCode: "PR", name: "Prasadam Coupon" },
  windowed: true,
  validFrom: ago(48),
  validUntil: ago(24),
  ...extra,
});

test("coupon scans inside its window (opaque id accepted)", async () => {
  const restore = setup({ pass: couponPass(), event: standingEvent });
  try {
    const res = await qrService.validateQR(OPAQUE_ID, EP_ID.toString(), null, ago(36));
    assert.strictEqual(res.valid, true);
  } finally { restore(); }
});

test("the same coupon is refused on another day (not_yet_valid before, expired after)", async () => {
  const restore = setup({ pass: couponPass(), event: standingEvent });
  try {
    const before = await qrService.validateQR(OPAQUE_ID, EP_ID.toString(), null, ago(60));
    assert.strictEqual(before.reason, "not_yet_valid");
    assert.match(before.message, /Coupon not valid yet/);
    // no `at`: judged now, a day after the session ended — the year-long event window must not rescue it
    const after = await qrService.validateQR(OPAQUE_ID, EP_ID.toString());
    assert.strictEqual(after.reason, "expired");
    assert.match(after.message, /Coupon expired/);
  } finally { restore(); }
});

test("an offline scan is judged at scan time, not sync time", async () => {
  const restore = setup({ pass: couponPass(), event: standingEvent });
  try {
    // scanned inside the session, synced a day later (now is past the window)
    const ok = await qrService.validateQR(OPAQUE_ID, EP_ID.toString(), null, ago(30));
    assert.strictEqual(ok.valid, true);
    const live = await qrService.validateQR(OPAQUE_ID, EP_ID.toString());
    assert.strictEqual(live.valid, false);
  } finally { restore(); }
});

test("a future `at` is ignored (client clock cannot push validation forward)", async () => {
  const restore = setup({ pass: couponPass({ validFrom: ago(1), validUntil: new Date(Date.now() + H) }), event: standingEvent });
  try {
    // session valid now; a forged scan time 10 days ahead must be clamped to now, so still valid
    const res = await qrService.validateQR(OPAQUE_ID, EP_ID.toString(), null, new Date(Date.now() + 240 * H));
    assert.strictEqual(res.valid, true);
  } finally { restore(); }
});

test("non-windowed passes still use the event window, untouched", async () => {
  const narrowEvent = { ...standingEvent, dateStart: ago(48), dateEnd: ago(24) };
  const restore = setup({ pass: couponPass({ windowed: false, validFrom: undefined, validUntil: undefined }), event: narrowEvent });
  try {
    const ok = await qrService.validateQR(OPAQUE_ID, EP_ID.toString(), null, ago(36));
    assert.strictEqual(ok.valid, true);
    const late = await qrService.validateQR(OPAQUE_ID, EP_ID.toString());
    assert.strictEqual(late.reason, "expired");
    assert.match(late.message, /has ended/);
  } finally { restore(); }
});

// ── opaque id rules ─────────────────────────────────────────────────────────
test("only the unguessable id format is accepted bare; legacy sequential ids are not", async () => {
  let looked = false;
  const o = QRPass.findOne;
  QRPass.findOne = () => { looked = true; return fakeQuery(null); };
  try {
    for (const bad of ["ISK-SKJ26-PR-0000123", "ISK-SKJ26-PR-00001", "ISK-SKJ26-PR-ABCDEFGHJKL", "ISK-SKJ26-PR-abcdefghjklm", "garbage", ""]) {
      looked = false;
      const res = await qrService.validateQR(bad, EP_ID.toString());
      assert.strictEqual(res.valid, false, bad);
      assert.strictEqual(looked, false, `must not look up ${bad}`);
    }
    const res = await qrService.validateQR(OPAQUE_ID, EP_ID.toString());
    assert.strictEqual(res.valid, false);
    assert.strictEqual(looked, true, "well-formed opaque id is resolved against the DB (and found nothing)");
  } finally { QRPass.findOne = o; }
});

test("generated ids match the opaque format", async () => {
  const id = await qrService.generateQRId("PRASADAM", "PR");
  assert.match(id, /^ISK-PRASADAM-PR-[A-Z2-7]{12}$/);
});
