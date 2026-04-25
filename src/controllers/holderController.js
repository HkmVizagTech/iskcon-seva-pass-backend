/**
 * Get QR pass details
 */
exports.getQRDetails = async (req, res) => {
  try {
    const qrPass = await QRPass.findOne({ qrId: req.params.qrId })
      .populate("holderId", "name phone email")
      .populate("eventId", "name eventCode")
      .populate("entryPoints", "name stationLabel type");

    if (!qrPass) {
      return res.status(404).json({ error: "QR pass not found" });
    }

    res.json({ qrPass });
  } catch (error) {
    console.error("Get QR details error:", error);
    res.status(500).json({ error: "Failed to fetch QR details" });
  }
};

/**
 * Revoke a QR pass
 */
exports.revokeQR = async (req, res) => {
  try {
    const qrPass = await QRPass.findOneAndUpdate(
      { qrId: req.params.qrId },
      { status: "revoked" },
      { new: true },
    );

    if (!qrPass) {
      return res.status(404).json({ error: "QR pass not found" });
    }

    res.json({
      success: true,
      message: "QR pass revoked successfully",
      qrPass: {
        qrId: qrPass.qrId,
        status: qrPass.status,
      },
    });
  } catch (error) {
    console.error("Revoke QR error:", error);
    res.status(500).json({ error: "Failed to revoke QR" });
  }
};

/**
 * Resend QR code via WhatsApp/Email
 */
exports.resendQR = async (req, res) => {
  try {
    const { deliveryMethod } = req.body;

    const qrPass = await QRPass.findOne({ qrId: req.params.qrId })
      .populate("holderId")
      .populate("eventId")
      .populate("entryPoints");

    if (!qrPass) {
      return res.status(404).json({ error: "QR pass not found" });
    }

    if (!qrPass.holderId) {
      return res.status(400).json({ error: "Holder not found for this QR" });
    }

    const holder = qrPass.holderId;
    const event = qrPass.eventId;
    const entryPoints = qrPass.entryPoints;

    const payload = {
      qrId: qrPass.qrId,
      eventId: event._id,
      eventCode: event.eventCode,
      holderId: holder._id,
      holderName: holder.name,
      entryPoints: entryPoints.map((ep) => ep._id.toString()),
      validFrom: qrPass.validFrom.toISOString(),
      validUntil: qrPass.validUntil.toISOString(),
      version: 1,
    };

    const { image: qrImage } = await qrService.generateQRCode(payload);

    const passDetails = {
      entryPoints: entryPoints.map((ep) => ep.name || ep.stationLabel),
      qrId: qrPass.qrId,
      validFrom: qrPass.validFrom.toISOString(),
      validUntil: qrPass.validUntil.toISOString(),
      venue: event.venue?.name || event.venue?.address || "",
    };

    if (deliveryMethod === "whatsapp" || deliveryMethod === "both") {
      await whatsappService.sendQRMessage(
        holder.phone || holder.whatsappNumber,
        qrImage,
        holder.name,
        event.name,
        passDetails,
      );
    }

    if (deliveryMethod === "email" || deliveryMethod === "both") {
      if (holder.email) {
        const emailService = require("../services/emailService");
        await emailService.sendQRPass(
          holder.email,
          qrImage,
          holder.name,
          event.name,
          passDetails,
        );
      }
    }

    qrPass.deliveryMethod = deliveryMethod;
    qrPass.deliveredAt = new Date();
    qrPass.deliveryStatus = "sent";
    await qrPass.save();

    res.json({
      success: true,
      message: "QR resent successfully",
      deliveryMethod,
    });
  } catch (error) {
    console.error("Resend QR error:", error);
    res.status(500).json({ error: "Failed to resend QR: " + error.message });
  }
};

/**
 * Get holders for a specific event
 */
