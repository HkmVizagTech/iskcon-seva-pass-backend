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
  res.json({ build: "v4-cleanup", time: new Date().toISOString() });
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

// Diagnostic endpoint — no auth, keyed. Remove after debugging.
app.get("/api/debug/volunteer", async (req, res) => {
  if (req.query.key !== "hkm2026") return res.status(403).json({ error: "bad key" });
  try {
    const User = require("./models/User");
    const EntryPoint = require("./models/EntryPoint");
    const { email, phone } = req.query;
    const query = { role: "volunteer" };
    if (email) query.email = email;
    else if (phone) {
      const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
      const normPhone = digits.length === 10 ? "91" + digits : digits;
      query.$or = [{ phone: normPhone }, { phone: digits }, { phone }];
    } else {
      // List all volunteers briefly
      const all = await User.find({ role: "volunteer" }).select("name email phone assignedEntryPoints assignedEvents");
      return res.json({ volunteers: all });
    }
    const vol = await User.findOne(query).select("-password")
      .populate({ path: "assignedEntryPoints", populate: { path: "eventId", select: "name eventCode" } })
      .populate("assignedEvents", "name eventCode");
    if (!vol) return res.json({ error: "not found", query });
    // Also check raw IDs vs what populated
    const raw = await User.findOne(query).select("assignedEntryPoints assignedEvents").lean();
    const rawEpIds = raw?.assignedEntryPoints || [];
    const resolvedEps = await EntryPoint.find({ _id: { $in: rawEpIds } }).select("name stationLabel eventId isActive");

    // Simulate what /me and login would now return (filtered by assignedEvents)
    const assignedEventIds = new Set((raw?.assignedEvents || []).map(e => e.toString()));
    const filteredStations = resolvedEps.filter(ep => assignedEventIds.has(ep.eventId.toString()));

    res.json({
      volunteer: { id: vol._id, name: vol.name, email: vol.email, phone: vol.phone },
      rawEpIds,
      rawEventIds: raw?.assignedEvents || [],
      resolvedEntryPoints: resolvedEps,
      filteredStations_whatScannerGets: filteredStations,
      populatedEvents: vol.assignedEvents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-shot cleanup: purge orphaned entry point IDs from ALL volunteers
app.post("/api/debug/cleanup-volunteers", async (req, res) => {
  if (req.query.key !== "hkm2026") return res.status(403).json({ error: "bad key" });
  try {
    const User = require("./models/User");
    const EntryPoint = require("./models/EntryPoint");
    const volunteers = await User.find({ role: "volunteer" }).select("name assignedEntryPoints assignedEvents");
    const results = [];
    for (const vol of volunteers) {
      const rawCount = (vol.assignedEntryPoints || []).length;
      const assignedEventIds = new Set((vol.assignedEvents || []).map(e => e.toString()));
      // Find which entry points actually exist AND belong to an assigned event
      const validEps = await EntryPoint.find({
        _id: { $in: vol.assignedEntryPoints || [] },
        eventId: { $in: Array.from(assignedEventIds) },
      }).select("_id");
      const cleanIds = validEps.map(ep => ep._id);
      if (cleanIds.length < rawCount) {
        await User.updateOne({ _id: vol._id }, { $set: { assignedEntryPoints: cleanIds } });
        results.push({ name: vol.name, before: rawCount, after: cleanIds.length, cleaned: true });
      } else {
        results.push({ name: vol.name, count: rawCount, cleaned: false });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
