const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const crypto = require("crypto"); // ← ADD THIS LINE

const getReqUserId = (req) => req.user?._id || req.user?.userId;

const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user._id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, phone, password, role } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const user = await User.create({
      name,
      email,
      phone,
      password,
      role: role || "self",
    });

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("Login attempt:", { email }); // Debug log

    const user = await User.findOne({ email });
    if (!user) {
      console.log("User not found:", email); // Debug log
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("User found, comparing password..."); // Debug log

    const isPasswordValid = await user.comparePassword(password);
    console.log("Password valid:", isPasswordValid); // Debug log

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        permissions: {
          canOverride: user.canOverride,
          allowedEvents: user.allowedEvents,
        },
      },
    });
  } catch (error) {
    console.error("Login error details:", error); // Detailed error
    res.status(500).json({ error: "Login failed: " + error.message });
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

exports.updateProfile = async (req, res) => {
  try {
    const { name, phone, avatar } = req.body;

    const user = await User.findByIdAndUpdate(
      getReqUserId(req),
      { name, phone, avatar },
      { new: true },
    ).select("-password");

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: "Failed to update profile" });
  }
};

// Add these at the end of your existing authController.js file

// Forgot Password - Send reset email
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    user.resetPasswordToken = resetTokenHash;
    user.resetPasswordExpire = Date.now() + 30 * 60 * 1000; // 30 minutes
    await user.save();

    // In production, send email with reset link
    // For now, just return the token (in development)
    res.json({
      success: true,
      message: "Password reset email sent",
      resetToken:
        process.env.NODE_ENV === "development" ? resetToken : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process forgot password" });
  }
};

// Reset Password
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    const resetPasswordToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    res.json({ success: true, message: "Password reset successful" });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
};

// Change Password (Logged in user)
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(getReqUserId(req));

    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to change password" });
  }
};

// Get All Users (Admin only)
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });

    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// Update User (Admin only)
exports.updateUser = async (req, res) => {
  try {
    const { name, email, phone, role, isActive, canOverride } = req.body;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email, phone, role, isActive, canOverride },
      { new: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: "Failed to update user" });
  }
};

// Delete User (Admin only)
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
};
