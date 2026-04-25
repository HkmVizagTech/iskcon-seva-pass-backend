const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const path = require("path");

// Load env from backend directory
dotenv.config({ path: path.join(__dirname, "../.env") });

// Simple User schema for this script
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  password: String,
  role: String,
  isActive: Boolean,
  canOverride: Boolean,
});

const User = mongoose.model("User", userSchema);

async function createAdmin() {
  try {
    const MONGODB_URI =
      process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

    console.log("📡 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    // Check if admin exists
    const existingAdmin = await User.findOne({
      email: "admin@iskconvizag.org",
    });

    if (existingAdmin) {
      console.log("ℹ️ Admin user already exists");
      console.log("   Email: admin@iskconvizag.org");
      console.log("   Password: Admin@123");

      // Update password if needed
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash("Admin@123", salt);
      existingAdmin.password = hashedPassword;
      await existingAdmin.save();
      console.log("✅ Password reset to: Admin@123\n");

      await mongoose.disconnect();
      process.exit(0);
    }

    // Create admin user
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash("Admin@123", salt);

    const admin = await User.create({
      name: "Super Admin",
      email: "admin@iskconvizag.org",
      phone: "+919999999999",
      password: hashedPassword,
      role: "super_admin",
      isActive: true,
      canOverride: true,
    });

    console.log("✅ Admin user created successfully!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📧 Email:    admin@iskconvizag.org");
    console.log("🔑 Password: Admin@123");
    console.log("👤 Role:     super_admin");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    console.log("⚠️  Please change the password after first login!\n");

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating admin:", error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

createAdmin();
