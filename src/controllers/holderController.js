// FIX: All requires moved to TOP
const { resolvePreacherFromString } = require("./preacherController");
const SevaSlot = require("../models/SevaSlot");
const thirdPartyService = require("../services/thirdPartyService");
// ─── Helper: normalise phone to 91XXXXXXXXXX format ──────────────────────────
function normalisePhone(phone) {
  if (!phone) return undefined;
  const digits = String(phone).replace(/[\+\s\-\(\)]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;
}
// FIX: All requires moved to TOP
// FIX: All requires moved to TOP of file — previously they were at the bottom,
// causing ReferenceError when any exported function was called before the
// module fully evaluated.
const Event = require("../models/Event");
const Category = require("../models/Category");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const qrService = require("../services/qrService");
const whatsappService = require("../services/whatsappService");
const fs = require("fs");
const path = require("path");

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
      { returnDocument: "after" },
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

exports.resendQR = async (req, res) => {
  try {
    const { deliveryMethod } = req.body;

    const qrPass = await QRPass.findOne({ qrId: req.params.qrId })
      .populate("holderId")
      .populate("eventId")
      .populate("entryPoints");

    if (!qrPass) return res.status(404).json({ error: "QR pass not found" });
    if (!qrPass.holderId)
      return res.status(400).json({ error: "Holder not found" });

    const holder = qrPass.holderId;
    const evt = qrPass.eventId;
    const entryPoints = qrPass.entryPoints;

    // FIX: Use qrService.createPayload (compact keys q/e/h/n/p/f/u) so the
    // resent QR uses the same payload schema as the original and passes
    // validation at scan time. Previously used an incompatible plain object.
    const validFrom = qrPass.validFrom || evt.dateStart;
    const validUntil = qrPass.validUntil || evt.dateEnd;

    const compactPayload = qrService.createPayload(
      { ...holder.toObject(), qrId: qrPass.qrId },
      evt,
      null,
      entryPoints,
    );

    const { image: qrImage } = await qrService.generateQRCode(compactPayload);

    const passDetails = {
      entryPoints: entryPoints.map((ep) => ep.name || ep.stationLabel),
      qrId: qrPass.qrId,
      validFrom: qrPass.validFrom.toISOString(),
      validUntil: qrPass.validUntil.toISOString(),
      venue: evt.venue?.[0]?.name || "",
    };

    if (deliveryMethod === "whatsapp" || deliveryMethod === "both") {
      await whatsappService.sendQRMessage(
        holder.phone || holder.whatsappNumber,
        qrImage,
        holder.name,
        evt.name,
        passDetails,
      );
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
      .populate("preacherId", "name")
      .sort({ issuedAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await Holder.countDocuments(query);

    const holderIds = holders.map((h) => h._id);
    // FIX: Single batch query instead of N+1 loop
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
      .populate("eventId", "name eventCode dateStart dateEnd")
      .populate("preacherId", "name shortCode");

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
 * Update holder — FIX: whitelist fields to prevent mass-assignment
 */
exports.updateHolder = async (req, res) => {
  try {
    const ALLOWED_FIELDS = [
      "name",
      "phone",
      "email",
      "whatsappNumber",
      "address",
      "notes",
      "overrideReason",
      "preacher",
      "preacherId",  // allow updating preacher assignment
      "venueName",
      "lifetimeDonation",
      "donorEligibilityStatus",
      "idProof",
      "photo",
      "customFields",
    ];

    const update = {};
    for (const field of ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    }

    const holder = await Holder.findByIdAndUpdate(
      req.params.holderId,
      update,
      { returnDocument: "after", runValidators: true },
    );
    if (!holder) return res.status(404).json({ error: "Holder not found" });
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
      preacher,
      preacherId,  // ObjectId ref to User with role "preacher" (from dropdown)
      venueName,
    } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    const primaryVenue = event.venue?.[0];

    const normPhone = normalisePhone(phone) || phone;

    // TWO independent sponsor fields:
    //   • tier (subCategory)  → A/B/C — drives bahumana/gift
    //   • slotCode            → seva slot code — drives timing/seating
    const incomingTier = (req.body.subCategory || req.body.tier || "").toString().trim().toUpperCase();
    const incomingSlotCode = (req.body.sevaSlotCode || req.body.slotCode || "").toString().trim().toUpperCase();

    // Resolve category to check if it's a Sponsor category (catCode SP)
    const categoryForCheck = await Category.findById(catId).select("catCode name").lean();
    const isSponsorCategory = (categoryForCheck?.catCode || "").toUpperCase() === "SP";

    // Resolve SevaSlot from the slot code (sponsors only)
    const sevaSlot = (isSponsorCategory && incomingSlotCode)
      ? await SevaSlot.findOne({ eventId, code: incomingSlotCode, isActive: true }).lean()
      : null;

    // ── Duplicate check ──────────────────────────────────────────────────────
    // Sponsor: one QR per phone per SEVA SLOT (timing). Same phone + same slot
    //   = block. Same phone + different slot = allow (they attend two sevas).
    //   Tier does NOT affect duplicate logic — it's just the bahumana.
    // Non-sponsor: one QR per phone per event.
    const existingHolders = await Holder.find({ eventId, phone: normPhone })
      .select("_id name subCategory sevaSlotId").lean();

    for (const existing of existingHolders) {
      if (isSponsorCategory) {
        // Compare by seva slot (timing), not tier
        const existingSlotId = existing.sevaSlotId ? String(existing.sevaSlotId) : "";
        const incomingSlotId = sevaSlot ? String(sevaSlot._id) : "";
        const sameSlot =
          (incomingSlotId && existingSlotId && incomingSlotId === existingSlotId) ||
          (!incomingSlotId && !existingSlotId);
        if (!sameSlot) continue; // different slot — allow new QR
      }

      const existingQR = await QRPass.findOne({ holderId: existing._id, status: "active" })
        .select("qrId").lean();
      if (!existingQR) continue;

      const reason = (req.body.overrideReason || "").toString().trim();
      if (!reason) {
        const code = isSponsorCategory ? "DUPLICATE_SEVA_SLOT" : "DUPLICATE_PHONE";
        const slotLabel = sevaSlot ? (sevaSlot.name || incomingSlotCode) : "this seva slot";
        return res.status(409).json({
          code,
          error: isSponsorCategory
            ? `An active pass for "${slotLabel}" already exists for this phone number.`
            : "An active pass already exists for this phone number at this event.",
          hint: isSponsorCategory
            ? "To issue a replacement, provide a reason. To add a different seva slot, change the Seva Slot."
            : "To issue a replacement, provide a reason (e.g. 'Lost phone').",
          existing: {
            holderId: existing._id,
            holderName: existing.name,
            subCategory: existing.subCategory || null,
            qrId: existingQR.qrId,
          },
        });
      }
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
      phone: normalisePhone(phone) || phone,
      email,
      whatsappNumber: normalisePhone(phone) || phone,
      holderType: holderType || "custom",
      lifetimeDonation: Number(lifetimeDonation || 0),
      issuedBy: req.user?._id || req.user?.userId,
      // FIX: normalise phone so duplicate detection works across manual + bulk imports
      overrideReason,
      preacher: preacher || "",
      preacherId: preacherId || null,
      venueName: venueName || primaryVenue?.name || "",
      // Sponsor only: tier (bahumana) + seva slot (timing) — independent
      subCategory: isSponsorCategory ? (incomingTier || undefined) : undefined,
      sevaSlotId: isSponsorCategory ? (sevaSlot?._id || undefined) : undefined,
      // Reason given when issuing a second pass to the same phone number
      overrideReason: (req.body.overrideReason || "").toString().trim() || undefined,
    });

    const qrId = await qrService.generateQRId(
      event.eventCode,
      category.catCode,
    );
    // validFrom/validUntil stored in QRPass for display purposes only.
    // Scan validation reads live event dates from DB — not these stored values.
    const validFrom = event.dateStart;
    const validUntil = event.dateEnd;

    const payload = qrService.createPayload(
      { ...holder.toObject(), qrId },
      event,
      category,
      finalEntryPoints,
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

    let deliveryStatus = "pending";
    let deliveryError = null;

    if (deliveryMethod && deliveryMethod !== "none") {
      // Resolve sevaSlot for WhatsApp (sponsor only)
      let sevaSlotDetails = null;
      if (holder.sevaSlotId) {
        const SevaSlotModel = require("../models/SevaSlot");
        sevaSlotDetails = await SevaSlotModel.findById(holder.sevaSlotId)
          .select("code name time displayLabel").lean();
      }

      const passDetails = {
        entryPoints: finalEntryPoints.map((ep) => ep.name || ep.stationLabel),
        qrId: qrId,
        validFrom: validFrom ? validFrom.toISOString() : "",
        validUntil: validUntil ? validUntil.toISOString() : "",
        venue: venueName || event.venue?.[0]?.name || "",
        sevaSlot: sevaSlotDetails,
        tier: holder.subCategory || "",  // bahumana tier (A/B/C)
        isSponsor: isSponsorCategory,    // always use sponsor template for SP category
      };

      try {
        if (deliveryMethod === "whatsapp" || deliveryMethod === "both") {
          const waResult = await whatsappService.sendQRMessage(
            phone,
            qrImage,
            name,
            event.name,
            passDetails,
          );
          // Store Flaxxa message_id for webhook delivery status matching
          if (waResult?.messageId) qrPass.deliveryMessageId = waResult.messageId;
        }
        qrPass.deliveryStatus = "sent";
        qrPass.deliveredAt = new Date();
        deliveryStatus = "sent";
      } catch (error) {
        console.error("WhatsApp send error:", error.message, error.response?.data);
        qrPass.deliveryStatus = "failed";
        deliveryStatus = "failed";
        deliveryError = error.message;
      }
      await qrPass.save();
    }

    // ── Push to third-party system (non-blocking) ──
    thirdPartyService.pushHolder({
      holder,
      qrPass,
      qrImageBase64: qrImage,
      event,
    }).catch((e) => console.error("[ThirdParty] createHolder push failed:", e.message));

    res.status(201).json({
      success: true,
      holder,
      qrPass: {
        qrId: qrPass.qrId,
        qrImage,
        validFrom,
        validUntil,
        deliveryStatus,
        deliveryError,
      },
    });
  } catch (error) {
    console.error("Create holder error:", error);
    res.status(500).json({ error: "Failed to create holder" });
  }
};

/**
 * Export holders to CSV — FIX: batch QR query instead of N+1 loop
 */
exports.exportHolders = async (req, res) => {
  try {
    const { eventId } = req.params;
    const holders = await Holder.find({ eventId }).populate("catId", "name");

    // Single batch query
    const holderIds = holders.map((h) => h._id);
    const qrPasses = await QRPass.find({ holderId: { $in: holderIds } });
    const qrMap = {};
    for (const qp of qrPasses) {
      qrMap[qp.holderId.toString()] = qp;
    }

    let csvOutput = "Name,Phone,Email,Category,QR ID,Status\n";

    for (const holder of holders) {
      const qrPass = qrMap[holder._id.toString()];
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
    const { categoryId, holderType, deliveryMethod = "whatsapp", preacherId } = req.body;

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
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    if (fileExt === ".csv") {
      records = await parseCSV(filePath);
    } else if ([".xlsx", ".xls"].includes(fileExt)) {
      records = parseExcel(filePath);
    } else {
      try { fs.unlinkSync(filePath); } catch (_) {}
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
          preacherId || null,
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

    try { fs.unlinkSync(filePath); } catch (_) {}

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
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ error: "Bulk import failed: " + error.message });
  }
};

exports.downloadFailedImport = async (req, res) => {
  try {
    const filePath = path.join(
      __dirname,
      "../../uploads",
      req.params.filename,
    );
    if (!fs.existsSync(filePath))
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

// ──────────────────────────────── HELPERS ────────────────────────────────────

async function processSingleRecord(
  record,
  event,
  category,
  holderType,
  deliveryMethod,
  userId,
  bulkPreacherId = null,
) {
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
  // TWO separate sponsor columns:
  //   Tier         → A/B/C bahumana gift  (column: Tier / Bahumana)
  //   SubCategory  → seva slot code        (column: SubCategory / Seva Slot)
  const tier = (record.Tier || record.tier || record.Bahumana || record.bahumana || "").toString().trim().toUpperCase();
  const slotCode = (record.SubCategory || record["Sub Category"] || record.subcategory || record.Subcategory || record["Seva Slot"] || record["seva slot"] || "").toString().trim().toUpperCase();
  const preacherRaw = (record.Preacher || record.preacher || "").toString().trim();
  // Resolve preacher from CSV value — tries shortCode match first, then name
  // e.g. "MKGD" in the Preacher column → links to Mukunda Gauranga Dasa's User record
  const resolvedPreacher = await resolvePreacherFromString(preacherRaw, event._id);
  const preacher = resolvedPreacher?.preacherName || preacherRaw;
  const csvPreacherId = resolvedPreacher?.preacherId || null;
  const venue = (record.Venue || record.venue || "").toString().trim();
  const slot = (record.Slot || record.slot || "").toString().trim();

  // Resolve SevaSlot from the slot code (sponsors only)
  const sevaSlot = slotCode
    ? await SevaSlot.findOne({ eventId: event._id, code: slotCode, isActive: true }).select("_id code name time").lean()
    : null;

  if (!name)
    return { success: false, error: "Name is required", name: "Unknown", phone };
  if (!phone || !/^\d{10,15}$/.test(phone.replace(/[\+\s\-\(\)]/g, "")))
    return { success: false, error: "Invalid phone", name, phone };

  try {
    const formattedPhone =
      phone.replace(/[\+\s\-\(\)]/g, "").length === 10
        ? "91" + phone.replace(/[\+\s\-\(\)]/g, "")
        : phone.replace(/[\+\s\-\(\)]/g, "");

    // Duplicate check:
    // - Sponsor category (catCode SP): one QR per phone per seva slot (SubCategory)
    //   Same phone + same SubCategory = skip. Different SubCategory = new QR.
    // - All other categories: one QR per phone per event (SubCategory ignored)
    const isSponsor = (category.catCode || "").toUpperCase() === "SP";

    const existingHoldersForPhone = await Holder.find({
      eventId: event._id,
      phone: formattedPhone,
    }).select("_id sevaSlotId").lean();

    let skippedQrId = null;
    for (const eh of existingHoldersForPhone) {
      // Sponsor: dedup by seva SLOT (timing). Non-sponsor: any existing = skip.
      let isMatch = true;
      if (isSponsor) {
        const ehSlotId = eh.sevaSlotId ? String(eh.sevaSlotId) : "";
        const inSlotId = sevaSlot ? String(sevaSlot._id) : "";
        isMatch = (inSlotId && ehSlotId && inSlotId === ehSlotId) || (!inSlotId && !ehSlotId);
      }
      if (!isMatch) continue;
      const existingQR = await QRPass.findOne({ holderId: eh._id, status: "active" }).select("qrId").lean();
      if (existingQR) { skippedQrId = existingQR.qrId; break; }
    }
    if (skippedQrId)
      return { success: true, name, phone: formattedPhone, qrId: skippedQrId, skipped: true };

    let holder = null;

    try {
      holder = await Holder.create({
          eventId: event._id,
          catId: category._id,
          name,
          phone: formattedPhone,
          whatsappNumber: formattedPhone,
          holderType,
          subCategory: isSponsor ? (tier || undefined) : undefined,        // bahumana tier
          sevaSlotId: isSponsor ? (sevaSlot?._id || undefined) : undefined,  // seva slot (timing)
          preacher: preacher || "",
          // CSV shortCode/name resolves to preacherId; UI dropdown overrides if set
          preacherId: csvPreacherId || bulkPreacherId || null,
          venueName: venue || event.venue?.[0]?.name || "",
          notes:
            [sponsorSeva, sponsorCategory, preacher, venue, tier, slotCode]
              .filter(Boolean)
              .join(" | ") || undefined,
          customFields: { sponsorSeva, sponsorCategory, preacher, venue, tier, slotCode },
          issuedBy: userId,
        });
      } catch (createErr) {
        // FIX: unique index race condition — another request already created this holder
        if (createErr.code === 11000) {
          holder = await Holder.findOne({ eventId: event._id, phone: formattedPhone });
          if (!holder) throw createErr;
          const existingQR = await QRPass.findOne({ holderId: holder._id, status: "active" });
          if (existingQR) {
            return { success: true, skipped: true, name, phone: formattedPhone, qrId: existingQR.qrId };
          }
        } else {
          throw createErr;
        }
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

    // FIX: WhatsApp delivery failure does NOT return success:false.
    // The holder + QRPass are already persisted. We record failure status
    // and include the record in the "failed" list for re-delivery,
    // but we don't orphan the holder record.
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
            venue: venue || event.venue?.[0]?.name || "",
            isSponsor: isSponsor,           // use sponsor_qr_message template
            tier: tier || "",               // bahumana tier A/B/C
            sevaSlot: sevaSlot ? {          // slot name + time for {{5}}
              name: sevaSlot.name,
              time: sevaSlot.time,
              displayLabel: sevaSlot.displayLabel ||
                (sevaSlot.name + (sevaSlot.time ? ` · ${sevaSlot.time}` : "")),
            } : null,
          },
        );
        qrPass.deliveryStatus = "sent";
        qrPass.deliveredAt = new Date();
      } catch (e) {
        qrPass.deliveryStatus = "failed";
        await qrPass.save();
        // Return success:true because the QR was created — just delivery failed
        return {
          success: true,
          deliveryFailed: true,
          error: "WhatsApp delivery failed: " + e.message,
          name,
          phone: formattedPhone,
          qrId,
          deliveryStatus: "failed",
        };
      }
      await qrPass.save();
    }

    // ── Push to third-party system (non-blocking) ──
    thirdPartyService.pushHolder({
      holder,
      qrPass,
      qrImageBase64: qrImage,
      event,
    }).catch((e) => console.error("[ThirdParty] bulkImport push failed:", e.message));

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
    fs.createReadStream(filePath)
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

// ── Manual Entry: mark a holder as attended without physical QR scan ─────────
// POST /api/qr/:qrId/manual-entry
// Requires canManualEntry permission. Creates a ScanLog with source:manual.
exports.manualEntry = async (req, res) => {
  try {
    const { qrId } = req.params;
    const { epId, stationLabel, reason } = req.body;
    const userId = req.user._id || req.user.id;

    // Check permission — super_admin and event_admin always allowed
    const hasPermission = req.user.canManualEntry ||
      req.user.role === "super_admin" || req.user.role === "event_admin";
    if (!hasPermission) {
      return res.status(403).json({ error: "You do not have manual entry permission" });
    }

    // Find the QR pass
    const QRPass = require("../models/QRPass");
    const ScanLog = require("../models/ScanLog");
    const EntryPoint = require("../models/EntryPoint");

    const qrPass = await QRPass.findOne({ qrId: qrId.toUpperCase() })
      .populate({ path: "holderId", select: "name phone subCategory catId sevaSlotId eventId",
        populate: [{ path: "catId", select: "name catCode color" },
                   { path: "sevaSlotId", select: "code name time" }] });

    if (!qrPass) return res.status(404).json({ error: "QR pass not found" });
    if (qrPass.status !== "active") return res.status(400).json({ error: "QR pass is not active" });

    // Resolve entry point
    let resolvedEpId = epId;
    let resolvedLabel = stationLabel || "Manual Entry";
    if (!resolvedEpId) {
      // Use the first entry point for the event
      const ep = await EntryPoint.findOne({ eventId: qrPass.eventId }).select("_id name stationLabel");
      if (ep) { resolvedEpId = ep._id; resolvedLabel = ep.name || resolvedLabel; }
    }

    // Create scan log with source: manual
    await ScanLog.create({
      qrId: qrPass.qrId,
      holderId: qrPass.holderId?._id || qrPass.holderId,
      epId: resolvedEpId,
      scannedBy: userId,
      stationLabel: resolvedLabel,
      result: "granted",
      source: "manual",
      notes: reason || "Manual entry by admin",
      deviceInfo: { ipAddress: req.ip, source: "admin_dashboard" },
    });

    // Update entry point counter
    if (resolvedEpId) {
      await EntryPoint.findByIdAndUpdate(resolvedEpId, { $inc: { currentCount: 1 } });
    }

    return res.json({
      success: true,
      message: `${qrPass.holderId?.name || "Holder"} marked as attended`,
      holderName: qrPass.holderId?.name,
      qrId: qrPass.qrId,
    });
  } catch (error) {
    console.error("manualEntry error:", error);
    res.status(500).json({ error: "Manual entry failed", detail: error.message });
  }
};
