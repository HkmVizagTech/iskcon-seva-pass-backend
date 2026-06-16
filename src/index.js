const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const dotenv = require("dotenv");
const path = require("path");
const Redis = require("ioredis");

// Load environment variables
dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();

// Redis setup with error handling
let redis = null;
try {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) {
        console.log("⚠️ Redis connection failed, continuing without Redis");
        return null;
      }
      return Math.min(times * 100, 3000);
    },
  });

  redis.on("connect", () => console.log("✅ Connected to Redis"));
  redis.on("error", (err) => {
    console.log("⚠️ Redis error (continuing without Redis):", err.message);
    redis = null;
  });
} catch (error) {
  console.log("⚠️ Redis not available, continuing without it");
}

// Make redis available to routes
app.locals.redis = redis;

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
      "http://localhost:3001",
    ],
    credentials: true,
  }),
);
app.use(compression());
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Static files
const uploadDir = path.join(__dirname, "../uploads");
const fs = require("fs");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use("/uploads", express.static(uploadDir));

// Routes
app.use("/api/auth", require("./routes/auth"));

// ── WhatsApp delivery test — admin only ──────────────────────────────────────
app.post("/api/test/whatsapp", async (req, res) => {
  try {
    const { protect, authorize } = require("./src/middleware/auth");
    // Inline auth check
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });

    const jwt = require("jsonwebtoken");
    const User = require("./src/models/User");
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    if (!user || !["super_admin","event_admin"].includes(user.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const { phone, holderName } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });

    const whatsappService = require("./src/services/whatsappService");

    // Check env vars
    const envCheck = {
      WHATSAPP_API_KEY: !!process.env.WHATSAPP_API_KEY,
      WHATSAPP_API_URL: process.env.WHATSAPP_API_URL || "(default: https://wapi.flaxxa.com/api/v1)",
      HELP_CONTACT: process.env.HELP_CONTACT || "(default: 8977761187)",
    };

    // Send a minimal test with a placeholder QR image (1x1 white PNG base64)
    const testQR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";
    try {
      const result = await whatsappService.sendQRMessage(
        phone,
        testQR,
        holderName || "Test Devotee",
        "Test Event",
        { entryPoints: ["Main Gate"], qrId: "TEST-001", validFrom: new Date().toISOString(), venue: "ISKCON Temple" }
      );
      res.json({ success: true, envCheck, result });
    } catch (e) {
      res.json({
        success: false,
        envCheck,
        error: e.message,
        responseData: e.response?.data,
        statusCode: e.response?.status,
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use("/api/events/:eventId/seva-slots", require("./routes/sevaSlots"));
app.use("/api/events", require("./routes/events"));
app.use("/api/holders", require("./routes/holders"));
app.use("/api/qr", require("./routes/qr"));
app.use("/api/scan", require("./routes/scan"));
app.use("/api/webhooks", require("./routes/webhooks"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/volunteers", require("./routes/volunteers"));
app.use("/api/preachers", require("./routes/preachers"));
app.use("/api/integration", require("./routes/integration"));

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    mongodb:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    redis: redis && redis.status === "ready" ? "connected" : "disconnected",
  });
});

// Version — used to verify Railway deployed the latest commit
app.get("/version", (req, res) => {
  res.json({ build: "production-v22-sponsor-wa-fix", time: new Date().toISOString() });
});

// Test route
app.get("/api/test", (req, res) => {
  res.json({ message: "API is working!" });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
  });
});


// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// MongoDB connection
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

console.log("📡 Connecting to MongoDB...");
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    setTimeout(() => {
      console.log("🔄 Retrying MongoDB connection...");
      mongoose
        .connect(MONGODB_URI)
        .catch((e) => console.error("❌ Retry failed:", e.message));
    }, 5000);
    console.log("\n💡 Quick fix:");
    console.log("Run: sudo systemctl start mongodb");
    console.log("Or with Docker: docker run -d -p 27017:27017 mongo:7");
  });

const PORT = process.env.PORT || 5000;

// ─── Critical env var checks (fail fast in production) ───────────────────────
if (process.env.NODE_ENV === "production") {
  const required = ["JWT_SECRET", "QR_SECRET_KEY", "MONGODB_URI"];
  // Optional but logged as warnings if missing
  const recommended = ["INTEGRATION_API_KEY", "THIRD_PARTY_API_URL", "THIRD_PARTY_API_KEY"];
  for (const key of recommended) {
    if (!process.env[key]) console.warn(`⚠️  ${key} not set — third-party integration disabled`);
  }
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`FATAL: ${key} environment variable is required in production`);
      process.exit(1);
    }
  }
}


app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`📡 Test endpoint: http://localhost:${PORT}/api/test\n`);
});

module.exports = { app, redis };
