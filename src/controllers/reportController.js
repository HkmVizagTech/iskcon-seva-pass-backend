const Event = require("../models/Event");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const ScanLog = require("../models/ScanLog");
const EntryPoint = require("../models/EntryPoint");
const mongoose = require("mongoose");

exports.getEventSummary = async (req, res) => {
  try {
    const { eventId } = req.params;
    const eventObjectId = new mongoose.Types.ObjectId(eventId);

    // FIX: scope all queries to the specific event

    const totalIssued = await QRPass.countDocuments({ eventId: eventObjectId });

    // Get entry point IDs for this event, then filter scan logs
    const eventEntryPoints = await EntryPoint.find({ eventId: eventObjectId }).select("_id");
    const epIds = eventEntryPoints.map((ep) => ep._id);

    const totalScanned = await ScanLog.countDocuments({
      epId: { $in: epIds },
      result: "granted",
    });

    // By Entry Point — scoped to this event's entry points
    const byEntryPoint = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds } } },
      { $lookup: { from: "entrypoints", localField: "epId", foreignField: "_id", as: "ep" } },
      { $unwind: { path: "$ep", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { epId: "$epId", epName: "$ep.name", epLabel: "$ep.stationLabel" },
          granted: { $sum: { $cond: [{ $eq: ["$result", "granted"] }, 1, 0] } },
          already_used: { $sum: { $cond: [{ $eq: ["$result", "already_used"] }, 1, 0] } },
          not_included: { $sum: { $cond: [{ $eq: ["$result", "not_included"] }, 1, 0] } },
          invalid: { $sum: { $cond: [{ $eq: ["$result", "invalid"] }, 1, 0] } },
        },
      },
      { $sort: { granted: -1 } },
    ]);

    // By Holder Type — scoped to holders of this event
    const byHolderType = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds }, result: "granted" } },
      { $lookup: { from: "holders", localField: "holderId", foreignField: "_id", as: "holder" } },
      { $unwind: { path: "$holder", preserveNullAndEmptyArrays: true } },
      { $match: { "holder.eventId": eventObjectId } },
      { $group: { _id: "$holder.holderType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // By Venue — scoped to this event
    const byVenue = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds }, result: "granted" } },
      { $lookup: { from: "holders", localField: "holderId", foreignField: "_id", as: "holder" } },
      { $unwind: { path: "$holder", preserveNullAndEmptyArrays: true } },
      { $match: { "holder.eventId": eventObjectId } },
      { $group: { _id: { $ifNull: ["$holder.venueName", "$holder.customFields.venue"] }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
      { $sort: { count: -1 } },
    ]);

    res.json({ totalIssued, totalScanned, byEntryPoint, byHolderType, byVenue });
  } catch (error) {
    console.error("getEventSummary error:", error);
    res.status(500).json({ error: "Failed to fetch event summary" });
  }
};

exports.getHolderDetailsReport = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { holderType, venue, preacher, entryPoint } = req.query;

    const holderQuery = { eventId };
    if (holderType) holderQuery.holderType = holderType;
    if (venue) holderQuery.venueName = new RegExp(venue, "i");
    if (preacher) holderQuery.preacher = new RegExp(preacher, "i");

    // Scope preacher role to their own holders only
    if (req.user.role === "preacher") {
      holderQuery.$or = [
        { preacherId: req.user._id },
        { preacher: new RegExp(`^${req.user.name}$`, "i") },
      ];
    }

    const holders = await Holder.find(holderQuery)
      .populate("catId", "name")
      .populate("issuedBy", "name");

    const holderIds = holders.map((h) => h._id);

    // FIX: scope QR passes to event — fetch with entryPoint filter if provided
    const qrQuery = { holderId: { $in: holderIds } };
    const qrPasses = await QRPass.find(qrQuery).populate(
      "entryPoints",
      "name stationLabel type",
    );

    // Filter by entryPoint after population if requested
    const filteredPasses = entryPoint
      ? qrPasses.filter((qp) =>
          qp.entryPoints.some((ep) => ep._id.toString() === entryPoint),
        )
      : qrPasses;

    const passMap = {};
    for (const qp of filteredPasses) {
      passMap[qp.holderId.toString()] = qp;
    }

    const report = holders
      .filter((h) => !entryPoint || passMap[h._id.toString()])
      .map((holder) => {
        const qrPass = passMap[holder._id.toString()];
        return {
          holder: {
            name: holder.name,
            phone: holder.phone,
            preacher: holder.preacher || holder.customFields?.preacher || "",
            venue: holder.venueName || holder.customFields?.venue || "",
          },
          holderType: holder.catId?.name,
          entryPoints: qrPass?.entryPoints || [],
          scans: qrPass?.redemptionHistory || [],
        };
      });

    res.json({ report });
  } catch (error) {
    console.error("getHolderDetailsReport error:", error);
    res.status(500).json({ error: "Failed to fetch holder details report" });
  }
};

