// Run: QR_SECRET_KEY=throwaway node --test test/holderPasses.test.js
// Holders with several passes (one per session). No database: models are stubbed.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const {
  isCollected, sortNewestFirst, primaryPass, classifyNoShows, sessionRollup,
} = require("../src/utils/holderPasses");
const QRPass = require("../src/models/QRPass");
const Holder = require("../src/models/Holder");
const ScanLog = require("../src/models/ScanLog");
const ClientApp = require("../src/models/ClientApp");
const holderController = require("../src/controllers/holderController");
const reportController = require("../src/controllers/reportController");

const oid = () => new mongoose.Types.ObjectId();
const H = 3600e3;
const NOW = new Date(); // controllers read the real clock
const at = (h) => new Date(NOW.getTime() + h * H);
const granted = [{ result: "granted", scannedAt: at(-1) }];

// Four weekend coupons for one person: three used, one missed, plus next week's.
const PERSON = oid();
const session = (key, startH, over = {}) => ({
  _id: oid(), qrId: `ISK-PR-${key}`, holderId: PERSON, sessionKey: `vaikuntham:${key}`, windowed: true,
  validFrom: at(startH), validUntil: at(startH + 6), status: "active", redemptionHistory: [],
  createdAt: at(startH - 48), ...over,
});
const COUPONS = [
  session("s1", -24 * 21, { redemptionHistory: granted }),
  session("s2", -24 * 14, { redemptionHistory: [{ result: "not_included" }] }),
  session("s3", -24 * 7, { redemptionHistory: granted }),
  session("s4", -2, { redemptionHistory: granted }), // today, window still open
  session("s5", 24 * 7), // next week
];

// ── pure helpers ─────────────────────────────────────────────────────────────
test("collected means a granted redemption; failed scans do not count", () => {
  assert.strictEqual(isCollected(COUPONS[0]), true);
  assert.strictEqual(isCollected(COUPONS[1]), false);
  assert.strictEqual(isCollected({}), false);
});

test("passes sort newest session first", () => {
  assert.deepStrictEqual(sortNewestFirst(COUPONS).map((p) => p.qrId),
    ["ISK-PR-s5", "ISK-PR-s4", "ISK-PR-s3", "ISK-PR-s2", "ISK-PR-s1"]);
});

test("primary pass is the one usable now, else the newest", () => {
  assert.strictEqual(primaryPass(COUPONS, NOW).qrId, "ISK-PR-s4");
  assert.strictEqual(primaryPass(COUPONS, at(24 * 3)).qrId, "ISK-PR-s5");
  assert.strictEqual(primaryPass([], NOW), null);
  // Revoked original + its replacement: the live one wins.
  const old = { qrId: "OLD", status: "revoked", validFrom: at(-5), createdAt: at(-100) };
  const repl = { qrId: "NEW", status: "active", validFrom: at(-5), createdAt: at(-1) };
  assert.strictEqual(primaryPass([old, repl], NOW).qrId, "NEW");
  assert.strictEqual(primaryPass([repl, old], NOW).qrId, "NEW");
});

test("no-shows: a missed session is counted, the person is not a no-show overall", () => {
  const uncollected = COUPONS.filter((p) => !isCollected(p));
  const r = classifyNoShows(uncollected, [PERSON], NOW);
  assert.deepStrictEqual(r.noShows.map((p) => p.qrId), ["ISK-PR-s2"]);
  assert.deepStrictEqual(r.pending.map((p) => p.qrId), ["ISK-PR-s5"]);
  assert.strictEqual(r.holderCount, 0);
});

test("no-shows: a person who never came counts once however many sessions they missed", () => {
  const ghost = oid();
  const passes = [
    { holderId: ghost, status: "active", windowed: true, validUntil: at(-30), redemptionHistory: [] },
    { holderId: ghost, status: "active", windowed: true, validUntil: at(-10), redemptionHistory: [] },
    { holderId: oid(), status: "active", windowed: false, validUntil: at(48), redemptionHistory: [] },
    { holderId: oid(), status: "revoked", windowed: false, redemptionHistory: [] },
  ];
  const r = classifyNoShows(passes, [], NOW);
  assert.strictEqual(r.noShows.length, 3); // non-windowed passes behave as before
  assert.strictEqual(r.holderCount, 2);
  assert.strictEqual(r.pending.length, 0);
});

