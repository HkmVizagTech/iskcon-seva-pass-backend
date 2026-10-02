// Run: QR_SECRET_KEY=throwaway-test-secret node --test test/
// Exercises scanQR / syncOfflineScans against in-memory stand-ins for the models.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const qrService = require("../src/services/qrService");
const QRPass = require("../src/models/QRPass");
const ScanLog = require("../src/models/ScanLog");
const EntryPoint = require("../src/models/EntryPoint");
const Event = require("../src/models/Event");
const scanController = require("../src/controllers/scanController");

const oid = () => new mongoose.Types.ObjectId();
const EVT = oid();
const EP = oid();
const HOLDER = oid();
const QR_ID = "ISK-TEST26-GN-ABCDEFGHJKLM";

const fakeQuery = (value) => {
  const q = new Proxy({}, { get: (_, prop) => (prop === "lean" ? async () => value : () => q) });
  return q;
};

let state;
function reset(overrides = {}) {
  state = {
    logs: [],
    redeems: [],
    counters: [],
    redeemOk: true,
    pass: {
      eventId: EVT, entryPoints: [EP], holderId: { _id: HOLDER, name: "Devotee" },
      status: "active", redemptionHistory: [],
    },
    ep: { _id: EP, eventId: EVT, stationLabel: "Main Gate", multiEntryAllowed: false, allowGroupCount: false },
    ...overrides,
  };
}
reset();

QRPass.findOne = () => fakeQuery(state.pass);
QRPass.findOneAndUpdate = async (filter, update) => {
  state.redeems.push({ filter, update });
  return state.redeemOk ? { _id: oid() } : null;
};
EntryPoint.findById = () => fakeQuery(state.ep);
EntryPoint.updateOne = async (f, u) => { state.counters.push(u.$inc.currentCount); };
EntryPoint.find = () => ({ distinct: async () => [EP] });
Event.findById = () => fakeQuery({
  name: "Test", dateStart: new Date(Date.now() - 3600e3), dateEnd: new Date(Date.now() + 3600e3),
  venue: [{ name: "Kailash" }, { name: "Main Temple" }],
});
ScanLog.create = async (doc) => {
  if (doc.clientScanId && state.logs.some((l) => l.clientScanId === doc.clientScanId)) {
    const e = new Error("E11000"); e.code = 11000; throw e;
  }
  state.logs.push(doc);
  return doc;
};
ScanLog.findOne = (filter) => fakeQuery(state.logs.find((l) => l.clientScanId === filter.clientScanId) || null);

const volunteer = (extra = {}) => ({
  _id: oid(), role: "volunteer",
  assignedEntryPoints: [EP], assignedEvents: [EVT], assignedVenues: [0],
  ...extra,
});

async function call(handler, user, body, params = {}) {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; out.status = out.status || 200; return this; } };
  await handler({ user, body, params, ip: "1.2.3.4" }, res);
  return out;
}

let seq = 0;
const goodToken = (q) => qrService.signPayload({ q: q || `${QR_ID.slice(0, -4)}${String(++seq).padStart(4, "0")}` });

test("live scan: granted, redeemed atomically before the granted log, clientScanId stored", async () => {
  reset();
  const out = await call(scanController.scanQR, volunteer(), {
    qrData: goodToken(), epId: EP.toString(), venue: "Kailash", clientScanId: "c-1",
  });
  assert.strictEqual(out.body.result, "granted");
  assert.strictEqual(state.redeems.length, 1);
  const elem = state.redeems[0].filter.redemptionHistory.$not.$elemMatch;
  assert.strictEqual(elem.venue, "Kailash");
  assert.strictEqual(state.logs.length, 1);
  assert.strictEqual(state.logs[0].result, "granted");
  assert.strictEqual(state.logs[0].clientScanId, "c-1");
  assert.deepStrictEqual(state.counters, [1]);
});

test("live scan: same clientScanId again is idempotent (no second redeem)", async () => {
  // state carries over from the previous test
  const out = await call(scanController.scanQR, volunteer(), {
    qrData: goodToken(), epId: EP.toString(), venue: "Kailash", clientScanId: "c-1",
  });
  assert.strictEqual(out.body.result, "duplicate");
  assert.strictEqual(out.body.success, true);
  assert.strictEqual(state.redeems.length, 1);
});

