const HolderType = require("../models/HolderType");
const EntryPoint = require("../models/EntryPoint");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");

// Full CRUD for the merged HolderType entity (absorbs the old
// categoryController capabilities: entry points, access-control roles,
// duplicate-catCode handling and delete guards).

exports.getHolderTypes = async (req, res) => {
  try {
    const holderTypes = await HolderType.find({ eventId: req.params.eventId })
      .populate("entryPoints", "name stationLabel type");
    res.json(holderTypes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch holder types" });
  }
};

exports.getHolderType = async (req, res) => {
  try {
    const holderType = await HolderType.findById(req.params.htId)
      .populate("entryPoints", "name stationLabel type");
    if (!holderType) return res.status(404).json({ error: "Holder type not found" });
    res.json(holderType);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch holder type" });
  }
};

exports.createHolderType = async (req, res) => {
  try {
    const { name, catCode, description, color, icon,
            entryPointIds, issuerRoleRequired, overrideAllowedBy, categories } = req.body;

    if (!name || !catCode) {
      return res.status(400).json({ error: "Name and code are required" });
    }

    const finalEntryPoints = entryPointIds?.length > 0 ? entryPointIds : [];
    if (finalEntryPoints.length > 0) {
      const validCount = await EntryPoint.countDocuments({
        _id: { $in: finalEntryPoints }, eventId: req.params.eventId,
      });
      if (validCount !== finalEntryPoints.length)
        return res.status(400).json({ error: "Invalid entry points" });
    }

    const holderType = await HolderType.create({
      eventId: req.params.eventId,
      name,
      catCode: catCode.toUpperCase(),
      description,
      color: color || "#FF6B6B",
      icon: icon || "🏷️",
      entryPoints: finalEntryPoints,
      issuerRoleRequired,
      overrideAllowedBy,
      isCustom: true,
      categories: Array.isArray(categories) ? categories : [],
    });

    const populated = await HolderType.findById(holderType._id)
      .populate("entryPoints", "name stationLabel type");
    res.status(201).json(populated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "A holder type with this code already exists for this event" });
    }
    res.status(500).json({ error: "Failed to create holder type" });
  }
};

exports.updateHolderType = async (req, res) => {
  try {
    const { name, catCode, description, color, icon,
            entryPointIds, issuerRoleRequired, overrideAllowedBy, isActive, categories } = req.body;

    // FIX: use $set so fields absent from the request are not wiped
    const updateData = {};
    if (name) updateData.name = name;
    if (catCode) updateData.catCode = catCode.toUpperCase();
    if (description !== undefined) updateData.description = description;
    if (color) updateData.color = color;
    if (icon) updateData.icon = icon;
    if (entryPointIds !== undefined) {
      if (entryPointIds.length > 0) {
        const validCount = await EntryPoint.countDocuments({
          _id: { $in: entryPointIds }, eventId: req.params.eventId,
        });
        if (validCount !== entryPointIds.length)
          return res.status(400).json({ error: "Invalid entry points" });
      }
      updateData.entryPoints = entryPointIds;
    }
    if (issuerRoleRequired) updateData.issuerRoleRequired = issuerRoleRequired;
    if (overrideAllowedBy) updateData.overrideAllowedBy = overrideAllowedBy;
    if (typeof isActive === "boolean") updateData.isActive = isActive;
    if (Array.isArray(categories)) updateData.categories = categories;

    const holderType = await HolderType.findByIdAndUpdate(
      req.params.htId,
      { $set: updateData },
      { returnDocument: "after", runValidators: true },
    ).populate("entryPoints", "name stationLabel type");

    if (!holderType)
      return res.status(404).json({ error: "Holder type not found" });
    res.json({ success: true, holderType });
  } catch (error) {
    if (error.code === 11000)
      return res.status(409).json({ error: "A holder type with this code already exists for this event" });
    res.status(500).json({ error: "Failed to update holder type" });
  }
};

exports.deleteHolderType = async (req, res) => {
  try {
    const existing = await HolderType.findById(req.params.htId);
    if (!existing) return res.status(404).json({ error: "Holder type not found" });

    if (existing.isDefault) {
      return res.status(409).json({ error: "Default pass types cannot be deleted. Deactivate them instead." });
    }

    const activeHolderCount = await Holder.countDocuments({ catId: req.params.htId });
    if (activeHolderCount > 0 && !req.query.moveToTypeId) {
      return res.status(409).json({
        error: `Cannot delete: ${activeHolderCount} holder(s) are assigned to this type. Reassign them first.`,
        activeHolderCount,
      });
    }

    // Optional reassign-and-delete: move all holders (and their QR passes)
    // to the target type in the same event, then remove this type.
    let reassignedHolders = 0;
    let reassignedPasses = 0;
    if (activeHolderCount > 0 && req.query.moveToTypeId) {
      const target = await HolderType.findOne({
        _id: req.query.moveToTypeId,
        eventId: existing.eventId,
      });
      if (!target) return res.status(400).json({ error: "Target pass type not found for this event" });
      if (String(target._id) === String(existing._id)) {
        return res.status(400).json({ error: "Target pass type must be different from the one being deleted" });
      }

      const holderRes = await Holder.updateMany(
        { catId: existing._id },
        { $set: { catId: target._id } },
      );
      reassignedHolders = holderRes.modifiedCount ?? activeHolderCount;

      // Keep QR passes pointing at a live type — scan feed, reports and the
      // app resolve catId for display/grouping. Entry-point enforcement is
      // unaffected (it uses the pass's own entryPoints array).
      const passRes = await QRPass.updateMany(
        { catId: existing._id },
        { $set: { catId: target._id } },
      );
      reassignedPasses = passRes.modifiedCount ?? 0;
    }

    await HolderType.findByIdAndDelete(req.params.htId);
    res.json({
      success: true,
      message: reassignedHolders > 0
        ? `Pass type deleted. ${reassignedHolders} holder(s) and ${reassignedPasses} pass(es) moved to the target type.`
        : "Holder type deleted successfully",
      reassignedHolders,
      reassignedPasses,
    });
  } catch (error) {
    console.error("deleteHolderType error:", error);
    res.status(500).json({ error: "Failed to delete holder type" });
  }
};
