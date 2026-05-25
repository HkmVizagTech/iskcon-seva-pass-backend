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
