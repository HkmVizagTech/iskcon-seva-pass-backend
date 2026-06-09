const User = require("../models/User");
const EntryPoint = require("../models/EntryPoint");
const Event = require("../models/Event");

// Create volunteer (Admin only)
exports.createVolunteer = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      assignedEventIds,
      assignedEntryPointIds,
      assignedVenues, // FIX: now persisted (was ignored before, field added to User schema)
    } = req.body;

    // Check if email exists (if provided)
    if (email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ error: "Email already registered" });
      }
    }

    // FIX: keep ONLY entry points that exist AND belong to an assigned event
    let validEpIds = [];
    if (assignedEntryPointIds && assignedEntryPointIds.length > 0) {
      const uniqueIds = [...new Set(assignedEntryPointIds.map(String))];
      const eventIds = (assignedEventIds || []).map(String);
      const entryPoints = await EntryPoint.find({
        _id: { $in: uniqueIds },
        ...(eventIds.length > 0 ? { eventId: { $in: eventIds } } : {}),
      }).select("_id");
      validEpIds = entryPoints.map((ep) => ep._id);
    }

    const volunteer = await User.create({
      name,
      email: email || undefined,
      phone,
      password,
      role: "volunteer",
      assignedEvents: assignedEventIds || [],
      assignedEntryPoints: validEpIds,
      assignedVenues: assignedVenues || [],
    });

    res.status(201).json({
      success: true,
      volunteer: {
        id: volunteer._id,
        name: volunteer.name,
        email: volunteer.email,
        phone: volunteer.phone,
        assignedEvents: volunteer.assignedEvents,
        assignedEntryPoints: volunteer.assignedEntryPoints,
      },
    });
  } catch (error) {
    console.error("Create volunteer error:", error);
    res.status(500).json({ error: "Failed to create volunteer" });
  }
};

// Get all volunteers (Admin only)
exports.getVolunteers = async (req, res) => {
  try {
    const { eventId, search } = req.query;
    const query = { role: "volunteer" };

    if (eventId) {
      query.assignedEvents = eventId;
    }

    if (search) {
      query.$or = [
        { name: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
        { phone: new RegExp(search, "i") },
      ];
    }

    const volunteersRaw = await User.find(query)
      .select("-password")
      .populate("assignedEvents", "name eventCode venue")
      .populate({
        path: "assignedEntryPoints",
        select: "name stationLabel type allowGroupCount eventId",
        populate: { path: "eventId", select: "_id name eventCode" },
      })
      .sort({ createdAt: -1 });

    // FIX: clean the displayed stations — only those with a valid event,
    // and dedup by _id. This removes orphaned/duplicate IDs from old data
    // so the list view matches what the edit modal shows.
    const volunteers = volunteersRaw.map((v) => {
      const obj = v.toObject();
      const assignedEventIds = new Set((obj.assignedEvents || []).map((e) => (e._id || e).toString()));
      const seen = new Set();
      obj.assignedEntryPoints = (obj.assignedEntryPoints || []).filter((ep) => {
        if (!ep || !ep._id) return false;
        const id = ep._id.toString();
        if (seen.has(id)) return false;        // dedup
        seen.add(id);
        if (!ep.eventId) return false;          // orphaned (event deleted)
        // keep only if its event is one the volunteer is assigned to
        const epEventId = (ep.eventId._id || ep.eventId).toString();
        return assignedEventIds.has(epEventId);
      });
      return obj;
    });

    res.json({ volunteers });
  } catch (error) {
    console.error("Get volunteers error:", error);
    res.status(500).json({ error: "Failed to fetch volunteers" });
  }
};

// Get single volunteer
exports.getVolunteer = async (req, res) => {
  try {
    const volunteer = await User.findOne({
      _id: req.params.id,
      role: "volunteer",
    })
      .select("-password")
      .populate("assignedEvents", "name eventCode dateStart dateEnd venue")
      .populate("assignedEntryPoints", "name stationLabel type location allowGroupCount");

    if (!volunteer) {
      return res.status(404).json({ error: "Volunteer not found" });
    }

    res.json({ volunteer });
  } catch (error) {
    console.error("Get volunteer error:", error);
    res.status(500).json({ error: "Failed to fetch volunteer" });
  }
};

// Update volunteer
exports.updateVolunteer = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      assignedEventIds,
      assignedEntryPointIds,
      isActive,
    } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;
    if (typeof isActive === "boolean") updateData.isActive = isActive;
    if (assignedEventIds) updateData.assignedEvents = assignedEventIds;

    if (assignedEntryPointIds) {
      // FIX: validate entry points against the DB. Keep ONLY entry points that:
      //   1. Actually exist in the database (not deleted/orphaned)
      //   2. Belong to one of the assigned events
      // This purges stale/duplicate IDs that accumulated from deleted events
      // or old re-assignments — the cause of "12 stations showing for 1 event".
      const EntryPoint = require("../models/EntryPoint");
      const uniqueIds = [...new Set(assignedEntryPointIds.map(String))];
      const eventIds = (assignedEventIds || []).map(String);

      const validEps = await EntryPoint.find({
        _id: { $in: uniqueIds },
        ...(eventIds.length > 0 ? { eventId: { $in: eventIds } } : {}),
      }).select("_id");

      updateData.assignedEntryPoints = validEps.map((ep) => ep._id);
    }

    if (req.body.assignedVenues !== undefined)
      updateData.assignedVenues = req.body.assignedVenues;

    // If password provided, it will be hashed by pre-save hook
    if (password) {
      updateData.password = password;
    }

    const volunteer = await User.findOneAndUpdate(
      { _id: req.params.id, role: "volunteer" },
      { $set: updateData }, // FIX: was missing $set — Mongoose was replacing top-level fields
      { new: true, runValidators: true },
    )
      .select("-password")
      .populate("assignedEvents", "name eventCode")
      .populate("assignedEntryPoints", "name stationLabel type allowGroupCount");

    if (!volunteer) {
      return res.status(404).json({ error: "Volunteer not found" });
    }

    res.json({ success: true, volunteer });
  } catch (error) {
    console.error("Update volunteer error:", error);
    res.status(500).json({ error: "Failed to update volunteer" });
  }
};