exports.getScanLog = async (req, res) => {
  try {
    const { eventId } = req.params;
    // FIX: cursor-based pagination instead of skip/limit
    // skip(N) on large collections scans N documents — gets exponentially slower per page
    // before= accepts the scannedAt ISO string of the last item from the previous page
    const { before, limit = 50, result: resultFilter } = req.query;

    const eventEntryPoints = await EntryPoint.find({ eventId }).select("_id");
    const epIds = eventEntryPoints.map((ep) => ep._id);

    const query = { epId: { $in: epIds } };
    if (resultFilter) query.result = resultFilter;
    // Cursor: only return records older than the cursor
    if (before) query.scannedAt = { $lt: new Date(before) };

    const logs = await ScanLog.find(query)
      .populate("epId", "name stationLabel")
      .populate("scannedBy", "name")
      .populate({
        path: "holderId",
        select: "name phone subCategory sevaSlotId catId",
        populate: [
          { path: "catId", select: "name catCode color" },
          { path: "sevaSlotId", select: "code name time" },
        ],
      })
      .sort({ scannedAt: -1 })
      .limit(Number(limit) + 1); // fetch one extra to detect hasMore

    const hasMore = logs.length > Number(limit);
    const results = hasMore ? logs.slice(0, Number(limit)) : logs;
    const nextCursor = hasMore ? results[results.length - 1].scannedAt.toISOString() : null;

    res.json({
      logs: results,
      pagination: { hasMore, nextCursor, limit: Number(limit) },
    });
  } catch (error) {
    console.error("getScanLog error:", error);
    res.status(500).json({ error: "Failed to fetch scan log" });
  }
};

exports.getNoShows = async (req, res) => {
  try {
    const { eventId } = req.params;

    const noShows = await QRPass.find({
      eventId,
      status: "active",
      "redemptionHistory.0": { $exists: false },
    }).populate("holderId", "name phone email");

    res.json({ noShows, count: noShows.length });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch no-shows" });
  }
};

exports.getCapacityReport = async (req, res) => {
  try {
    const { eventId } = req.params;

    const entryPoints = await EntryPoint.find({ eventId });
    const report = await Promise.all(
      entryPoints.map(async (ep) => {
        const scanCount = await ScanLog.countDocuments({
          epId: ep._id,
          result: "granted",
        });

        return {
          name: ep.name,
          currentCount: scanCount,
          maxCapacity: ep.maxCapacity,
          percentage: ep.maxCapacity
            ? ((scanCount / ep.maxCapacity) * 100).toFixed(1)
            : 0,
        };
      }),
    );

    res.json(report);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch capacity report" });
  }
};

