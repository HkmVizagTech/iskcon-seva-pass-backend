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

    // Only return stations that belong to an event the volunteer is assigned to.
    // Stations from old/removed events are orphans and should not appear.
    const assignedEventIds = new Set(
      (volunteer.assignedEvents || []).map((e) => e.toString())
    );

    const activeStations = (volunteer.assignedEntryPoints || []).filter((ep) => {
      if (!ep || !ep._id) return false;
      if (ep.isActive === false) return false;
      // Station's event must be in the volunteer's assignedEvents
      const epEventId = ep.eventId?._id ? ep.eventId._id.toString() : (ep.eventId || "").toString();
      return assignedEventIds.has(epEventId);
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

    // Background cleanup: if orphaned IDs were found, purge them from the DB
    const cleanEpIds = activeStations.map((ep) => ep._id);
    if (cleanEpIds.length < (volunteer.assignedEntryPoints || []).length) {
      User.updateOne(
        { _id: volunteer._id },
        { $set: { assignedEntryPoints: cleanEpIds } }
      ).catch((err) => console.error("EP cleanup error:", err));
    }

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

module.exports = router;
