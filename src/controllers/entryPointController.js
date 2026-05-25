const EntryPoint = require("../models/EntryPoint");
const Category = require("../models/Category");
const User = require("../models/User");
const QRPass = require("../models/QRPass");

const EP_ALLOWED_FIELDS = [
  "name", "stationLabel", "type", "description",
  "linkedEpId", "allowGroupCount", "multiEntryAllowed",
  "isPaid", "isActive", "maxCapacity", "location",
];

exports.getEntryPoints = async (req, res) => {
  try {
    const entryPoints = await EntryPoint.find({ eventId: req.params.eventId });
    res.json(entryPoints);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch entry points" });
  }
};

exports.createEntryPoint = async (req, res) => {
  try {
    const data = { ...req.body, eventId: req.params.eventId };
    if (data.linkedEpId === "" || data.linkedEpId === "none") data.linkedEpId = null;
    if (data.maxCapacity === "" || data.maxCapacity === 0) data.maxCapacity = null;
    const entryPoint = await EntryPoint.create(data);
    res.status(201).json(entryPoint);
  } catch (error) {
    res.status(500).json({ error: "Failed to create entry point: " + error.message });
  }
};

// FIX: use $set with allowlist so currentCount / eventId are never accidentally overwritten
exports.updateEntryPoint = async (req, res) => {
  try {
    const $set = {};
    for (const field of EP_ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) $set[field] = req.body[field];
    }
    if ($set.linkedEpId === "" || $set.linkedEpId === "none") $set.linkedEpId = null;
    if ($set.maxCapacity === "" || $set.maxCapacity === 0) $set.maxCapacity = null;

    const entryPoint = await EntryPoint.findOneAndUpdate(
      { _id: req.params.epId, eventId: req.params.eventId },
      { $set },
      { new: true, runValidators: true },
    );
    if (!entryPoint) return res.status(404).json({ error: "Entry point not found" });
    res.json(entryPoint);
  } catch (error) {
    res.status(500).json({ error: "Failed to update entry point: " + error.message });
  }
};

// FIX: cascade delete — remove from Category.entryPoints and User.assignedEntryPoints
exports.deleteEntryPoint = async (req, res) => {
  try {
    const epId = req.params.epId;

    // Check if any active QR passes reference this entry point
    const activePassCount = await QRPass.countDocuments({
      entryPoints: epId,
      status: "active",
    });

    if (activePassCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${activePassCount} active QR pass(es) reference this entry point. Revoke or reassign them first.`,
        activePassCount,
      });
    }

    const ep = await EntryPoint.findOneAndDelete({
      _id: epId,
      eventId: req.params.eventId,
    });
    if (!ep) return res.status(404).json({ error: "Entry point not found" });

    // Cascade: remove from categories and volunteers
    await Promise.all([
      Category.updateMany({ entryPoints: epId }, { $pull: { entryPoints: ep._id } }),
      User.updateMany({ assignedEntryPoints: epId }, { $pull: { assignedEntryPoints: ep._id } }),
    ]);

    res.json({
      success: true,
      message: "Entry point deleted and removed from categories and volunteers",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete entry point: " + error.message });
  }
};