exports.exportReport = async (req, res) => {
  try {
    const { eventId } = req.params;

    const passes = await QRPass.find({ eventId })
      .populate("holderId")
      .populate("entryPoints");

    let csv = "Name,Phone,Email,QR ID,Entry Points,Scans,Status\n";

    passes.forEach((pass) => {
      csv += `"${pass.holderId?.name || ""}",`;
      csv += `"${pass.holderId?.phone || ""}",`;
      csv += `"${pass.holderId?.email || ""}",`;
      csv += `"${pass.qrId}",`;
      csv += `"${pass.entryPoints.map((ep) => ep.name).join("; ")}",`;
      csv += `${pass.redemptionHistory.length},`;
      csv += `${pass.status}\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=event-${eventId}-report.csv`,
    );
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: "Failed to export report" });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    // FIX: scope counts to allowedEvents for event_admin — was returning global counts
    const isAdmin = ["super_admin"].includes(req.user.role);
    const scopedEventIds = isAdmin ? null : (req.user.allowedEvents || []);
    const eventFilter = scopedEventIds ? { _id: { $in: scopedEventIds } } : {};
    const qrFilter = scopedEventIds ? { eventId: { $in: scopedEventIds } } : {};
    const holderFilter = scopedEventIds ? { eventId: { $in: scopedEventIds } } : {};

    const [totalEvents, activePasses, totalHolders, totalScans, totalPasses] = await Promise.all([
      Event.countDocuments(eventFilter),
      QRPass.countDocuments({ ...qrFilter, status: "active" }),
      Holder.countDocuments(holderFilter),
      ScanLog.countDocuments({ result: "granted" }),
      QRPass.countDocuments(qrFilter),
    ]);
    const scanRate = totalPasses > 0 ? ((totalScans / totalPasses) * 100).toFixed(1) : 0;

    const holderTypeStats = await Holder.aggregate([
      { $group: { _id: "$holderType", count: { $sum: 1 } } },
    ]);

    const scansByEP = await ScanLog.aggregate([
      { $match: { result: "granted" } },
      { $group: { _id: "$epId", count: { $sum: 1 } } },
      {
        $lookup: {
          from: "entrypoints",
          localField: "_id",
          foreignField: "_id",
          as: "ep",
        },
      },
      { $unwind: "$ep" },
      { $project: { name: "$ep.name", count: 1 } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    res.json({
      totalEvents,
      activePasses,
      totalHolders,
      scanRate,
      holderTypeStats,
      scansByEP,
      eventTrend: 0,
      passesTrend: 0,
      holdersTrend: 0,
      scanRateTrend: 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
};

// ── Comprehensive multi-angle analytics ─────────────────────────────────────
// GET /api/reports/analytics?eventId=xxx  (omit eventId for all-events)
// Returns: preacherWise, slotWise, tierWise, entryWise + totals
exports.getAnalytics = async (req, res) => {
  try {
    const { eventId } = req.query;
    const scoped = eventId && eventId !== "all";
    const eventObjectId = scoped ? new mongoose.Types.ObjectId(eventId) : null;

    // Holder match filter
    const holderMatch = scoped ? { eventId: eventObjectId } : {};

    // Entry points in scope (for scan filtering)
    const epFilter = scoped ? { eventId: eventObjectId } : {};
    const eps = await EntryPoint.find(epFilter).select("_id name stationLabel");
    const epIds = eps.map((e) => e._id);

    // ── 1. PREACHER-WISE ──────────────────────────────────────────────────
    // Issued count + scanned (attended) count per preacher
    const preacherWise = await Holder.aggregate([
      { $match: holderMatch },
      {
        $group: {
          _id: {
            preacherId: "$preacherId",
            preacher: { $ifNull: ["$preacher", "Unassigned"] },
          },
          issued: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id.preacherId",
          foreignField: "_id",
          as: "p",
        },
      },
      {
        $project: {
          _id: 0,
          preacherId: "$_id.preacherId",
          name: {
            $ifNull: [
              { $arrayElemAt: ["$p.name", 0] },
              "$_id.preacher",
            ],
          },
          shortCode: { $arrayElemAt: ["$p.shortCode", 0] },
          issued: 1,
        },
      },
      { $sort: { issued: -1 } },
    ]);

    // Scanned (attended) per preacher — join scanlog -> holder
    const preacherScanned = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds }, result: "granted" } },
      { $lookup: { from: "holders", localField: "holderId", foreignField: "_id", as: "h" } },
      { $unwind: { path: "$h", preserveNullAndEmptyArrays: false } },
      ...(scoped ? [{ $match: { "h.eventId": eventObjectId } }] : []),
      // unique holders per preacher (one attendance per holder)
      { $group: { _id: { holderId: "$holderId", preacher: { $ifNull: ["$h.preacher", "Unassigned"] } } } },
      { $group: { _id: "$_id.preacher", attended: { $sum: 1 } } },
    ]);
    const scannedMap = {};
    preacherScanned.forEach((p) => { scannedMap[p._id] = p.attended; });
    preacherWise.forEach((p) => { p.attended = scannedMap[p.name] || 0; });

    // ── 2. SEVA SLOT-WISE ─────────────────────────────────────────────────
    const slotWise = await Holder.aggregate([
      { $match: { ...holderMatch, sevaSlotId: { $ne: null } } },
      { $group: { _id: "$sevaSlotId", issued: { $sum: 1 } } },
      { $lookup: { from: "sevaslots", localField: "_id", foreignField: "_id", as: "s" } },
      { $unwind: { path: "$s", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          slotId: "$_id",
          code: "$s.code",
          name: { $ifNull: ["$s.name", "Unknown"] },
          time: "$s.time",
          issued: 1,
        },
      },
      { $sort: { code: 1 } },
    ]);

    // ── 3. BAHUMANA TIER-WISE ─────────────────────────────────────────────
    const tierWise = await Holder.aggregate([
      { $match: { ...holderMatch, subCategory: { $nin: [null, ""] } } },
      { $group: { _id: "$subCategory", issued: { $sum: 1 } } },
      { $project: { _id: 0, tier: "$_id", issued: 1 } },
      { $sort: { tier: 1 } },
    ]);

    // ── 4. ENTRY / SCAN-WISE ──────────────────────────────────────────────
    const entryWise = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds } } },
      { $lookup: { from: "entrypoints", localField: "epId", foreignField: "_id", as: "ep" } },
      { $unwind: { path: "$ep", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { epId: "$epId", name: "$ep.name", label: "$ep.stationLabel" },
          granted: { $sum: { $cond: [{ $eq: ["$result", "granted"] }, 1, 0] } },
          duplicate: { $sum: { $cond: [{ $eq: ["$result", "already_used"] }, 1, 0] } },
          denied: { $sum: { $cond: [{ $in: ["$result", ["invalid", "expired", "not_included", "capacity_full"]] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          epId: "$_id.epId",
          name: { $ifNull: ["$_id.name", "$_id.label"] },
          granted: 1, duplicate: 1, denied: 1,
        },
      },
      { $sort: { granted: -1 } },
    ]);

    // ── Totals ────────────────────────────────────────────────────────────
    const totalIssued = await Holder.countDocuments(holderMatch);
    const totalScannedUnique = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds }, result: "granted" } },
      ...(scoped ? [
        { $lookup: { from: "holders", localField: "holderId", foreignField: "_id", as: "h" } },
        { $unwind: "$h" },
        { $match: { "h.eventId": eventObjectId } },
      ] : []),
      { $group: { _id: "$holderId" } },
      { $count: "n" },
    ]);
    const attended = totalScannedUnique[0]?.n || 0;

    res.json({
      scope: scoped ? "event" : "all",
      totals: {
        issued: totalIssued,
        attended,
        notAttended: Math.max(0, totalIssued - attended),
        attendanceRate: totalIssued ? Math.round((attended / totalIssued) * 100) : 0,
      },
      preacherWise,
      slotWise,
      tierWise,
      entryWise,
    });
  } catch (error) {
    console.error("getAnalytics error:", error);
    res.status(500).json({ error: "Failed to fetch analytics", detail: error.message });
  }
};

