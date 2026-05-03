const qrService = require("../services/qrService");
const ScanLog = require("../models/ScanLog");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const mongoose = require("mongoose");

// ─── In-memory dedup map ──────────────────────────────────────────────────────
// Prevents duplicate DB writes when the frontend sends two near-simultaneous
// requests for the same QR + station (happens due to React Strict Mode or
// html5-qrcode firing the callback on multiple frames before the scanner stops).
const recentScans = new Map(); // dedupKey → Date.now()
const DEDUP_WINDOW_MS = 5000; // 5 seconds is more than enough

function isDuplicate(qrId, epId) {
  const key = `${qrId}::${epId}`;
  const now = Date.now();
  const last = recentScans.get(key);

  if (last && now - last < DEDUP_WINDOW_MS) {
    return true; // duplicate
  }

  recentScans.set(key, now);

  // Prune stale entries to avoid memory leak
  if (recentScans.size > 500) {
    for (const [k, ts] of recentScans.entries()) {
      if (now - ts > DEDUP_WINDOW_MS * 2) recentScans.delete(k);
    }
  }

  return false;
}

exports.scanQR = async (req, res) => {
  try {
    const {
      qrData,
      qr_payload,
      epId,
      ep_id,
      stationLabel,
      station_label,
      deviceInfo,
      groupCount,
      client_scan_id,
      clientScanId,
    } = req.body;

    const incomingQrData = qrData || qr_payload;
    const incomingEpId = epId || ep_id;
    const incomingStationLabel = stationLabel || station_label || "";
    const incomingGroupCount = groupCount || 1;
    const userId = req.user._id || req.user.userId;

    if (!incomingQrData || !incomingEpId) {
      return res.status(400).json({
        success: false,
        result: "invalid",
        message: "qr payload and ep id are required",
      });
    }

    // ✅ FIX 1: Extract qrId BEFORE validation for quick dedup check
    let scanQrId = "pending";
    try {
      const decoded = jwt.decode(incomingQrData); // Quick decode without verification
      scanQrId = decoded?.q || decoded?.qrId || incomingQrData.substring(0, 20);
    } catch (e) {
      scanQrId = incomingQrData.substring(0, 20);
    }

    // ✅ FIX 2: Synchronous dedup check FIRST
    const dupKey = `${scanQrId}::${incomingEpId}`;
    const now = Date.now();
    const lastScan = recentScans.get(dupKey);

    if (lastScan && now - lastScan < DEDUP_WINDOW_MS) {
      console.warn(`[DEDUP] Blocked duplicate: ${scanQrId} @ ${incomingEpId}`);
      return res.status(200).json({
        success: false,
        result: "duplicate",
        message: "Duplicate scan ignored",
      });
    }

    // ✅ FIX 3: Mark as processing IMMEDIATELY (before async operations)
    recentScans.set(dupKey, now);

    // Now do validation
    const validation = await qrService.validateQR(incomingQrData, incomingEpId);
    const validatedQrId =
      validation.payload?.q || validation.payload?.qrId || scanQrId;

    if (!validation.valid) {
      // Remove from dedup map since it wasn't a real scan
      recentScans.delete(dupKey);

      // Still log failed attempts
      await ScanLog.create({
        qrId: validatedQrId,
        epId: incomingEpId,
        scannedBy: userId,
        stationLabel: incomingStationLabel,
        result: validation.reason,
        deviceInfo: {
          ...deviceInfo,
          groupCount: incomingGroupCount,
          ipAddress: req.ip,
        },
      });

      return res.json({
        success: false,
        result: validation.reason,
        message: validation.message,
        holder_name: validation.holderName,
        holderName: validation.holderName,
      });
    }

    // Get holderId
    const fullHolderId =
      validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null;

    // ✅ FIX 4: Create ScanLog AND update QRPass atomically
    const [logEntry] = await Promise.all([
      ScanLog.create({
        qrId: validatedQrId,
        holderId: fullHolderId,
        epId: incomingEpId,
        scannedBy: userId,
        stationLabel: incomingStationLabel,
        result: "granted",
        groupCount: incomingGroupCount,
        clientScanId: client_scan_id || clientScanId,
        deviceInfo: {
          ...deviceInfo,
          groupCount: incomingGroupCount,
          ipAddress: req.ip,
        },
      }),
      // Update QRPass redemption history
      qrService.redeemQR(
        validatedQrId,
        incomingEpId,
        userId,
        incomingStationLabel,
        deviceInfo,
        incomingGroupCount,
        validation.qrPass,
      ),
      // Update entry point count
      EntryPoint.findByIdAndUpdate(incomingEpId, {
        $inc: { currentCount: incomingGroupCount },
      }),
    ]);

    // Clean up dedup map after successful scan (keep for DEDUP_WINDOW_MS to prevent re-scans)
    setTimeout(() => recentScans.delete(dupKey), DEDUP_WINDOW_MS);

    return res.json({
      success: true,
      result: "granted",
      holder_name: validation.holderName,
      holderName: validation.holderName,
      groupCount: incomingGroupCount,
      message: "Access granted",
    });
  } catch (error) {
    console.error("Scan error:", error);
    res.status(500).json({
      success: false,
      result: "invalid",
      message: "Scan processing failed",
    });
  }
};

