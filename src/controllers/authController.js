const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const crypto = require("crypto");

const getReqUserId = (req) => req.user?._id || req.user?.userId;

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

    const { name, email, phone, password, role } = req.body;

    if (email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) return res.status(400).json({ error: "Email already registered" });
    }

    const user = await User.create({
      name,
      email: email || undefined,
      phone: normalisePhone(phone),
      password,
      role: role || "self",
    });

    const token = generateToken(user);
    res.status(201).json({
      success: true, token,
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
    const user = await User.findOne({ email });
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
        permissions: { canOverride: user.canOverride, canManualEntry: user.canManualEntry, allowedEvents: user.allowedEvents },
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
    res.json({ user });
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
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    user.resetPasswordExpire = Date.now() + 30 * 60 * 1000;
    await user.save();

    res.json({
      success: true,
      message: "Password reset email sent",
      resetToken: process.env.NODE_ENV === "development" ? resetToken : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process forgot password" });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
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
    const user = await User.findById(getReqUserId(req));
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
    const { name, email, phone, role, isActive, canOverride } = req.body;
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
    const { name, email, password, role, allowedEvents, canManualEntry } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "name, email, password, role are required" });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const user = await User.create({
      name, email, password,
      role,
      canManualEntry: canManualEntry === true,
      allowedEvents: allowedEvents || [],
      isActive: true,
    });
    res.status(201).json({
      success: true,
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, canManualEntry: user.canManualEntry, allowedEvents: user.allowedEvents },
    });
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
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// ── Admin: delete a staff user ───────────────────────────────────────────────
exports.deleteStaffUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
};
