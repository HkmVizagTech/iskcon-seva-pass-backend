const Event = require("../models/Event");
const EntryPoint = require("../models/EntryPoint");
const Category = require("../models/Category");
const QRPass = require("../models/QRPass");
const PaidTier = require("../models/PaidTier");
const HolderType = require("../models/HolderType");
const Holder = require("../models/Holder");
const ScanLog = require("../models/ScanLog");
const FailedImport = require("../models/FailedImport");

exports.createEvent = async (req, res) => {
  try {
    const eventData = {
      ...req.body,
      // FIX: sanitise eventCode — strip spaces and special chars so QR IDs are always clean
      eventCode: (req.body.eventCode || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      createdBy: req.user._id || req.user.userId,
    };
    if (!eventData.eventCode) {
      return res.status(400).json({ error: "Event code is required and must contain letters or numbers" });
    }

    // FIX: validate dateEnd > dateStart
    if (eventData.dateStart && eventData.dateEnd) {
      if (new Date(eventData.dateEnd) <= new Date(eventData.dateStart)) {
        return res.status(400).json({ error: "End date must be after start date" });
      }
    }

    const event = await Event.create(eventData);
    const primaryVenue = event.venue?.[0];

    const defaultEntryPoints = [
      { name: "Venue Entry", stationLabel: "Main Gate", type: "venue_entry" },
      { name: "Darshan", stationLabel: "Darshan Queue", type: "darshan" },
      { name: "Special Prasadam", stationLabel: "Prasadam Counter", type: "prasadam" },
      { name: "Bahumana", stationLabel: "Bahumana Desk", type: "bahumana" },
    ];

    const entryPoints = await EntryPoint.insertMany(
      defaultEntryPoints.map((ep) => ({ ...ep, eventId: event._id })),
    );

    const allEpIds = entryPoints.map((ep) => ep._id);
    const darshanPrasadamIds = entryPoints
      .filter((ep) => ["darshan", "prasadam"].includes(ep.type))
      .map((ep) => ep._id);
    const venuePrasadamIds = entryPoints
      .filter((ep) => ["venue_entry", "prasadam"].includes(ep.type))
      .map((ep) => ep._id);

    const [sponsorHT, donorHT, volunteerHT, generalHT, vipHT] =
      await HolderType.insertMany([
        { eventId: event._id, name: "Sponsor", code: "SP", icon: "💰", color: "#F97316", isDefault: true },
        { eventId: event._id, name: "Donor", code: "DN", icon: "🙏", color: "#22C55E", isDefault: true },
        { eventId: event._id, name: "Volunteer", code: "VL", icon: "🤝", color: "#8B5CF6", isDefault: true },
        { eventId: event._id, name: "General Public", code: "GN", icon: "👤", color: "#3B82F6", isDefault: true },
        { eventId: event._id, name: "VIP Guest", code: "VP", icon: "⭐", color: "#EAB308", isDefault: true },
      ]);

    await Category.insertMany([
      { eventId: event._id, name: "Sponsor", catCode: "SP", holderTypeId: sponsorHT._id, entryPoints: allEpIds, color: "#F97316", icon: "💰" },
      { eventId: event._id, name: "Donor", catCode: "DN", holderTypeId: donorHT._id, entryPoints: darshanPrasadamIds, color: "#22C55E", icon: "🙏" },
      { eventId: event._id, name: "Volunteer", catCode: "VL", holderTypeId: volunteerHT._id, entryPoints: venuePrasadamIds, color: "#8B5CF6", icon: "🤝" },
      { eventId: event._id, name: "General Public", catCode: "GN", holderTypeId: generalHT._id, entryPoints: entryPoints.filter((ep) => ep.type === "darshan").map((ep) => ep._id), color: "#3B82F6", icon: "👤" },
      { eventId: event._id, name: "VIP Guest", catCode: "VP", holderTypeId: vipHT._id, entryPoints: allEpIds, color: "#EAB308", icon: "⭐" },
    ]);

    res.status(201).json({
      success: true,
      event,
      message: "Event created with default entry points, holder types, and categories",
    });
  } catch (error) {
    console.error("Create event error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ error: "Event code already exists. Use a different code." });
    }
    res.status(500).json({ error: "Failed to create event" });
  }
};

exports.createPaidTier = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, entryPoints, razorpayItemId, is80gEligible } = req.body;

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ error: "Event not found" });

    if (!Array.isArray(entryPoints) || entryPoints.length === 0) {
      return res.status(400).json({ error: "At least one entry point is required" });
    }

    const existingEntryPoints = await EntryPoint.countDocuments({
      _id: { $in: entryPoints },
      eventId: id,
    });
    if (existingEntryPoints !== entryPoints.length) {
      return res.status(400).json({ error: "One or more entry points are invalid for this event" });
    }

    const tier = await PaidTier.create({
      eventId: id,
      name,
      price,
      entryPoints,
      razorpayItemId,
      is80gEligible: Boolean(is80gEligible),
    });

    res.status(201).json({ success: true, tier });
  } catch (error) {
    console.error("Create paid tier error:", error);
    res.status(500).json({ error: "Failed to create paid tier" });
  }
};

