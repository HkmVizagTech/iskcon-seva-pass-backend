const Category = require("../models/Category");
const HolderType = require("../models/HolderType");
const EntryPoint = require("../models/EntryPoint");

// Get all categories for an event
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

// Create category
exports.createCategory = async (req, res) => {
  try {
    const {
      name,
      catCode,
      description,
      color,
      icon,
      holderTypeId,
      entryPointIds,
    } = req.body;

    const holderType = await HolderType.findOne({
      _id: holderTypeId,
      eventId: req.params.eventId,
    });
    if (!holderType)
      return res.status(400).json({ error: "Invalid holder type" });

    let finalEntryPoints =
      entryPointIds && entryPointIds.length > 0
        ? entryPointIds
        : holderType.entryPoints.map((ep) => ep.toString());

    if (finalEntryPoints.length > 0) {
      const validPoints = await EntryPoint.countDocuments({
        _id: { $in: finalEntryPoints },
        eventId: req.params.eventId,
      });
      if (validPoints !== finalEntryPoints.length) {
        return res.status(400).json({ error: "Invalid entry points" });
      }
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
    res.status(500).json({ error: "Failed to create category" });
  }
};

// UPDATE CATEGORY - Full edit support
exports.updateCategory = async (req, res) => {
  try {
    const {
      name,
      catCode,
      description,
      color,
      icon,
      holderTypeId,
      entryPointIds,
      issuerRoleRequired,
      overrideAllowedBy,
      isActive,
    } = req.body;

    const updateData = {};

    if (name) updateData.name = name;
    if (catCode) updateData.catCode = catCode.toUpperCase();
    if (description !== undefined) updateData.description = description;
    if (color) updateData.color = color;
    if (icon) updateData.icon = icon;
    if (holderTypeId) {
      // Validate holder type belongs to this event
      const holderType = await HolderType.findOne({
        _id: holderTypeId,
        eventId: req.params.eventId,
      });
      if (!holderType)
        return res
          .status(400)
          .json({ error: "Invalid holder type for this event" });
      updateData.holderTypeId = holderTypeId;
    }
    if (entryPointIds) {
      // Validate entry points belong to this event
      if (entryPointIds.length > 0) {
        const validPoints = await EntryPoint.countDocuments({
          _id: { $in: entryPointIds },
          eventId: req.params.eventId,
        });
        if (validPoints !== entryPointIds.length) {
          return res.status(400).json({ error: "Invalid entry points" });
        }
      }
      updateData.entryPoints = entryPointIds;
    }
    if (issuerRoleRequired) updateData.issuerRoleRequired = issuerRoleRequired;
    if (overrideAllowedBy) updateData.overrideAllowedBy = overrideAllowedBy;
    if (typeof isActive === "boolean") updateData.isActive = isActive;

    const category = await Category.findByIdAndUpdate(
      req.params.catId,
      updateData,
      { new: true },
    )
      .populate("holderTypeId", "name code icon color")
      .populate("entryPoints", "name stationLabel type");

    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.json({ success: true, category });
  } catch (error) {
    console.error("Update category error:", error);
    res.status(500).json({ error: "Failed to update category" });
  }
};

// Delete category
exports.deleteCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.catId);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true, message: "Category deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete category" });
  }
};

// Get single category
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
