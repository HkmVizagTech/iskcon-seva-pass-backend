const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { validate } = require("../middleware/validator");

// Public routes
router.post("/register", validate("register"), authController.register);
router.post("/login", validate("login"), authController.login);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);

// Protected routes
router.get("/profile", protect, authController.getProfile);
router.put("/profile", protect, authController.updateProfile);
router.post("/change-password", protect, authController.changePassword);

// Admin routes — FIX: add role guards (previously any authenticated user could manage users)
const { authorize } = require("../middleware/auth");
router.get("/users", protect, authorize("super_admin", "event_admin"), authController.getAllUsers);
router.put("/users/:id", protect, authorize("super_admin"), authController.updateUser);
router.delete("/users/:id", protect, authorize("super_admin"), authController.deleteUser);

module.exports = router;

// ── Admin-only user management ───────────────────────────────────────────────
const { protect: _protect, authorize: _authorize } = require("../middleware/auth");
router.get("/staff", _protect, _authorize("super_admin","event_admin"), authController.listStaffUsers);
router.post("/staff", _protect, _authorize("super_admin","event_admin"), authController.createStaffUser);
router.delete("/staff/:userId", _protect, _authorize("super_admin","event_admin"), authController.deleteStaffUser);

// ── Admin: toggle canManualEntry for a user ──────────────────────────────────
const User = require("../models/User");
router.patch("/staff/:userId/permissions", _protect, _authorize("super_admin","event_admin"), async (req, res) => {
  try {
    const { canManualEntry, canOverride } = req.body;
    const update = {};
    if (canManualEntry !== undefined) update.canManualEntry = canManualEntry;
    if (canOverride !== undefined) update.canOverride = canOverride;
    const user = await User.findByIdAndUpdate(req.params.userId, { $set: update }, { new: true })
      .select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: "Failed to update permissions" });
  }
});

// ── Admin: full update of a staff user (role, allowedEvents, permissions) ────
router.patch("/staff/:userId", _protect, _authorize("super_admin","event_admin"), async (req, res) => {
  try {
    const { role, allowedEvents, canManualEntry, canOverride, isActive } = req.body;
    const update = {};
    if (role !== undefined) update.role = role;
    if (allowedEvents !== undefined) update.allowedEvents = allowedEvents;
    if (canManualEntry !== undefined) update.canManualEntry = canManualEntry;
    if (canOverride !== undefined) update.canOverride = canOverride;
    if (isActive !== undefined) update.isActive = isActive;
    const user = await User.findByIdAndUpdate(
      req.params.userId, { $set: update }, { new: true }
    ).select("-password").populate("allowedEvents", "name eventCode");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: "Failed to update user" });
  }
});
