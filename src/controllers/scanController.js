const qrService = require("../services/qrService");
const ScanLog = require("../models/ScanLog");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const mongoose = require("mongoose");

exports.scanQR = async (req, res) => {
  try {
    const {
      qrData, qr_payload,
      epId, ep_id,
      stationLabel, station_label,
      deviceInfo,
      client_scan_id, clientScanId,
    } = req.body;
    
    const incomingQrData = qrData || qr_payload;
    const incomingEpId = epId || ep_id;
    const incomingStationLabel = stationLabel || station_label || "";
    const userId = req.user._id || req.user.userId;

    if (!incomingQrData || !incomingEpId) {
      return res.status(400).json({
        success: false, result: "invalid",
        message: "qr payload and ep id are required",
      });
    }

    const validation = await qrService.validateQR(incomingQrData, incomingEpId);

    // Get QR ID from payload (short key 'q')
    const scanQrId = validation.payload?.q || validation.payload?.qrId || "unknown";
    
    // Get FULL holderId from the QR pass document (not the short payload)
    const fullHolderId = validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null;

    const scanLog = await ScanLog.create({
      qrId: scanQrId,
      holderId: fullHolderId,  // Full ObjectId from DB document
      epId: incomingEpId,
      scannedBy: userId,
      stationLabel: incomingStationLabel,
      result: validation.valid ? "granted" : validation.reason,
      clientScanId: client_scan_id || clientScanId,
      deviceInfo: { ...deviceInfo, ipAddress: req.ip },
    });

    if (!validation.valid) {
      return res.json({
        success: false,
        result: validation.reason,
        message: validation.message,
        holder_name: validation.holderName,
        holderName: validation.holderName,
      });
    }

    // Use qrService.redeemQR which handles everything atomically
    await qrService.redeemQR(
      scanQrId,
      incomingEpId,
      userId,
      incomingStationLabel,
      deviceInfo,
      validation.qrPass
    );

    // Update entry point count
    await EntryPoint.findByIdAndUpdate(incomingEpId, {
      $inc: { currentCount: 1 },
    });

    res.json({
      success: true,
      result: "granted",
      holder_name: validation.holderName,
      holderName: validation.holderName,
      message: "Access granted",
    });
  } catch (error) {
    console.error("Scan error:", error);
    res.status(500).json({
      success: false, result: "invalid",
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
        denied: stats.filter((s) => s._id !== "granted").reduce((sum, s) => sum + s.count, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch station stats" });
  }
};

exports.getRecentScans = async (req, res) => {
  try {
    const { eventId } = req.params;
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
    let synced = 0, duplicates = 0;
    for (const scan of scans) {
      try {
        const clientId = scan.client_scan_id || scan.clientScanId;
        if (clientId) {
          const result = await ScanLog.updateOne(
            { clientScanId: clientId },
            { $setOnInsert: { ...scan, clientScanId: clientId, scannedBy: req.user._id || req.user.userId, offlineSync: { isOffline: true, syncedAt: new Date() } } },
            { upsert: true }
          );
          result.upsertedCount > 0 ? synced++ : duplicates++;
        } else {
          await ScanLog.create({ ...scan, scannedBy: req.user._id || req.user.userId, offlineSync: { isOffline: true, syncedAt: new Date() } });
          synced++;
        }
      } catch (e) { console.error("Failed to sync scan:", e); }
    }
    res.json({ success: true, synced, duplicates, message: `Synced ${synced} scans` });
  } catch (error) {
    res.status(500).json({ error: "Failed to sync offline scans" });
  }
};