exports.getHolders = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { search, page = 1, limit = 20 } = req.query;

    const query = { eventId };

    if (search) {
      query.$or = [
        { name: new RegExp(search, "i") },
        { phone: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
      ];
    }

    const holders = await Holder.find(query)
      .populate("catId", "name catCode color")
      .populate("issuedBy", "name")
      .sort({ issuedAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await Holder.countDocuments(query);

    const holderIds = holders.map((h) => h._id);
    const qrPasses = await QRPass.find({ holderId: { $in: holderIds } });

    const holdersWithPasses = holders.map((holder) => {
      const qrPass = qrPasses.find(
        (qp) => qp.holderId.toString() === holder._id.toString(),
      );
      return {
        ...holder.toObject(),
        qrPass: qrPass
          ? {
              qrId: qrPass.qrId,
              status: qrPass.status,
              redemptionCount: qrPass.redemptionHistory.length,
            }
          : null,
      };
    });

    res.json({
      holders: holdersWithPasses,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error("Get holders error:", error);
    res.status(500).json({ error: "Failed to fetch holders" });
  }
};

/**
 * Get single holder details
 */
exports.getHolderDetails = async (req, res) => {
  try {
    const holder = await Holder.findById(req.params.holderId)
      .populate("catId")
      .populate("issuedBy", "name email")
      .populate("eventId", "name eventCode dateStart dateEnd");

    if (!holder) {
      return res.status(404).json({ error: "Holder not found" });
    }

    const qrPass = await QRPass.findOne({ holderId: holder._id }).populate(
      "entryPoints",
    );

    res.json({ holder, qrPass });
  } catch (error) {
    console.error("Get holder details error:", error);
    res.status(500).json({ error: "Failed to fetch holder details" });
  }
};

/**
 * Update holder
 */
exports.updateHolder = async (req, res) => {
  try {
    const holder = await Holder.findByIdAndUpdate(
      req.params.holderId,
      req.body,
      { new: true },
    );
    res.json({ success: true, holder });
  } catch (error) {
    console.error("Update holder error:", error);
    res.status(500).json({ error: "Failed to update holder" });
  }
};

/**
 * Delete holder
 */
exports.deleteHolder = async (req, res) => {
  try {
    await Holder.findByIdAndDelete(req.params.holderId);
    await QRPass.deleteOne({ holderId: req.params.holderId });
    res.json({ success: true, message: "Holder deleted" });
  } catch (error) {
    console.error("Delete holder error:", error);
    res.status(500).json({ error: "Failed to delete holder" });
  }
};

/**
 * Create single holder with QR
 */
exports.createHolder = async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      name,
      phone,
      email,
      catId,
      holderType,
      lifetimeDonation,
      entryPoints,
      overrideReason,
      deliveryMethod,
    } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const category = await Category.findById(catId).populate("entryPoints");
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const finalEntryPoints =
      entryPoints && entryPoints.length > 0
        ? await EntryPoint.find({ _id: { $in: entryPoints }, eventId })
        : category.entryPoints;

    const holder = await Holder.create({
      eventId,
      catId,
      name,
      phone,
      email,
      whatsappNumber: phone,
      holderType: holderType || "custom",
      lifetimeDonation: Number(lifetimeDonation || 0),
      issuedBy: req.user?._id || req.user?.userId,
      overrideReason,
    });

    const qrId = await qrService.generateQRId(
      event.eventCode,
      category.catCode,
    );
    const validFrom = event.dateStart;
    const validUntil = event.dateEnd;

    const payload = qrService.createPayload(
      { ...holder.toObject(), qrId },
      event,
      category,
      finalEntryPoints,
      validFrom,
      validUntil,
    );

    const { image: qrImage, signedPayload } =
      await qrService.generateQRCode(payload);

    const qrPass = await QRPass.create({
      qrId,
      holderId: holder._id,
      eventId,
      catId,
      entryPoints: finalEntryPoints.map((ep) => ep._id),
      payloadSigned: signedPayload,
      validFrom,
      validUntil,
      deliveryMethod: deliveryMethod || "none",
    });

    if (deliveryMethod && deliveryMethod !== "none") {
      const passDetails = {
        entryPoints: finalEntryPoints.map((ep) => ep.name || ep.stationLabel),
        qrId: qrId,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
        venue: event.venue?.name || event.venue?.address,
      };

      try {
        if (deliveryMethod === "whatsapp" || deliveryMethod === "both") {
          await whatsappService.sendQRMessage(
            phone,
            qrImage,
            name,
            event.name,
            passDetails,
          );
        }
        qrPass.deliveryStatus = "sent";
        qrPass.deliveredAt = new Date();
      } catch (error) {
        qrPass.deliveryStatus = "failed";
      }
      await qrPass.save();
    }

    res.status(201).json({
      success: true,
      holder,
      qrPass: {
        qrId: qrPass.qrId,
        qrImage,
        validFrom,
        validUntil,
      },
    });
  } catch (error) {
    console.error("Create holder error:", error);
    res.status(500).json({ error: "Failed to create holder" });
  }
};

/**
 * Export holders to CSV
 */
