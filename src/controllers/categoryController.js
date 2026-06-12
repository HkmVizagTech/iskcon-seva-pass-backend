const Category = require("../models/Category");
const HolderType = require("../models/HolderType");
const EntryPoint = require("../models/EntryPoint");
const Holder = require("../models/Holder");

exports.getCategories = async (req, res) => {
  try {
    const categories = await Category.find({ eventId: req.params.eventId })
      .populate("holderTypeId", "name code icon color")
      .populate("entryPoints", "name stationLabel type");
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
};

exports.getCategory = async (req, res) => {
  try {
    const category = await Category.findById(req.params.catId)
      .populate("holderTypeId", "name code icon color entryPoints")
      .populate("entryPoints", "name stationLabel type");
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch category" });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const { name, catCode, description, color, icon, holderTypeId, entryPointIds } = req.body;

    const holderType = await HolderType.findOne({ _id: holderTypeId, eventId: req.params.eventId });
    if (!holderType) return res.status(400).json({ error: "Invalid holder type" });

    let finalEntryPoints = entryPointIds?.length > 0
      ? entryPointIds
      : holderType.entryPoints.map((ep) => ep.toString());

    if (finalEntryPoints.length > 0) {
      const validCount = await EntryPoint.countDocuments({
        _id: { $in: finalEntryPoints }, eventId: req.params.eventId,
      });
      if (validCount !== finalEntryPoints.length)
        return res.status(400).json({ error: "Invalid entry points" });
    }

    const category = await Category.create({
      eventId: req.params.eventId,
      name,
      catCode: catCode.toUpperCase(),
      description,
      color: color || holderType.color || "#FF6B6B",
      icon: icon || holderType.icon || "🏷️",
      holderTypeId,
      entryPoints: finalEntryPoints,
    });

    const populated = await Category.findById(category._id)
      .populate("holderTypeId", "name code icon color")
      .populate("entryPoints", "name stationLabel type");

    res.status(201).json(populated);
  } catch (error) {
    // FIX: surface duplicate catCode per event with a clear message
    if (error.code === 11000) {
      return res.status(409).json({ error: "A category with this code already exists for this event" });
    }
    res.status(500).json({ error: "Failed to create category" });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const { name, catCode, description, color, icon, holderTypeId,
            entryPointIds, issuerRoleRequired, overrideAllowedBy, isActive } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (catCode) updateData.catCode = catCode.toUpperCase();
    if (description !== undefined) updateData.description = description;
    if (color) updateData.color = color;
    if (icon) updateData.icon = icon;
    if (holderTypeId) {
      const ht = await HolderType.findOne({ _id: holderTypeId, eventId: req.params.eventId });
      if (!ht) return res.status(400).json({ error: "Invalid holder type for this event" });
      updateData.holderTypeId = holderTypeId;
    }
    if (entryPointIds) {
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

    const category = await Category.findByIdAndUpdate(
      req.params.catId, { $set: updateData }, { returnDocument: "after" }
    )
      .populate("holderTypeId", "name code icon color")
      .populate("entryPoints", "name stationLabel type");

    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true, category });
  } catch (error) {
    if (error.code === 11000)
      return res.status(409).json({ error: "A category with this code already exists for this event" });
    res.status(500).json({ error: "Failed to update category" });
  }
};

// FIX: check for active holders before deleting category
exports.deleteCategory = async (req, res) => {
  try {
    const activeHolderCount = await Holder.countDocuments({ catId: req.params.catId });
    if (activeHolderCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${activeHolderCount} holder(s) are assigned to this category. Reassign them first.`,
        activeHolderCount,
      });
    }
    const category = await Category.findByIdAndDelete(req.params.catId);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true, message: "Category deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete category" });
  }
};
