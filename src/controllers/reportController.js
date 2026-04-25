const Event = require("../models/Event");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const ScanLog = require("../models/ScanLog");
const EntryPoint = require("../models/EntryPoint");
const mongoose = require("mongoose");

exports.getDashboardStats = async (req, res) => {
  try {
    const totalEvents = await Event.countDocuments();
    const activePasses = await QRPass.countDocuments({ status: "active" });
    const totalHolders = await Holder.countDocuments();

    const totalScans = await ScanLog.countDocuments();
    const totalPasses = await QRPass.countDocuments();
    const scanRate =
      totalPasses > 0 ? ((totalScans / totalPasses) * 100).toFixed(1) : 0;

    res.json({
      totalEvents,
      activePasses,
      totalHolders,
      scanRate,
      eventTrend: 0,
      passesTrend: 0,
      holdersTrend: 0,
      scanRateTrend: 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
};

exports.getEventSummary = async (req, res) => {
  try {
    const { eventId } = req.params;

    const totalIssued = await QRPass.countDocuments({ eventId });
    const totalScanned = await ScanLog.countDocuments({
      holderId: { $exists: true },
    });

    const byEntryPoint = await ScanLog.aggregate([
      { $match: { eventId: new mongoose.Types.ObjectId(eventId) } },
      { $group: { _id: "$epId", count: { $sum: 1 } } },
    ]);

    res.json({
      totalIssued,
      totalScanned,
      byEntryPoint,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch event summary" });
  }
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
