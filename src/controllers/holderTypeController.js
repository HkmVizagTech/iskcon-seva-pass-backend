const HolderType = require("../models/HolderType");
const Category = require("../models/Category");

exports.getHolderTypes = async (req, res) => {
  try {
    const holderTypes = await HolderType.find({ eventId: req.params.eventId });
    res.json(holderTypes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch holder types" });
  }
};

exports.createHolderType = async (req, res) => {
  try {
    const { name, code, description, icon, color } = req.body;
    const holderType = await HolderType.create({
      eventId: req.params.eventId,
      name,
      code: code.toUpperCase(),
      description,
      icon: icon || "👤",
      color: color || "#FF6B6B",
    });
    res.status(201).json(holderType);
  } catch (error) {
    if (error.code === 11000)
      return res.status(409).json({ error: "A holder type with this code already exists" });
    res.status(500).json({ error: "Failed to create holder type" });
  }
};

exports.updateHolderType = async (req, res) => {
  try {
    const { name, code, description, icon, color } = req.body;
    // FIX: use $set so fields absent from request are not wiped
    const $set = {};
    if (name) $set.name = name;
    if (code) $set.code = code.toUpperCase();
    if (description !== undefined) $set.description = description;
    if (icon) $set.icon = icon;
    if (color) $set.color = color;

    const holderType = await HolderType.findByIdAndUpdate(
      req.params.htId,
      { $set },
      { new: true, runValidators: true },
    );
    if (!holderType)
      return res.status(404).json({ error: "Holder type not found" });
    res.json(holderType);
  } catch (error) {
    res.status(500).json({ error: "Failed to update holder type" });
  }
};

exports.deleteHolderType = async (req, res) => {
  try {
    // FIX: cascade check — categories that reference this holder type become orphaned
    const categoryCount = await Category.countDocuments({
      holderTypeId: req.params.htId,
    });
    if (categoryCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${categoryCount} category(ies) use this holder type. Reassign or delete them first.`,
        categoryCount,
      });
    }

    const holderType = await HolderType.findByIdAndDelete(req.params.htId);
    if (!holderType)
      return res.status(404).json({ error: "Holder type not found" });
    res.json({ success: true, message: "Holder type deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete holder type" });
  }
};
