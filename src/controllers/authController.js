const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { isValidRole, canAssignRole, canManageUser } = require("../utils/roles");

const MIN_PASSWORD_LENGTH = 8;
const validPassword = (p) => typeof p === "string" && p.length >= MIN_PASSWORD_LENGTH;
const passwordTooShort = { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };

const {
  normaliseCodes,
  normaliseMethods,
} = require("../utils/issuePermissions");

const getReqUserId = (req) => req.user?._id || req.user?.userId;

// The `permissions` block the dashboard's AuthContext reads.
//
// FIX: login() nested these under `permissions` but getProfile() returned the
// raw user document with the same flags at top level, so `user.permissions` was
// undefined after every page refresh and permission-gated screens fell back to
// "no access" for legitimate users. Both endpoints now emit this one shape.
const permissionsBlock = (u) => ({
  canOverride: !!u.canOverride,
  canManualEntry: !!u.canManualEntry,
  canBahumanaView: !!u.canBahumanaView,
  allowedEvents: u.allowedEvents || [],
  // Turns allowedEvents into a hard limit rather than a label.
  restrictToAllowedEvents: u.restrictToAllowedEvents === true,
  // Per-account issue restrictions — empty array means "no restriction".
  allowedHolderTypeCodes: u.allowedHolderTypeCodes || [],
  allowedDeliveryMethods: u.allowedDeliveryMethods || [],
  // Absent on user documents predating these fields — treat as allowed.
  canViewAllHolders: u.canViewAllHolders !== false,
  canViewReports: u.canViewReports !== false,
  canViewScanFeed: u.canViewScanFeed !== false,
});

// The staff-user shape returned to the admin dashboard. Kept in one place so
// create / list / update can't drift and leave the UI unable to show a
// permission it just saved.
const publicStaffFields = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  isActive: u.isActive,
  canManualEntry: u.canManualEntry,
  canOverride: u.canOverride,
  canBahumanaView: u.canBahumanaView,
  allowedEvents: u.allowedEvents,
  restrictToAllowedEvents: u.restrictToAllowedEvents === true,
  allowedHolderTypeCodes: u.allowedHolderTypeCodes || [],
  allowedDeliveryMethods: u.allowedDeliveryMethods || [],
  canViewAllHolders: u.canViewAllHolders !== false,
  canViewReports: u.canViewReports !== false,
  canViewScanFeed: u.canViewScanFeed !== false,
});

// Exported so routes/auth.js's PATCH handlers return the same shape.
exports.publicStaffFields = publicStaffFields;

