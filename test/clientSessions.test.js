// Run: QR_SECRET_KEY=x node --test test/clientSessions.test.js
// /api/integration/sessions/revoke and /window through the real router, models faked.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");

const ClientApp = require("../src/models/ClientApp");
const QRPass = require("../src/models/QRPass");
const Event = require("../src/models/Event");
const { hashKey, generateKey } = require("../src/utils/clientKeys");

const EVT = new mongoose.Types.ObjectId();
const CLIENTS = {};
const addClient = (slug, over = {}) => {
  const key = generateKey();
  CLIENTS[hashKey(key)] = { _id: new mongoose.Types.ObjectId(), slug, name: slug, status: "active", scopes: ["prasadam:issue"], allowedEvents: ["PRASADAM"], allowedPassTypes: ["PR"], rateLimitPerMin: 300, ...over };
  return key;
};

let passes;
const reset = () => {
  passes = [
    { sessionKey: "hv:42", status: "active", redemptionHistory: [] },
    { sessionKey: "hv:42", status: "active", redemptionHistory: [{ result: "granted" }] },
    { sessionKey: "hv:42", status: "revoked", redemptionHistory: [] },
    { sessionKey: "other:42", status: "active", redemptionHistory: [] },
    { sessionKey: "hv:43", status: "active", redemptionHistory: [] },
  ].map((p) => ({ eventId: EVT, validFrom: new Date(0), validUntil: new Date(0), ...p }));
};
const matches = (p, f) => Object.entries(f).every(([k, v]) => {
  if (k === "redemptionHistory") return p.redemptionHistory.some((h) => h.result === "granted");
  if (v && typeof v === "object" && "$ne" in v) return p[k] !== v.$ne;
  return String(p[k]) === String(v);
});

ClientApp.findOne = (f) => ({ lean: async () => CLIENTS[f.keyHash] || null });
ClientApp.updateOne = () => ({ catch() {} });
const fq = (v) => { const q = new Proxy({}, { get: (_, p) => (p === "lean" ? async () => v : () => q) }); return q; };
Event.findOne = (f) => fq((f.$or || []).some((c) => c.eventCode === "PRASADAM") ? { _id: EVT, eventCode: "PRASADAM" } : null);
QRPass.countDocuments = async (f) => passes.filter((p) => matches(p, f)).length;
QRPass.updateMany = async (f, u) => {
  const hit = passes.filter((p) => matches(p, f));
  hit.forEach((p) => Object.assign(p, u.$set));
  return { modifiedCount: hit.length };
};

const app = express();
app.use(express.json());
app.use("/api/integration", require("../src/routes/integration"));
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}/api/integration`; });
test.after(() => server.close());
const post = async (path, key, body) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
  return { code: res.status, ...(await res.json()) };
};

test("revoke: only this client's session, counts collected ones", async () => {
  reset();
  const key = addClient("hv");
  const r = await post("/sessions/revoke", key, { event_id: "PRASADAM", session_ref: "42" });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.revoked, 2);
  assert.strictEqual(r.already_collected, 1);
  assert.deepStrictEqual(passes.map((p) => p.status), ["revoked", "revoked", "revoked", "active", "active"]);
});

test("window: moves every non-revoked pass of the session, nothing else", async () => {
  reset();
  const key = addClient("hv2", { slug: "hv" });
  const day = new Date(Date.now() + 3 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const r = await post("/sessions/window", key, { event_id: "PRASADAM", session_ref: "42", valid_for_date: day, valid_from: `${day}T12:00:00+05:30`, valid_until: `${day}T16:00:00+05:30` });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.updated, 2);
  assert.strictEqual(passes[0].validUntil.toISOString(), new Date(`${day}T16:00:00+05:30`).toISOString());
  assert.strictEqual(passes[2].validUntil.getTime(), 0, "revoked pass untouched");
  assert.strictEqual(passes[3].validUntil.getTime(), 0, "another client's session 42 untouched");
});

test("validation and scopes", async () => {
  reset();
  const key = addClient("hv3");
  assert.strictEqual((await post("/sessions/window", key, { event_id: "PRASADAM", session_ref: "42" })).code, 400);
  assert.strictEqual((await post("/sessions/window", key, { event_id: "PRASADAM", session_ref: "42", valid_for_date: "2020-01-01" })).code, 400);
  assert.strictEqual((await post("/sessions/revoke", key, { event_id: "PRASADAM" })).code, 400);
  const scanOnly = addClient("scanner-only", { scopes: ["passes:scan"] });
  assert.strictEqual((await post("/sessions/revoke", scanOnly, { event_id: "PRASADAM", session_ref: "42" })).code, 403);
  const passesKey = addClient("generic", { scopes: ["passes:issue"] });
  assert.strictEqual((await post("/sessions/revoke", passesKey, { event_id: "PRASADAM", session_ref: "42" })).code, 200, "either issuing scope works");
});
