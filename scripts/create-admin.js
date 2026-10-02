// Usage:
//   ADMIN_EMAIL=you@example.org ADMIN_PASSWORD='...' node scripts/create-admin.js
//   node scripts/create-admin.js --email=you@example.org --password='...'
//
// Creates a super_admin. If the account already exists nothing is changed
// unless --reset is passed, in which case its password is replaced.
// ADMIN_NAME / ADMIN_PHONE are optional.
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const path = require("path");

// Load env from backend directory
dotenv.config({ path: path.join(__dirname, "../.env") });

const MIN_PASSWORD_LENGTH = 12;

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const reset = argv.includes("--reset");

const email = (process.env.ADMIN_EMAIL || arg("email") || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || arg("password") || "";
const name = process.env.ADMIN_NAME || arg("name") || "Super Admin";
const phone = process.env.ADMIN_PHONE || arg("phone") || undefined;

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
  if (!email || !password) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD (or --email / --password) are required.");
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  try {
    const MONGODB_URI =
      process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

    console.log("📡 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    const existingAdmin = await User.findOne({ email });

    if (existingAdmin) {
      if (!reset) {
        console.log(`ℹ️ A user with email ${email} already exists. Nothing changed.`);
        console.log("   Pass --reset to replace its password.");
        await mongoose.disconnect();
        process.exit(0);
      }

      const salt = await bcrypt.genSalt(10);
      existingAdmin.password = await bcrypt.hash(password, salt);
      await existingAdmin.save();
      console.log(`✅ Password reset for ${email}\n`);

      await mongoose.disconnect();
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await User.create({
      name,
      email,
      phone,
      password: hashedPassword,
      role: "super_admin",
      isActive: true,
      canOverride: true,
    });

    console.log("✅ Admin user created successfully!");
    console.log(`📧 Email: ${email}`);
    console.log("👤 Role:  super_admin\n");

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating admin:", error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

createAdmin();
