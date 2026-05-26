const User = require("../models/User");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const jwt = require("jsonwebtoken");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateShortCode(code) {
  if (!code) return null;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 2 || clean.length > 10)
    throw new Error("Short code must be 2–10 letters/numbers (e.g. MKGD)");
  return clean;
}

/**
 * Resolve a CSV preacher column value to a User _id.
 * Tries shortCode first (exact, case-insensitive), then name.
 * Preacher is NOT scoped to an event — they work across all festivals.
 */
async function resolvePreacherFromString(value) {
  if (!value || !value.trim()) return null;
  const v = value.trim();

  // Try shortCode match first (e.g. "MKGD")
  const byCode = await User.findOne({
    role: "preacher",
    shortCode: v.toUpperCase(),
  }).select("_id name shortCode");
  if (byCode) return { preacherId: byCode._id, preacherName: byCode.name };

  // Fallback: case-insensitive full name match
  const byName = await User.findOne({
    role: "preacher",
    name: new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).select("_id name shortCode");
  if (byName) return { preacherId: byName._id, preacherName: byName.name };

  // Not a registered preacher — store raw string, no link
  return { preacherId: null, preacherName: v };
}

module.exports.resolvePreacherFromString = resolvePreacherFromString;

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

exports.createPreacher = async (req, res) => {
  try {
    const { name, email, phone, password, shortCode } = req.body;

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

    const existing = await User.findOne({ shortCode: cleanCode });
    if (existing)
      return res.status(409).json({
        error: `Short code '${cleanCode}' is already used by ${existing.name}`,
      });

    if (email) {
      const existingEmail = await User.findOne({ email: email.toLowerCase() });
      if (existingEmail)
        return res.status(409).json({ error: "Email already registered" });
    }

    const preacher = await User.create({
      name,
      shortCode: cleanCode,
      email: email ? email.toLowerCase() : undefined,
      phone: phone || undefined,
      password,
      role: "preacher",
      isActive: true,
      // No allowedEvents — preachers see all their holders across all festivals
    });

    res.status(201).json({
      success: true,
      preacher: {
        id: preacher._id,
        name: preacher.name,
        shortCode: preacher.shortCode,
        email: preacher.email,
        phone: preacher.phone,
      },
    });
  } catch (error) {
    console.error("Create preacher error:", error);
    if (error.code === 11000)
      return res.status(409).json({ error: "Email or short code already in use" });
    res.status(500).json({ error: "Failed to create preacher" });
  }
};

exports.getPreachers = async (req, res) => {
  try {
    // No event filter — preachers are global
    const preachers = await User.find({ role: "preacher" })
      .select("-password")
      .sort({ name: 1 });
    res.json({ preachers });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch preachers" });
  }
};

exports.getPreacher = async (req, res) => {
  try {
    const preacher = await User.findOne({ _id: req.params.id, role: "preacher" })
      .select("-password");
    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    res.json({ preacher });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch preacher" });
  }
};

exports.updatePreacher = async (req, res) => {
  try {
    const { name, email, phone, isActive, shortCode } = req.body;
    const $set = {};
    if (name !== undefined) $set.name = name;
    if (email !== undefined) $set.email = email.toLowerCase();
    if (phone !== undefined) $set.phone = phone;
    if (isActive !== undefined) $set.isActive = isActive;

    if (shortCode !== undefined) {
      let cleanCode;
      try { cleanCode = validateShortCode(shortCode); }
      catch (e) { return res.status(400).json({ error: e.message }); }

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
    ).select("-password");

    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    res.json({ success: true, preacher });
  } catch (error) {
    if (error.code === 11000)
      return res.status(409).json({ error: "Email or short code already in use" });
    res.status(500).json({ error: "Failed to update preacher" });
  }
};

exports.deletePreacher = async (req, res) => {
  try {
    // Soft delete — preserve holder history
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
    if (!email && !phone)
      return res.status(400).json({ error: "Email or phone is required" });

    const query = { role: "preacher" };
    if (email) query.email = email.toLowerCase();
    else {
      const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
      const norm = digits.length === 10 ? "91" + digits : digits;
      query.$or = [{ phone: norm }, { phone: digits }, { phone }];
    }

    const preacher = await User.findOne(query);
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
      },
    });
  } catch (error) {
    console.error("Preacher login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

// ─── Preacher's own dashboard — sees ALL their holders across ALL festivals ───

exports.getMyHolders = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, eventId } = req.query;
    const preacherId = req.user._id;
    const preacherName = req.user.name;

    // No event scoping — preacher sees all their holders across every festival
    const query = {
      $or: [
        { preacherId },
        { preacher: new RegExp(`^${preacherName}$`, "i") },
        ...(req.user.shortCode
          ? [{ preacher: new RegExp(`^${req.user.shortCode}$`, "i") }]
          : []),
      ],
    };

    // Optional event filter (for preacher's own UI — not enforced)
    if (eventId) query.eventId = eventId;

    if (search) {
      const rgx = new RegExp(search, "i");
      query.$and = [
        { $or: query.$or },
        { $or: [{ name: rgx }, { phone: rgx }] },
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
      holders: holders.map((h) => ({
        ...h.toObject(),
        qrPass: passMap[h._id.toString()] || null,
      })),
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
      },
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

    const holderQuery = {
      $or: [
        { preacherId },
        { preacher: new RegExp(`^${preacherName}$`, "i") },
        ...(req.user.shortCode
          ? [{ preacher: new RegExp(`^${req.user.shortCode}$`, "i") }]
          : []),
      ],
    };

    const holders = await Holder.find(holderQuery).select("_id eventId").lean();
    const holderIds = holders.map((h) => h._id);

    const [activePasses, scannedPasses] = await Promise.all([
      QRPass.countDocuments({ holderId: { $in: holderIds }, status: "active" }),
      QRPass.countDocuments({
        holderId: { $in: holderIds },
        "redemptionHistory.0": { $exists: true },
      }),
    ]);

    // Breakdown by festival — across ALL events
    const byEvent = await Holder.aggregate([
      { $match: holderQuery },
      { $group: { _id: "$eventId", count: { $sum: 1 } } },
      {
        $lookup: {
          from: "events",
          localField: "_id",
          foreignField: "_id",
          as: "event",
        },
      },
      { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          eventName: "$event.name",
          eventCode: "$event.eventCode",
          count: 1,
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      totalHolders: holders.length,
      activePasses,
      scannedPasses,
      scanRate:
        activePasses > 0
          ? ((scannedPasses / activePasses) * 100).toFixed(1)
          : 0,
      byEvent,
    });
  } catch (error) {
    console.error("getMyStats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
};
