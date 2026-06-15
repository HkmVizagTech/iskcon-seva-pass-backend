const QRCode = require("qrcode");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const Event = require("../models/Event");
const ScanLog = require("../models/ScanLog");

class QRService {
  constructor() {
    this.secretKey = process.env.QR_SECRET_KEY;
    if (!this.secretKey) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "FATAL: QR_SECRET_KEY env var is required in production.",
        );
      }
      console.warn(
        "⚠️  QR_SECRET_KEY not set — using development fallback. NEVER deploy without this.",
      );
      this.secretKey = "dev-only-iskcon-secret-key-change-me";
    }
  }

  async generateQRId(eventCode, catCode) {
    const count = await QRPass.countDocuments({
      qrId: new RegExp(`^ISK-${eventCode}-${catCode}-`),
    });
    const serial = (count + 1).toString().padStart(5, "0");
    const rand = Math.floor(Math.random() * 100)
      .toString()
      .padStart(2, "0");
    return `ISK-${eventCode}-${catCode}-${serial}${rand}`;
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

  async validateQR(qrData, epId) {
    try {
      // Step 1: verify JWT signature — proves it was legitimately issued.
      // FALLBACK: some delivery surfaces (third-party app, re-rendered QRs)
      // encode just the qrId (e.g. ISK-ACT26-GN-0000137) instead of the JWT.
      // Accept that too — the pass record is then looked up by qrId and ALL
      // the same checks (status, live event dates, station membership,
      // already-used, capacity, dedup) still apply.
      let payload;
      try {
        payload = this.verifyPayload(qrData);
      } catch (jwtErr) {
        const candidate = String(qrData || "").trim().toUpperCase();
        if (/^ISK-[A-Z0-9]+-[A-Z0-9]+-\d+$/.test(candidate)) {
          payload = { q: candidate }; // qrId-only QR
        } else {
          return { valid: false, reason: "invalid", message: "Invalid QR code" };
        }
      }

      // Step 2: fetch QR pass + entry point in parallel
      const [qrPassAny, entryPoint] = await Promise.all([
        QRPass.findOne({ qrId: payload.q })
          .select("eventId entryPoints holderId redemptionHistory status")
          .populate({ path: "holderId", select: "name subCategory sevaSlotId catId", populate: [{ path: "catId", select: "name" }, { path: "sevaSlotId", select: "code name time displayLabel" }] })
          .lean(),
        EntryPoint.findById(epId)
          .select("eventId linkedEpId maxCapacity currentCount multiEntryAllowed stationLabel")
          .lean(),
      ]);

      if (!qrPassAny) {
        return { valid: false, reason: "invalid", message: "Invalid QR code" };
      }
      if (qrPassAny.status === "revoked") {
        return { valid: false, reason: "revoked", message: "Pass has been revoked" };
      }
      if (qrPassAny.status === "expired") {
        return { valid: false, reason: "expired", message: "Pass has expired" };
      }
      if (qrPassAny.status !== "active") {
        return { valid: false, reason: "invalid", message: "Pass is not active" };
      }
      const qrPass = qrPassAny;

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
        };
      }
      }

      // Step 3: validate date window from the LIVE Event record — not from JWT payload
      // This means updating event dates works immediately for all existing QR passes
      // without needing to re-sign or regenerate them.
      const event = await Event.findById(qrPass.eventId)
        .select("dateStart dateEnd scanStart scanEnd name").lean();
      if (!event) {
        return { valid: false, reason: "invalid", message: "Event not found" };
      }

      const now = new Date();
      const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes tolerance

      // Use scanStart/scanEnd if set — these are the GATE timings.
      // Falls back to dateStart/dateEnd (ceremony timings) if scan window not configured.
      const gateStart = event.scanStart || event.dateStart;
      const gateEnd   = event.scanEnd   || event.dateEnd;

      const hasValidStart = gateStart && !isNaN(new Date(gateStart).getTime());
      const hasValidEnd   = gateEnd   && !isNaN(new Date(gateEnd).getTime());

      if (hasValidStart && hasValidEnd) {
        const startMs = new Date(gateStart).getTime();
        const endMs   = new Date(gateEnd).getTime();

        if (now.getTime() < startMs - CLOCK_SKEW_MS) {
          const openTime = new Date(gateStart).toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
          });
          return {
            valid: false,
            reason: "not_yet_valid",
            message: `Gate not open yet — scanning starts at ${openTime}`,
          };
        }
        if (now.getTime() > endMs + CLOCK_SKEW_MS) {
          return {
            valid: false,
            reason: "expired",
            message: `Old QR expired — ${event.name || "event"} has ended`,
          };
        }
      }
      // If no scan/event dates configured, QR is valid (skip check)

      // Step 4: check entry point access
      const epIdStr = epId.toString();
      const hasEP = qrPass.entryPoints.some((ep) => ep.toString() === epIdStr);
      if (!hasEP) {
        return { valid: false, reason: "not_included", message: "Not in your pass" };
      }

      // Step 5: check already used
      if (!entryPoint.multiEntryAllowed) {
        const used = qrPass.redemptionHistory?.some(
          (rh) => rh.epId?.toString() === epIdStr && rh.result === "granted",
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
            categoryName: qrPass.holderId?.catId?.name || null,
          };
        }
      }

      // Step 6: check linked prerequisite
      if (entryPoint.linkedEpId) {
        const linked = qrPass.redemptionHistory?.some(
          (rh) => rh.epId?.toString() === entryPoint.linkedEpId.toString(),
        );
        if (!linked) {
          return { valid: false, reason: "link_required", message: "Scan prerequisite first" };
        }
      }

      // Step 7: capacity check
      if (entryPoint.maxCapacity && entryPoint.currentCount >= entryPoint.maxCapacity) {
        return { valid: false, reason: "capacity_full", message: "Capacity full" };
      }

      return {
        valid: true,
        payload,
        qrPass,
        entryPoint,
        event,
        holderName: qrPass.holderId?.name || payload.n,
        subCategory: qrPass.holderId?.subCategory || null,
        sevaSlot: qrPass.holderId?.sevaSlotId ? {
          code: qrPass.holderId.sevaSlotId.code,
          name: qrPass.holderId.sevaSlotId.name,
          time: qrPass.holderId.sevaSlotId.time,
          displayLabel: qrPass.holderId.sevaSlotId.displayLabel,
        } : null,
        categoryName: qrPass.holderId?.catId?.name || null,
      };
    } catch (error) {
      return { valid: false, reason: "invalid", message: "Invalid QR code" };
    }
  }

  // redeemQR — only updates QRPass redemptionHistory.
  // ScanLog creation and EntryPoint.currentCount increment are the caller's responsibility.
  async redeemQR(qrId, epId, userId, stationLabel, deviceInfo = {}, groupCount = 1, opts = {}) {
    // ATOMIC: for one-time stations the filter itself rejects a second redemption,
    // so two simultaneous scans (even on different server instances) can never
    // both be granted — the loser gets { redeemed:false } → already_used.
    const filter = { qrId, status: "active" };
    if (!opts.multiEntryAllowed) {
      filter.redemptionHistory = {
        $not: { $elemMatch: { epId: new mongoose.Types.ObjectId(String(epId)), result: "granted" } },
      };
    }
    const qrPass = await QRPass.findOneAndUpdate(
      filter,
      {
        $push: {
          redemptionHistory: {
            epId, scannedAt: new Date(), scannedBy: userId,
            stationLabel, result: "granted", groupCount,
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
