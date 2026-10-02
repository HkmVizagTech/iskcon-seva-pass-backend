// Run: QR_SECRET_KEY=throwaway-test-secret node --test test/
// No database needed: the model finders used by validateQR are stubbed.
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";

const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const qrService = require("../src/services/qrService");
const QRPass = require("../src/models/QRPass");
const EntryPoint = require("../src/models/EntryPoint");
const { sanitizeHtml, escapeHtml } = require("../src/utils/html");

const EP_ID = new mongoose.Types.ObjectId().toString();
const QR_ID = "ISK-TEST26-GN-ABCDEFGHJKLM";

// Chainable stand-in for mongoose queries: any chained call returns itself,
// lean() resolves the value.
const fakeQuery = (value) => {
  const q = new Proxy({}, {
    get: (_, prop) => (prop === "lean" ? async () => value : () => q),
  });
  return q;
};

function stubFinders({ pass }) {
  const origPass = QRPass.findOne;
  const origEp = EntryPoint.findById;
  QRPass.findOne = (filter) => {
    stubFinders.lastFilter = filter;
    return fakeQuery(pass);
  };
  EntryPoint.findById = () => fakeQuery({ _id: EP_ID, eventId: new mongoose.Types.ObjectId() });
  return () => {
    QRPass.findOne = origPass;
    EntryPoint.findById = origEp;
  };
}

const revokedPass = {
  eventId: new mongoose.Types.ObjectId(),
  entryPoints: [],
  status: "revoked",
  holderId: { name: "Test" },
};

test("validateQR accepts a JWT signed with QR_SECRET_KEY", async () => {
  const restore = stubFinders({ pass: revokedPass });
  try {
    const token = qrService.signPayload({ q: QR_ID, n: "Test" });
    const res = await qrService.validateQR(token, EP_ID);
    // Reaching the pass-status check proves step 1 (signature) passed
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, "revoked");
    assert.strictEqual(stubFinders.lastFilter.qrId, QR_ID);
  } finally {
    restore();
  }
});

test("validateQR rejects guessable legacy qrIds without a DB lookup", async () => {
  const restore = stubFinders({ pass: revokedPass });
  try {
    stubFinders.lastFilter = null;
    for (const legacy of ["ISK-TEST26-GN-0000142", "ISK-TEST26-GN-00001"]) {
      const res = await qrService.validateQR(legacy, EP_ID);
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.reason, "invalid");
    }
    assert.strictEqual(stubFinders.lastFilter, null, "must not even look the pass up");
  } finally {
    restore();
  }
});

test("validateQR resolves an unguessable opaque id via the DB (revoked pass is refused)", async () => {
  const restore = stubFinders({ pass: revokedPass });
  try {
    const res = await qrService.validateQR(QR_ID, EP_ID);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, "revoked");
    assert.strictEqual(stubFinders.lastFilter.qrId, QR_ID);
  } finally {
    restore();
  }
});