test("session roll-up counts each session separately", () => {
  const other = { ...session("s3", -24 * 7), holderId: oid(), status: "revoked", issuedByClient: oid() };
  const rows = sessionRollup([...COUPONS, other], NOW);
  assert.deepStrictEqual(rows.map((s) => s.sessionKey),
    ["vaikuntham:s5", "vaikuntham:s4", "vaikuntham:s3", "vaikuntham:s2", "vaikuntham:s1"]);
  const s3 = rows.find((s) => s.sessionKey === "vaikuntham:s3");
  assert.deepStrictEqual(
    { issued: s3.issued, collected: s3.collected, revoked: s3.revoked, missed: s3.missed, pending: s3.pending },
    { issued: 2, collected: 1, revoked: 1, missed: 0, pending: 0 },
  );
  assert.strictEqual(s3.clientIds.length, 1);
  assert.strictEqual(rows.find((s) => s.sessionKey === "vaikuntham:s2").missed, 1);
  assert.strictEqual(rows.find((s) => s.sessionKey === "vaikuntham:s5").pending, 1);
  assert.strictEqual(sessionRollup([{ status: "active" }], NOW).length, 0); // no sessionKey -> skipped
});

// ── controllers over stubbed models ──────────────────────────────────────────
const chain = (value) => {
  const q = { then: (ok, fail) => Promise.resolve(value).then(ok, fail), lean: async () => value };
  for (const m of ["populate", "select", "sort", "limit", "skip"]) q[m] = () => q;
  return q;
};
const doc = (o) => ({ ...o, toObject: () => ({ ...o }) });

function stub(model, fns) {
  const saved = Object.fromEntries(Object.keys(fns).map((k) => [k, model[k]]));
  Object.assign(model, fns);
  return () => Object.assign(model, saved);
}

function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const EVENT = oid();
const SUPER = { _id: oid(), role: "super_admin" };

test("holder detail returns every pass newest first; qrPass is the current one", async (t) => {
  const passes = COUPONS.map((p) => doc({ ...p, payloadSigned: "signed", issuedByClient: { name: "Vaikuntham app" } }));
  const restore = [
    stub(Holder, { findById: () => chain(doc({ _id: PERSON, eventId: EVENT, name: "Devotee" })) }),
    stub(QRPass, { find: () => chain(passes) }),
    stub(ScanLog, { find: () => chain([]) }),
  ];
  t.after(() => restore.forEach((r) => r()));

  const out = await call(holderController.getHolderDetails, { params: { holderId: String(PERSON) }, user: SUPER });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.passes.map((p) => p.qrId),
    ["ISK-PR-s5", "ISK-PR-s4", "ISK-PR-s3", "ISK-PR-s2", "ISK-PR-s1"]);
  assert.strictEqual(out.body.qrPass.qrId, "ISK-PR-s4");
  assert.deepStrictEqual(out.body.passes.map((p) => p.collected), [false, true, true, false, true]);
  assert.strictEqual(out.body.passes[0].issuedByClient.name, "Vaikuntham app");
  assert.ok(out.body.passes.every((p) => p.payloadSigned && p.imageUrl));
});

test("holder detail strips signed payloads for non-staff readers", async (t) => {
  const restore = [
    stub(Holder, { findById: () => chain(doc({ _id: PERSON, eventId: EVENT, name: "Devotee" })) }),
    stub(QRPass, { find: () => chain(COUPONS.map((p) => doc({ ...p, payloadSigned: "signed" }))) }),
    stub(ScanLog, { find: () => chain([]) }),
  ];
  t.after(() => restore.forEach((r) => r()));
  const out = await call(holderController.getHolderDetails, {
    params: { holderId: String(PERSON) }, user: { _id: oid(), role: "preacher" },
  });
  assert.strictEqual(out.status, 200);
  assert.ok(out.body.passes.every((p) => !p.payloadSigned && !p.imageUrl));
  assert.ok(!out.body.qrPass.payloadSigned);
});

test("holders list: one row per holder with pass count", async (t) => {
  const single = oid();
  const holders = [doc({ _id: PERSON, name: "Devotee" }), doc({ _id: single, name: "Sponsor" })];
  const passes = [...COUPONS, { _id: oid(), qrId: "ISK-SP-1", holderId: single, status: "active", redemptionHistory: [] }];
  const restore = [
    stub(Holder, { find: () => chain(holders), countDocuments: async () => 2 }),
    stub(QRPass, { find: () => chain(passes) }),
  ];
  t.after(() => restore.forEach((r) => r()));
  const out = await call(holderController.getHolders, { params: { eventId: String(EVENT) }, query: {}, user: SUPER });
  assert.strictEqual(out.body.holders.length, 2);
  assert.strictEqual(out.body.holders[0].passCount, 5);
  assert.strictEqual(out.body.holders[1].passCount, 1);
  assert.strictEqual(out.body.holders[1].qrPass.qrId, "ISK-SP-1");
  assert.strictEqual(out.body.holders[1].qrPass.collected, false);
});

