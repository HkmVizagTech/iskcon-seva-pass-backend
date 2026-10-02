const crypto = require("crypto");
const { startOfTodayIST } = require("../utils/dateUtils");
const qrService = require("../services/qrService");
const ScanLog = require("../models/ScanLog");
const EntryPoint = require("../models/EntryPoint");
const Event = require("../models/Event");
const mongoose = require("mongoose");
const { isObjectId } = require("../utils/objectId");
const { isEventScoped, isEventAllowed, allowedEventIds } = require("../utils/issuePermissions");

// ─── In-memory dedup map (optimisation only) ──────────────────────────────────
// Short-circuits an immediate double-fire on the SAME process without touching
// the DB. It is NOT the source of truth: cross-instance idempotency comes from
// the unique clientScanId on ScanLog, and one-time redemption from the atomic
// findOneAndUpdate in qrService.redeemQR.
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

const MAX_GROUP_COUNT = 50;
const MAX_SYNC_BATCH = 500;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QR_DATA_LEN = 4096;

const normGroupCount = (v) => Math.min(Math.max(1, parseInt(v) || 1), MAX_GROUP_COUNT);
const normVenue = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
// Never null/"" — the unique sparse index would collide on those
const normClientScanId = (v) => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= 128 ? s : undefined;
};

// Only the plain-string device fields are kept (ScanLog.deviceInfo schema)
const cleanDeviceInfo = (d) => ({
  ...(d && typeof d.deviceId === "string" ? { deviceId: d.deviceId.slice(0, 100) } : {}),
  ...(d && typeof d.userAgent === "string" ? { userAgent: d.userAgent.slice(0, 300) } : {}),
});

// Some scanner clients (native BarcodeDetector path in html5-qrcode)
// occasionally send a stringified wrapper object instead of the raw signed
// payload — e.g. '{"String":"<actual-payload>",...}'. Unwrap it.
function unwrapQrData(raw) {
  if (typeof raw !== "string") return null;
  let data = raw;
  if (data.startsWith('{"String"')) {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.String === "string") data = parsed.String;
    } catch (_) {
      // fall through with the raw value
    }
  }
  return data.length > MAX_QR_DATA_LEN ? null : data;
}

// qrId for logging/dedup: only taken from a VERIFIED token. Anything else is
// logged under a hash so attacker-controlled text never poses as a real qrId.
function peekQrId(qrData) {
  try {
    const payload = qrService.verifyPayload(qrData);
    if (payload && typeof payload.q === "string" && payload.q) {
      return payload.q.slice(0, 64);
    }
  } catch (_) {}
  const digest = crypto.createHash("sha256").update(String(qrData)).digest("hex").slice(0, 16);
  return `INVALID:${digest}`;
}

// Resolves the venue NAMES a volunteer is assigned to for an entry point's
// event (User.assignedVenues indexes into Event.venue). Cached briefly — it is
// an optimisation to keep the scan hot path to one round-trip.
const scopeCache = new Map(); // epId → { at, eventId, venueNames }
const SCOPE_TTL_MS = 60 * 1000;

async function getEpScope(epId) {
  const key = String(epId);
  const hit = scopeCache.get(key);
  if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit;
  const ep = await EntryPoint.findById(key).select("eventId").lean();
  if (!ep) return null;
  const event = await Event.findById(ep.eventId).select("venue").lean();
  const entry = {
    at: Date.now(),
    eventId: String(ep.eventId),
    venueNames: (event?.venue || []).map((v) => String(v?.name || "").trim()),
  };
  if (scopeCache.size > 500) scopeCache.clear();
  scopeCache.set(key, entry);
  return entry;
}

