const express = require("express");
const router = express.Router();
const volunteerController = require("../controllers/volunteerController");
const { protect, authorize } = require("../middleware/auth");

// Volunteer login (public)
router.post("/login", volunteerController.volunteerLogin);

// FIX: /me endpoint so scanner can re-fetch its own assignments without logging out
router.get("/me", protect, async (req, res) => {
  try {
    const User = require("../models/User");
    const Event = require("../models/Event");
    const EntryPoint = require("../models/EntryPoint");

    const volunteer = await User.findOne({ _id: req.user._id, role: "volunteer" })
      .select("-password")
      .populate({
        path: "assignedEntryPoints",
        select: "name stationLabel type _id allowGroupCount eventId isActive",
        populate: { path: "eventId", select: "name eventCode _id dateStart dateEnd" },
      });

    if (!volunteer) return res.status(404).json({ error: "Volunteer not found" });

    // Show every assigned station that still has a valid linked event.
    // We do NOT hide stations just because the event window has passed —
    // volunteers may scan before/after official times, and admins assign
    // stations for events with various date configs. Only hide a station if:
    //   1. The station was explicitly deactivated (isActive === false), or
    //   2. Its event was deleted (eventId no longer resolves)
    // Show every assigned station that exists and is active.
    // We keep stations even if the event didn't fully populate, so volunteers
    // never lose access to assigned stations.
    const activeStations = (volunteer.assignedEntryPoints || []).filter((ep) => {
      if (!ep || !ep._id) return false;
      if (ep.isActive === false) return false;
      return true;
    });

    // Build the events list from the stations' events (deduplicated).
    // If a station's event didn't resolve, group it under a placeholder.
    const eventMap = new Map();
    for (const ep of activeStations) {
      const ev = ep.eventId;
      const evId = ev?._id ? ev._id.toString() : "unknown";
      if (!eventMap.has(evId)) {
        eventMap.set(evId, {
          _id: evId,
          name: ev?.name || "Event",
          eventCode: ev?.eventCode || "",
          dateStart: ev?.dateStart,
          dateEnd: ev?.dateEnd,
        });
      }
    }

    // Flatten station eventId back to just the id (scanner expects this shape)
    // FIX: dedup stations by _id — same entry point may have been assigned twice
    const seenStationIds = new Set();
    const stationsForScanner = activeStations
      .filter((ep) => {
        const id = ep._id.toString();
        if (seenStationIds.has(id)) return false;
        seenStationIds.add(id);
        return true;
      })
      .map((ep) => ({
        _id: ep._id.toString(),
        name: ep.name,
        stationLabel: ep.stationLabel,
        type: ep.type,
        allowGroupCount: ep.allowGroupCount,
        eventId: (ep.eventId?._id ? ep.eventId._id.toString() : "unknown"),  // plain string, fallback
        eventName: ep.eventId?.name || "",
        eventCode: ep.eventId?.eventCode || "",
      }));

    // Also stringify all event _ids
    const eventsForScanner = Array.from(eventMap.values()).map((ev) => ({
      ...ev,
      _id: ev._id.toString(),
    }));

    res.json({
      volunteer: {
        id: volunteer._id.toString(),
        name: volunteer.name,
        assignedEntryPoints: stationsForScanner,
        assignedEvents: eventsForScanner,
      },
    });
  } catch (error) {
    console.error("/volunteers/me error:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Admin routes - CRUD volunteers
router.post(
  "/",
  protect,
  authorize("super_admin", "event_admin"),
  volunteerController.createVolunteer,
);
router.get(
  "/",
  protect,
  authorize("super_admin", "event_admin"),
  volunteerController.getVolunteers,
);
router.get(
  "/available-entry-points",
  protect,
  authorize("super_admin", "event_admin"),
  volunteerController.getAvailableEntryPoints,
);
router.get(
  "/:id",
  protect,
  authorize("super_admin", "event_admin"),
  volunteerController.getVolunteer,
);
router.put(
  "/:id",
  protect,
  authorize("super_admin", "event_admin"),
  volunteerController.updateVolunteer,
);
router.delete(
  "/:id",
  protect,
  authorize("super_admin"),
  volunteerController.deleteVolunteer,
);

// DIAGNOSTIC — open in browser: /api/volunteers/diagnose?key=hkmvizag2026&q=mkgd@hkmvizag.org
router.get("/diagnose", async (req, res) => {
  try {
    if (req.query.key !== "hkmvizag2026") {
      return res.status(403).json({ error: "bad key" });
    }
    const User = require("../models/User");
    const EntryPoint = require("../models/EntryPoint");
    const Event = require("../models/Event");

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ error: "pass ?q=email-or-phone" });

    // Find the volunteer by email or phone (any format)
    const digits = q.replace(/[\+\s\-\(\)]/g, "");
    const norm = digits.length === 10 ? "91" + digits : digits;
    const volunteer = await User.findOne({
      role: "volunteer",
      $or: [
        { email: q.toLowerCase() },
        { phone: norm }, { phone: digits }, { phone: q },
      ],
    }).select("-password").lean();

    if (!volunteer) {
      // List all volunteers so we can see what exists
      const all = await User.find({ role: "volunteer" })
        .select("name email phone assignedEntryPoints assignedEvents").lean();
      return res.json({
        found: false,
        searchedFor: q,
        allVolunteers: all.map((v) => ({
          name: v.name, email: v.email, phone: v.phone,
          epCount: v.assignedEntryPoints?.length || 0,
          eventCount: v.assignedEvents?.length || 0,
        })),
      });
    }

    // For each assigned EP id, look it up directly and check its event
    const epIds = (volunteer.assignedEntryPoints || []).map((x) => x.toString());
    const eps = await EntryPoint.find({ _id: { $in: epIds } })
      .select("name stationLabel eventId isActive").lean();
    const foundEpIds = new Set(eps.map((e) => e._id.toString()));

    // Check which event each EP points to and whether that event exists
    const eventIds = [...new Set(eps.map((e) => e.eventId?.toString()).filter(Boolean))];
    const events = await Event.find({ _id: { $in: eventIds } }).select("name eventCode").lean();
    const eventSet = new Set(events.map((e) => e._id.toString()));

    res.json({
      found: true,
      volunteer: { id: volunteer._id, name: volunteer.name, email: volunteer.email, phone: volunteer.phone, isActive: volunteer.isActive },
      assignedEntryPointIds_inUserRecord: epIds.length,
      entryPointsThatActuallyExist: eps.length,
      missingEntryPointIds: epIds.filter((id) => !foundEpIds.has(id)),
      assignedEventIds_inUserRecord: (volunteer.assignedEvents || []).map((x) => x.toString()),
      stationDetail: eps.map((ep) => ({
        label: ep.stationLabel || ep.name,
        isActive: ep.isActive,
        eventId: ep.eventId?.toString() || "NULL",
        eventExists: ep.eventId ? eventSet.has(ep.eventId.toString()) : false,
        eventName: events.find((e) => e._id.toString() === ep.eventId?.toString())?.name || "EVENT MISSING",
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

module.exports = router;
