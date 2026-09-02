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
// Options the staff-permissions UI needs to render its allow-list pickers:
// every holder-type catCode configured across all events, plus the canonical
// assignable delivery methods. Served from the backend so the admin never
// picks a code that doesn't exist, and so the delivery labels have one source.
const { ASSIGNABLE_DELIVERY_METHODS } = require("../utils/issuePermissions");
const HolderTypeModel = require("../models/HolderType");
router.get("/staff/available-restrictions", _protect, _authorize("super_admin","event_admin"), async (req, res) => {
  try {
    const types = await HolderTypeModel.find({}).select("catCode name").lean();
    // Collapse to one entry per catCode — the same code exists once per event.
    const byCode = new Map();
    for (const t of types) {
      const code = String(t.catCode || "").toUpperCase();
      if (!code) continue;
      if (!byCode.has(code)) byCode.set(code, { catCode: code, name: t.name });
    }
    res.json({
      holderTypeCodes: [...byCode.values()].sort((a, b) => a.catCode.localeCompare(b.catCode)),
      deliveryMethods: ASSIGNABLE_DELIVERY_METHODS,
    });
  } catch (e) {
    console.error("available-restrictions error:", e);
    res.status(500).json({ error: "Failed to load restriction options" });
  }
});

router.get("/staff", _protect, _authorize("super_admin","event_admin"), authController.listStaffUsers);
router.post("/staff", _protect, _authorize("super_admin","event_admin"), authController.createStaffUser);
router.delete("/staff/:userId", _protect, _authorize("super_admin","event_admin"), authController.deleteStaffUser);

// ── Admin: update a staff user's role / events / permissions ─────────────────
const User = require("../models/User");
const { normaliseCodes, normaliseMethods } = require("../utils/issuePermissions");

// PATCH /staff/:userId and PATCH /staff/:userId/permissions were two
// near-identical handlers accepting overlapping subsets of the same fields, so
// a field added to one silently did nothing on the other. Both now share this
// builder and accept the full set.
//
// Every field is gated on `!== undefined`, never on truthiness: an empty array
// CLEARS an allow-list (back to "no restriction") and `false` is a meaningful
// value for every boolean here.
function buildStaffUpdate(body = {}) {
  const update = {};
  const set = (key, value) => { if (value !== undefined) update[key] = value; };

  set("role", body.role);
  set("allowedEvents", body.allowedEvents);
  set("canManualEntry", body.canManualEntry);
  set("canOverride", body.canOverride);
  set("canBahumanaView", body.canBahumanaView);
  set("isActive", body.isActive);

  if (body.allowedHolderTypeCodes !== undefined) {
    update.allowedHolderTypeCodes = normaliseCodes(body.allowedHolderTypeCodes);
  }
  if (body.allowedDeliveryMethods !== undefined) {
    update.allowedDeliveryMethods = normaliseMethods(body.allowedDeliveryMethods);
  }
  if (body.restrictToAllowedEvents !== undefined) {
    update.restrictToAllowedEvents = !!body.restrictToAllowedEvents;
  }
  if (body.canViewAllHolders !== undefined) update.canViewAllHolders = !!body.canViewAllHolders;
  if (body.canViewReports !== undefined) update.canViewReports = !!body.canViewReports;
  if (body.canViewScanFeed !== undefined) update.canViewScanFeed = !!body.canViewScanFeed;

  return update;
}

async function updateStaffUser(req, res) {
  try {
    const update = buildStaffUpdate(req.body);

    // Restrictions on a super_admin are meaningless — issuePermissions.js
    // always bypasses them — so refuse rather than storing a setting that
    // looks enforced in the UI but is not.
    if (
      String(update.role || "") === "super_admin" &&
      ((update.allowedHolderTypeCodes || []).length ||
        (update.allowedDeliveryMethods || []).length)
    ) {
      return res.status(400).json({
        error:
          "A super_admin account cannot be restricted. Use the 'issuer' role " +
          "for a limited pass-issuing account.",
      });
    }

    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { $set: update },
      { new: true, runValidators: true },
    ).select("-password").populate("allowedEvents", "name eventCode");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: authController.publicStaffFields(user) });
  } catch (e) {
    console.error("updateStaffUser error:", e);
    res.status(500).json({ error: "Failed to update user" });
  }
}

router.patch("/staff/:userId/permissions", _protect, _authorize("super_admin","event_admin"), updateStaffUser);
router.patch("/staff/:userId", _protect, _authorize("super_admin","event_admin"), updateStaffUser);