// Volunteers may only scan at their assigned stations / events / venues.
// Returns { ok:true, venue } (venue possibly normalised to the event's own
// spelling, or defaulted when the volunteer has exactly one assigned venue)
// or { ok:false, message }.
async function checkVolunteerScope(user, epId, venue) {
  if (user.role !== "volunteer") return { ok: true, venue };

  const assignedEpIds = (user.assignedEntryPoints || []).map((id) => id.toString());
  if (!assignedEpIds.includes(String(epId))) {
    return { ok: false, message: "You are not assigned to this station" };
  }

  const assignedEvents = (user.assignedEvents || []).map((id) => id.toString());
  const assignedVenues = (user.assignedVenues || []).filter((i) => Number.isInteger(i));
  if (assignedEvents.length === 0 && assignedVenues.length === 0) {
    return { ok: true, venue };
  }

  const scope = await getEpScope(epId);
  if (!scope) return { ok: false, message: "Station not found" };

  if (assignedEvents.length > 0 && !assignedEvents.includes(scope.eventId)) {
    return { ok: false, message: "You are not assigned to this event" };
  }

  if (assignedVenues.length > 0) {
    const names = assignedVenues.map((i) => scope.venueNames[i]).filter(Boolean);
    if (names.length > 0) {
      if (venue) {
        const canonical = names.find((n) => n.toLowerCase() === venue.toLowerCase());
        if (!canonical) {
          return { ok: false, message: `You are not assigned to venue "${venue}"` };
        }
        venue = canonical;
      } else if (names.length === 1) {
        venue = names[0];
      }
    }
  }
  return { ok: true, venue };
}

// Awaited, retried once. Returns "ok" | "duplicate" (clientScanId already
// recorded) | "error".
async function writeScanLog(doc) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ScanLog.create(doc);
      return "ok";
    } catch (e) {
      if (e && e.code === 11000) return "duplicate";
      if (attempt === 1) {
        console.error("ScanLog write error:", e.message);
        return "error";
      }
    }
  }
  return "error";
}

async function bumpCounter(epId, by) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await EntryPoint.updateOne({ _id: epId }, { $inc: { currentCount: by } });
      return;
    } catch (e) {
      if (attempt === 1) console.error("EP counter error:", e.message);
    }
  }
}

function verdictBody(validation) {
  return {
    holder_name: validation.holderName,
    holderName: validation.holderName,
    subCategory: validation.subCategory || null,
    sevaSlot: validation.sevaSlot || null,
    categoryName: validation.categoryName || null,
    categoryCode: validation.categoryCode || null,
    passType: validation.passType || null,
    isPrasadamCoupon: !!validation.isPrasadamCoupon,
  };
}

