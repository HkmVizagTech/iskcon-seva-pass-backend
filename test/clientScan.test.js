// Run: QR_SECRET_KEY=x node --test test/clientScan.test.js
// POST /api/integration/scan through the real router, models faked in memory.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");

const ClientApp = require("../src/models/ClientApp");
const QRPass = require("../src/models/QRPass");
const ScanLog = require("../src/models/ScanLog");
const EntryPoint = require("../src/models/EntryPoint");
const Event = require("../src/models/Event");
const { hashKey, generateKey } = require("../src/utils/clientKeys");

const oid = () => new mongoose.Types.ObjectId();
const EVT = oid(), EP = oid(), OTHER_EVT = oid();
const QR = "ISK-PRASADAM-PR-ABCDEFGHJKLM";

const fakeQuery = (value) => {
  const q = new Proxy({}, { get: (_, prop) => (prop === "lean" ? async () => value : () => q) });
  return q;
};

const CLIENTS = {};
const addClient = (slug, over = {}) => {
  const key = generateKey();
  CLIENTS[hashKey(key)] = {
    _id: oid(), slug, name: slug, status: "active", scopes: ["passes:scan"],
    allowedEvents: ["PRASADAM"], allowedPassTypes: ["PR"], rateLimitPerMin: 300, ...over,
  };
  return key;
};

let state;
const reset = (over = {}) => {
  state = {
    logs: [], redeems: [],
    pass: {
      eventId: EVT, entryPoints: [EP], status: "active", redemptionHistory: [],
      holderId: { _id: oid(), name: "Guest One" },
      catId: { catCode: "PR", name: "Prasadam Coupon" },
      windowed: true, validFrom: new Date(Date.now() - 3600e3), validUntil: new Date(Date.now() + 3600e3),
    },
    ...over,
  };
};
reset();

ClientApp.findOne = (f) => ({ lean: async () => CLIENTS[f.keyHash] || null });
ClientApp.updateOne = () => ({ catch() {} });
Event.findOne = (f) => {
  const ev = (f.$or || []).some((c) => c.eventCode === "PRASADAM") ? { _id: EVT, eventCode: "PRASADAM" }
    : (f.$or || []).some((c) => c.eventCode === "SKJ26") ? { _id: OTHER_EVT, eventCode: "SKJ26" } : null;
  return fakeQuery(ev);
};
Event.findById = () => fakeQuery({ name: "Weekend Prasadam", dateStart: new Date(Date.now() - 864e5), dateEnd: new Date(Date.now() + 864e5) });
EntryPoint.findOne = (f) => fakeQuery(String(f.eventId) === String(EVT) && (f.type === "prasadam_coupon" || String(f._id) === String(EP))
  ? { _id: EP, stationLabel: "Prasadam Coupon Counter" } : null);
EntryPoint.findById = () => fakeQuery({ _id: EP, eventId: EVT, stationLabel: "Prasadam Coupon Counter", type: "prasadam_coupon", multiEntryAllowed: false });
EntryPoint.updateOne = async () => {};
EntryPoint.find = () => ({ distinct: async () => [EP], select: () => ({ lean: async () => [] }) });
QRPass.findOne = () => fakeQuery(state.pass);
QRPass.findOneAndUpdate = async (filter, update) => {
  state.redeems.push(update);
  const entry = update.$push.redemptionHistory;
  state.pass.redemptionHistory.push({ ...entry, result: "granted" });
  return { _id: oid() };
};
ScanLog.create = async (doc) => {
  if (doc.clientScanId && state.logs.some((l) => l.clientScanId === doc.clientScanId)) {
    const e = new Error("E11000"); e.code = 11000; throw e;
  }
  state.logs.push(doc);
  return doc;
};
ScanLog.findOne = (f) => fakeQuery(state.logs.find((l) => l.clientScanId === f.clientScanId) || null);

const app = express();
app.use(express.json());
app.use("/api/integration", require("../src/routes/integration"));
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}/api/integration`; });
test.after(() => server.close());

const scan = async (key, body) => {
  const res = await fetch(base + "/scan", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
  return { code: res.status, ...(await res.json()) };
};
const body = (over = {}) => ({ qr: QR, event_id: "PRASADAM", client_scan_id: "s1", scanned_by: { ref: "user-7", name: "Ramesh", phone: "9000000007" }, ...over });

test("granted: logged against the app + named scanner, no volunteer account", async () => {
  reset();
  const key = addClient("community");
  const r = await scan(key, body());
  assert.strictEqual(r.result, "granted");
  assert.strictEqual(r.holderName, "Guest One");
  assert.strictEqual(r.windowed, true);
  const log = state.logs[0];
  assert.strictEqual(log.result, "granted");
  assert.strictEqual(log.scannedBy, undefined);
  assert.ok(log.client);
  assert.deepStrictEqual(log.externalScanner, { ref: "user-7", name: "Ramesh", phone: "9000000007" });
  assert.strictEqual(log.clientScanId, "community:s1", "scan id namespaced per app");
  assert.strictEqual(state.redeems[0].$push.redemptionHistory.scannerName, "Ramesh");
  assert.strictEqual(state.redeems[0].$push.redemptionHistory.source, "scanner");
});

test("second scan of the same coupon: already used, with when / where / by whom", async () => {
  const key = addClient("community2");
  const r = await scan(key, body({ client_scan_id: "s2", scanned_by: { ref: "user-8", name: "Gopal" } }));
  assert.strictEqual(r.result, "already_used");
  assert.strictEqual(r.lastUsed.by, "Ramesh");
  assert.strictEqual(r.lastUsed.station, "Prasadam Coupon Counter");
  assert.ok(r.lastUsed.at);
});

test("same client_scan_id again is idempotent", async () => {
  const key = addClient("community3");
  reset();
  await scan(key, body({ client_scan_id: "dup" }));
  const again = await scan(key, body({ client_scan_id: "dup" }));
  assert.strictEqual(again.result, "duplicate");
  assert.strictEqual(state.redeems.length, 1);
});

test("a pass type the app may not scan is refused without revealing whose it is", async () => {
  reset({ pass: { ...state.pass, catId: { catCode: "SP", name: "Sponsor" } } });
  const key = addClient("community4");
  const r = await scan(key, body({ client_scan_id: "sp1" }));
  assert.strictEqual(r.result, "not_included");
  assert.strictEqual(r.holderName, undefined);
  assert.strictEqual(state.redeems.length, 0);
});

test("scope and event allowlist", async () => {
  reset();
  const noScope = addClient("noscope", { scopes: ["prasadam:issue"] });
  assert.strictEqual((await scan(noScope, body())).code, 403);
  const key = addClient("community5");
  assert.strictEqual((await scan(key, body({ event_id: "SKJ26" }))).code, 403, "event outside the allowlist");
  assert.strictEqual((await scan(key, body({ scanned_by: {} }))).code, 400, "who scanned is required");
  assert.strictEqual((await scan(key, body({ client_scan_id: "" }))).code, 400);
  assert.strictEqual(state.redeems.length, 0);
});