const generateToken = (user) => {
  return jwt.sign(
    { userId: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

// ─── Helper: normalise phone to 91XXXXXXXXXX ─────────────────────────────────
function normalisePhone(phone) {
  if (!phone) return undefined;
  const digits = phone.replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
}

exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, phone, password } = req.body;

    // Only a super_admin may choose a role; everyone else is forced to "self".
    let role = "self";
    if (req.body.role !== undefined && req.user?.role === "super_admin") {
      if (!isValidRole(req.body.role)) return res.status(400).json({ error: "Invalid role" });
      role = req.body.role;
    }

    if (email) {
      const existingUser = await User.findOne({ email: String(email).toLowerCase() });
      if (existingUser) return res.status(400).json({ error: "Email already registered" });
    }

    const user = await User.create({
      name,
      email: email || undefined,
      phone: normalisePhone(phone),
      password,
      role,
    });

    res.status(201).json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    console.error("Registration error:", error);
    if (error.code === 11000) return res.status(409).json({ error: "Email already registered" });
    res.status(500).json({ error: "Registration failed" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.isActive) return res.status(403).json({ error: "Account is deactivated" });

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user);
    res.json({
      success: true, token,
      user: {
        id: user._id, name: user.name, email: user.email,
        role: user.role, avatar: user.avatar,
        permissions: permissionsBlock(user),
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(getReqUserId(req))
      .select("-password")
      .populate("allowedEvents", "name eventCode");
    if (!user) return res.status(404).json({ error: "User not found" });
    // Top-level fields kept for the settings page, plus the same nested
    // `permissions` block login() returns so a page refresh doesn't lose it.
    res.json({
      user: {
        ...user.toObject(),
        id: user._id,
        permissions: permissionsBlock(user),
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// FIX: updateProfile uses $set with only defined fields to prevent blanking fields
exports.updateProfile = async (req, res) => {
  try {
    const update = {};
    if (req.body.name !== undefined) update.name = req.body.name;
    if (req.body.phone !== undefined) update.phone = normalisePhone(req.body.phone);
    if (req.body.avatar !== undefined) update.avatar = req.body.avatar;

    const user = await User.findByIdAndUpdate(
      getReqUserId(req),
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).select("-password");

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: "Failed to update profile" });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    // Identical response whether or not the account exists (no enumeration).
    const generic = {
      success: true,
      message: "If an account exists for that email, password reset instructions will be sent.",
    };
    if (!email) return res.json(generic);

    const user = await User.findOne({ email });
    if (!user || !user.isActive) return res.json(generic);

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    user.resetPasswordExpire = Date.now() + 30 * 60 * 1000;
    await user.save();

    // No reset-mail template exists yet, so nothing is delivered. The token is
    // only ever exposed in development.
    console.log(`Password reset requested for user ${user._id} (no mail sender configured)`);

    res.json({
      ...generic,
      resetToken: process.env.NODE_ENV === "development" ? resetToken : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process forgot password" });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (typeof token !== "string" || !token) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }
    if (!validPassword(password)) return res.status(400).json(passwordTooShort);
    const resetPasswordToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() },
    });
    if (!user) return res.status(400).json({ error: "Invalid or expired reset token" });

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    res.json({ success: true, message: "Password reset successful" });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!validPassword(newPassword)) return res.status(400).json(passwordTooShort);
    if (typeof currentPassword !== "string") {
      return res.status(400).json({ error: "Current password is required" });
    }
    const user = await User.findById(getReqUserId(req));
    if (!user) return res.status(404).json({ error: "User not found" });
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) return res.status(401).json({ error: "Current password is incorrect" });

    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to change password" });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// FIX: updateUser uses $set with only defined fields
exports.updateUser = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const { name, email, phone, role, isActive, canOverride } = req.body;
    if (role !== undefined && !isValidRole(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (String(req.params.id) === String(getReqUserId(req)) &&
        (role !== undefined || isActive === false)) {
      return res.status(400).json({ error: "You cannot change your own role or deactivate yourself" });
    }
    const update = {};
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email;
    if (phone !== undefined) update.phone = normalisePhone(phone);
    if (role !== undefined) update.role = role;
    if (isActive !== undefined) update.isActive = isActive;
    if (canOverride !== undefined) update.canOverride = canOverride;

    const user = await User.findByIdAndUpdate(
      req.params.id, { $set: update }, { returnDocument: "after" }
    ).select("-password");

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "Email already in use" });
    res.status(500).json({ error: "Failed to update user" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    // Prevent self-deletion
    if (req.params.id === (getReqUserId(req) || "").toString()) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
};

// ── Admin: create a staff user (event_admin, announcer, etc) ────────────────
exports.createStaffUser = async (req, res) => {
  try {
    const {
      name, email, password, role, allowedEvents, canManualEntry,
      canBahumanaView,
      // Per-account issue restrictions — see utils/issuePermissions.js
      allowedHolderTypeCodes, allowedDeliveryMethods, restrictToAllowedEvents,
      canViewAllHolders, canViewReports, canViewScanFeed,
    } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "name, email, password, role are required" });
    }
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid email or password" });
    }
    if (!validPassword(password)) return res.status(400).json(passwordTooShort);
    if (!isValidRole(role)) return res.status(400).json({ error: "Invalid role" });
    if (!canAssignRole(req.user, role)) {
      return res.status(403).json({ error: "You cannot create an account with this role" });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    // An "issuer" starts LOCKED DOWN: when the caller sends no explicit view
    // flags, they default to false for this role instead of true. A
    // half-filled form should not quietly produce a fully-privileged account.
    const isIssuer = String(role) === "issuer";
    const flag = (v, fallback) => (typeof v === "boolean" ? v : fallback);

    const user = await User.create({
      name, email, password,
      role,
      canManualEntry: canManualEntry === true,
      canBahumanaView: canBahumanaView === true,
      allowedEvents: allowedEvents || [],
      // On for a new issuer by default, so assigning them an event actually
      // limits them rather than just labelling them.
      restrictToAllowedEvents: flag(restrictToAllowedEvents, isIssuer),
      allowedHolderTypeCodes: normaliseCodes(allowedHolderTypeCodes),
      allowedDeliveryMethods: normaliseMethods(allowedDeliveryMethods),
      canViewAllHolders: flag(canViewAllHolders, !isIssuer),
      canViewReports: flag(canViewReports, !isIssuer),
      canViewScanFeed: flag(canViewScanFeed, !isIssuer),
      isActive: true,
    });
    res.status(201).json({ success: true, user: publicStaffFields(user) });
  } catch (error) {
    console.error("createStaffUser error:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
};

// ── Admin: list all staff users ──────────────────────────────────────────────
exports.listStaffUsers = async (req, res) => {
  try {
    const users = await User.find({ role: { $ne: "self" } })
      .select("-password")
      .populate("allowedEvents", "name eventCode")
      .sort({ createdAt: -1 });
    // Normalised through publicStaffFields so the permission toggles always
    // arrive as real booleans/arrays, even on documents predating the fields.
    res.json({ users: users.map(publicStaffFields) });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// ── Admin: delete a staff user ───────────────────────────────────────────────
exports.deleteStaffUser = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (String(req.params.userId) === String(getReqUserId(req))) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const target = await User.findById(req.params.userId).select("role");
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!canManageUser(req.user, target)) {
      return res.status(403).json({ error: "You cannot delete an account of equal or higher role" });
    }
    await User.deleteOne({ _id: target._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
};
