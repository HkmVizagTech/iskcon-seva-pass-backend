const User = require("../models/User");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateShortCode(code) {
  if (!code) return null;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 2 || clean.length > 10) {
    throw new Error("Short code must be 2–10 letters/numbers (e.g. MKGD)");
  }
  return clean;
}

/**
 * Resolve a CSV preacher column value to a User _id.
 * Tries shortCode first (exact, case-insensitive), then name (case-insensitive).
 * Returns { preacherId, preacherName } or null if not found.
 */
async function resolvePreacherFromString(value, eventId) {
  if (!value || !value.trim()) return null;
  const v = value.trim();

  // Try shortCode match (most reliable — e.g. "MKGD")
  const byCode = await User.findOne({
    role: "preacher",
    shortCode: v.toUpperCase(),
    ...(eventId ? { allowedEvents: eventId } : {}),
  }).select("_id name shortCode");

  if (byCode) return { preacherId: byCode._id, preacherName: byCode.name };

  // Fallback: case-insensitive name match
  const byName = await User.findOne({
    role: "preacher",
    name: new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    ...(eventId ? { allowedEvents: eventId } : {}),
  }).select("_id name shortCode");

  if (byName) return { preacherId: byName._id, preacherName: byName.name };

  // Not found — store the raw string as preacher name, no preacherId link
  return { preacherId: null, preacherName: v };
}

module.exports.resolvePreacherFromString = resolvePreacherFromString;

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

exports.createPreacher = async (req, res) => {
  try {
    const { name, email, phone, password, allowedEvents, shortCode } = req.body;

    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!password || password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!email && !phone)
      return res.status(400).json({ error: "Email or phone is required" });
    if (!shortCode)
      return res.status(400).json({ error: "Short code is required (e.g. MKGD)" });

    let cleanCode;
    try { cleanCode = validateShortCode(shortCode); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // Check shortCode uniqueness
    const existing = await User.findOne({ shortCode: cleanCode });
    if (existing)
      return res.status(409).json({
        error: `Short code '${cleanCode}' is already used by ${existing.name}`,
      });

    if (email) {
      const existingEmail = await User.findOne({ email: email.toLowerCase() });
      if (existingEmail) return res.status(409).json({ error: "Email already registered" });
    }

    const preacher = await User.create({
      name,
      shortCode: cleanCode,
      email: email ? email.toLowerCase() : undefined,
      phone: phone || undefined,
      password,
      role: "preacher",
      allowedEvents: allowedEvents || [],
      isActive: true,
    });

    res.status(201).json({
      success: true,
      preacher: {
        id: preacher._id,
        name: preacher.name,
        shortCode: preacher.shortCode,
        email: preacher.email,
        phone: preacher.phone,
        allowedEvents: preacher.allowedEvents,
      },
    });
  } catch (error) {
    console.error("Create preacher error:", error);
    if (error.code === 11000) return res.status(409).json({ error: "Email or short code already in use" });
    res.status(500).json({ error: "Failed to create preacher" });
  }
};

exports.getPreachers = async (req, res) => {
  try {
    const { eventId } = req.query;
    const query = { role: "preacher" };
    if (eventId) query.allowedEvents = eventId;

    const preachers = await User.find(query)
      .select("-password")
      .populate("allowedEvents", "name eventCode")
      .sort({ name: 1 });

    res.json({ preachers });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch preachers" });
  }
};

exports.getPreacher = async (req, res) => {
  try {
    const preacher = await User.findOne({ _id: req.params.id, role: "preacher" })
      .select("-password")
      .populate("allowedEvents", "name eventCode dateStart dateEnd");
    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    res.json({ preacher });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch preacher" });
  }
};

exports.updatePreacher = async (req, res) => {
  try {
    const { name, email, phone, allowedEvents, isActive, shortCode } = req.body;
    const $set = {};
    if (name !== undefined) $set.name = name;
    if (email !== undefined) $set.email = email.toLowerCase();
    if (phone !== undefined) $set.phone = phone;
    if (allowedEvents !== undefined) $set.allowedEvents = allowedEvents;
    if (isActive !== undefined) $set.isActive = isActive;

    if (shortCode !== undefined) {
      let cleanCode;
      try { cleanCode = validateShortCode(shortCode); }
      catch (e) { return res.status(400).json({ error: e.message }); }

      // Check uniqueness — exclude self
      const existing = await User.findOne({
        shortCode: cleanCode,
        _id: { $ne: req.params.id },
      });
      if (existing)
        return res.status(409).json({
          error: `Short code '${cleanCode}' is already used by ${existing.name}`,
        });
      $set.shortCode = cleanCode;
    }

    const preacher = await User.findOneAndUpdate(
      { _id: req.params.id, role: "preacher" },
      { $set },
      { new: true, runValidators: true },
    ).select("-password").populate("allowedEvents", "name eventCode");

    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    res.json({ success: true, preacher });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "Email or short code already in use" });
    res.status(500).json({ error: "Failed to update preacher" });
  }
};

