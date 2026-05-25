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

    // Validate entry points belong to assigned events
    if (assignedEntryPointIds && assignedEntryPointIds.length > 0) {
      const entryPoints = await EntryPoint.find({
        _id: { $in: assignedEntryPointIds },
        eventId: { $in: assignedEventIds || [] },
      });

      if (entryPoints.length !== assignedEntryPointIds.length) {
        return res.status(400).json({
          error: "Some entry points don't belong to the assigned events",
        });
      }
    }

    const volunteer = await User.create({
      name,
      email: email || undefined,
      phone,
      password,
      role: "volunteer",
      assignedEvents: assignedEventIds || [],
      assignedEntryPoints: assignedEntryPointIds || [],
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

    const volunteers = await User.find(query)
      .select("-password")
      .populate("assignedEvents", "name eventCode")
      .populate("assignedEntryPoints", "name stationLabel type allowGroupCount")
      .sort({ createdAt: -1 });

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
    if (assignedEntryPointIds)
      updateData.assignedEntryPoints = assignedEntryPointIds;
    if (req.body.assignedVenues !== undefined)
      updateData.assignedVenues = req.body.assignedVenues;

    // If password provided, it will be hashed by pre-save hook
    if (password) {
      updateData.password = password;
    }

    const volunteer = await User.findOneAndUpdate(
      { _id: req.params.id, role: "volunteer" },
      updateData,
      { new: true },
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
      query.phone = phone;
    } else {
      return res.status(400).json({ error: "Email or phone is required" });
    }

    const volunteer = await User.findOne(query)
      .populate("assignedEntryPoints", "name stationLabel type _id allowGroupCount")
      .populate("assignedEvents", "name eventCode _id");

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

    res.json({
      success: true,
      token,
      volunteer: {
        id: volunteer._id,
        name: volunteer.name,
        assignedEntryPoints: volunteer.assignedEntryPoints,
        assignedEvents: volunteer.assignedEvents,
      },
    });
  } catch (error) {
    console.error("Volunteer login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};