// Delete volunteer
exports.deleteVolunteer = async (req, res) => {
  try {
    const volunteer = await User.findOneAndDelete({
      _id: req.params.id,
      role: "volunteer",
    });

    if (!volunteer) {
      return res.status(404).json({ error: "Volunteer not found" });
    }

    res.json({ success: true, message: "Volunteer deleted successfully" });
  } catch (error) {
    console.error("Delete volunteer error:", error);
    res.status(500).json({ error: "Failed to delete volunteer" });
  }
};

// Get available entry points for assigning to volunteers
exports.getAvailableEntryPoints = async (req, res) => {
  try {
    // FIX: accept multiple eventId params (?eventId=A&eventId=B)
    // previously only supported a single eventId string
    let { eventId } = req.query;

    const query = { isActive: true };
    if (eventId) {
      // eventId can be a string (single) or array (multiple)
      const eventIds = Array.isArray(eventId) ? eventId : [eventId];
      query.eventId = eventIds.length === 1 ? eventIds[0] : { $in: eventIds };
    }

    const entryPoints = await EntryPoint.find(query)
      .populate("eventId", "name eventCode")
      .sort({ eventId: 1, name: 1 });

    res.json({ entryPoints });
  } catch (error) {
    console.error("Get entry points error:", error);
    res.status(500).json({ error: "Failed to fetch entry points" });
  }
};

// Volunteer login (for scanner)
exports.volunteerLogin = async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    // Find volunteer by email or phone
    const query = { role: "volunteer" };
    if (email) {
      query.email = email.toLowerCase();
    } else if (phone) {
      // FIX: normalise phone so login works regardless of format user types
      // Volunteers are stored as 91XXXXXXXXXX — raw "9876543210" would fail lookup
      const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
      const normPhone = digits.length === 10 ? "91" + digits : digits;
      query.$or = [{ phone: normPhone }, { phone: digits }, { phone: phone }];
    } else {
      return res.status(400).json({ error: "Email or phone is required" });
    }

    const volunteer = await User.findOne(query)
      .populate({
        path: "assignedEntryPoints",
        select: "name stationLabel type _id allowGroupCount eventId isActive",
        populate: { path: "eventId", select: "name eventCode _id dateStart dateEnd" },
      });

    if (!volunteer) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isPasswordValid = await volunteer.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!volunteer.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    volunteer.lastLogin = new Date();
    await volunteer.save();

    const jwt = require("jsonwebtoken");
    const token = jwt.sign(
      { userId: volunteer._id, role: "volunteer" },
      process.env.JWT_SECRET,
      { expiresIn: "12h" },
    );

    // Only return stations belonging to the volunteer's assigned events.
    // Orphan stations from old events are excluded.
    const assignedEventIds = new Set(
      (volunteer.assignedEvents || []).map((e) => e.toString())
    );

    const activeStations = (volunteer.assignedEntryPoints || []).filter((ep) => {
      if (!ep || !ep._id) return false;
      if (ep.isActive === false) return false;
      const epEventId = ep.eventId?._id ? ep.eventId._id.toString() : (ep.eventId || "").toString();
      return assignedEventIds.has(epEventId);
    });

    // Build the events list from the active stations' events (deduplicated)
    const eventMap = new Map();
    for (const ep of activeStations) {
      const ev = ep.eventId;
      const evId = ev?._id ? ev._id.toString() : "unknown";
      if (!eventMap.has(evId)) {
        eventMap.set(evId, {
          _id: evId, name: ev?.name || "Event", eventCode: ev?.eventCode || "",
          dateStart: ev?.dateStart, dateEnd: ev?.dateEnd,
        });
      }
    }

    // FIX: dedup stations by _id
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
        eventId: (ep.eventId?._id || ep.eventId).toString(),  // ALWAYS plain string
        eventName: ep.eventId?.name || "",
        eventCode: ep.eventId?.eventCode || "",
      }));

    const eventsForScanner = Array.from(eventMap.values()).map((ev) => ({
      ...ev,
      _id: ev._id.toString(),
    }));

    res.json({
      success: true,
      token,
      volunteer: {
        id: volunteer._id.toString(),
        name: volunteer.name,
        assignedEntryPoints: stationsForScanner,
        assignedEvents: eventsForScanner,
      },
    });
  } catch (error) {
    console.error("Volunteer login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};
