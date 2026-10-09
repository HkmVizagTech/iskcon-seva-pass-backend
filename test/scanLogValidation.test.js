// ScanLog's own validation (the scan tests stub ScanLog.create, so they never
// ran it): app scans made with the shared integration key have no ClientApp id
// and no volunteer account, only the scanner the app names.

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const ScanLog = require("../src/models/ScanLog");

const base = () => ({
  qrId: "ISK-PRASADAM-PR-ABCDEFGHJKLM",
  epId: new mongoose.Types.ObjectId(),
  stationLabel: "Prasadam Coupon Counter",
  result: "granted",
});

test("shared-key app scan: valid with only the named scanner", () => {
  const err = new ScanLog({ ...base(), externalScanner: { ref: "hk-user-40", name: "Giridhar" } }).validateSync();
  assert.strictEqual(err?.errors?.scannedBy, undefined);
});

test("registered app scan: valid with the client id", () => {
  const err = new ScanLog({ ...base(), client: new mongoose.Types.ObjectId(), externalScanner: { ref: "x" } }).validateSync();
  assert.strictEqual(err?.errors?.scannedBy, undefined);
});

test("volunteer scan still needs the volunteer", () => {
  const err = new ScanLog(base()).validateSync();
  assert.ok(err?.errors?.scannedBy, "scannedBy required without client or named scanner");
  assert.strictEqual(new ScanLog({ ...base(), scannedBy: new mongoose.Types.ObjectId() }).validateSync()?.errors?.scannedBy, undefined);
});