// One scan, live or replayed from the offline queue — identical rules for both.
// Returns { status, body, outcome, duplicate?, existingResult? }.
async function processScan(ctx) {
  const {
    user, qrData, epId, stationLabel, deviceInfo, ip,
    clientScanId, source = "scanner", scannedAt = new Date(),
    stale = false, useMemoryDedup = false,
  } = ctx;
  const userId = user._id || user.userId;
  const requestedGroupCount = normGroupCount(ctx.groupCount);
  const qrId = peekQrId(qrData);
  const offline = source === "offline";
  const baseLog = {
    qrId,
    epId,
    scannedBy: userId,
    scannedAt,
    source,
    clientScanId,
    ...(offline ? { offlineSync: { isOffline: true, syncedAt: new Date() } } : {}),
  };

  // Assigned station / event / venue
  const scope = await checkVolunteerScope(user, epId, normVenue(ctx.venue));
  const venue = scope.ok ? scope.venue : null;
  if (!scope.ok) {
    if (offline) {
      // Keep an audit record (and make the retry idempotent) for replayed scans
      await writeScanLog({
        ...baseLog,
        stationLabel: stationLabel || String(epId),
        venue: normVenue(ctx.venue),
        result: "invalid",
        groupCount: requestedGroupCount,
        notes: scope.message,
        deviceInfo: { ...cleanDeviceInfo(deviceInfo), groupCount: requestedGroupCount, ipAddress: ip },
      });
    }
    return {
      status: 403,
      outcome: "invalid",
      body: { success: false, result: "invalid", message: scope.message },
    };
  }

  const dupKey = `${qrId}::${epId}`;
  const releaseMemory = () => recentScans.delete(dupKey);

  // Authoritative idempotency: clientScanId already recorded (any instance).
  // Checked first so a retry gets the ORIGINAL verdict rather than a bare duplicate.
  if (clientScanId) {
    const existing = await ScanLog.findOne({ clientScanId }).select("result").lean();
    if (existing) {
      return {
        status: 200,
        outcome: "duplicate",
        duplicate: true,
        existingResult: existing.result,
        body: {
          success: existing.result === "granted",
          result: "duplicate",
          message: "Duplicate scan ignored",
        },
      };
    }
  }

  // In-memory double-fire guard (same process, 5s) — optimisation only
  if (useMemoryDedup && isDuplicate(dupKey)) {
    console.warn(`[DEDUP] Blocked duplicate: ${qrId} @ ${epId}`);
    return {
      status: 200,
      outcome: "duplicate",
      duplicate: true,
      body: { success: false, result: "duplicate", message: "Duplicate scan ignored" },
    };
  }

  const label = stationLabel || String(epId);

  // Offline scan too old to trust: log it, never redeem it
  if (stale) {
    releaseMemory();
    await writeScanLog({
      ...baseLog,
      stationLabel: label,
      venue,
      result: "stale",
      groupCount: requestedGroupCount,
      notes: "Offline scan older than 7 days — not redeemed",
      deviceInfo: { ...cleanDeviceInfo(deviceInfo), groupCount: requestedGroupCount, ipAddress: ip },
    });
    return {
      status: 200,
      outcome: "stale",
      body: {
        success: false,
        result: "stale",
        message: "Offline scan is too old to redeem",
      },
    };
  }

  const validation = await qrService.validateQR(qrData, epId, venue);
  const finalStationLabel = stationLabel || validation.entryPoint?.stationLabel || String(epId);
  const validatedQrId = validation.payload?.q || qrId;

  if (!validation.valid) {
    // Invalid scans shouldn't block future attempts
    releaseMemory();
    await writeScanLog({
      ...baseLog,
      qrId: validatedQrId,
      holderId: validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null,
      stationLabel: finalStationLabel,
      venue,
      result: validation.reason || "invalid",
      groupCount: requestedGroupCount,
      deviceInfo: { ...cleanDeviceInfo(deviceInfo), groupCount: requestedGroupCount, ipAddress: ip },
    });
    return {
      status: 200,
      outcome: validation.reason || "invalid",
      body: {
        success: false,
        result: validation.reason,
        message: validation.message,
        ...verdictBody(validation),
      },
    };
  }

  // Group size only counts where the station allows it
  const groupCount = validation.entryPoint?.allowGroupCount ? requestedGroupCount : 1;
  const fullHolderId =
    validation.qrPass?.holderId?._id || validation.qrPass?.holderId || null;

  // The atomic redemption comes first; a "granted" log is only ever written
  // for a redemption that actually happened.
  const redemption = await qrService.redeemQR(
    validatedQrId, epId, userId, finalStationLabel,
    venue, deviceInfo, groupCount,
    {
      multiEntryAllowed: validation.entryPoint?.multiEntryAllowed,
      redemptionGroupEpIds: validation.redemptionGroupEpIds || null,
      source,
    },
  );

  const logCommon = {
    ...baseLog,
    qrId: validatedQrId,
    holderId: fullHolderId,
    stationLabel: finalStationLabel,
    venue,
    groupCount,
    deviceInfo: { ...cleanDeviceInfo(deviceInfo), groupCount, ipAddress: ip },
  };

  if (!redemption.redeemed) {
    // Lost an atomic race (or pass just revoked) — treat as already scanned
    releaseMemory();
    await writeScanLog({ ...logCommon, result: "already_used" });
    return {
      status: 200,
      outcome: "already_used",
      body: {
        success: false,
        result: "already_used",
        message: "Already scanned here",
        ...verdictBody(validation),
      },
    };
  }

  const [logResult] = await Promise.all([
    writeScanLog({ ...logCommon, result: "granted" }),
    bumpCounter(epId, groupCount),
  ]);
  if (logResult === "duplicate") {
    // A concurrent request with the same clientScanId logged first
    return {
      status: 200,
      outcome: "duplicate",
      duplicate: true,
      body: { success: true, result: "duplicate", message: "Duplicate scan ignored" },
    };
  }

  if (useMemoryDedup) {
    const t = setTimeout(releaseMemory, DEDUP_WINDOW_MS);
    if (t.unref) t.unref();
  }

  return {
    status: 200,
    outcome: "granted",
    body: {
      success: true,
      result: "granted",
      ...verdictBody(validation),
      groupCount,
      message: "Access granted",
    },
  };
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
      venue,
    } = req.body;

    const incomingQrData = unwrapQrData(qrData || qr_payload);
    const incomingEpId = epId || ep_id;

    if (!incomingQrData || !incomingEpId) {
      return res.status(400).json({
        success: false,
        result: "invalid",
        message: "qr payload and ep id are required",
      });
    }
    if (!isObjectId(String(incomingEpId))) {
      return res.status(400).json({
        success: false,
        result: "invalid",
        message: "invalid station id",
      });
    }

    const out = await processScan({
      user: req.user,
      qrData: incomingQrData,
      epId: String(incomingEpId),
      stationLabel: String(stationLabel || station_label || "").slice(0, 120),
      venue,
      groupCount,
      clientScanId: normClientScanId(client_scan_id || clientScanId),
      deviceInfo,
      ip: req.ip,
      useMemoryDedup: true,
    });
    return res.status(out.status).json(out.body);
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
    if (!isObjectId(epId)) {
      return res.status(400).json({ error: "Invalid station id" });
    }
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
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const { eventId } = req.params; // optional — from /scan/events/:eventId/recent
    const resultFilter = req.query.result; // optional — filter by result type

    const query = { holderId: { $exists: true } };
    if (typeof resultFilter === "string" && resultFilter) query.result = resultFilter;

    // Restrict to the event IN THE QUERY (before the limit) via its entry points
    if (eventId) {
      if (!isObjectId(eventId)) return res.status(400).json({ error: "Invalid event id" });
      if (!isEventAllowed(req.user, eventId)) {
        return res.status(403).json({
          code: "EVENT_NOT_ALLOWED",
          error: "Your account is not assigned to this event.",
        });
      }
      query.epId = { $in: await EntryPoint.find({ eventId }).distinct("_id") };
    } else if (isEventScoped(req.user)) {
      query.epId = {
        $in: await EntryPoint.find({ eventId: { $in: allowedEventIds(req.user) } }).distinct("_id"),
      };
    }

    const scans = await ScanLog.find(query)
      .populate({ path: "epId", select: "name stationLabel eventId",
        populate: { path: "eventId", select: "name eventCode" } })
      .populate("scannedBy", "name")
      .populate({
        path: "holderId",
        select: "name phone catId",
        populate: { path: "catId", select: "name catCode" },
      })
      .sort({ scannedAt: -1 })
      .limit(limit);

    // ADDITIVE pass-type classification so the live feed shows whether the
    // scan was a prasadam coupon or a seva pass at a glance.
    const scansWithType = scans.map((s) => {
      const cat = s.holderId?.catId || null;
      const categoryCode = cat?.catCode ? String(cat.catCode).toUpperCase() : null;
      const isPrasadamCoupon = categoryCode === "PR";
      return {
        ...s.toObject(),
        passType: isPrasadamCoupon ? "prasadam_coupon" : "seva_pass",
        isPrasadamCoupon,
        categoryCode,
        categoryName: cat?.name || null,
      };
    });

    res.json({ scans: scansWithType });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch recent scans" });
  }
};

