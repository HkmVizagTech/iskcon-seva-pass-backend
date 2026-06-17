const jwt = require("jsonwebtoken"); // FIX: was missing — caused ReferenceError on every scan
const { startOfTodayIST } = require("../utils/dateUtils");
const qrService = require("../services/qrService");
const ScanLog = require("../models/ScanLog");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const mongoose = require("mongoose");

// ─── In-memory dedup map ──────────────────────────────────────────────────────
// NOTE: This works for a single process. For multi-worker deployments, swap
// this map for Redis (the redis client is on app.locals.redis). See comment
// inside scanQR for the Redis path.
const recentScans = new Map(); // dedupKey → timestamp
const DEDUP_WINDOW_MS = 5000;

function isDuplicate(key) {
  const now = Date.now();
  const last = recentScans.get(key);

  if (last && now - last < DEDUP_WINDOW_MS) return true;

  recentScans.set(key, now);

  // Prune stale entries to avoid unbounded memory growth
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
    // FIX: cap groupCount to prevent malicious/accidental huge increments
    const incomingGroupCount = Math.min(Math.max(1, parseInt(groupCount) || 1), 50);
    const userId = req.user._id || req.user.userId;
    // FIX: will be overridden with DB value below if empty

    if (!incomingQrData || !incomingEpId) {
      return res.status(400).json({
        success: false,
        result: "invalid",
        message: "qr payload and ep id are required",
      });
    }

    // Quick decode to extract qrId for dedup key (no verification yet)
    let scanQrId = "pending";
    try {
      const decoded = jwt.decode(incomingQrData);
      scanQrId = decoded?.q || decoded?.qrId || incomingQrData.substring(0, 20);
    } catch (_) {
      scanQrId = incomingQrData.substring(0, 20);
    }

    const dupKey = `${scanQrId}::${incomingEpId}`;

    // FIX: Check volunteer is assigned to this entry point
    if (req.user.role === "volunteer") {
      const assignedEpIds = (req.user.assignedEntryPoints || []).map((id) =>
        id.toString(),
      );
      if (!assignedEpIds.includes(incomingEpId.toString())) {
        return res.status(403).json({
          success: false,
          result: "invalid",
          message: "You are not assigned to this station",
        });
      }
    }

    // Synchronous in-memory dedup check (same process, 5s window)
    if (isDuplicate(dupKey)) {
      console.warn(`[DEDUP] Blocked duplicate: ${scanQrId} @ ${incomingEpId}`);
      return res.status(200).json({
        success: false,
        result: "duplicate",
        message: "Duplicate scan ignored",
      });
    }

    // DB-level dedup: if clientScanId was already recorded, return the original result
    // This blocks network retries and scanner double-fires from creating two records
    const incomingClientScanId = client_scan_id || clientScanId;
    if (incomingClientScanId) {
      const existing = await ScanLog.findOne({ clientScanId: incomingClientScanId })
        .select("result")
        .lean();
      if (existing) {
        return res.status(200).json({
          success: existing.result === "granted",
          result: "duplicate",
          message: "Duplicate scan ignored",
        });
      }
    }

    // Full validation
    const validation = await qrService.validateQR(incomingQrData, incomingEpId);
    // FIX: use DB station label as fallback so ScanLog.stationLabel is never blank
    const finalStationLabel =
      incomingStationLabel ||
      validation.entryPoint?.stationLabel ||
      incomingEpId;
    const validatedQrId =
      validation.payload?.q || validation.payload?.qrId || scanQrId;

    if (!validation.valid) {
      // Remove from dedup map — invalid scans shouldn't block future attempts
      recentScans.delete(dupKey);

      // Log the failed attempt (async — don't make the volunteer wait)
      ScanLog.create({
        qrId: validatedQrId,
        holderId: validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null,
        epId: incomingEpId,
        scannedBy: userId,
        stationLabel: finalStationLabel,
        result: validation.reason,
        groupCount: incomingGroupCount,
        deviceInfo: {
          ...deviceInfo,
          groupCount: incomingGroupCount,
          ipAddress: req.ip,
        },
      }).catch((e) => console.error("ScanLog(fail) write error:", e.message));

      return res.json({
        success: false,
        result: validation.reason,
        message: validation.message,
        holder_name: validation.holderName,
        holderName: validation.holderName,
        subCategory: validation.subCategory || null,
      sevaSlot: validation.sevaSlot || null,
        categoryName: validation.categoryName || null,
      });
    }

    const fullHolderId =
      validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null;

    // SPEED: await ONLY the atomic redemption (single indexed write, race-proof).
    // ScanLog + counter persist asynchronously — the volunteer gets the verdict
    // in one DB round-trip instead of three.
    const redemption = await qrService.redeemQR(
      validatedQrId, incomingEpId, userId, finalStationLabel,
      deviceInfo, incomingGroupCount,
      { multiEntryAllowed: validation.entryPoint?.multiEntryAllowed },
    );

    if (!redemption.redeemed) {
      // Lost an atomic race (or pass just revoked) — treat as already scanned
      recentScans.delete(dupKey);
      // Log the already_used scan so it shows correctly in the live feed
      ScanLog.create({
        qrId: validatedQrId,
        holderId: fullHolderId,
        epId: incomingEpId,
        scannedBy: userId,
        stationLabel: finalStationLabel,
        result: "already_used",
        groupCount: incomingGroupCount,
        deviceInfo: { ...deviceInfo, groupCount: incomingGroupCount, ipAddress: req.ip },
      }).catch((e) => console.error("ScanLog(already_used) write error:", e.message));
      return res.json({
        success: false,
        result: "already_used",
        message: "Already scanned here",
        holder_name: validation.holderName,
        holderName: validation.holderName,
        subCategory: validation.subCategory || null,
        sevaSlot: validation.sevaSlot || null,
        categoryName: validation.categoryName || null,
      });
    }

    ScanLog.create({
      qrId: validatedQrId,
      holderId: fullHolderId,
      epId: incomingEpId,
      scannedBy: userId,
      stationLabel: finalStationLabel,
      result: "granted",
      groupCount: incomingGroupCount,
      clientScanId: client_scan_id || clientScanId,
      deviceInfo: { ...deviceInfo, groupCount: incomingGroupCount, ipAddress: req.ip },
    }).catch((e) => console.error("ScanLog(grant) write error:", e.message));
    EntryPoint.findByIdAndUpdate(incomingEpId, {
      $inc: { currentCount: incomingGroupCount },
    }).catch((e) => console.error("EP counter error:", e.message));

    setTimeout(() => recentScans.delete(dupKey), DEDUP_WINDOW_MS);

    return res.json({
      success: true,
      result: "granted",
      holder_name: validation.holderName,
      holderName: validation.holderName,
      subCategory: validation.subCategory || null,
      sevaSlot: validation.sevaSlot || null,
      categoryName: validation.categoryName || null,
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
          // FIX: was using UTC midnight (= 5:30 AM IST), so scans between
          // 12:00–5:30 AM IST were excluded. Now uses real IST midnight.
          scannedAt: { $gte: startOfTodayIST() },
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
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { eventId } = req.params; // optional — from /scan/events/:eventId/recent
    const resultFilter = req.query.result; // optional — filter by result type

    const query = { holderId: { $exists: true } };
    if (resultFilter) query.result = resultFilter;

    const scans = await ScanLog.find(query)
      .populate({ path: "epId", select: "name stationLabel eventId",
        populate: { path: "eventId", select: "name eventCode" } })
      .populate("scannedBy", "name")
      .populate("holderId", "name phone")
      .sort({ scannedAt: -1 })
      .limit(limit * 3); // fetch more so filter still returns enough

    // Filter to event if route param provided
    const filtered = eventId
      ? scans.filter(s => s.epId?.eventId?._id?.toString() === eventId)
      : scans;

    res.json({ scans: filtered.slice(0, limit) });
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
    if (!Array.isArray(scans)) {
      return res.status(400).json({ error: "scans array is required" });
    }

    const syncedIds = [];   // clientScanIds that were processed (new records)
    let duplicates = 0;
    let failed = 0;

    for (const scan of scans) {
      try {
        const clientId = scan.client_scan_id || scan.clientScanId || null;
        const qrData = scan.qrData || scan.qr_payload;
        const epId = scan.epId || scan.ep_id;
        const stationLabel = scan.stationLabel || scan.station || "";
        const groupCount = Math.min(Math.max(1, parseInt(scan.groupCount) || 1), 50);
        const scannedAt = scan.timestamp ? new Date(scan.timestamp) : new Date();

        if (!qrData || !epId) { failed++; continue; }

        // Dedup: if this clientScanId already exists, skip
        if (clientId) {
          const existing = await ScanLog.findOne({ clientScanId: clientId }).select("_id").lean();
          if (existing) { duplicates++; syncedIds.push(clientId); continue; }
          // NOTE: still push to syncedIds so the device marks it synced and stops retrying
        }

        // FIX: validate the QR like a live scan so the record is complete & correct
        const validation = await qrService.validateQR(qrData, epId);
        const validatedQrId = validation.payload?.q || validation.payload?.qrId || "unknown";
        const finalStationLabel = stationLabel || validation.entryPoint?.stationLabel || String(epId);
        const fullHolderId = validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null;

        if (validation.valid) {
          // Record + redeem + increment, same as a live granted scan
          await Promise.all([
            ScanLog.create({
              qrId: validatedQrId,
              holderId: fullHolderId,
              epId,
              scannedBy: req.user._id || req.user.userId,
              stationLabel: finalStationLabel,
              result: "granted",
              groupCount,
              clientScanId: clientId || undefined,
              scannedAt,
              deviceInfo: { offlineOrigin: true, groupCount },
              offlineSync: { isOffline: true, syncedAt: new Date() },
            }),
            qrService.redeemQR(validatedQrId, epId, req.user._id || req.user.userId, finalStationLabel, { offlineOrigin: true }, groupCount),
            EntryPoint.findByIdAndUpdate(epId, { $inc: { currentCount: groupCount } }),
          ]);
        } else {
          // Log the failed validation so reports reflect reality
          await ScanLog.create({
            qrId: validatedQrId,
            epId,
            scannedBy: req.user._id || req.user.userId,
            stationLabel: finalStationLabel,
            result: validation.reason || "invalid",
            groupCount,
            clientScanId: clientId || undefined,
            scannedAt,
            deviceInfo: { offlineOrigin: true },
            offlineSync: { isOffline: true, syncedAt: new Date() },
          });
        }

        if (clientId) syncedIds.push(clientId);
      } catch (e) {
        console.error("Failed to sync scan:", e.message);
        failed++;
      }
    }

    res.json({
      success: true,
      synced: syncedIds.length,
      duplicates,
      failed,
      syncedIds,
      message: `Synced ${syncedIds.length} scans`,
    });
  } catch (error) {
    console.error("syncOfflineScans error:", error);
    res.status(500).json({ error: "Failed to sync offline scans" });
  }
};
