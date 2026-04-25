const HolderType = require("../models/HolderType");

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
    res.status(500).json({ error: "Failed to create holder type" });
  }
};

exports.updateHolderType = async (req, res) => {
  try {
    const { name, code, description, icon, color } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (code) updateData.code = code.toUpperCase();
    if (description !== undefined) updateData.description = description;
    if (icon) updateData.icon = icon;
    if (color) updateData.color = color;

    const holderType = await HolderType.findByIdAndUpdate(
      req.params.htId,
      updateData,
      { new: true },
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
    await HolderType.findByIdAndDelete(req.params.htId);
    res.json({ success: true, message: "Holder type deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete holder type" });
  }
};
