// Run: QR_SECRET_KEY=throwaway node --test test/clientApps.test.js
// Real express routes over HTTP, database faked in memory.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";
process.env.INTEGRATION_API_KEY = "legacy-shared-key-for-tests";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");

const ClientApp = require("../src/models/ClientApp");
const Event = require("../src/models/Event");
const HolderType = require("../src/models/HolderType");
const Holder = require("../src/models/Holder");
const QRPass = require("../src/models/QRPass");
const qrService = require("../src/services/qrService");
const thirdPartyService = require("../src/services/thirdPartyService");
const { hashKey, generateKey } = require("../src/utils/clientKeys");

// ── fake data ────────────────────────────────────────────────────────────────
const oid = () => new mongoose.Types.ObjectId();
const EVENTS = {
  PRASADAM: { _id: oid(), eventCode: "PRASADAM", name: "Weekend Prasadam", dateStart: new Date("2026-10-01"), dateEnd: new Date("2099-01-01") },
  SKJ26: { _id: oid(), eventCode: "SKJ26", name: "Janmashtami", thirdPartyEventId: "event_9", dateStart: new Date("2026-08-01"), dateEnd: new Date("2026-09-01") },
};
const CATS = {
  PR: { _id: oid(), catCode: "PR", name: "Prasadam Coupon", entryPoints: [{ _id: oid() }] },
  SP: { _id: oid(), catCode: "SP", name: "Sponsor", entryPoints: [{ _id: oid() }] },
};
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const CLIENTS = {};
const addClient = (slug, over = {}) => {
  const key = generateKey();
  CLIENTS[hashKey(key)] = {
    _id: oid(), slug, name: slug, status: "active", scopes: ["prasadam:issue", "passes:read"],
    allowedEvents: ["*"], allowedPassTypes: ["*"], rateLimitPerMin: 300, ...over,
  };
  return key;
};

let holders = [], passes = [], seq = 0;
const matches = (doc, f) => Object.entries(f).every(([k, v]) => (v === null ? doc[k] == null : String(doc[k]) === String(v)));

ClientApp.findOne = (f) => ({ lean: async () => CLIENTS[f.keyHash] || null });
ClientApp.updateOne = () => ({ catch() {} });
Event.findOne = (f) => {
  const found = Object.values(EVENTS).find((e) => (f.$or || []).some((c) =>
    (c.eventCode && c.eventCode === e.eventCode) || (c.thirdPartyEventId && c.thirdPartyEventId === e.thirdPartyEventId) || (c._id && String(c._id) === String(e._id))));
  const r = Promise.resolve(found || null);
  r.select = () => ({ lean: async () => found || null });
  return r;
};
Event.find = (q) => {
  let list = Object.values(EVENTS);
  if (q.eventCode && q.eventCode.$in) list = list.filter((e) => q.eventCode.$in.includes(e.eventCode));
  const chain = { select: () => chain, sort: () => Promise.resolve(list) };
  return chain;
};
HolderType.findOne = (f) => ({ populate: async () => CATS[f.catCode || (f.$or ? "PR" : "")] || null });
Holder.findOne = async (f) => holders.find((h) => matches(h, f)) || null;
Holder.create = async (d) => { const h = { _id: oid(), ...d }; holders.push(h); return h; };
QRPass.findOne = (f) => {
  const p = passes.find((x) => matches(x, f)) || null;
  const r = Promise.resolve(p);
  Object.assign(r, { populate: () => r, lean: async () => p });
  return r;
};
qrService.createQRPassWithUniqueId = async ({ holder, category, passFields }) => {
  const qrId = `ISK-X-${category.catCode}-${String.fromCharCode(65 + (++seq % 26))}${"ABCDEFGHJKL"}`;
  const p = { _id: oid(), qrId, holderId: holder._id, status: "active", ...passFields, save: async function () { return this; } };
  passes.push(p);
  return { qrId, qrPass: p, qrImage: "img", signedPayload: "jwt" };
};
thirdPartyService.pushHolder = async () => {};

