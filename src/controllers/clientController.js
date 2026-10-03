const mongoose = require("mongoose");
const ClientApp = require("../models/ClientApp");
const { SCOPES, generateKey, hashKey, keyHint } = require("../utils/clientKeys");

// Starting points for the common consumers; scopes can still be edited after.
const PRESETS = {
  prasadam: ["prasadam:issue", "passes:read", "passes:scan"],
  "seva-pass-app": ["events:read", "events:write", "passes:issue", "passes:read", "preachers:manage"],
  full: Object.keys(SCOPES),
};

const toList = (v, fallback) => {
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  if (out.some((x) => x !== "*" && !/^[A-Z0-9_-]{1,40}$/.test(x))) return null;
  return out.length ? out : fallback;
};

function validScopes(list) {
  return Array.isArray(list) && list.length > 0 && list.every((s) => SCOPES[s]);
}

const slugify = (name) =>
  String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);

const publicView = (c) => {
  const o = c.toObject ? c.toObject() : c;
  delete o.keyHash;
  return o;
};

exports.listScopes = (req, res) => res.json({ scopes: SCOPES, presets: PRESETS });

exports.list = async (req, res) => {
  const clients = await ClientApp.find().select("-keyHash").sort({ createdAt: -1 }).lean();
  res.json({ clients });
};

// The key is returned ONCE here (and on rotate); only its hash is stored.
exports.create = async (req, res) => {
  try {
    const { name, description, preset } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const slug = String(req.body.slug || slugify(name)).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) {
      return res.status(400).json({ error: "slug must be 2-31 characters: a-z, 0-9, dash" });
    }
    const scopes = req.body.scopes !== undefined ? req.body.scopes : PRESETS[preset];
    if (!validScopes(scopes)) {
      return res.status(400).json({ error: "scopes (or a preset) is required", validScopes: Object.keys(SCOPES), presets: Object.keys(PRESETS) });
    }
    const allowedEvents = toList(req.body.allowedEvents, ["*"]);
    const allowedPassTypes = toList(req.body.allowedPassTypes, ["*"]);
    if (!allowedEvents || !allowedPassTypes) {
      return res.status(400).json({ error: "allowedEvents / allowedPassTypes must be arrays of codes (or \"*\")" });
    }
    const rate = req.body.rateLimitPerMin === undefined ? 300 : Number(req.body.rateLimitPerMin);
    if (!Number.isInteger(rate) || rate < 1 || rate > 6000) {
      return res.status(400).json({ error: "rateLimitPerMin must be a whole number from 1 to 6000" });
    }

    const apiKey = generateKey();
    const client = await ClientApp.create({
      name: name.trim(),
      slug,
      description: description ? String(description).slice(0, 300) : undefined,
      keyHash: hashKey(apiKey),
      keyHint: keyHint(apiKey),
      scopes,
      allowedEvents,
      allowedPassTypes,
      rateLimitPerMin: rate,
      createdBy: req.user._id,
    });
    res.status(201).json({
      client: publicView(client),
      apiKey,
      notice: "Copy this key now — it is shown only once. Send it as the X-API-Key header.",
    });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: "A client with that slug already exists" });
    console.error("createClient error:", err.message);
    res.status(500).json({ error: "Could not create the client" });
  }
};

exports.update = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const client = await ClientApp.findById(req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const b = req.body || {};

    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim()) return res.status(400).json({ error: "name cannot be empty" });
      client.name = b.name.trim();
    }
    if (b.description !== undefined) client.description = String(b.description).slice(0, 300);
    if (b.status !== undefined) {
      if (!["active", "disabled"].includes(b.status)) return res.status(400).json({ error: "status must be active or disabled" });
      client.status = b.status;
    }
    if (b.scopes !== undefined) {
      if (!validScopes(b.scopes)) return res.status(400).json({ error: "Invalid scopes", validScopes: Object.keys(SCOPES) });
      client.scopes = b.scopes;
    }
    if (b.allowedEvents !== undefined) {
      const l = toList(b.allowedEvents, null);
      if (!l) return res.status(400).json({ error: "allowedEvents must be a non-empty array of codes (or \"*\")" });
      client.allowedEvents = l;
    }
    if (b.allowedPassTypes !== undefined) {
      const l = toList(b.allowedPassTypes, null);
      if (!l) return res.status(400).json({ error: "allowedPassTypes must be a non-empty array of codes (or \"*\")" });
      client.allowedPassTypes = l;
    }
    if (b.rateLimitPerMin !== undefined) {
      const r = Number(b.rateLimitPerMin);
      if (!Number.isInteger(r) || r < 1 || r > 6000) return res.status(400).json({ error: "rateLimitPerMin must be a whole number from 1 to 6000" });
      client.rateLimitPerMin = r;
    }
    await client.save();
    res.json({ client: publicView(client) });
  } catch (err) {
    console.error("updateClient error:", err.message);
    res.status(500).json({ error: "Could not update the client" });
  }
};

// New key; the old one stops working immediately.
exports.rotateKey = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const client = await ClientApp.findById(req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const apiKey = generateKey();
    client.keyHash = hashKey(apiKey);
    client.keyHint = keyHint(apiKey);
    client.keyRotatedAt = new Date();
    await client.save();
    res.json({
      client: publicView(client),
      apiKey,
      notice: "Copy this key now — it is shown only once. The previous key no longer works.",
    });
  } catch (err) {
    console.error("rotateClientKey error:", err.message);
    res.status(500).json({ error: "Could not rotate the key" });
  }
};

// Passes already issued keep working; the client simply can no longer call in.
exports.remove = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const out = await ClientApp.findByIdAndDelete(req.params.id);
  if (!out) return res.status(404).json({ error: "Client not found" });
  res.json({ message: "Client removed" });
};