test("holders export keeps one row per holder and lists multiple passes", async (t) => {
  const restore = [
    stub(Holder, { find: () => chain([doc({ _id: PERSON, name: "Devotee", phone: "91999", catId: { name: "Prasadam" } })]) }),
    stub(QRPass, { find: () => chain(COUPONS) }),
  ];
  t.after(() => restore.forEach((r) => r()));
  const out = await call(holderController.exportHolders, { params: { eventId: String(EVENT) }, user: SUPER });
  const lines = out.body.trim().split("\n");
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /Pass Count,Collected,Passes$/);
  assert.match(lines[1], /"5","3","ISK-PR-s5 \(/);
  assert.match(lines[1], /ISK-PR-s2 \([0-9-]+, active, not collected\)/);
});

test("no-shows endpoint: missed sessions per pass, people counted once", async (t) => {
  const ghost = oid();
  const missed = [
    doc({ ...COUPONS[1], holderId: { _id: PERSON, name: "Devotee" } }),
    doc({ ...COUPONS[4], holderId: { _id: PERSON, name: "Devotee" }, }),
    doc({ qrId: "ISK-PR-g1", holderId: { _id: ghost, name: "Ghost" }, status: "active", windowed: true,
      validFrom: at(-30), validUntil: at(-24), redemptionHistory: [] }),
  ];
  let distinctFilter;
  const restore = [stub(QRPass, {
    find: () => chain(missed),
    distinct: async (field, f) => { distinctFilter = f; return [PERSON]; },
  })];
  t.after(() => restore.forEach((r) => r()));
  const out = await call(reportController.getNoShows, { params: { eventId: String(EVENT) } });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.noShows.map((p) => p.qrId).sort(), ["ISK-PR-g1", "ISK-PR-s2"]);
  assert.strictEqual(out.body.count, 2);
  assert.strictEqual(out.body.holderCount, 1);
  assert.strictEqual(out.body.pendingCount, 1);
  assert.strictEqual(distinctFilter["redemptionHistory.result"], "granted");
});

test("sessions endpoint groups a standing event's passes and names the issuing client", async (t) => {
  const client = oid();
  const passes = COUPONS.map((p) => ({ ...p, issuedByClient: client }));
  const restore = [
    stub(QRPass, { find: () => chain(passes) }),
    stub(ClientApp, { find: () => chain([{ _id: client, name: "Vaikuntham app" }]) }),
  ];
  t.after(() => restore.forEach((r) => r()));
  const out = await call(reportController.getSessions, { params: { eventId: String(EVENT) } });
  assert.strictEqual(out.body.sessions.length, 5);
  assert.deepStrictEqual(out.body.sessions[0].clients, ["Vaikuntham app"]);
  assert.strictEqual(out.body.sessions[0].clientIds, undefined);
  assert.strictEqual(out.body.sessions.reduce((n, s) => n + s.issued, 0), 5);
});

test("category edit is refused only when every pass of the holder is revoked", async (t) => {
  let statuses;
  let updated = 0;
  const restore = [
    stub(Holder, {
      findById: () => chain({ _id: PERSON }),
      findByIdAndUpdate: async () => { updated++; return { _id: PERSON, subCategory: "A" }; },
    }),
    stub(QRPass, {
      distinct: async (field, f) =>
        (f.status === "revoked" ? statuses.includes("revoked") : statuses.some((s) => s !== "revoked")) ? [PERSON] : [],
    }),
  ];
  t.after(() => restore.forEach((r) => r()));
  const edit = () => call(holderController.updateHolder, { params: { holderId: String(PERSON) }, body: { subCategory: "A" } });

  statuses = ["revoked", "active"]; // replaced pass, or other sessions still live
  assert.strictEqual((await edit()).status, 200);
  statuses = ["revoked"];
  const blocked = await edit();
  assert.strictEqual(blocked.status, 400);
  assert.match(blocked.body.error, /revoked/);
  assert.strictEqual(updated, 1);
});