const app = express();
app.use(express.json());
app.use("/api/integration", require("../src/routes/integration"));
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}/api/integration`; });
test.after(() => server.close());

const call = async (method, path, key, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: res.status, ...(await res.json().catch(() => ({}))) };
};
const reset = () => { holders = []; passes = []; };

// ── authentication ───────────────────────────────────────────────────────────
test("no key / wrong key -> 401", async () => {
  assert.strictEqual((await call("GET", "/events")).code, 401);
  assert.strictEqual((await call("GET", "/events", "nope")).code, 401);
});

test("legacy shared key still works everywhere (compat)", async () => {
  assert.strictEqual((await call("GET", "/events", "legacy-shared-key-for-tests")).code, 200);
  reset();
  const r = await call("POST", "/prasadam/qr", "legacy-shared-key-for-tests", { event_id: "PRASADAM", phone: "9951141915" });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(passes[0].issuedByClient, undefined, "legacy callers are not a registered client");
});

test("disabled client is rejected", async () => {
  const key = addClient("old", { status: "disabled" });
  // the real model filters status:"active" in the query; the fake mirrors that
  for (const h of Object.keys(CLIENTS)) if (CLIENTS[h].slug === "old") CLIENTS[h] = null;
  assert.strictEqual((await call("GET", "/events", key)).code, 401);
});

// ── scopes ───────────────────────────────────────────────────────────────────
test("scopes: a prasadam key cannot list events or manage preachers", async () => {
  const key = addClient("vaikuntham");
  assert.strictEqual((await call("GET", "/events", key)).code, 403);
  assert.strictEqual((await call("GET", "/preachers", key)).code, 403);
  assert.strictEqual((await call("POST", "/seva-pass/issue", key, { event_id: "PRASADAM" })).code, 403);
  assert.strictEqual((await call("POST", "/prasadam/qr", key, { event_id: "PRASADAM", phone: "9951141915" })).code, 200);
});

// ── event allowlist ──────────────────────────────────────────────────────────
test("event allowlist: other events are refused, including via aliases", async () => {
  reset();
  const key = addClient("pr-only", { allowedEvents: ["PRASADAM"] });
  const ok = await call("POST", "/prasadam/qr", key, { event_id: "prasadam", phone: "9951141915" });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual((await call("POST", "/prasadam/qr", key, { event_id: "SKJ26", phone: "9951141915" })).code, 403);
  assert.strictEqual((await call("POST", "/prasadam/qr", key, { event_id: "event_9", phone: "9951141915" })).code, 403, "third-party alias");
  assert.strictEqual((await call("POST", "/prasadam/qr", key, { event_id: String(EVENTS.SKJ26._id), phone: "9951141915" })).code, 403, "_id alias");
  assert.strictEqual((await call("POST", "/prasadam/qr", key, { event_id: { $ne: null }, phone: "9951141915" })).code, 404, "operator injection is coerced to a string, matches nothing");
  assert.strictEqual(passes.length, 1);
});

test("event list is filtered to the client's events", async () => {
  const key = addClient("lister", { scopes: ["events:read"], allowedEvents: ["SKJ26"] });
  const r = await call("GET", "/events", key);
  assert.strictEqual(r.code, 200);
});

// ── generic passes + pass types ──────────────────────────────────────────────
test("generic /passes: any pass type, subject to allowedPassTypes", async () => {
  reset();
  const key = addClient("entry", { scopes: ["passes:issue"], allowedPassTypes: ["SP"] });
  const sp = await call("POST", "/passes", key, { event_id: "SKJ26", type: "sp", phone: "9951141915", name: "A" });
  assert.strictEqual(sp.code, 200);
  assert.match(sp.message, /^Pass QR generated/);
  assert.strictEqual((await call("POST", "/passes", key, { event_id: "SKJ26", type: "PR", phone: "9951141915" })).code, 403);
  assert.strictEqual((await call("POST", "/passes", key, { event_id: "SKJ26", type: "ZZ", phone: "9951141915" })).code, 403);
  const open = addClient("open", { scopes: ["passes:issue"] });
  assert.strictEqual((await call("POST", "/passes", open, { event_id: "SKJ26", type: "ZZ", phone: "9951141915" })).code, 404);
});

// ── session namespacing + audit ──────────────────────────────────────────────
test("two clients using the same session_ref get different QRs; each is recorded", async () => {
  reset();
  const a = addClient("app-a"), b = addClient("app-b");
  const body = { event_id: "PRASADAM", phone: "9951141915", valid_for_date: day(2), session_ref: "42" };
  const a1 = await call("POST", "/prasadam/qr", a, body);
  const a2 = await call("POST", "/prasadam/qr", a, body);
  const b1 = await call("POST", "/prasadam/qr", b, body);
  assert.strictEqual(a1.qr_id, a2.qr_id, "same client + session -> same QR");
  assert.notStrictEqual(a1.qr_id, b1.qr_id, "another client's session 42 is a different session");
  assert.strictEqual(a1.session_ref, "42", "raw ref is echoed back");
  assert.match(passes[0].sessionKey, /^app-a:42$/);
  assert.match(passes[1].sessionKey, /^app-b:42$/);
  assert.ok(passes[0].issuedByClient && passes[1].issuedByClient);
});

// ── pass read is event-scoped ────────────────────────────────────────────────
test("pass details: a restricted client cannot read another event's pass", async () => {
  reset();
  const issuer = addClient("issuer2", { scopes: ["passes:issue", "passes:read"] });
  await call("POST", "/passes", issuer, { event_id: "SKJ26", type: "SP", phone: "9951141915" });
  const restricted = addClient("reader", { scopes: ["passes:read"], allowedEvents: ["PRASADAM"] });
  const pass = passes[0];
  pass.eventId = { eventCode: "SKJ26" }; // populated shape
  const r = await call("GET", `/qr/${pass.qrId}`, restricted);
  assert.strictEqual(r.code, 404);
});
