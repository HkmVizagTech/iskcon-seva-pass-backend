const express = require("express");
const router = express.Router({ mergeParams: true }); // picks up :eventId from parent
const { protect, authorize } = require("../middleware/auth");
const SevaSlot = require("../models/SevaSlot");

const ADMIN = ["super_admin", "event_admin"];

// ── GET /api/events/:eventId/seva-slots ──────────────────────────────────────
router.get("/", protect, async (req, res) => {
  try {
    const slots = await SevaSlot.find({ eventId: req.params.eventId, isActive: true })
      .sort({ sortOrder: 1, code: 1 });
    res.json({ slots });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch slots" });
  }
});

// ── POST /api/events/:eventId/seva-slots ─────────────────────────────────────
router.post("/", protect, authorize(...ADMIN), async (req, res) => {
  try {
    const { code, name, time, description, sortOrder } = req.body;
    if (!code) return res.status(400).json({ error: "code is required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    const slot = await SevaSlot.create({
      eventId: req.params.eventId,
      code: code.toString().trim().toUpperCase(),
      name, time, description,
      sortOrder: sortOrder ?? 0,
    });
    res.status(201).json({ slot });
  } catch (e) {
    if (e.code === 11000)
      return res.status(409).json({ error: `Slot code "${req.body.code?.toUpperCase()}" already exists for this event` });
    res.status(500).json({ error: "Failed to create slot" });
  }
});

// ── PATCH /api/events/:eventId/seva-slots/:slotId ────────────────────────────
router.patch("/:slotId", protect, authorize(...ADMIN), async (req, res) => {
  try {
    const { name, time, description, sortOrder, isActive } = req.body;
    const $set = {};
    if (name !== undefined) $set.name = name;
    if (time !== undefined) $set.time = time;
    if (description !== undefined) $set.description = description;
    if (sortOrder !== undefined) $set.sortOrder = sortOrder;
    if (isActive !== undefined) $set.isActive = isActive;

    const slot = await SevaSlot.findOneAndUpdate(
      { _id: req.params.slotId, eventId: req.params.eventId },
      { $set }, { returnDocument: "after" },
    );
    if (!slot) return res.status(404).json({ error: "Slot not found" });
    res.json({ slot });
  } catch (e) {
    res.status(500).json({ error: "Failed to update slot" });
  }
});

// ── DELETE /api/events/:eventId/seva-slots/:slotId ───────────────────────────
router.delete("/:slotId", protect, authorize(...ADMIN), async (req, res) => {
  try {
    const slot = await SevaSlot.findOneAndUpdate(
      { _id: req.params.slotId, eventId: req.params.eventId },
      { $set: { isActive: false } }, { returnDocument: "after" },
    );
    if (!slot) return res.status(404).json({ error: "Slot not found" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete slot" });
  }
});

module.exports = router;
