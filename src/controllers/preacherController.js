const User = require("../models/User");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const ScanLog = require("../models/ScanLog");
const EntryPoint = require("../models/EntryPoint");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ─── Admin: manage preachers ──────────────────────────────────────────────────

exports.createPreacher = async (req, res) => {
  try {
    const { name, email, phone, password, allowedEvents } = req.body;

    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!password || password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!email && !phone)
      return res.status(400).json({ error: "Email or phone is required" });

    if (email) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(409).json({ error: "Email already registered" });
    }

    const preacher = await User.create({
      name,
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
        email: preacher.email,
        phone: preacher.phone,
        allowedEvents: preacher.allowedEvents,
      },
    });
  } catch (error) {
    console.error("Create preacher error:", error);
    if (error.code === 11000) return res.status(409).json({ error: "Email already registered" });
    res.status(500).json({ error: "Failed to create preacher" });
  }
};

exports.getPreachers = async (req, res) => {
  try {
    const { eventId } = req.query;
    const query = { role: "preacher", isActive: true };
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
    const { name, email, phone, allowedEvents, isActive } = req.body;
    const $set = {};
    if (name !== undefined) $set.name = name;
    if (email !== undefined) $set.email = email.toLowerCase();
    if (phone !== undefined) $set.phone = phone;
    if (allowedEvents !== undefined) $set.allowedEvents = allowedEvents;
    if (isActive !== undefined) $set.isActive = isActive;

    const preacher = await User.findOneAndUpdate(
      { _id: req.params.id, role: "preacher" },
      { $set },
      { new: true, runValidators: true },
    ).select("-password").populate("allowedEvents", "name eventCode");

    if (!preacher) return res.status(404).json({ error: "Preacher not found" });
    res.json({ success: true, preacher });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "Email already in use" });
    res.status(500).json({ error: "Failed to update preacher" });
  }
};

exports.deletePreacher = async (req, res) => {
  try {
    // Don't delete — just deactivate to preserve holder history
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

    preacher.password = password; // pre-save hook hashes it
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
        role: "preacher",
        allowedEvents: preacher.allowedEvents,
      },
    });
  } catch (error) {
    console.error("Preacher login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

// ─── Preacher dashboard data (scoped to their name / preacherId) ─────────────

exports.getMyHolders = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, eventId } = req.query;
    const preacherId = req.user._id;
    const preacherName = req.user.name;

    // Scope to preacher's allowed events
    const allowedEventIds = req.user.allowedEvents?.map((e) => e.toString()) || [];

    const query = {
      $or: [
        { preacherId },
        { preacher: new RegExp(`^${preacherName}$`, "i") }, // backward compat with string
      ],
    };

    if (eventId && allowedEventIds.includes(eventId)) {
      query.eventId = eventId;
    } else if (allowedEventIds.length > 0) {
      query.eventId = { $in: allowedEventIds };
    }

    if (search) {
      query.$and = [
        { $or: query.$or },
        {
          $or: [
            { name: new RegExp(search, "i") },
            { phone: new RegExp(search, "i") },
          ],
        },
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

    // Batch fetch QR passes
    const holderIds = holders.map((h) => h._id);
    const qrPasses = await QRPass.find({ holderId: { $in: holderIds } }).select(
      "holderId qrId status redemptionHistory deliveryStatus",
    );
    const passMap = Object.fromEntries(qrPasses.map((p) => [p.holderId.toString(), p]));

    const holdersWithPass = holders.map((h) => ({
      ...h.toObject(),
      qrPass: passMap[h._id.toString()] || null,
    }));

    res.json({
      holders: holdersWithPass,
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
    const allowedEventIds = req.user.allowedEvents?.map((e) => e.toString()) || [];

    const holderQuery = {
      $or: [{ preacherId }, { preacher: new RegExp(`^${preacherName}$`, "i") }],
    };
    if (allowedEventIds.length > 0) holderQuery.eventId = { $in: allowedEventIds };

    const holders = await Holder.find(holderQuery).select("_id eventId catId").lean();
    const holderIds = holders.map((h) => h._id);

    const [totalHolders, activePasses, scannedPasses] = await Promise.all([
      Promise.resolve(holders.length),
      QRPass.countDocuments({ holderId: { $in: holderIds }, status: "active" }),
      QRPass.countDocuments({
        holderId: { $in: holderIds },
        "redemptionHistory.0": { $exists: true },
      }),
    ]);

    // By event breakdown
    const byEvent = await Holder.aggregate([
      {
        $match: {
          $or: [{ preacherId }, { preacher: new RegExp(`^${preacherName}$`, "i") }],
          ...(allowedEventIds.length > 0 ? { eventId: { $in: allowedEventIds.map(id => require("mongoose").Types.ObjectId.createFromHexString(id)) } } : {}),
        },
      },
      { $group: { _id: "$eventId", count: { $sum: 1 } } },
      { $lookup: { from: "events", localField: "_id", foreignField: "_id", as: "event" } },
      { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
      { $project: { eventName: "$event.name", eventCode: "$event.eventCode", count: 1 } },
    ]);

    res.json({
      totalHolders,
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
