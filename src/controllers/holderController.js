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
const HolderType = require("../models/HolderType");
const Holder = require("../models/Holder");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const User = require("../models/User");
const qrService = require("../services/qrService");
const whatsappService = require("../services/whatsappService");
const { deriveHolderTypeLabel } = require("../utils/holderTypeLabel");
const {
  checkIssuePermission,
  isLimitedToOwnHolders,
  isEventAllowed,
  canIssueAdditionalPass,
} = require("../utils/issuePermissions");

// Refuses a read for an event this account is not assigned to. Returns true
// when it has already answered the request.
function blockedByEventScope(req, res, eventId) {
  if (isEventAllowed(req.user, eventId)) return false;
  res.status(403).json({
    code: "EVENT_NOT_ALLOWED",
    error: "Your account is not assigned to this event.",
  });
  return true;
}

// Same guard for a SINGLE holder reached directly by id, covering both limits:
// the event it belongs to, and "own passes only".
//
// Without this, an account restricted to its own passes at one event could
// still read any devotee's name, phone and email by holder id or QR id — the
// list was scoped but these detail endpoints were not.
function blockedByHolderScope(req, res, holder) {
  const eventId = holder?.eventId?._id || holder?.eventId;
  if (!isEventAllowed(req.user, eventId)) {
    res.status(403).json({
      code: "EVENT_NOT_ALLOWED",
      error: "Your account is not assigned to this event.",
    });
    return true;
  }
  if (isLimitedToOwnHolders(req.user)) {
    const issuedBy = String(holder?.issuedBy?._id || holder?.issuedBy || "");
    const me = String(req.user._id || req.user.userId || "");
    if (issuedBy !== me) {
      res.status(403).json({
        code: "NOT_YOUR_HOLDER",
        error: "Your account can only view passes it issued.",
      });
      return true;
    }
  }
  return false;
}

