const crypto = require("crypto");
const QRCode = require("qrcode");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const Event = require("../models/Event");
const ScanLog = require("../models/ScanLog");
const { PRASADAM_COUPON } = require("../utils/entryPointTypes");

const QR_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // 32 symbols, 5 bits each
const QR_ID_SUFFIX_LEN = 12; // 60 bits of entropy
const QR_ID_MAX_ATTEMPTS = 5;
// ISK-<event>-<type>-<12 base32 chars>; the entropy suffix is what makes it unguessable.
const OPAQUE_QR_ID = /^ISK-[A-Za-z0-9_.-]{1,40}-[A-Z2-7]{12}$/;

class QRService {
  constructor() {
    this.secretKey = process.env.QR_SECRET_KEY;
    if (!this.secretKey) {
      if (!["development", "test"].includes(process.env.NODE_ENV)) {
        throw new Error(
          "FATAL: QR_SECRET_KEY env var is required (the dev fallback only works when NODE_ENV is 'development' or 'test').",
        );
      }
      console.warn(
        "⚠️  QR_SECRET_KEY not set — using development fallback. NEVER deploy without this.",
      );
      this.secretKey = "dev-only-iskcon-secret-key-change-me";
    }
  }

  // Unguessable id: readable prefix + CSPRNG suffix.
  async generateQRId(eventCode, catCode) {
    const bytes = crypto.randomBytes(QR_ID_SUFFIX_LEN);
    let suffix = "";
    for (let i = 0; i < QR_ID_SUFFIX_LEN; i++) {
      suffix += QR_ID_ALPHABET[bytes[i] & 31];
    }
    return `ISK-${eventCode}-${catCode}-${suffix}`;
  }

  // Generates the id, signs the payload and inserts the QRPass, retrying with a
  // fresh id if the unique index on qrId ever reports a duplicate.
  async createQRPassWithUniqueId({ event, category, holder, entryPoints, passFields = {} }) {
    for (let attempt = 0; attempt < QR_ID_MAX_ATTEMPTS; attempt++) {
      const qrId = await this.generateQRId(event.eventCode, category.catCode);
      const payload = this.createPayload(
        { ...holder.toObject(), qrId },
        event,
        category,
        entryPoints,
      );
      const { image, signedPayload } = await this.generateQRCode(payload);
      try {
        const qrPass = await QRPass.create({
          qrId,
          holderId: holder._id,
          eventId: event._id,
          catId: category._id,
          entryPoints: entryPoints.map((ep) => ep._id),
          payloadSigned: signedPayload,
          ...passFields,
        });
        return { qrId, qrPass, qrImage: image, signedPayload };
      } catch (err) {
        const dupQrId =
          err && err.code === 11000 && (err.keyPattern?.qrId || /qrId/.test(err.message || ""));
        if (!dupQrId) throw err;
      }
    }
    throw new Error("Could not allocate a unique QR id");
  }

  // ─── Public QR image URLs ──────────────────────────────────────────────────
  // GET /api/qr/:qrId/image only serves requests carrying ?t=HMAC(qrId), so it
  // cannot be used to enumerate ids. Every place that builds an image URL must
  // go through signedImageUrl.
  imageToken(qrId) {
    return crypto.createHmac("sha256", this.secretKey).update(String(qrId)).digest("hex");
  }