// ── Export a specific analytics angle as CSV ───────────────────────────────
// GET /api/reports/analytics/export?eventId=xxx&angle=preacher|slot|tier|entry
exports.exportAnalytics = async (req, res) => {
  try {
    const { eventId, angle } = req.query;
    const scoped = eventId && eventId !== "all";
    const eventObjectId = scoped ? new mongoose.Types.ObjectId(eventId) : null;
    const holderMatch = scoped ? { eventId: eventObjectId } : {};
    const epFilter = scoped ? { eventId: eventObjectId } : {};
    const eps = await EntryPoint.find(epFilter).select("_id");
    const epIds = eps.map((e) => e._id);

    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    let csv = "";

    if (angle === "preacher") {
      csv = "Preacher,Issued\n";
      const data = await Holder.aggregate([
        { $match: holderMatch },
        { $group: { _id: { $ifNull: ["$preacher", "Unassigned"] }, issued: { $sum: 1 } } },
        { $sort: { issued: -1 } },
      ]);
      data.forEach((d) => { csv += `${esc(d._id)},${d.issued}\n`; });
    } else if (angle === "slot") {
      csv = "Slot Code,Seva Name,Time,Issued\n";
      const data = await Holder.aggregate([
        { $match: { ...holderMatch, sevaSlotId: { $ne: null } } },
        { $group: { _id: "$sevaSlotId", issued: { $sum: 1 } } },
        { $lookup: { from: "sevaslots", localField: "_id", foreignField: "_id", as: "s" } },
        { $unwind: { path: "$s", preserveNullAndEmptyArrays: true } },
        { $sort: { "s.code": 1 } },
      ]);
      data.forEach((d) => { csv += `${esc(d.s?.code)},${esc(d.s?.name)},${esc(d.s?.time)},${d.issued}\n`; });
    } else if (angle === "tier") {
      csv = "Bahumana Tier,Issued\n";
      const data = await Holder.aggregate([
        { $match: { ...holderMatch, subCategory: { $nin: [null, ""] } } },
        { $group: { _id: "$subCategory", issued: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);
      data.forEach((d) => { csv += `${esc(d._id)},${d.issued}\n`; });
    } else if (angle === "entry") {
      csv = "Entry Point,Granted,Duplicate,Denied\n";
      const data = await ScanLog.aggregate([
        { $match: { epId: { $in: epIds } } },
        { $lookup: { from: "entrypoints", localField: "epId", foreignField: "_id", as: "ep" } },
        { $unwind: { path: "$ep", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $ifNull: ["$ep.name", "$ep.stationLabel"] },
            granted: { $sum: { $cond: [{ $eq: ["$result", "granted"] }, 1, 0] } },
            duplicate: { $sum: { $cond: [{ $eq: ["$result", "already_used"] }, 1, 0] } },
            denied: { $sum: { $cond: [{ $in: ["$result", ["invalid", "expired", "not_included", "capacity_full"]] }, 1, 0] } },
          },
        },
        { $sort: { granted: -1 } },
      ]);
      data.forEach((d) => { csv += `${esc(d._id)},${d.granted},${d.duplicate},${d.denied}\n`; });
    } else {
      return res.status(400).json({ error: "Invalid angle" });
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="report_${angle}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error("exportAnalytics error:", error);
    res.status(500).json({ error: "Export failed", detail: error.message });
  }
};

// ── Bahumana Announcement View ───────────────────────────────────────────────
// GET /api/reports/events/:eventId/bahumana-announcement
// Returns attended sponsors grouped by tier, ordered for stage announcement.
exports.getBahumanaAnnouncement = async (req, res) => {
  try {
    const { eventId } = req.params;
    const eventObjectId = new mongoose.Types.ObjectId(eventId);

    // Get all entry points for this event
    const eps = await EntryPoint.find({ eventId: eventObjectId }).select("_id");
    const epIds = eps.map((e) => e._id);

    // Find all unique holders who were granted entry (attended)
    const attendedScans = await ScanLog.aggregate([
      { $match: { epId: { $in: epIds }, result: "granted" } },
      { $group: { _id: "$holderId" } },
    ]);
    const attendedIds = attendedScans.map((s) => s._id).filter(Boolean);

    // Get holder details for attended sponsors
    const holders = await Holder.find({
      _id: { $in: attendedIds },
      eventId: eventObjectId,
    })
      .populate("catId", "name catCode color")
      .populate("sevaSlotId", "code name time sortOrder")
      .select("name phone subCategory catId sevaSlotId venueName")
      .sort({ subCategory: 1, name: 1 })
      .lean();

    // Group by tier (A first, then B, then C, then untiered sponsors, then others)
    const tierOrder = ["A", "B", "C"];
    const sponsors = holders.filter(
      (h) => (h.catId?.catCode || "").toUpperCase() === "SP"
    );
    const others = holders.filter(
      (h) => (h.catId?.catCode || "").toUpperCase() !== "SP"
    );

    const grouped = tierOrder.map((tier) => ({
      tier,
      holders: sponsors.filter((h) => h.subCategory === tier),
    })).filter((g) => g.holders.length > 0);

    // Add any sponsors without a tier
    const untiered = sponsors.filter((h) => !h.subCategory);
    if (untiered.length > 0) grouped.push({ tier: "—", holders: untiered });

    res.json({
      eventId,
      totalAttended: attendedIds.length,
      sponsorsAttended: sponsors.length,
      grouped,
      others,
    });
  } catch (error) {
    console.error("getBahumanaAnnouncement error:", error);
    res.status(500).json({ error: "Failed to fetch announcement data" });
  }
};