exports.exportHolders = async (req, res) => {
  try {
    const { eventId } = req.params;
    const holders = await Holder.find({ eventId }).populate("catId", "name");

    let csvOutput = "Name,Phone,Email,Category,QR ID,Status\n";

    for (const holder of holders) {
      const qrPass = await QRPass.findOne({ holderId: holder._id });
      csvOutput += `"${holder.name}",`;
      csvOutput += `"${holder.phone}",`;
      csvOutput += `"${holder.email || ""}",`;
      csvOutput += `"${holder.catId?.name || ""}",`;
      csvOutput += `"${qrPass?.qrId || ""}",`;
      csvOutput += `"${qrPass?.status || ""}"\n`;
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=holders-${eventId}.csv`,
    );
    res.send(csvOutput);
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Export failed" });
  }
};

/**
 * Bulk import holders with WhatsApp QR delivery
 */
exports.bulkImportHolders = async (req, res) => {
  console.log("📦 BULK IMPORT - body:", JSON.stringify(req.body));
  try {
    const { eventId } = req.params;
    const { categoryId, holderType, deliveryMethod = "whatsapp" } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const category =
      await Category.findById(categoryId).populate("entryPoints");
    if (!category) return res.status(404).json({ error: "Category not found" });

    let records = [];
    const filePath = req.file.path;
    const fileExt = require("path")
      .extname(req.file.originalname)
      .toLowerCase();

    if (fileExt === ".csv") {
      records = await parseCSV(filePath);
    } else if ([".xlsx", ".xls"].includes(fileExt)) {
      records = parseExcel(filePath);
    } else {
      try {
        require("fs").unlinkSync(filePath);
      } catch (e) {}
      return res.status(400).json({ error: "Unsupported file format" });
    }

    const results = {
      total: records.length,
      success: [],
      failed: [],
      successCount: 0,
      failedCount: 0,
    };

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      try {
        const result = await processSingleRecord(
          record,
          event,
          category,
          holderType || "general",
          deliveryMethod,
          req.user?._id || req.user?.userId,
        );
        if (result.success) {
          results.success.push(result);
          results.successCount++;
        } else {
          results.failed.push(result);
          results.failedCount++;
        }
        await sleep(500);
      } catch (error) {
        results.failed.push({
          record,
          error: error.message,
          phone: record["Phone Number"] || record.Phone || record.phone,
          name: record.Name || record.name,
        });
        results.failedCount++;
      }
      if (i % 10 === 0 && i < records.length - 1) await sleep(2000);
    }

    if (results.failed.length > 0) {
      try {
        const FailedImport = require("../models/FailedImport");
        await FailedImport.create({
          eventId: event._id,
          batchId: `BATCH-${Date.now()}`,
          records: results.failed.map((r) => ({
            name: r.name || r.record?.Name || r.record?.name || "",
            phone:
              r.phone ||
              r.record?.["Phone Number"] ||
              r.record?.Phone ||
              r.record?.phone ||
              "",
            error: r.error || "Unknown error",
            rowData: r.record,
          })),
          totalCount: results.total,
          failedCount: results.failedCount,
          successCount: results.successCount,
          importedBy: req.user?._id || req.user?.userId,
        });
        console.log("💾 Failed import saved to DB");
      } catch (dbError) {
        console.error("❌ Failed to save to DB:", dbError.message);
      }
    }

    try {
      require("fs").unlinkSync(filePath);
    } catch (e) {}

    res.json({
      success: true,
      message: `Processed ${results.total} records`,
      stats: {
        total: results.total,
        success: results.successCount,
        failed: results.failedCount,
      },
      summary: {
        successList: results.success.map((r) => ({
          name: r.name,
          phone: r.phone,
          qrId: r.qrId,
        })),
        failedList: results.failed.map((r) => ({
          name: r.name,
          phone: r.phone,
          error: r.error,
        })),
      },
    });
  } catch (error) {
    console.error("Bulk import error:", error);
    if (req.file) {
      try {
        require("fs").unlinkSync(req.file.path);
      } catch (e) {}
    }
    res.status(500).json({ error: "Bulk import failed: " + error.message });
  }
};

exports.downloadFailedImport = async (req, res) => {
  try {
    const filePath = require("path").join(
      __dirname,
      "../../uploads",
      req.params.filename,
    );
    if (!require("fs").existsSync(filePath))
      return res.status(404).json({ error: "File not found" });
    res.download(filePath);
  } catch (error) {
    res.status(500).json({ error: "Failed to download file" });
  }
};

exports.getCategoryEntryPoints = async (req, res) => {
  try {
    const category = await Category.findById(req.params.categoryId).populate(
      "entryPoints",
    );
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({
      category: { name: category.name, code: category.catCode },
      entryPoints: category.entryPoints.map((ep) => ({
        id: ep._id,
        name: ep.name,
        label: ep.stationLabel,
        type: ep.type,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch entry points" });
  }
};

exports.getFailedImports = async (req, res) => {
  try {
    const FailedImport = require("../models/FailedImport");
    const imports = await FailedImport.find({ eventId: req.params.eventId })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ imports });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch imports" });
  }
};

// ============ HELPER FUNCTIONS ============

const Event = require("../models/Event");
const Category = require("../models/Category");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const qrService = require("../services/qrService");
const whatsappService = require("../services/whatsappService");
const fs = require("fs");
const path = require("path");

async function processSingleRecord(
  record,
  event,
  category,
  holderType,
  deliveryMethod,
  userId,
) {
  // NEW FORMAT: Name, Phone Number, Sponsor Sevas, Sponsor Category, Preacher, Venue, Slot
  const name = (record.Name || record.name || "").toString().trim();
  const phone = (
    record["Phone Number"] ||
    record["phone number"] ||
    record.Phone ||
    record.phone ||
    ""
  )
    .toString()
    .trim();
  const sponsorSeva = (record["Sponsor Sevas"] || record["sponsor sevas"] || "")
    .toString()
    .trim();
  const sponsorCategory = (
    record["Sponsor Category"] ||
    record["sponsor category"] ||
    ""
  )
    .toString()
    .trim();
  const preacher = (record.Preacher || record.preacher || "").toString().trim();
  const venue = (record.Venue || record.venue || "").toString().trim();
  const slot = (record.Slot || record.slot || "").toString().trim();

  if (!name)
    return {
      success: false,
      error: "Name is required",
      name: "Unknown",
      phone,
    };
  if (!phone || !/^\d{10,15}$/.test(phone.replace(/[\+\s\-\(\)]/g, "")))
    return { success: false, error: "Invalid phone", name, phone };

  try {
    const formattedPhone =
      phone.replace(/[\+\s\-\(\)]/g, "").length === 10
        ? "91" + phone.replace(/[\+\s\-\(\)]/g, "")
        : phone.replace(/[\+\s\-\(\)]/g, "");

    let holder = await Holder.findOne({
      eventId: event._id,
      phone: formattedPhone,
    });
    const existingQR = holder
      ? await QRPass.findOne({ holderId: holder._id, status: "active" })
      : null;
    if (existingQR)
      return {
        success: true,
        name,
        phone: formattedPhone,
        qrId: existingQR.qrId,
        skipped: true,
      };

    if (!holder) {
      holder = await Holder.create({
        eventId: event._id,
        catId: category._id,
        name,
        phone: formattedPhone,
        whatsappNumber: formattedPhone,
        holderType,
        notes:
          [sponsorSeva, sponsorCategory, preacher, venue, slot]
            .filter(Boolean)
            .join(" | ") || undefined,
        customFields: { sponsorSeva, sponsorCategory, preacher, venue, slot },
        issuedBy: userId,
      });
    }

    const qrId = await qrService.generateQRId(
      event.eventCode,
      category.catCode,
    );
    const entryPoints = category.entryPoints;
    const payload = qrService.createPayload(
      { ...holder.toObject(), qrId },
      event,
      category,
      entryPoints,
      event.dateStart,
      event.dateEnd,
    );
    const { image: qrImage, signedPayload } =
      await qrService.generateQRCode(payload);

    const qrPass = await QRPass.create({
      qrId,
      holderId: holder._id,
      eventId: event._id,
      catId: category._id,
      entryPoints: entryPoints.map((ep) => ep._id),
      payloadSigned: signedPayload,
      validFrom: event.dateStart,
      validUntil: event.dateEnd,
      deliveryMethod,
      deliveryStatus: "pending",
    });

    if (deliveryMethod === "whatsapp") {
      try {
        await whatsappService.sendQRMessage(
          formattedPhone,
          qrImage,
          name,
          event.name,
          {
            entryPoints: entryPoints.map((ep) => ep.name),
            qrId,
            validFrom: event.dateStart.toISOString(),
            validUntil: event.dateEnd.toISOString(),
          },
        );
        qrPass.deliveryStatus = "sent";
        qrPass.deliveredAt = new Date();
      } catch (e) {
        qrPass.deliveryStatus = "failed";
        await qrPass.save();
        return {
          success: false,
          error: "WhatsApp failed: " + e.message,
          name,
          phone: formattedPhone,
          qrId,
        };
      }
      await qrPass.save();
    }

    return {
      success: true,
      name,
      phone: formattedPhone,
      qrId,
      deliveryStatus: qrPass.deliveryStatus,
    };
  } catch (error) {
    return { success: false, error: error.message, name, phone };
  }
}

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    require("fs")
      .createReadStream(filePath)
      .pipe(require("csv-parser")())
      .on("data", (d) => results.push(d))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

function parseExcel(filePath) {
  const workbook = require("xlsx").readFile(filePath);
  return require("xlsx").utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]],
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