  verifyImageToken(qrId, token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return false;
    const expected = Buffer.from(this.imageToken(qrId), "hex");
    const given = Buffer.from(token, "hex");
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  signedImageUrl(qrId, baseUrl) {
    const base = String(baseUrl || process.env.BACKEND_PUBLIC_URL || "").replace(/\/$/, "");
    return `${base}/api/qr/${encodeURIComponent(qrId)}/image?t=${this.imageToken(qrId)}`;
  }

  // Resolves the shared-redemption group for an entry point (null when the EP is
  // standalone). Two ways an EP can be part of ONE combined entrance (scanned
  // only once across the whole group, e.g. Bahumana desks one per venue):
  //   1. EXPLICIT — EPs share the same redemptionGroupId (any type).
  //   2. AUTOMATIC — every `bahumana`-type EP of the event is combined.
  // The returned list ALWAYS includes the current EP.
  async resolveRedemptionGroup(entryPoint, epId, eventId) {
    const explicitGroup = entryPoint && entryPoint.redemptionGroupId;
    const isBahumanaAuto = entryPoint && entryPoint.type === "bahumana";
    if (!explicitGroup && !isBahumanaAuto) return null;
    const match = explicitGroup
      ? { eventId, redemptionGroupId: entryPoint.redemptionGroupId }
      : { eventId, type: "bahumana" };
    const groupEps = await EntryPoint.find(match).select("_id").lean();
    return [
      ...new Set(groupEps.map((e) => e._id.toString()).concat(String(epId))),
    ];
  }

  // ─── Payload only carries identity + entry point list ──────────────────────
  // Dates are NOT embedded in the JWT.
  // Validity is always checked against the live Event record in the DB.
  // This means:
  //   - Changing event dates immediately affects all existing QR passes
  //   - No need to re-sign or regenerate QRs when dates change
  //   - The JWT proves "this pass was legitimately issued", not "it's valid now"
  createPayload(holder, event, category, entryPoints) {
    return {
      q: holder.qrId,                                      // QR ID
      e: event._id.toString().slice(-6),                   // event shortcode
      h: holder._id.toString().slice(-6),                  // holder shortcode
      n: (holder.name || "").substring(0, 15),             // holder name (display only)
      p: entryPoints.map((ep) => ep._id.toString().slice(-4)), // entry point shortcodes
    };
  }

  signPayload(payload) {
    return jwt.sign(payload, this.secretKey, {
      algorithm: "HS256",
      // FIX: no expiresIn — JWT never expires by itself.
      // Validity window is controlled entirely by Event.dateStart / Event.dateEnd
      // in the DB, so changing event dates works without re-signing QRs.
      noTimestamp: true,
    });
  }

  verifyPayload(token) {
    try {
      // ignoreExpiration: true because we removed expiresIn above.
      // We also set it for backwards compatibility with old QRs that still
      // carry the 7d exp field — those would otherwise fail jwt.verify()
      // even when the event is still running.
      return jwt.verify(token, this.secretKey, {
        algorithms: ["HS256"],
        ignoreExpiration: true,
      });
    } catch (error) {
      throw new Error("Invalid QR code signature");
    }
  }

  async generateQRCode(payload) {
    try {
      const signedPayload = this.signPayload(payload);
      const qrImage = await QRCode.toDataURL(signedPayload, {
        errorCorrectionLevel: "L",
        margin: 2,
        width: 350,
        color: { dark: "#000000", light: "#FFFFFF" },
      });
      return { image: qrImage, signedPayload };
    } catch (error) {
      throw new Error(`QR generation failed: ${error.message}`);
    }
  }

  // `at`: when the scan physically happened (offline replays); defaults to now.
  // Callers clamp it to <= now, so a replay can never be validated in the future.
  async validateQR(qrData, epId, venue = null, at = null) {
    try {
      // Step 1: either a JWT signed with QR_SECRET_KEY (HS256), or an opaque
      // pass id. Opaque ids carry 60 bits of CSPRNG entropy (see generateQRId),
      // so a bare id is an unguessable bearer reference the DB lookup below must
      // resolve — client apps (e.g. the community app) draw the QR from it.
      // The old sequential ids (guessable) never match OPAQUE_QR_ID.
      let payload;
      try {
        payload = this.verifyPayload(qrData);
      } catch (jwtErr) {
        if (typeof qrData === "string" && OPAQUE_QR_ID.test(qrData)) {
          payload = { q: qrData };
        } else {
          return { valid: false, reason: "invalid", message: "Invalid QR code" };
        }
      }
      if (!payload || typeof payload.q !== "string" || !payload.q) {
        return { valid: false, reason: "invalid", message: "Invalid QR code" };
      }

      // Step 2: fetch QR pass + entry point in parallel
      const [qrPassAny, entryPoint] = await Promise.all([
        QRPass.findOne({ qrId: payload.q })
          .select("eventId entryPoints holderId catId redemptionHistory status allowedVenues windowed validFrom validUntil")
          .populate({ path: "holderId", select: "name subCategory sevaSlotId catId", populate: [{ path: "catId", select: "name catCode" }, { path: "sevaSlotId", select: "code name time displayLabel" }] })
          .populate({ path: "catId", select: "name catCode" })
          .lean(),
        EntryPoint.findById(epId)
          .select("eventId linkedEpId maxCapacity currentCount multiEntryAllowed allowGroupCount stationLabel type redemptionGroupId")
          .lean(),
      ]);

      if (!qrPassAny) {
        return { valid: false, reason: "invalid", message: "Invalid QR code" };
      }

      // ── Pass-type classification ────────────────────────────────────────
      // Resolve WHICH pass this is (prasadam coupon vs any seva pass) purely
      // from the DB by qrId, so it works for every already-issued QR with no
      // re-encoding. qrPass.catId is the pass's own type; holder.catId is the
      // fallback for older records that never set QRPass.catId. Surfaced to the
      // scanner so a volunteer instantly knows the coupon lane from the seva
      // pass lane at the prasadam counter.
      const typeDoc =
        (qrPassAny.catId && qrPassAny.catId.catCode)
          ? qrPassAny.catId
          : (qrPassAny.holderId?.catId || null);
      const categoryCode =
        (typeDoc?.catCode ? String(typeDoc.catCode).toUpperCase() : "") || null;
      const isPrasadamCoupon = categoryCode === "PR";
      const passType = isPrasadamCoupon ? "prasadam_coupon" : "seva_pass";
      const typeInfo = { categoryCode, passType, isPrasadamCoupon };
      // categoryName mirrors the SAME type doc used for classification, so the
      // label and the code can never disagree.
      const categoryName = typeDoc?.name || qrPassAny.holderId?.catId?.name || null;

      if (qrPassAny.status === "revoked") {
        return { valid: false, reason: "revoked", message: "Pass has been revoked", ...typeInfo };
      }
      if (qrPassAny.status === "expired") {
        return { valid: false, reason: "expired", message: "Pass has expired", ...typeInfo };
      }
      if (qrPassAny.status !== "active") {
        return { valid: false, reason: "invalid", message: "Pass is not active", ...typeInfo };
      }
      const qrPass = qrPassAny;

      // Venue restriction: if the pass was issued for specific venues only,
      // the scan must happen at one of them. Passes with no allowedVenues
      // (all legacy passes) are valid at every venue of the event.
      const allowedVenues = (qrPass.allowedVenues || []).filter((v) => v && String(v).trim());
      if (allowedVenues.length > 0 && venue && !allowedVenues.includes(String(venue).trim())) {
        return {
          valid: false,
          reason: "not_included",
          message: `Pass for ${allowedVenues.join(" / ")} — send to that venue`,
          holderName: qrPass.holderId?.name,
          allowedVenues,
          categoryName,
          ...typeInfo,
        };
      }

      // Shared-redemption group for this entry point (see resolveRedemptionGroup).
      const epIdStr = epId.toString();
      const redemptionGroupEpIds = await this.resolveRedemptionGroup(
        entryPoint,
        epIdStr,
        qrPass.eventId,
      );

      if (!entryPoint || entryPoint.eventId.toString() !== qrPass.eventId.toString()) {
        {
        // Old/foreign QR: tell the volunteer exactly what this pass is
        const Event2 = require("../models/Event");
        const passEvent = await Event2.findById(qrPass.eventId).select("name dateEnd").lean();
        const ended = passEvent?.dateEnd && new Date(passEvent.dateEnd).getTime() < Date.now();
        return {
          valid: false,
          reason: ended ? "expired" : "invalid",
          message: ended
            ? `Old QR — ${passEvent?.name || "previous event"} has ended`
            : `This pass is for a different event${passEvent?.name ? ` (${passEvent.name})` : ""}`,
          holderName: qrPass.holderId?.name,
          categoryName,
          ...typeInfo,
        };
      }
      }

      // Step 3: validate date window from the LIVE Event record — not from JWT payload
      // This means updating event dates works immediately for all existing QR passes
      // without needing to re-sign or regenerate them.
      const event = await Event.findById(qrPass.eventId)
        .select("dateStart dateEnd scanStart scanEnd name").lean();
      if (!event) {
        return {
          valid: false,
          reason: "invalid",
          message: "Event not found",
          categoryName,
          ...typeInfo,
        };
      }

      const now = at instanceof Date && !isNaN(at.getTime()) && at.getTime() <= Date.now() ? at : new Date();
      const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes tolerance

      // Use scanStart/scanEnd if set — these are the GATE timings.
      // Falls back to dateStart/dateEnd (ceremony timings) if scan window not configured.
      // A windowed pass (session coupon) carries its own validity window, which
      // replaces the event's gate window.
      const gateStart = qrPass.windowed ? qrPass.validFrom : (event.scanStart || event.dateStart);
      const gateEnd   = qrPass.windowed ? qrPass.validUntil : (event.scanEnd   || event.dateEnd);
      const windowLabel = qrPass.windowed ? "Coupon" : (event.name || "event");

      const hasValidStart = gateStart && !isNaN(new Date(gateStart).getTime());
      const hasValidEnd   = gateEnd   && !isNaN(new Date(gateEnd).getTime());

      if (hasValidStart && hasValidEnd) {
        const startMs = new Date(gateStart).getTime();
        const endMs   = new Date(gateEnd).getTime();

        if (now.getTime() < startMs - CLOCK_SKEW_MS) {
          const openTime = new Date(gateStart).toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
          });
          const openDay = new Date(gateStart).toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata", day: "numeric", month: "short",
          });
          return {
            valid: false,
            reason: "not_yet_valid",
            message: qrPass.windowed
              ? `Coupon not valid yet — starts ${openDay}, ${openTime}`
              : `Gate not open yet — scanning starts at ${openTime}`,
            holderName: qrPass.holderId?.name,
            categoryName,
            ...typeInfo,
          };
        }
        if (now.getTime() > endMs + CLOCK_SKEW_MS) {
          return {
            valid: false,
            reason: "expired",
            message: qrPass.windowed
              ? `${windowLabel} expired — it was valid until ${new Date(gateEnd).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })}`
              : `Old QR expired — ${windowLabel} has ended`,
            holderName: qrPass.holderId?.name,
            categoryName,
            ...typeInfo,
          };
        }
      }
      // If no scan/event dates configured, QR is valid (skip check)

      // Step 4: check entry point access
      const hasEP = qrPass.entryPoints.some((ep) => ep.toString() === epIdStr);
      if (!hasEP) {
        // A pass scanned at the WRONG prasadam lane should tell the volunteer
        // which counter to use, not just say "not in your pass". A coupon and a
        // seva pass each live on their own lane entry point, so being here with
        // the scanned counter being one of the two prasadam lanes is a
        // lane-mismatch we can diagnose precisely.
        const scannedType = String(entryPoint?.type || "");
        let message = "Not in your pass";
        if (isPrasadamCoupon && scannedType === "prasadam") {
          message = "This is a Prasadam coupon — use the Prasadam Coupon counter";
        } else if (!isPrasadamCoupon && scannedType === PRASADAM_COUPON) {
          message = `This is a ${categoryName || "Seva"} pass — use the Prasadam counter, not the Coupon counter`;
        }
        return {
          valid: false, reason: "not_included", message,
          holderName: qrPass.holderId?.name,
          subCategory: qrPass.holderId?.subCategory || null,
          sevaSlot: qrPass.holderId?.sevaSlotId ? {
            code: qrPass.holderId.sevaSlotId.code,
            name: qrPass.holderId.sevaSlotId.name,
            time: qrPass.holderId.sevaSlotId.time,
            displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
          } : null,
          categoryName,
          ...typeInfo,
        };
      }

      // Step 5: check already used
      if (!entryPoint.multiEntryAllowed) {
        // A redemption group means the whole group is scanned only ONCE no
        // matter the venue (e.g. Bahumana desks one per venue are combined).
        if (redemptionGroupEpIds) {
          const used = qrPass.redemptionHistory?.some(
            (rh) => redemptionGroupEpIds.includes(rh.epId?.toString()) && rh.result === "granted",
          );
          if (used) {
            return {
              valid: false, reason: "already_used", message: "Already scanned here",
              holderName: qrPass.holderId?.name,
              subCategory: qrPass.holderId?.subCategory || null,
              sevaSlot: qrPass.holderId?.sevaSlotId ? {
                code: qrPass.holderId.sevaSlotId.code,
                name: qrPass.holderId.sevaSlotId.name,
                time: qrPass.holderId.sevaSlotId.time,
                displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
              } : null,
              categoryName,
              ...typeInfo,
              qrPass,  // include so scanController can log holderId
            };
          }
        } else {
          // Per-venue entrance (standalone EP, e.g. Jhulan/Prasadam that is
          // shared across venues). The pass can be used ONCE AT EACH VENUE, so
          // block only when the same EP was already granted at this venue.
          // Passes scanned before venues were recorded have rh.venue === null
          // and are treated as legacy (block if they were used at this EP).
          const used = qrPass.redemptionHistory?.some((rh) => {
            if (rh.epId?.toString() !== epIdStr || rh.result !== "granted") return false;
            if (venue) {
              // Venue-aware: only block if a grant exists at the SAME venue.
              return rh.venue ? rh.venue === venue : false;
            }
            // No venue provided by the scanner → conservative: block.
            return true;
          });
          if (used) {
            return {
              valid: false, reason: "already_used", message: "Already scanned here",
              holderName: qrPass.holderId?.name,
              subCategory: qrPass.holderId?.subCategory || null,
              sevaSlot: qrPass.holderId?.sevaSlotId ? {
                code: qrPass.holderId.sevaSlotId.code,
                name: qrPass.holderId.sevaSlotId.name,
                time: qrPass.holderId.sevaSlotId.time,
                displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
              } : null,
              categoryName,
              ...typeInfo,
              qrPass,  // include so scanController can log holderId
            };
          }
        }
      }

      // Step 6: check linked prerequisite
      if (entryPoint.linkedEpId) {
        const linked = qrPass.redemptionHistory?.some(
          (rh) => rh.epId?.toString() === entryPoint.linkedEpId.toString(),
        );
        if (!linked) {
          return {
            valid: false, reason: "link_required", message: "Scan prerequisite first",
            holderName: qrPass.holderId?.name,
            subCategory: qrPass.holderId?.subCategory || null,
            sevaSlot: qrPass.holderId?.sevaSlotId ? {
              code: qrPass.holderId.sevaSlotId.code,
              name: qrPass.holderId.sevaSlotId.name,
              time: qrPass.holderId.sevaSlotId.time,
              displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
            } : null,
            categoryName,
            ...typeInfo,
          };
        }
      }

      // Step 7: capacity check
      if (entryPoint.maxCapacity && entryPoint.currentCount >= entryPoint.maxCapacity) {
        return {
          valid: false, reason: "capacity_full", message: "Capacity full",
          holderName: qrPass.holderId?.name,
          subCategory: qrPass.holderId?.subCategory || null,
          sevaSlot: qrPass.holderId?.sevaSlotId ? {
            code: qrPass.holderId.sevaSlotId.code,
            name: qrPass.holderId.sevaSlotId.name,
            time: qrPass.holderId.sevaSlotId.time,
            displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
          } : null,
          categoryName,
          ...typeInfo,
        };
      }

      return {
        valid: true,
        payload,
        qrPass,
        entryPoint,
        event,
        redemptionGroupEpIds,
        holderName: qrPass.holderId?.name || payload.n,
        subCategory: qrPass.holderId?.subCategory || null,
        sevaSlot: qrPass.holderId?.sevaSlotId ? {
          code: qrPass.holderId.sevaSlotId.code,
          name: qrPass.holderId.sevaSlotId.name,
          time: qrPass.holderId.sevaSlotId.time,
          displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
        } : null,
        categoryName,
        ...typeInfo,
      };
    } catch (error) {
      return { valid: false, reason: "invalid", message: "Invalid QR code" };
    }
  }

  // redeemQR — only updates QRPass redemptionHistory.
  // ScanLog creation and EntryPoint.currentCount increment are the caller's responsibility.
  async redeemQR(qrId, epId, userId, stationLabel, venue = null, deviceInfo = {}, groupCount = 1, opts = {}) {
    // ATOMIC: for one-time stations the filter itself rejects a second redemption,
    // so two simultaneous scans (even on different server instances) can never
    // both be granted — the loser gets { redeemed:false } → already_used.
    const filter = { qrId, status: "active" };
    if (!opts.multiEntryAllowed) {
      if (opts.redemptionGroupEpIds) {
        // Combined group (e.g. Bahumana desks across venues): the pass can be
        // redeemed only ONCE across the whole group regardless of venue.
        const groupEpIds = opts.redemptionGroupEpIds.map((id) => new mongoose.Types.ObjectId(String(id)));
        filter.redemptionHistory = {
          $not: { $elemMatch: { epId: { $in: groupEpIds }, result: "granted" } },
        };
      } else {
        // Per-venue entrance (shared EP, e.g. Jhulan/Prasadam): allow once per
        // venue. When a venue is provided, block only if this exact EP was
        // already granted at the SAME venue (legacy grants with no venue don't
        // block). Without a venue, block if used here at all (conservative).
        const used = { epId: new mongoose.Types.ObjectId(String(epId)), result: "granted" };
        if (venue) used.venue = venue;
        filter.redemptionHistory = { $not: { $elemMatch: used } };
      }
    }
    const qrPass = await QRPass.findOneAndUpdate(
      filter,
      {
        $push: {
          redemptionHistory: {
            epId, scannedAt: new Date(), scannedBy: userId,
            stationLabel, venue: venue || undefined, result: "granted", groupCount,
            source: opts.source || "scanner",
          },
        },
      },
      { returnDocument: "after", select: "_id" },
    );
    return { redeemed: !!qrPass };
  }

  async deliverQR(qrPass, deliveryMethod) {
    console.warn("deliverQR not yet implemented for method:", deliveryMethod);
  }

  async generateQRForPayment(opts) {
    console.warn("generateQRForPayment not yet implemented");
  }
}

module.exports = new QRService();