exports.getHolderScanHistory = async (req, res) => {
  try {
    if (!isObjectId(req.params.holderId)) {
      return res.status(400).json({ error: "Invalid holder id" });
    }
    // The Seva Pass app calls this with a preacher's token so a devotee can
    // see where their holders were scanned. A preacher must only reach the
    // holders attributed to them — without this check the holderId in the URL
    // is enough to read anyone's scan history.
    if (String(req.user?.role || "") === "preacher") {
      const Holder = require("../models/Holder");
      const { buildPreacherHolderQuery } = require("./preacherController");
      const mine = await Holder.findOne({
        _id: req.params.holderId,
        ...buildPreacherHolderQuery(req.user),
      }).select("_id").lean();
      if (!mine) {
        return res.status(403).json({
          code: "NOT_YOUR_HOLDER",
          error: "This pass is not attributed to you.",
        });
      }
    }

    const scans = await ScanLog.find({ holderId: req.params.holderId })
      .populate("epId", "name")
      .sort({ scannedAt: -1 });
    res.json({ history: scans });
  } catch (error) {
    console.error("Get holder scan history error:", error);
    res.status(500).json({ error: "Failed to fetch scan history" });
  }
};

// Replays scans captured offline. Every item goes through the same
// processScan as a live scan (assigned station/event/venue, validation,
// atomic redemption BEFORE the granted log, clientScanId idempotency).
exports.syncOfflineScans = async (req, res) => {
  try {
    const { scans } = req.body;
    if (!Array.isArray(scans)) {
      return res.status(400).json({ error: "scans array is required" });
    }

    const batch = scans.slice(0, MAX_SYNC_BATCH);
    const syncedIds = [];   // clientScanIds that were processed (device may stop retrying)
    const results = [];     // per-item verdicts (the scanner uses these to flag rejections)
    let duplicates = 0;
    let failed = 0;
    let stale = 0;

    for (const scan of batch) {
      try {
        if (!scan || typeof scan !== "object") { failed++; continue; }
        const clientId = normClientScanId(scan.client_scan_id || scan.clientScanId);
        const qrData = unwrapQrData(scan.qrData || scan.qr_payload);
        const epId = scan.epId || scan.ep_id;

        // Idempotency needs an id; without one a retry could not be recognised
        if (!clientId || !qrData || !epId || !isObjectId(String(epId))) { failed++; continue; }

        // Never trust the client clock past "now"; very old scans are logged only
        const now = Date.now();
        let ts = scan.timestamp ? new Date(scan.timestamp).getTime() : NaN;
        if (!Number.isFinite(ts) || ts > now) ts = now;
        const isStale = now - ts > STALE_MS;

        const out = await processScan({
          user: req.user,
          qrData,
          epId: String(epId),
          stationLabel: String(scan.stationLabel || scan.station || "").slice(0, 120),
          venue: scan.venue,
          groupCount: scan.groupCount,
          clientScanId: clientId,
          deviceInfo: {},
          ip: req.ip,
          source: "offline",
          scannedAt: new Date(ts),
          stale: isStale,
        });

        if (out.duplicate) {
          duplicates++;
          const existing = out.existingResult;
          results.push({
            clientScanId: clientId,
            result: existing || out.body.result,
            success: existing ? existing === "granted" : !!out.body.success,
            duplicate: true,
          });
        } else {
          if (out.outcome === "stale") stale++;
          results.push({
            clientScanId: clientId,
            result: out.body.result,
            success: !!out.body.success,
            holderName: out.body.holderName,
            message: out.body.message,
          });
        }
        syncedIds.push(clientId);
      } catch (e) {
        console.error("Failed to sync scan:", e.message);
        failed++;
      }
    }

    res.json({
      success: true,
      synced: syncedIds.length,
      duplicates,
      stale,
      failed,
      remaining: Math.max(0, scans.length - batch.length),
      syncedIds,
      results,
      message: `Synced ${syncedIds.length} scans`,
    });
  } catch (error) {
    console.error("syncOfflineScans error:", error);
    res.status(500).json({ error: "Failed to sync offline scans" });
  }
};