test("validateQR rejects tampered / foreign-signed / alg=none tokens", async () => {
  const restore = stubFinders({ pass: revokedPass });
  try {
    stubFinders.lastFilter = null;
    const good = qrService.signPayload({ q: QR_ID });
    const [h, p, s] = good.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ q: "ISK-TEST26-GN-ZZZZZZZZZZZZ" })).toString("base64url");
    const tampered = `${h}.${forgedPayload}.${s}`;
    const wrongKey = jwt.sign({ q: QR_ID }, "some-other-secret", { algorithm: "HS256", noTimestamp: true });
    const hs512 = jwt.sign({ q: QR_ID }, process.env.QR_SECRET_KEY, { algorithm: "HS512", noTimestamp: true });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ q: QR_ID })).toString("base64url")}.`;
    const noQ = jwt.sign({ n: "x" }, process.env.QR_SECRET_KEY, { algorithm: "HS256", noTimestamp: true });

    for (const bad of [tampered, wrongKey, hs512, none, noQ, "", "garbage", undefined, null, { q: QR_ID }]) {
      const res = await qrService.validateQR(bad, EP_ID);
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.reason, "invalid");
    }
    assert.strictEqual(stubFinders.lastFilter, null);
  } finally {
    restore();
  }
});

test("image token: round-trips, binds to the qrId, rejects junk", () => {
  const t = qrService.imageToken(QR_ID);
  assert.match(t, /^[a-f0-9]{64}$/);
  assert.strictEqual(qrService.verifyImageToken(QR_ID, t), true);
  assert.strictEqual(qrService.verifyImageToken("ISK-TEST26-GN-OTHEROTHEROT", t), false);
  assert.strictEqual(qrService.verifyImageToken(QR_ID, t.slice(0, 63) + (t.endsWith("0") ? "1" : "0")), false);
  for (const bad of [undefined, null, "", "abc", t.slice(0, 32), t + "00", ["x"], { a: 1 }]) {
    assert.strictEqual(qrService.verifyImageToken(QR_ID, bad), false);
  }
});

test("signedImageUrl appends a verifiable token", () => {
  const url = new URL(qrService.signedImageUrl(QR_ID, "https://api.example.org/"));
  assert.strictEqual(url.pathname, `/api/qr/${QR_ID}/image`);
  assert.strictEqual(qrService.verifyImageToken(QR_ID, url.searchParams.get("t")), true);
});

test("generateQRId: prefix kept, unguessable suffix, no collisions", async () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = await qrService.generateQRId("SKJ26", "SP");
    assert.match(id, /^ISK-SKJ26-SP-[A-Z2-7]{12}$/);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 2000);
});

test("QR_SECRET_KEY missing: throws unless NODE_ENV is development/test", () => {
  const path = require.resolve("../src/services/qrService");
  const saved = { key: process.env.QR_SECRET_KEY, env: process.env.NODE_ENV, mod: require.cache[path] };
  try {
    delete process.env.QR_SECRET_KEY;
    for (const env of [undefined, "production", "staging"]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      delete require.cache[path];
      assert.throws(() => require(path), /QR_SECRET_KEY/);
    }
    process.env.NODE_ENV = "development";
    delete require.cache[path];
    assert.doesNotThrow(() => require(path));
  } finally {
    process.env.QR_SECRET_KEY = saved.key;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    require.cache[path] = saved.mod;
  }
});

test("sanitizeHtml strips script/iframe/handlers/javascript: URLs, keeps formatting", () => {
  const cases = [
    ['<p>Hi <b>there</b></p>', '<p>Hi <b>there</b></p>'],
    ['<script>alert(1)</script><p>x</p>', '<p>x</p>'],
    ['<iframe src="//evil"></iframe>ok', 'ok'],
    ['<img src=x onerror=alert(1)>t', 't'],
    ['<p onclick="alert(1)">t</p>', '<p>t</p>'],
    ['<a href="javascript:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="  JaVa\tScRiPt:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="jav&#x09;ascript:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="https://ok.example/?a=1&amp;b=2" target="_blank">l</a>', '<a href="https://ok.example/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">l</a>'],
    ['<span style="color:red;position:fixed;background:url(x)">s</span>', '<span style="color:red">s</span>'],
    ['<ul><li>a &amp; b</li></ul>', '<ul><li>a &amp; b</li></ul>'],
    ['1 < 2 and <3', '1 &lt; 2 and &lt;3'],
    ['<svg onload=alert(1)><circle/></svg>x', 'x'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(sanitizeHtml(input), expected, input);
  }
  assert.strictEqual(sanitizeHtml(undefined), "");
  // malformed tags are neutralised as inert text, never emitted as live markup
  const odd = sanitizeHtml('<div/onclick=alert(1)>x</div><a href="x"onclick="y">z</a>');
  assert.ok(!/<[^>]*\bon\w+\s*=/i.test(odd), odd);
});

test("escapeHtml", () => {
  assert.strictEqual(escapeHtml(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  assert.strictEqual(escapeHtml(null), "");
});