test("live scan: venue outside the volunteer's assigned venues is rejected (403)", async () => {
  reset();
  const out = await call(scanController.scanQR, volunteer(), {
    qrData: goodToken(), epId: EP.toString(), venue: "Main Temple", clientScanId: "c-2",
  });
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.success, false);
  assert.strictEqual(state.redeems.length, 0);
});

test("live scan: unassigned station is rejected (403)", async () => {
  reset();
  const out = await call(scanController.scanQR, volunteer({ assignedEntryPoints: [oid()] }), {
    qrData: goodToken(), epId: EP.toString(), clientScanId: "c-3",
  });
  assert.strictEqual(out.status, 403);
});

test("live scan: failed redemption never leaves a granted log", async () => {
  reset({ redeemOk: false });
  const out = await call(scanController.scanQR, volunteer(), {
    qrData: goodToken(), epId: EP.toString(), venue: "Kailash", clientScanId: "c-4",
  });
  assert.strictEqual(out.body.result, "already_used");
  assert.deepStrictEqual(state.logs.map((l) => l.result), ["already_used"]);
  assert.strictEqual(state.logs[0].clientScanId, "c-4");
  assert.deepStrictEqual(state.counters, []);
});

test("live scan: legacy sequential qrId is rejected and logged under a hash, with clientScanId", async () => {
  reset();
  const out = await call(scanController.scanQR, volunteer(), {
    qrData: "ISK-TEST26-GN-0000142", epId: EP.toString(), venue: "Kailash", clientScanId: "c-5",
  });
  assert.strictEqual(out.body.result, "invalid");
  assert.strictEqual(state.redeems.length, 0);
  assert.match(state.logs[0].qrId, /^INVALID:[a-f0-9]{16}$/);
  assert.strictEqual(state.logs[0].clientScanId, "c-5");
});

test("live scan: groupCount ignored where the station does not allow groups", async () => {
  reset();
  const out = await call(scanController.scanQR, volunteer(), {
    qrData: goodToken(), epId: EP.toString(), venue: "Kailash", groupCount: 9, clientScanId: "c-6",
  });
  assert.strictEqual(out.body.groupCount, 1);
  assert.deepStrictEqual(state.counters, [1]);
  reset({ ep: { ...state.ep, allowGroupCount: true } });
  const out2 = await call(scanController.scanQR, volunteer(), {
    qrData: goodToken(), epId: EP.toString(), venue: "Kailash", groupCount: 9, clientScanId: "c-7",
  });
  assert.strictEqual(out2.body.groupCount, 9);
  assert.deepStrictEqual(state.counters, [9]);
});

test("sync: stale logged-not-redeemed, future clamped, unassigned logged, retries idempotent", async () => {
  reset();
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const scans = [
    { qrData: goodToken(), epId: EP.toString(), venue: "Kailash", clientScanId: "s-stale", timestamp: ago(8 * 864e5) },
    { qrData: goodToken(), epId: EP.toString(), venue: "Kailash", clientScanId: "s-future", timestamp: new Date(Date.now() + 864e5).toISOString() },
    { qrData: goodToken(), epId: EP.toString(), venue: "Main Temple", clientScanId: "s-venue", timestamp: ago(1000) },
    { qrData: "ISK-TEST26-GN-BARE", epId: EP.toString(), venue: "Kailash", clientScanId: "s-bare", timestamp: ago(1000) },
    { qrData: goodToken(), epId: EP.toString(), venue: "Kailash", timestamp: ago(1000) }, // no id
  ];
  const out = await call(scanController.syncOfflineScans, volunteer(), { scans });
  const byId = Object.fromEntries(out.body.results.map((r) => [r.clientScanId, r]));
  assert.strictEqual(byId["s-stale"].result, "stale");
  assert.strictEqual(byId["s-future"].result, "granted");
  assert.strictEqual(byId["s-venue"].result, "invalid");
  assert.strictEqual(byId["s-bare"].result, "invalid");
  assert.strictEqual(out.body.failed, 1, "item without clientScanId is refused");
  assert.strictEqual(out.body.stale, 1);
  assert.strictEqual(state.redeems.length, 1, "only the in-window assigned scan redeems");

  const future = state.logs.find((l) => l.clientScanId === "s-future");
  assert.ok(future.scannedAt.getTime() <= Date.now(), "timestamp clamped to now");
  assert.strictEqual(future.source, "offline");
  assert.strictEqual(state.logs.find((l) => l.clientScanId === "s-stale").result, "stale");
  assert.ok(state.logs.find((l) => l.clientScanId === "s-bare"), "failed validation stored its clientScanId");

  const logCount = state.logs.length;
  const again = await call(scanController.syncOfflineScans, volunteer(), { scans: scans.slice(0, 4) });
  // the unassigned-venue item is re-evaluated (same answer) rather than flagged duplicate
  assert.strictEqual(again.body.duplicates, 3);
  assert.strictEqual(again.body.results.find((r) => r.clientScanId === "s-venue").result, "invalid");
  assert.strictEqual(state.logs.length, logCount);
  assert.strictEqual(state.redeems.length, 1);
  assert.deepStrictEqual(
    again.body.results.find((r) => r.clientScanId === "s-future"),
    { clientScanId: "s-future", result: "granted", success: true, duplicate: true },
  );
});