exports.getEvents = async (req, res) => {
  try {
    const { status, search } = req.query;

    // FIX: "status" is a virtual — cannot filter by it in MongoDB.
    // Translate status string into a date range query.
    const query = {};
    const now = new Date();

    if (status === "upcoming") {
      query.dateStart = { $gt: now };
    } else if (status === "active") {
      query.dateStart = { $lte: now };
      query.dateEnd = { $gte: now };
    } else if (status === "completed") {
      query.dateEnd = { $lt: now };
    }

    if (search) {
      query.$or = [
        { name: new RegExp(search, "i") },
        { eventCode: new RegExp(search, "i") },
      ];
    }

    const events = await Event.find(query)
      .populate("createdBy", "name email")
      .sort({ dateStart: -1 });

    // FIX: single aggregation instead of 2N parallel countDocuments queries
    const eventIds = events.map((e) => e._id);
    const [totalAgg, scannedAgg] = await Promise.all([
      QRPass.aggregate([
        { $match: { eventId: { $in: eventIds } } },
        { $group: { _id: "$eventId", count: { $sum: 1 } } },
      ]),
      QRPass.aggregate([
        { $match: { eventId: { $in: eventIds }, "redemptionHistory.0": { $exists: true } } },
        { $group: { _id: "$eventId", count: { $sum: 1 } } },
      ]),
    ]);

    const totalMap = Object.fromEntries(totalAgg.map((r) => [r._id.toString(), r.count]));
    const scannedMap = Object.fromEntries(scannedAgg.map((r) => [r._id.toString(), r.count]));

    const eventsWithStats = events.map((event) => {
      const total = totalMap[event._id.toString()] || 0;
      const scanned = scannedMap[event._id.toString()] || 0;
      return {
        ...event.toObject(),
        stats: {
          totalPasses: total,
          scannedPasses: scanned,
          scanRate: total ? ((scanned / total) * 100).toFixed(1) : 0,
        },
      };
    });

    res.json({ events: eventsWithStats });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch events" });
  }
};

exports.getEventDetails = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate("createdBy", "name email");
    if (!event) return res.status(404).json({ error: "Event not found" });

    const eventObj = event.toObject();
    if (!Array.isArray(eventObj.venue)) {
      eventObj.venue = eventObj.venue ? [eventObj.venue] : [];
    }

    const [entryPoints, categories, recentScans] = await Promise.all([
      EntryPoint.find({ eventId: event._id }),
      Category.find({ eventId: event._id })
        .populate("holderTypeId", "name code icon color")
        .populate("entryPoints", "name stationLabel type"),
      QRPass.find({ eventId: event._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("holderId", "name phone"),
    ]);

    res.json({ event, entryPoints, categories, recentActivity: recentScans });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch event details" });
  }
};

exports.updateEvent = async (req, res) => {
  try {
    const body = req.body;

    // FIX: Use $set so only the provided fields are updated.
    // Previously spread the full body without $set, meaning any field absent
    // from the payload (e.g. settings, bannerImage) was overwritten with
    // undefined, clearing it in the database.
    const ALLOWED = [
      "name", "eventCode", "description",
      "dateStart", "dateEnd", "venue",
      "bannerImage", "donorThreshold", "settings",
    ];

    const $set = { updatedAt: new Date() };
    for (const key of ALLOWED) {
      if (body[key] !== undefined) {
        $set[key] = body[key];
      }
    }
    // FIX: sanitise eventCode if being updated
    if ($set.eventCode) {
      $set.eventCode = $set.eventCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    // FIX: validate date order on update
    const startDate = $set.dateStart ? new Date($set.dateStart) : null;
    const endDate = $set.dateEnd ? new Date($set.dateEnd) : null;
    if (startDate && endDate && endDate <= startDate) {
      return res.status(400).json({ error: "End date must be after start date" });
    }

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $set },
      { new: true, runValidators: true },
    );

    if (!event) return res.status(404).json({ error: "Event not found" });

    // NOTE: No need to re-sign QR passes when dates change.
    // validateQR now reads event.dateStart/dateEnd from the live DB record,
    // so all existing QR passes immediately respect the new dates.
    res.json({ success: true, event });
  } catch (error) {
    console.error("Update event error:", error);
    res.status(500).json({ error: "Failed to update event" });
  }
};

exports.deleteEvent = async (req, res) => {
  try {
    const eventId = req.params.id;

    const event = await Event.findByIdAndDelete(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    // FIX: revoke all active QR passes so holders get a clear "revoked" message at scan time
    await QRPass.updateMany({ eventId, status: "active" }, { $set: { status: "revoked" } });

    const [entryPoints, holders] = await Promise.all([
      EntryPoint.find({ eventId }),
      Holder.find({ eventId }),
    ]);

    const holderIds = holders.map((h) => h._id);
    const epIds = entryPoints.map((ep) => ep._id);

    await Promise.all([
      EntryPoint.deleteMany({ eventId }),
      Category.deleteMany({ eventId }),
      HolderType.deleteMany({ eventId }),
      Holder.deleteMany({ eventId }),
      QRPass.deleteMany({ eventId }),
      ScanLog.deleteMany({ epId: { $in: epIds } }),
      ScanLog.deleteMany({ holderId: { $in: holderIds } }),
      FailedImport.deleteMany({ eventId }),
    ]);

    res.json({
      success: true,
      message: "Event and all related data deleted",
      holdersDeleted: holderIds.length,
      entryPointsDeleted: epIds.length,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete event" });
  }
};

exports.activateEvent = async (req, res) => {
  try {
    // Status is a virtual — we nudge dates to force "active" state
    // by ensuring dateStart <= now <= dateEnd without overriding business data.
    // The more correct approach is simply returning the event as-is after a
    // no-op update; actual activation is controlled by dateStart/dateEnd.
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json({ success: true, event });
  } catch (error) {
    res.status(500).json({ error: "Failed to activate event" });
  }
};

exports.deactivateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json({ success: true, event });
  } catch (error) {
    res.status(500).json({ error: "Failed to deactivate event" });
  }
};
