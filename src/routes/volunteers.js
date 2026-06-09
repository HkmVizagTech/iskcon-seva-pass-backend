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
    const activeStations = (volunteer.assignedEntryPoints || []).filter((ep) => {
      if (!ep || ep.isActive === false) return false;
      if (!ep.eventId) return false; // event deleted — orphaned station
      return true;
    });

    // Build the events list from the active stations' events (deduplicated)
    const eventMap = new Map();
    for (const ep of activeStations) {
      const ev = ep.eventId;
      if (ev && !eventMap.has(ev._id.toString())) {
        eventMap.set(ev._id.toString(), {
          _id: ev._id,
          name: ev.name,
          eventCode: ev.eventCode,
          dateStart: ev.dateStart,
          dateEnd: ev.dateEnd,
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
        eventId: (ep.eventId?._id || ep.eventId).toString(),  // ALWAYS a plain string
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

// TEMP DEBUG — remove after diagnosis
router.get("/me/debug", protect, async (req, res) => {
  try {
    const User = require("../models/User");
    const v = await User.findOne({ _id: req.user._id, role: "volunteer" })
      .select("-password")
      .populate({
        path: "assignedEntryPoints",
        select: "name stationLabel _id eventId isActive",
        populate: { path: "eventId", select: "name eventCode _id" },
      });
    if (!v) return res.status(404).json({ error: "not found", userId: req.user._id });
    res.json({
      volunteerId: v._id.toString(),
      name: v.name,
      email: v.email,
      rawAssignedCount: v.assignedEntryPoints?.length || 0,
      stations: (v.assignedEntryPoints || []).map((ep) => ({
        id: ep?._id?.toString(),
        label: ep?.stationLabel,
        isActive: ep?.isActive,
        eventResolved: !!ep?.eventId,
        eventName: ep?.eventId?.name || "EVENT NOT FOUND",
        rawEventId: ep?.eventId?._id?.toString() || ep?.eventId?.toString() || "null",
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