test("sync: honours groupCount per item where allowed", async () => {
  reset({ ep: { _id: EP, eventId: EVT, stationLabel: "Gate", multiEntryAllowed: false, allowGroupCount: true } });
  await call(scanController.syncOfflineScans, volunteer(), {
    scans: [{ qrData: goodToken(), epId: EP.toString(), venue: "Kailash", groupCount: 4, clientScanId: "g-1" }],
  });
  assert.strictEqual(state.redeems[0].update.$push.redemptionHistory.groupCount, 4);
  assert.strictEqual(state.redeems[0].update.$push.redemptionHistory.source, "offline");
  assert.deepStrictEqual(state.counters, [4]);
});

test("manual entry redeems atomically (source=manual); a repeat is already_used", async () => {
  const holderController = require("../src/controllers/holderController");
  const thenable = (v) => {
    const q = { populate: () => q, select: () => q, then: (res, rej) => Promise.resolve(v).then(res, rej) };
    return q;
  };
  const saved = { p: QRPass.findOne, f: EntryPoint.findById, o: EntryPoint.findOne, u: EntryPoint.findByIdAndUpdate };
  try {
    reset();
    const ep = { ...state.ep, type: "venue_entry", name: "Main Gate" };
    QRPass.findOne = () => thenable({
      qrId: QR_ID, status: "active", eventId: { _id: EVT }, holderId: { _id: HOLDER, name: "Devotee" },
      entryPoints: [ep],
    });
    EntryPoint.findById = () => thenable(ep);
    EntryPoint.findOne = () => thenable(ep);
    EntryPoint.findByIdAndUpdate = async (id, u) => { state.counters.push(u.$inc.currentCount); };
    const admin = { _id: oid(), role: "event_admin" };

    const first = await call(holderController.manualEntry, admin, { reason: "no phone" }, { qrId: QR_ID });
    assert.strictEqual(first.body && first.body.success, true, JSON.stringify(first.body));
    assert.strictEqual(state.redeems.length, 1);
    assert.strictEqual(state.redeems[0].update.$push.redemptionHistory.source, "manual");
    assert.deepStrictEqual(state.logs.map((l) => [l.source, l.result]), [["manual", "granted"]]);
    assert.deepStrictEqual(state.counters, [1]);

    state.redeemOk = false;
    const second = await call(holderController.manualEntry, admin, {}, { qrId: QR_ID });
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.result, "already_used");
    assert.deepStrictEqual(state.logs.map((l) => [l.source, l.result]), [["manual", "granted"], ["manual", "already_used"]]);
    assert.deepStrictEqual(state.counters, [1]);
  } finally {
    QRPass.findOne = saved.p; EntryPoint.findById = saved.f; EntryPoint.findOne = saved.o; EntryPoint.findByIdAndUpdate = saved.u;
  }
});