// ─── Helper: look up a preacher's phone for the community app's
// devotee_mobile_number field (identifies which preacher's devotee this
// sponsor/donor was registered under). Returns undefined if not resolvable
// so the push falls back to the sponsor's own number.
async function resolvePreacherPhone(preacherId) {
  if (!preacherId) return undefined;
  try {
    const preacherUser = await User.findById(preacherId).select("phone").lean();
    return preacherUser?.phone || undefined;
  } catch (_) {
    return undefined;
  }
}
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

    // The QR carries the holder's name/phone/email — same scope rules as
    // reading the holder directly.
    const scopeHolder = await Holder.findById(qrPass.holderId?._id || qrPass.holderId)
      .select("eventId issuedBy").lean();
    if (scopeHolder && blockedByHolderScope(req, res, scopeHolder)) return;

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

    // A restricted account must not be able to reach a delivery channel via
    // "resend" that it is barred from at issue time.
    const resendDenied = await checkIssuePermission(req.user, {
      catId: qrPass.catId,
      deliveryMethod: deliveryMethod || "none",
    });
    if (resendDenied) {
      return res.status(resendDenied.status).json(resendDenied.body);
    }

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
    const { search, catId, page = 1, limit = 20 } = req.query;
    if (blockedByEventScope(req, res, eventId)) return;

    const query = { eventId };

    if (catId) query.catId = catId;

    // Restricted accounts see only the passes they issued themselves.
    // Applied to the query (not the response) so the pagination total is
    // correct too, and so it cannot be bypassed by paging.
    if (isLimitedToOwnHolders(req.user)) {
      query.issuedBy = req.user._id || req.user.userId;
    }

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

    if (blockedByHolderScope(req, res, holder)) return;

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
      lifetimeDonation,
      entryPoints,
      overrideReason,
      deliveryMethod,
      preacher,
      preacherId,  // ObjectId ref to User with role "preacher" (from dropdown)
      venueName,
      venues,      // optional array of venue NAMES the pass is valid at
    } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    const primaryVenue = event.venue?.[0];

    // Resolve the list of venue names this pass is allowed to scan at.
    // - If `venues` is provided (array of venue names/indices), keep only those
    //   that match the event's actual venue names (case-insensitive). Numeric
    //   indices into event.venue[] are also accepted for the admin dashboard.
    // - If `venues` is empty, the pass is valid at EVERY venue (legacy behavior).
    const eventVenueNames = (Array.isArray(event.venue) ? event.venue : [])
      .map((v) => String(v?.name || "").trim())
      .filter(Boolean);
    let allowedVenues = [];
    if (Array.isArray(venues) && venues.length > 0) {
      allowedVenues = venues
        .map((v) => {
          if (typeof v === "number" && !isNaN(v)) {
            return eventVenueNames[Number(v)] || "";
          }
          return typeof v === "string" ? String(v).trim() : "";
        })
        .filter((name) => name && eventVenueNames.some((n) => n.toLowerCase() === name.toLowerCase()));
      // Normalise to the event's actual venue name casing
      allowedVenues = allowedVenues.map((name) =>
        eventVenueNames.find((n) => n.toLowerCase() === name.toLowerCase()) || name
      );
    }

    const normPhone = normalisePhone(phone) || phone;

    // TWO independent sponsor fields:
    //   • tier (subCategory)  → A/B/C — drives bahumana/gift
    //   • slotCode            → seva slot code — drives timing/seating
    const incomingTier = (req.body.subCategory || req.body.tier || "").toString().trim().toUpperCase();
    const incomingSlotCode = (req.body.sevaSlotCode || req.body.slotCode || "").toString().trim().toUpperCase();
    // Custom instruction (rich HTML from the dashboard editor) — passthrough,
    // no case/trim transforms since it may contain meaningful HTML markup.
    const incomingInstruction = (req.body.instruction || "").toString().trim();

    // Resolve pass type to check if it's a Sponsor type (catCode SP)
    const categoryForCheck = await HolderType.findById(catId).select("catCode name").lean();
    const isSponsorCategory = (categoryForCheck?.catCode || "").toUpperCase() === "SP";

    // ── Per-account issue restrictions ───────────────────────────────────────
    // Checked before anything is written. `deliveryMethod || "none"` matches
    // the effective value used below — without that default, an account barred
    // from "none" could slip a pass through simply by omitting the field.
    const denied = await checkIssuePermission(req.user, {
      eventId,
      holderType: categoryForCheck,
      deliveryMethod: deliveryMethod || "none",
    });
    if (denied) {
      return res.status(denied.status).json(denied.body);
    }

    // Resolve SevaSlot from the slot code (sponsors only)
    const sevaSlot = (isSponsorCategory && incomingSlotCode)
      ? await SevaSlot.findOne({ eventId, code: incomingSlotCode, isActive: true }).lean()
      : null;

    // ── Duplicate check ──────────────────────────────────────────────────────
    // A second pass for the same number + holder type + category is LEGITIMATE
    // (the donor who sponsors twice at tier A), so this is not a hard block —
    // it is a prompt. The admin picks one of two things, and doing nothing is
    // what stops a double-clicked submit or a re-run import:
    //
    //   issueAdditional: true  → a NEW pass alongside the existing one
    //                            (holder record with passSeq = max + 1)
    //   overrideReason: "..."  → REPLACE: revoke the old QR, reissue on the
    //                            same holder record
    //   neither                → 409 describing both options
    //
    // The tier/category filter below matches the uniq_event_phone_type_category_seq
    // index on Holder. Seva slot is NOT part of the key — timing/seating only.
    const tierFilter = incomingTier
      ? { subCategory: incomingTier }
      // Legacy rows may hold "" where new rows hold undefined — treat both as
      // "no category" so the app check agrees with the unique index.
      : { subCategory: { $in: [null, ""] } };

    const duplicateQuery = { eventId, phone: normPhone, catId, ...tierFilter };

    // Highest passSeq already used for this number/type/category, so an
    // additional pass lands on the next free slot.
    const siblings = await Holder.find(duplicateQuery)
      .select("_id name subCategory passSeq")
      .sort({ passSeq: -1 })
      .lean();

    const duplicateHolder = siblings[0]
      ? await Holder.findById(siblings[0]._id).select("_id name subCategory passSeq")
      : null;
    const maxPassSeq = siblings.reduce((m, h) => Math.max(m, h.passSeq || 1), 0);

    const overrideReasonText = (req.body.overrideReason || "").toString().trim();
    // Explicit intent to add a pass rather than replace one. Takes precedence
    // over overrideReason, which a client may send alongside it as a note.
    const wantsAdditional =
      req.body.issueAdditional === true || req.body.issueAdditional === "true";

    // Issuing a SECOND pass for the same number + type + category is an admin
    // decision — see ROLES_MAY_ISSUE_ADDITIONAL. Refuse rather than silently
    // downgrading to a replacement, which would revoke a live pass the caller
    // never meant to touch.
    const mayIssueAdditional = canIssueAdditionalPass(req.user);
    if (wantsAdditional && !mayIssueAdditional) {
      return res.status(403).json({
        code: "ADDITIONAL_PASS_NOT_ALLOWED",
        error:
          "Only an administrator can issue a second pass for the same number, " +
          "holder type and category.",
      });
    }
    const issueAdditional = wantsAdditional && mayIssueAdditional;

    if (duplicateHolder && !issueAdditional) {
      const activePasses = await QRPass.find({
        holderId: { $in: siblings.map((h) => h._id) },
        status: "active",
      }).select("qrId holderId").lean();

      if (activePasses.length > 0 && !overrideReasonText) {
        const passLabel = [
          categoryForCheck?.name || "pass",
          incomingTier ? `category ${incomingTier}` : null,
        ].filter(Boolean).join(" · ");
        return res.status(409).json({
          code: "DUPLICATE_PASS",
          error:
            `This phone number already holds ${activePasses.length} active ` +
            `"${passLabel}" pass${activePasses.length > 1 ? "es" : ""} at this event.`,
          // Advertise only what THIS role may do, so the dashboard never
          // shows a button that would come back 403.
          canIssueAdditional: mayIssueAdditional,
          canReplace: true,
          hint: mayIssueAdditional
            ? "If they have genuinely donated again, issue an ADDITIONAL pass — " +
              "both stay valid. If this is a lost phone or a correction, REPLACE " +
              "instead and the old QR is revoked. A different holder type or " +
              "category needs neither."
            : "To REPLACE the existing pass (lost phone, correction), provide a " +
              "reason and the old QR is revoked. A different holder type or " +
              "category needs neither. Only an administrator can issue a " +
              "second pass for this same type and category.",
          existing: {
            holderId: duplicateHolder._id,
            holderName: duplicateHolder.name,
            holderTypeName: categoryForCheck?.name || null,
            subCategory: duplicateHolder.subCategory || null,
            qrId: activePasses[0].qrId,
            activeQrIds: activePasses.map((p) => p.qrId),
            passCount: activePasses.length,
          },
        });
      }
    }

    const category = await HolderType.findById(catId).populate("entryPoints");
    if (!category) {
      return res.status(404).json({ error: "Pass type not found" });
    }

    const finalEntryPoints =
      entryPoints && entryPoints.length > 0
        ? await EntryPoint.find({ _id: { $in: entryPoints }, eventId })
        : category.entryPoints;

    const holderFields = {
      eventId,
      catId,
      name,
      phone: normPhone,
      email,
      whatsappNumber: normPhone,
      // Denormalized label derived from the pass type (shared codeMap)
      holderType: deriveHolderTypeLabel(category),
      lifetimeDonation: Number(lifetimeDonation || 0),
      issuedBy: req.user?._id || req.user?.userId,
      preacher: preacher || "",
      preacherId: preacherId || null,
      venueName: venueName || primaryVenue?.name || "",
      // Category tier (A/B/C) — applies to any pass type, part of the uniqueness key
      subCategory: incomingTier || undefined,
      // Seva slot (timing) — sponsors only, NOT part of the uniqueness key
      sevaSlotId: isSponsorCategory ? sevaSlot?._id || undefined : undefined,
      // Free-text note: why this pass was replaced, or why an additional one
      // was issued ("second donation"). Optional either way.
      overrideReason: overrideReasonText || undefined,
      instruction: incomingInstruction || undefined,
    };

    let holder;
    if (duplicateHolder && issueAdditional) {
      // ADDITIONAL pass: a genuine second donation at the same tier. A new
      // holder record on the next free passSeq, so both passes stay live and
      // each has its own scan history. The existing pass is left alone.
      holder = await Holder.create({
        ...holderFields,
        passSeq: maxPassSeq + 1,
      });
    } else if (duplicateHolder) {
      // REPLACEMENT (override reason supplied, or the previous pass was already
      // revoked/expired): revoke the old QR and reissue on the SAME record,
      // keeping its passSeq, rather than inserting a second one.
      await QRPass.updateMany(
        { holderId: duplicateHolder._id, status: "active" },
        { $set: { status: "revoked", updatedAt: new Date() } },
      );
      // Mongoose drops undefined values from an update, so a field cleared on
      // the replacement (seva slot removed, instruction blanked) would silently
      // keep its old value. Split the payload into $set / $unset explicitly.
      const $set = {};
      const $unset = {};
      for (const [k, v] of Object.entries(holderFields)) {
        if (v === undefined) $unset[k] = "";
        else $set[k] = v;
      }
      holder = await Holder.findByIdAndUpdate(
        duplicateHolder._id,
        {
          ...(Object.keys($set).length ? { $set } : {}),
          ...(Object.keys($unset).length ? { $unset } : {}),
        },
        { new: true, runValidators: true },
      );
    } else {
      try {
        holder = await Holder.create(holderFields);
      } catch (createErr) {
        // Race: a concurrent request created the same number+type+category.
        if (createErr.code === 11000) {
          return res.status(409).json({
            code: "DUPLICATE_PASS",
            error:
              "A pass for this phone number, holder type and category was just " +
              "created by another request. Reload and check before retrying.",
          });
        }
        throw createErr;
      }
    }

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
      allowedVenues,
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
        if (deliveryMethod === "whatsapp" || deliveryMethod === "both" || deliveryMethod === "mobile_whatsapp") {
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

    // ── Push to third-party system (non-blocking, result persisted for visibility) ──
    (async () => {
      try {
        const catCodeUpper = (categoryForCheck?.catCode || "").toUpperCase();
        let result;
        let qrStoreResult = null;
        if (["SP", "DN", "INV"].includes(catCodeUpper)) {
          const preacherPhone = await resolvePreacherPhone(holder?.preacherId);
          result = await thirdPartyService.pushSevaSponsor({
            holder, event, qrPass, catCode: catCodeUpper,
            categoryName: categoryForCheck?.name || "",
            subCategory: holder?.subCategory || "",
            preacherPhone,
            sevaSlotName: sevaSlot?.name || "",
            instruction: holder?.instruction || "",
          });
          // seva-sponsor dedupes on the devotee+donor pair only — a second QR
          // for the same phone is silently dropped on their side. Always also
          // register the raw qrcode string via store-qr-code so every pass of
          // a multi-QR holder shows up in their app.
          qrStoreResult = await thirdPartyService.pushStoreQrCode({ holder, event, qrPass });
        } else if (catCodeUpper === "VL") {
          result = await thirdPartyService.pushStoreQrCode({ holder, event, qrPass });
        } else {
          result = await thirdPartyService.pushHolder({
            holder, qrPass, qrImageBase64: qrImage, event,
          });
        }
        const syncUpdate = {
          communityAppSync: {
            attempted: !!result.attempted,
            success: !!result.success,
            skipped: !!result.skipped,
            reason: result.reason || null,
            responseBody: result.responseBody || null,
            attemptedAt: new Date(),
          },
        };
        if (qrStoreResult) {
          syncUpdate.communityAppSync.qrStoreSync = {
            attempted: !!qrStoreResult.attempted,
            success: !!qrStoreResult.success,
            skipped: !!qrStoreResult.skipped,
            reason: qrStoreResult.reason || null,
            responseBody: qrStoreResult.responseBody || null,
            attemptedAt: new Date(),
          };
        }
        await QRPass.findByIdAndUpdate(qrPass._id, syncUpdate);
      } catch (e) {
        console.error("[ThirdParty] createHolder push failed:", e.message);
      }
    })();

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
    if (blockedByEventScope(req, res, eventId)) return;
    // Export honours the same "own passes only" limit as the list — otherwise
    // it would be a one-click way around it.
    const exportQuery = { eventId };
    if (isLimitedToOwnHolders(req.user)) {
      exportQuery.issuedBy = req.user._id || req.user.userId;
    }
    const holders = await Holder.find(exportQuery).populate("catId", "name");

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
    const { categoryId, deliveryMethod = "whatsapp", preacherId } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const category =
      await HolderType.findById(categoryId).populate("entryPoints");
    if (!category) return res.status(404).json({ error: "Pass type not found" });

    // ── Per-account issue restrictions ───────────────────────────────────────
    // Bulk import is the obvious bypass route for a restricted account — it
    // reaches the same holder-creation code with its own type and delivery
    // choice — so it is checked with exactly the same rules as single issue,
    // before the uploaded file is even parsed.
    const bulkDenied = await checkIssuePermission(req.user, {
      eventId,
      holderType: category,
      deliveryMethod: deliveryMethod || "none",
    });
    if (bulkDenied) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(bulkDenied.status).json(bulkDenied.body);
    }

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
      // Rows skipped without issuing. Now only reachable in edge cases (a row
      // a concurrent request already handled) — deliberate duplicates are
      // issued, not skipped — but kept so `total` always reconciles as
      // success + skipped + failed.
      skipped: [],
      // Rows that issued a pass to a number which ALREADY held a live pass of
      // this type and tier. Legitimate for a second donation; a large count
      // right after an import is the signature of an accidental re-upload.
      additional: [],
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      additionalCount: 0,
    };

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      try {
        const result = await processSingleRecord(
          record,
          event,
          category,
          deliveryMethod,
          req.user?._id || req.user?.userId,
          preacherId || null,
          // Only an admin's import may issue a second pass to a number that
          // already has one; for other roles duplicate rows are skipped.
          { skipStoreQrCode: false, allowAdditional: canIssueAdditionalPass(req.user) },
        );
        if (result.skipped) {
          results.skipped.push(result);
          results.skippedCount++;
        } else if (result.success) {
          results.success.push(result);
          results.successCount++;
          // Counted in addition to (not instead of) success — these rows DID
          // issue a pass.
          if (result.additional) {
            results.additional.push(result);
            results.additionalCount++;
          }
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

    // Community app push now happens per-holder inside processSingleRecord
    // (routes to seva-sponsor for Sponsor/Donor/Invitee with the correct
    // subCategory tag, or store-qr-code for Volunteer/General) — the old
    // batch-only store-qr-code call here has been removed since it ignored
    // category entirely and pushed every holder as a plain volunteer QR.

    res.json({
      success: true,
      message: `Processed ${results.total} records`,
      stats: {
        total: results.total,
        success: results.successCount,
        skipped: results.skippedCount,
        failed: results.failedCount,
        // Subset of `success`, not a separate bucket.
        additional: results.additionalCount,
      },
      summary: {
        successList: results.success.map((r) => ({
          name: r.name,
          phone: r.phone,
          qrId: r.qrId,
        })),
        skippedList: results.skipped.map((r) => ({
          name: r.name,
          phone: r.phone,
          qrId: r.qrId,
          reason: r.reason || "Duplicate pass for this holder type and category",
        })),
        additionalList: results.additional.map((r) => ({
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
    const category = await HolderType.findById(req.params.categoryId).populate(
      "entryPoints",
    );
    if (!category) return res.status(404).json({ error: "Pass type not found" });
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
    if (blockedByEventScope(req, res, req.params.eventId)) return;
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
  deliveryMethod,
  userId,
  bulkPreacherId = null,
  { skipStoreQrCode = false, allowAdditional = false } = {},
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
  // TWO separate columns:
  //   Category/Tier → A/B/C category tier  (column: Category / Tier / Bahumana)
  //   SubCategory   → seva slot code        (column: SubCategory / Seva Slot)
  let tier = (record.Category || record.category || record.Tier || record.tier || record.Bahumana || record.bahumana || "").toString().trim().toUpperCase();
  if (tier === "NONE" || tier === "N/A" || tier === "-") tier = "";
  const slotCode = (record.SubCategory || record["Sub Category"] || record.subcategory || record.Subcategory || record["Seva Slot"] || record["seva slot"] || "").toString().trim().toUpperCase();

  // Custom instructions — reads Instruction1, Instruction2, Instruction3, ...
  // (any number of numbered columns, case-insensitive) and joins them into
  // an HTML bullet list for the community app's rich-text instruction field.
  // A single plain "Instruction" column (no number) is also supported.
  const instructionLines = [];
  const recordKeys = Object.keys(record || {});
  for (const key of recordKeys) {
    if (/^instruction\s*\d+$/i.test(key.trim())) {
      const val = (record[key] || "").toString().trim();
      if (val) instructionLines.push({ n: parseInt(key.replace(/\D/g, ""), 10), val });
    }
  }
  instructionLines.sort((a, b) => a.n - b.n);
  let rowInstruction = instructionLines.length > 0
    ? `<ul>${instructionLines.map((l) => `<li>${l.val}</li>`).join("")}</ul>`
    : "";
  if (!rowInstruction) {
    const plain = (record.Instruction || record.instruction || "").toString().trim();
    if (plain) rowInstruction = plain;
  }

  const preacherRaw = (record.Preacher || record.preacher || "").toString().trim();
  // Resolve preacher from CSV value — tries shortCode match first, then name
  // e.g. "MKGD" in the Preacher column → links to Mukunda Gauranga Dasa's User record
  const resolvedPreacher = await resolvePreacherFromString(preacherRaw, event._id);
  const preacher = resolvedPreacher?.preacherName || preacherRaw;
  const csvPreacherId = resolvedPreacher?.preacherId || null;
  // Venue column supports multiple venues, comma-separated (e.g. "Venue 1, Venue 2")
  // — restricts the pass to scan-valid only at those venues. Leave blank for
  // "valid at every venue" (legacy/default behaviour).
  const venueRaw = (record.Venue || record.venue || "").toString().trim();
  const venueList = venueRaw
    ? venueRaw.split(",").map((v) => v.trim()).filter(Boolean)
    : [];
  // venue: kept as a single string for display fields (seating label, notes,
  // customFields) that predate multi-venue support — uses the first venue.
  const venue = venueList[0] || "";
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

    // EVERY ROW GETS A PASS. A spreadsheet may legitimately list the same
    // donor twice for the same tier (two separate donations), so rows are no
    // longer skipped as duplicates.
    //
    // The cost of that choice: re-uploading the same file issues everyone a
    // SECOND pass. Nothing here can tell that apart from a deliberate repeat,
    // so instead each row reports whether it added to an existing pass, and
    // the import summary surfaces the total — an accidental re-upload shows up
    // immediately as a large "additional" count.
    //
    // Seva slot (SubCategory column) does not affect any of this.
    const isSponsor = (category.catCode || "").toUpperCase() === "SP";

    // Legacy rows may hold "" where new rows hold undefined — match both.
    const tierFilter = tier
      ? { subCategory: tier }
      : { subCategory: { $in: [null, ""] } };

    const duplicateQuery = {
      eventId: event._id,
      phone: formattedPhone,
      catId: category._id,
      ...tierFilter,
    };

    // Existing passes for this number/type/tier, so the new row lands on the
    // next free passSeq rather than colliding with the unique index.
    const siblings = await Holder.find(duplicateQuery)
      .select("_id passSeq")
      .sort({ passSeq: -1 })
      .lean();
    const maxPassSeq = siblings.reduce((m, h) => Math.max(m, h.passSeq || 1), 0);

    // A record with no live pass is reused rather than piling up another row.
    let reusableHolderId = null;
    let isAdditional = false;
    if (siblings.length > 0) {
      const activePasses = await QRPass.find({
        holderId: { $in: siblings.map((h) => h._id) },
        status: "active",
      }).select("holderId qrId").lean();
      const activeIds = new Set(activePasses.map((p) => String(p.holderId)));
      const dead = siblings.find((h) => !activeIds.has(String(h._id)));
      if (dead) reusableHolderId = dead._id;
      isAdditional = activePasses.length > 0;

      // Issuing a duplicate is admin-only (ROLES_MAY_ISSUE_ADDITIONAL). For
      // anyone else the row is skipped rather than silently creating a second
      // live pass — otherwise a repeated CSV row would be a way around the
      // rule enforced on the single-issue screen.
      if (isAdditional && !allowAdditional) {
        return {
          success: true,
          skipped: true,
          name,
          phone: formattedPhone,
          qrId: activePasses[0].qrId,
          reason:
            "Already has an active pass for this holder type and category — " +
            "only an administrator can issue a second one",
        };
      }
    }

    let holder = null;

    const rowHolderFields = {
      eventId: event._id,
      catId: category._id,
      name,
      phone: formattedPhone,
      whatsappNumber: formattedPhone,
      holderType: deriveHolderTypeLabel(category),
      source: "bulk_import",
      subCategory: tier || undefined,                                    // category tier (A/B/C — part of the uniqueness key)
      sevaSlotId: isSponsor ? (sevaSlot?._id || undefined) : undefined,  // seva slot (timing only — not part of the key)
      preacher: preacher || "",
      // CSV shortCode/name resolves to preacherId; UI dropdown overrides if set
      preacherId: csvPreacherId || bulkPreacherId || null,
      venueName: (venueList.length > 1 ? venueList.join(" / ") : venue) || event.venue?.[0]?.name || "",
      notes:
        [sponsorSeva, sponsorCategory, preacher, venue, tier, slotCode]
          .filter(Boolean)
          .join(" | ") || undefined,
      customFields: { sponsorSeva, sponsorCategory, preacher, venue, tier, slotCode },
      instruction: rowInstruction || undefined,
      issuedBy: userId,
    };

    if (reusableHolderId) {
      // A record exists for this number+type+tier whose pass is revoked or
      // expired. Reuse it instead of accumulating another row. $set/$unset
      // split so fields cleared on this import don't keep their old values.
      const $set = {};
      const $unset = {};
      for (const [k, v] of Object.entries(rowHolderFields)) {
        if (v === undefined) $unset[k] = "";
        else $set[k] = v;
      }
      holder = await Holder.findByIdAndUpdate(
        reusableHolderId,
        {
          ...(Object.keys($set).length ? { $set } : {}),
          ...(Object.keys($unset).length ? { $unset } : {}),
        },
        { new: true, runValidators: true },
      );
    } else {
      // New record. passSeq 1 for the first pass on this number+type+tier,
      // max+1 for each further one, which is what lets a spreadsheet list the
      // same donor twice without tripping the unique index.
      try {
        holder = await Holder.create({
          ...rowHolderFields,
          passSeq: maxPassSeq + 1,
        });
      } catch (createErr) {
        // Race: a concurrent request took this passSeq between our read and
        // this insert. Retry once on the next slot rather than failing the row.
        if (createErr.code === 11000) {
          const fresh = await Holder.find(duplicateQuery).select("passSeq").lean();
          const retrySeq = fresh.reduce((m, h) => Math.max(m, h.passSeq || 1), 0) + 1;
          holder = await Holder.create({ ...rowHolderFields, passSeq: retrySeq });
        } else {
          throw createErr;
        }
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
      // If the CSV provides Venue (comma-separated for multiple), restrict the
      // pass to those venues (matching the event's actual venue names where
      // possible); otherwise valid at every venue.
      allowedVenues: (() => {
        const candidates = Array.from(
          new Set(venueList.filter((v) => typeof v === "string" && v.trim())),
        );
        const eventNames = (Array.isArray(event.venue) ? event.venue : [])
          .map((ev) => String(ev?.name || "").trim()).filter(Boolean);
        if (candidates.length === 0) return [];
        const resolved = candidates.flatMap((c) => {
          const match = eventNames.find((n) => n.toLowerCase() === c.toLowerCase());
          return match ? [match] : [];
        });
        return resolved.length ? resolved : [];
      })(),
    });

    // FIX: WhatsApp delivery failure does NOT return success:false.
    // The holder + QRPass are already persisted. We record failure status
    // and include the record in the "failed" list for re-delivery,
    // but we don't orphan the holder record.
    if (deliveryMethod === "whatsapp" || deliveryMethod === "both" || deliveryMethod === "mobile_whatsapp") {
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
          // true when this number already held a live pass of this type and
          // tier — surfaced so an accidental re-upload is obvious.
          additional: isAdditional,
          error: "WhatsApp delivery failed: " + e.message,
          name,
          phone: formattedPhone,
          qrId,
          deliveryStatus: "failed",
        };
      }
      await qrPass.save();
    }

    // ── Push to third-party system (non-blocking, result persisted for visibility) ──
    (async () => {
      try {
        const catCodeUpper = (category?.catCode || "").toUpperCase();
        let result;
        let qrStoreResult = null;
        if (["SP", "DN", "INV"].includes(catCodeUpper)) {
          const preacherPhone = await resolvePreacherPhone(holder?.preacherId);
          result = await thirdPartyService.pushSevaSponsor({
            holder, event, qrPass, catCode: catCodeUpper,
            categoryName: category?.name || "",
            subCategory: holder?.subCategory || "",
            preacherPhone,
            sevaSlotName: sevaSlot?.name || "",
            instruction: holder?.instruction || "",
          });
          if (!skipStoreQrCode) {
            qrStoreResult = await thirdPartyService.pushStoreQrCode({ holder, event, qrPass });
          }
        } else if (catCodeUpper === "VL") {
          if (!skipStoreQrCode) {
            result = await thirdPartyService.pushStoreQrCode({ holder, event, qrPass });
          }
        } else {
          result = await thirdPartyService.pushHolder({
            holder, qrPass, qrImageBase64: qrImage, event,
          });
        }
        const syncUpdate = {
          communityAppSync: {
            attempted: !!result.attempted,
            success: !!result.success,
            skipped: !!result.skipped,
            reason: result.reason || null,
            responseBody: result.responseBody || null,
            attemptedAt: new Date(),
          },
        };
        if (qrStoreResult) {
          syncUpdate.communityAppSync.qrStoreSync = {
            attempted: !!qrStoreResult.attempted,
            success: !!qrStoreResult.success,
            skipped: !!qrStoreResult.skipped,
            reason: qrStoreResult.reason || null,
            responseBody: qrStoreResult.responseBody || null,
            attemptedAt: new Date(),
          };
        }
        await QRPass.findByIdAndUpdate(qrPass._id, syncUpdate);
      } catch (e) {
        console.error("[ThirdParty] bulkImport push failed:", e.message);
      }
    })();

    return {
      success: true,
      // true when this number already held a live pass of this type and tier.
      additional: isAdditional,
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

// ── Retry the community app push for an existing QR pass ────────────────────
// Does NOT re-issue the QR or resend WhatsApp — only retries the
// harekrishnavizag.co.in sync (register-volunteer / seva-sponsor /
// store-qr-code), and updates communityAppSync with the fresh result.
exports.retryCommunitySync = async (req, res) => {
  try {
    const { qrId } = req.params;
    const qrPass = await QRPass.findOne({ qrId: qrId.toUpperCase() })
      .populate({ path: "holderId", select: "name phone email subCategory catId sevaSlotId preacherId instruction" })
      .populate("eventId")
      .populate("catId", "name catCode");

    if (!qrPass) return res.status(404).json({ error: "QR pass not found" });

    const holder = qrPass.holderId;
    const event = qrPass.eventId;
    const category = qrPass.catId;
    const catCodeUpper = (category?.catCode || "").toUpperCase();

    let sevaSlotName = "";
    if (holder?.sevaSlotId) {
      const SevaSlot = require("../models/SevaSlot");
      const slot = await SevaSlot.findById(holder.sevaSlotId).select("name time");
      if (slot) sevaSlotName = slot.time ? `${slot.name} · ${slot.time}` : slot.name;
    }

    let result;
    let qrStoreResult = null;
    if (["SP", "DN", "INV"].includes(catCodeUpper)) {
      const preacherPhone = await resolvePreacherPhone(holder?.preacherId);
      result = await thirdPartyService.pushSevaSponsor({
        holder, event, qrPass, catCode: catCodeUpper,
        categoryName: category?.name || "",
        subCategory: holder?.subCategory || "",
        preacherPhone,
        sevaSlotName,
        instruction: holder?.instruction || "",
      });
      // Retry the store-qr-code leg too (see createHolder — seva-sponsor
      // alone drops extra QRs for the same phone on their side).
      qrStoreResult = await thirdPartyService.pushStoreQrCode({ holder, event, qrPass });
    } else if (catCodeUpper === "VL") {
      result = await thirdPartyService.pushStoreQrCode({ holder, event, qrPass });
    } else {
      // pushHolder needs the QR image — regenerate it from the already-signed payload
      const QRCode = require("qrcode");
      const qrImage = await QRCode.toDataURL(qrPass.payloadSigned, {
        errorCorrectionLevel: "L", margin: 2, width: 350,
        color: { dark: "#000000", light: "#FFFFFF" },
      });
      result = await thirdPartyService.pushHolder({ holder, qrPass, qrImageBase64: qrImage, event });
    }

    // Top-level success reflects the PRIMARY push (seva-sponsor / store-qr-code
    // / register-volunteer as applicable) — not the secondary qrStoreSync leg,
    // which is a known separate limitation (requires the phone to already be
    // registered as a volunteer on their side) and shouldn't mask a genuine
    // sponsor-save success.
    const overallSuccess = result.success;
    const overallSkipped = result.skipped;
    qrPass.communityAppSync = {
      attempted: !!result.attempted,
      success: !!overallSuccess,
      skipped: !!overallSkipped,
      reason: result.reason || null,
      responseBody: result.responseBody || null,
      attemptedAt: new Date(),
    };
    if (qrStoreResult) {
      qrPass.communityAppSync.qrStoreSync = {
        attempted: !!qrStoreResult.attempted,
        success: !!qrStoreResult.success,
        skipped: !!qrStoreResult.skipped,
        reason: qrStoreResult.reason || null,
        responseBody: qrStoreResult.responseBody || null,
        attemptedAt: new Date(),
      };
    }
    await qrPass.save();

    return res.json({
      success: true,
      message: overallSuccess
        ? "Community app sync succeeded"
        : (overallSkipped ? "Sync skipped" : "Community app sync failed"),
      communityAppSync: qrPass.communityAppSync,
    });
  } catch (error) {
    console.error("retryCommunitySync error:", error);
    res.status(500).json({ error: "Retry failed", detail: error.message });
  }
};