exports.deletePreacher = async (req, res) => {
  try {
    const preacher = await User.findOneAndUpdate(
      { _id: req.params.id, role: "preacher" },
      { $set: { isActive: false } },
      { new: true },
    );
    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    res.json({ success: true, message: "Preacher deactivated" });
  } catch (error) {
    res.status(500).json({ error: "Failed to deactivate preacher" });
  }
};

exports.resetPreacherPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    const preacher = await User.findOne({ _id: req.params.id, role: "preacher" });
    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    preacher.password = password;
    await preacher.save();
    res.json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
};

// ─── Preacher login ───────────────────────────────────────────────────────────

exports.preacherLogin = async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    if (!password) return res.status(400).json({ error: "Password is required" });
    if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });

    const query = { role: "preacher" };
    if (email) query.email = email.toLowerCase();
    else {
      const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
      const norm = digits.length === 10 ? "91" + digits : digits;
      query.$or = [{ phone: norm }, { phone: digits }, { phone }];
    }

    const preacher = await User.findOne(query).populate("allowedEvents", "name eventCode");
    if (!preacher) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await preacher.comparePassword(password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    if (!preacher.isActive) return res.status(403).json({ error: "Account deactivated" });

    preacher.lastLogin = new Date();
    await preacher.save();

    const token = jwt.sign(
      { userId: preacher._id, role: "preacher" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      success: true,
      token,
      preacher: {
        id: preacher._id,
        name: preacher.name,
        shortCode: preacher.shortCode,
        role: "preacher",
        allowedEvents: preacher.allowedEvents,
      },
    });
  } catch (error) {
    console.error("Preacher login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

// ─── Preacher dashboard data ──────────────────────────────────────────────────

exports.getMyHolders = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, eventId } = req.query;
    const preacherId = req.user._id;
    const preacherName = req.user.name;
    const allowedEventIds = (req.user.allowedEvents || []).map((e) => e.toString());

    const query = {
      $or: [
        { preacherId },
        { preacher: new RegExp(`^${preacherName}$`, "i") },
        ...(req.user.shortCode
          ? [{ preacher: new RegExp(`^${req.user.shortCode}$`, "i") }]
          : []),
      ],
    };

    if (eventId && allowedEventIds.includes(eventId)) {
      query.eventId = eventId;
    } else if (allowedEventIds.length > 0) {
      query.eventId = { $in: allowedEventIds };
    }

    if (search) {
      const searchRgx = new RegExp(search, "i");
      query.$and = [
        { $or: query.$or },
        { $or: [{ name: searchRgx }, { phone: searchRgx }] },
      ];
      delete query.$or;
    }

    const [holders, total] = await Promise.all([
      Holder.find(query)
        .populate("catId", "name icon color")
        .populate("eventId", "name eventCode")
        .sort({ issuedAt: -1 })
        .limit(Number(limit))
        .skip((Number(page) - 1) * Number(limit)),
      Holder.countDocuments(query),
    ]);

    const holderIds = holders.map((h) => h._id);
    const qrPasses = await QRPass.find({ holderId: { $in: holderIds } }).select(
      "holderId qrId status redemptionHistory deliveryStatus",
    );
    const passMap = Object.fromEntries(qrPasses.map((p) => [p.holderId.toString(), p]));

    res.json({
      holders: holders.map((h) => ({ ...h.toObject(), qrPass: passMap[h._id.toString()] || null })),
      pagination: { total, page: Number(page), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (error) {
    console.error("getMyHolders error:", error);
    res.status(500).json({ error: "Failed to fetch holders" });
  }
};

exports.getMyStats = async (req, res) => {
  try {
    const preacherId = req.user._id;
    const preacherName = req.user.name;
    const allowedEventIds = (req.user.allowedEvents || []).map((e) => e.toString());

    const holderQuery = {
      $or: [
        { preacherId },
        { preacher: new RegExp(`^${preacherName}$`, "i") },
        ...(req.user.shortCode
          ? [{ preacher: new RegExp(`^${req.user.shortCode}$`, "i") }]
          : []),
      ],
    };
    if (allowedEventIds.length > 0) holderQuery.eventId = { $in: allowedEventIds };

    const holders = await Holder.find(holderQuery).select("_id eventId").lean();
    const holderIds = holders.map((h) => h._id);

    const [activePasses, scannedPasses] = await Promise.all([
      QRPass.countDocuments({ holderId: { $in: holderIds }, status: "active" }),
      QRPass.countDocuments({
        holderId: { $in: holderIds },
        "redemptionHistory.0": { $exists: true },
      }),
    ]);

    const byEvent = await Holder.aggregate([
      { $match: holderQuery },
      { $group: { _id: "$eventId", count: { $sum: 1 } } },
      { $lookup: { from: "events", localField: "_id", foreignField: "_id", as: "event" } },
      { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
      { $project: { eventName: "$event.name", eventCode: "$event.eventCode", count: 1 } },
    ]);

    res.json({
      totalHolders: holders.length,
      activePasses,
      scannedPasses,
      scanRate: activePasses > 0 ? ((scannedPasses / activePasses) * 100).toFixed(1) : 0,
      byEvent,
    });
  } catch (error) {
    console.error("getMyStats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
};
