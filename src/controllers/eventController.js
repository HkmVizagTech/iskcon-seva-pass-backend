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
      createdBy: req.user._id || req.user.userId,
    };

    const event = await Event.create(eventData);
    const primaryVenue = event.venue?.[0];
    const venueName = primaryVenue?.name || "ISKCON Temple";

    // Create default entry points
    const defaultEntryPoints = [
      {
        name: "Venue Entry",
        stationLabel: `Main Gate `,
        type: "venue_entry",
      },
      {
        name: "Darshan",
        stationLabel: `Darshan Queue `,
        type: "darshan",
      },
      {
        name: "Special Prasadam",
        stationLabel: `Prasadam Counter `,
        type: "prasadam",
      },
      {
        name: "Bahumana",
        stationLabel: `Bahumana Desk `,
        type: "bahumana",
      },
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

    // In createEvent function, replace HolderType creation with:
    const HolderType = require("../models/HolderType");
    const [sponsorHT, donorHT, volunteerHT, generalHT, vipHT] =
      await HolderType.insertMany([
        {
          eventId: event._id,
          name: "Sponsor",
          code: "SP",
          icon: "💰",
          color: "#F97316",
          isDefault: true,
        },
        {
          eventId: event._id,
          name: "Donor",
          code: "DN",
          icon: "🙏",
          color: "#22C55E",
          isDefault: true,
        },
        {
          eventId: event._id,
          name: "Volunteer",
          code: "VL",
          icon: "🤝",
          color: "#8B5CF6",
          isDefault: true,
        },
        {
          eventId: event._id,
          name: "General Public",
          code: "GN",
          icon: "👤",
          color: "#3B82F6",
          isDefault: true,
        },
        {
          eventId: event._id,
          name: "VIP Guest",
          code: "VP",
          icon: "⭐",
          color: "#EAB308",
          isDefault: true,
        },
      ]);

    // Create default categories linked to holder types
    await Category.insertMany([
      {
        eventId: event._id,
        name: "Sponsor",
        catCode: "SP",
        holderTypeId: sponsorHT._id,
        entryPoints: allEpIds,
        color: "#F97316",
        icon: "💰",
      },
      {
        eventId: event._id,
        name: "Donor",
        catCode: "DN",
        holderTypeId: donorHT._id,
        entryPoints: darshanPrasadamIds,
        color: "#22C55E",
        icon: "🙏",
      },
      {
        eventId: event._id,
        name: "Volunteer",
        catCode: "VL",
        holderTypeId: volunteerHT._id,
        entryPoints: venuePrasadamIds,
        color: "#8B5CF6",
        icon: "🤝",
      },
      {
        eventId: event._id,
        name: "General Public",
        catCode: "GN",
        holderTypeId: generalHT._id,
        entryPoints: entryPoints
          .filter((ep) => ep.type === "darshan")
          .map((ep) => ep._id),
        color: "#3B82F6",
        icon: "👤",
      },
      {
        eventId: event._id,
        name: "VIP Guest",
        catCode: "VP",
        holderTypeId: vipHT._id,
        entryPoints: allEpIds,
        color: "#EAB308",
        icon: "⭐",
      },
    ]);

    res.status(201).json({
      success: true,
      event,
      message:
        "Event created with default entry points, holder types, and categories",
    });
  } catch (error) {
    console.error("Create event error:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
};

exports.createPaidTier = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, entryPoints, razorpayItemId, is80gEligible } =
      req.body;

    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (event.venue && !event.venues) {
      event.venues = [event.venue];
    }

    if (!Array.isArray(entryPoints) || entryPoints.length === 0) {
      return res
        .status(400)
        .json({ error: "At least one entry point is required" });
    }

    const existingEntryPoints = await EntryPoint.countDocuments({
      _id: { $in: entryPoints },
      eventId: id,
    });
    if (existingEntryPoints !== entryPoints.length) {
      return res
        .status(400)
        .json({ error: "One or more entry points are invalid for this event" });
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
    const query = {};

    if (status) query.status = status;
    if (search) {
      query.$or = [
        { name: new RegExp(search, "i") },
        { eventCode: new RegExp(search, "i") },
      ];
    }

    const events = await Event.find(query)
      .populate("createdBy", "name email")
      .sort({ dateStart: -1 });

    const stats = await Promise.all(
      events.map(async (event) => {
        const qrCount = await QRPass.countDocuments({ eventId: event._id });
        const scannedCount = await QRPass.countDocuments({
          eventId: event._id,
          "redemptionHistory.0": { $exists: true },
        });

        return {
          ...event.toObject(),
          stats: {
            totalPasses: qrCount,
            scannedPasses: scannedCount,
            scanRate: qrCount ? ((scannedCount / qrCount) * 100).toFixed(1) : 0,
          },
        };
      }),
    );

    res.json({ events: stats });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch events" });
  }
};

exports.getEventDetails = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate(
      "createdBy",
      "name email",
    );
    if (!event) return res.status(404).json({ error: "Event not found" });

    // COMPATIBILITY: If old format (single venue object), convert to array
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

    res.json({
      event,
      entryPoints,
      categories,
      recentActivity: recentScans,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch event details" });
  }
};

exports.updateEvent = async (req, res) => {
  try {
    const updates = req.body;
    delete updates._id;
    delete updates.createdBy;

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { ...updates, updatedAt: new Date() },
      { new: true },
    );

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    res.json({ success: true, event });
  } catch (error) {
    res.status(500).json({ error: "Failed to update event" });
  }
};

exports.deleteEvent = async (req, res) => {
  try {
    const eventId = req.params.id;
    
    const event = await Event.findByIdAndDelete(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    // Find all related data first
    const [entryPoints, holders] = await Promise.all([
      EntryPoint.find({ eventId }),
      Holder.find({ eventId }),
    ]);
    
    const holderIds = holders.map(h => h._id);
    const epIds = entryPoints.map(ep => ep._id);

    // Delete everything in parallel
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

    console.log(`🗑️ Deleted event ${eventId}: ${holderIds.length} holders, ${epIds.length} entry points`);
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
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { status: "active" },
      { new: true },
    );

    res.json({ success: true, event });
  } catch (error) {
    res.status(500).json({ error: "Failed to activate event" });
  }
};

exports.deactivateEvent = async (req, res) => {
  try {
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { status: "completed" },
      { new: true },
    );

    res.json({ success: true, event });
  } catch (error) {
    res.status(500).json({ error: "Failed to deactivate event" });
  }
};
