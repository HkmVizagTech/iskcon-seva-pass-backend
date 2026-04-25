const EntryPoint = require("../models/EntryPoint");
const Event = require("../models/Event");

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
    
    // Handle empty linkedEpId - convert to null
    if (data.linkedEpId === "" || data.linkedEpId === "none") {
      data.linkedEpId = null;
    }
    
    const entryPoint = await EntryPoint.create(data);
    res.status(201).json(entryPoint);
  } catch (error) {
    console.error("Create entry point error:", error.message);
    res.status(500).json({ error: "Failed to create entry point: " + error.message });
  }
};

exports.updateEntryPoint = async (req, res) => {
  try {
    const data = { ...req.body };
    
    // Handle empty linkedEpId - convert to null, if undefined keep as is (don't update)
    if (data.linkedEpId === "" || data.linkedEpId === "none") {
      data.linkedEpId = null;
    } else if (data.linkedEpId === undefined) {
      delete data.linkedEpId; // Don't update this field
    }
    
    // Handle empty maxCapacity
    if (data.maxCapacity === "" || data.maxCapacity === 0) {
      data.maxCapacity = null;
    }
    
    const entryPoint = await EntryPoint.findByIdAndUpdate(
      req.params.epId,
      data,
      { new: true, runValidators: true }
    );
    
    if (!entryPoint) {
      return res.status(404).json({ error: "Entry point not found" });
    }
    
    res.json(entryPoint);
  } catch (error) {
    console.error("Update entry point error:", error.message);
    res.status(500).json({ error: "Failed to update entry point: " + error.message });
  }
};

exports.deleteEntryPoint = async (req, res) => {
  try {
    await EntryPoint.findByIdAndDelete(req.params.epId);
    res.json({ message: "Entry point deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete entry point" });
  }
};
