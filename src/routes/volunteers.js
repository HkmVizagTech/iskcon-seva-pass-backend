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
    const volunteer = await User.findOne({ _id: req.user._id, role: "volunteer" })
      .select("-password")
      .populate("assignedEntryPoints", "name stationLabel type _id allowGroupCount eventId")
      .populate("assignedEvents", "name eventCode _id dateStart dateEnd");

    if (!volunteer) return res.status(404).json({ error: "Volunteer not found" });

    // FIX: same filter as volunteerLogin — only active/upcoming event stations
    const now = new Date();
    const activeEventIds = new Set(
      (volunteer.assignedEvents || [])
        .filter((ev) => !ev.dateEnd || new Date(ev.dateEnd).getTime() + 86400000 > now.getTime())
        .map((ev) => ev._id.toString()),
    );

    const filteredStations = (volunteer.assignedEntryPoints || []).filter((ep) =>
      activeEventIds.has(ep.eventId?.toString() || ""),
    );

    const filteredEvents = (volunteer.assignedEvents || []).filter((ev) =>
      activeEventIds.has(ev._id.toString()),
    );

    res.json({
      volunteer: {
        id: volunteer._id,
        name: volunteer.name,
        assignedEntryPoints: filteredStations,
        assignedEvents: filteredEvents,
      },
    });
  } catch (error) {
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
