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

    const totalIssued = await QRPass.countDocuments({ eventId: eventObjectId });
    const totalScanned = await ScanLog.countDocuments({ holderId: { $exists: true } });

    // By Entry Point with ALL result types
    const byEntryPoint = await ScanLog.aggregate([
      { $match: { holderId: { $exists: true } } },
      { $lookup: { from: "entrypoints", localField: "epId", foreignField: "_id", as: "ep" } },
      { $unwind: { path: "$ep", preserveNullAndEmptyArrays: true } },
      { $group: { 
        _id: { epId: "$epId", epName: "$ep.name", epLabel: "$ep.stationLabel" },
        granted: { $sum: { $cond: [{ $eq: ["$result", "granted"] }, 1, 0] } },
        already_used: { $sum: { $cond: [{ $eq: ["$result", "already_used"] }, 1, 0] } },
        not_included: { $sum: { $cond: [{ $eq: ["$result", "not_included"] }, 1, 0] } },
        invalid: { $sum: { $cond: [{ $eq: ["$result", "invalid"] }, 1, 0] } },
      }},
      { $sort: { granted: -1 } }
    ]);

    // By Holder Type (successful scans)
    const byHolderType = await ScanLog.aggregate([
      { $match: { holderId: { $exists: true }, result: "granted" } },
      { $lookup: { from: "holders", localField: "holderId", foreignField: "_id", as: "holder" } },
      { $unwind: { path: "$holder", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$holder.holderType", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // By Venue (successful scans)
    const byVenue = await ScanLog.aggregate([
      { $match: { holderId: { $exists: true }, result: "granted" } },
      { $lookup: { from: "holders", localField: "holderId", foreignField: "_id", as: "holder" } },
      { $unwind: { path: "$holder", preserveNullAndEmptyArrays: true } },
      { $group: { _id: { $ifNull: ["$holder.venueName", "$holder.customFields.venue"] }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
      { $sort: { count: -1 } }
    ]);

    res.json({ totalIssued, totalScanned, byEntryPoint, byHolderType, byVenue });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch event summary" });
  }
};
exports.getHolderDetailsReport = async (req, res) => {
  const { eventId } = req.params;
  const { holderType, venue, preacher, entryPoint } = req.query;

  const holders = await Holder.find({ eventId })
    .populate("catId", "name")
    .populate("issuedBy", "name");

  // Get QR passes with scan history
  const holderIds = holders.map((h) => h._id);
  const qrPasses = await QRPass.find({ holderId: { $in: holderIds } }).populate(
    "entryPoints",
    "name stationLabel type",
  );

  // Build report with scan progress per holder
  const report = holders.map((holder) => {
    const qrPass = qrPasses.find(
      (qp) => qp.holderId?.toString() === holder._id.toString(),
    );
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
};
exports.getScanLog = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const logs = await ScanLog.find({
      holderId: { $exists: true },
    })
      .populate("epId", "name")
      .populate("scannedBy", "name")
      .populate("holderId", "name phone")
      .sort({ scannedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await ScanLog.countDocuments();

    res.json({
      logs,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
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

    // Convert to CSV format
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
    const totalEvents = await Event.countDocuments();
    const activePasses = await QRPass.countDocuments({ status: "active" });
    const totalHolders = await Holder.countDocuments();

    const totalScans = await ScanLog.countDocuments();
    const totalPasses = await QRPass.countDocuments();
    const scanRate =
      totalPasses > 0 ? ((totalScans / totalPasses) * 100).toFixed(1) : 0;

    // Holder type breakdown
    const holderTypeStats = await Holder.aggregate([
      { $group: { _id: "$holderType", count: { $sum: 1 } } },
    ]);

    // Scans per entry point
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