exports.getStationStats = async (req, res) => {
  try {
    const { epId } = req.params;
    const stats = await ScanLog.aggregate([
      {
        $match: {
          epId: new mongoose.Types.ObjectId(epId),
          scannedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      },
      { $group: { _id: "$result", count: { $sum: 1 } } },
    ]);
    const entryPoint = await EntryPoint.findById(epId);
    res.json({
      entryPoint: {
        name: entryPoint?.name,
        currentCount: entryPoint?.currentCount || 0,
        maxCapacity: entryPoint?.maxCapacity,
      },
      stats: {
        granted: stats.find((s) => s._id === "granted")?.count || 0,
        denied: stats
          .filter((s) => s._id !== "granted")
          .reduce((sum, s) => sum + s.count, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch station stats" });
  }
};

exports.getRecentScans = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const scans = await ScanLog.find({ holderId: { $exists: true } })
      .populate("epId", "name stationLabel")
      .populate("scannedBy", "name")
      .populate("holderId", "name phone")
      .sort({ scannedAt: -1 })
      .limit(limit);
    res.json({ scans });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch recent scans" });
  }
};

exports.getHolderScanHistory = async (req, res) => {
  try {
    const scans = await ScanLog.find({ holderId: req.params.holderId })
      .populate("epId", "name")
      .sort({ scannedAt: -1 });
    res.json({ history: scans });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch scan history" });
  }
};

exports.syncOfflineScans = async (req, res) => {
  try {
    const { scans } = req.body;
    let synced = 0,
      duplicates = 0;
    for (const scan of scans) {
      try {
        const clientId = scan.client_scan_id || scan.clientScanId;
        if (clientId) {
          const result = await ScanLog.updateOne(
            { clientScanId: clientId },
            {
              $setOnInsert: {
                ...scan,
                clientScanId: clientId,
                scannedBy: req.user._id || req.user.userId,
                offlineSync: { isOffline: true, syncedAt: new Date() },
              },
            },
            { upsert: true },
          );
          result.upsertedCount > 0 ? synced++ : duplicates++;
        } else {
          await ScanLog.create({
            ...scan,
            scannedBy: req.user._id || req.user.userId,
            offlineSync: { isOffline: true, syncedAt: new Date() },
          });
          synced++;
        }
      } catch (e) {
        console.error("Failed to sync scan:", e);
      }
    }
    res.json({
      success: true,
      synced,
      duplicates,
      message: `Synced ${synced} scans`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to sync offline scans" });
  }
};
