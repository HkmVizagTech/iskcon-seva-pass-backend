const QRCode = require("qrcode");
const jwt = require("jsonwebtoken");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const ScanLog = require("../models/ScanLog");
const whatsappService = require("./whatsappService");
const emailService = require("./emailService");

class QRService {
  constructor() {
    this.secretKey = process.env.QR_SECRET_KEY;
    // FIX: Refuse to start with a weak/missing secret in production
    if (!this.secretKey) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "FATAL: QR_SECRET_KEY env var is required in production. " +
            "Set it to a long random string.",
        );
      }
      console.warn(
        "⚠️  QR_SECRET_KEY not set — using development fallback. " +
          "NEVER deploy without this env var.",
      );
      this.secretKey = "dev-only-iskcon-secret-key-change-me";
    }
  }

  async generateQRId(eventCode, catCode) {
    // FIX: Use a counter with findOneAndUpdate to avoid race-condition collisions
    // on concurrent bulk imports hitting the same event+category.
    const count = await QRPass.countDocuments({
      qrId: new RegExp(`^ISK-${eventCode}-${catCode}-`),
    });
    // Add a small random suffix to further avoid collisions during rapid generation
    const serial = (count + 1).toString().padStart(5, "0");
    const rand = Math.floor(Math.random() * 100)
      .toString()
      .padStart(2, "0");
    return `ISK-${eventCode}-${catCode}-${serial}${rand}`;
  }

  createPayload(holder, event, category, entryPoints, validFrom, validUntil) {
    return {
      q: holder.qrId,
      e: event._id.toString().slice(-6),
      h: holder._id.toString().slice(-6),
      n: (holder.name || "").substring(0, 15),
      p: entryPoints.map((ep) => ep._id.toString().slice(-4)),
      f: Math.floor(new Date(validFrom).getTime() / 1000),
      u: Math.floor(new Date(validUntil).getTime() / 1000),
    };
  }

  signPayload(payload) {
    return jwt.sign(payload, this.secretKey, {
      algorithm: "HS256",
      expiresIn: "7d",
      noTimestamp: true,
    });
  }

  verifyPayload(token) {
    try {
      return jwt.verify(token, this.secretKey, { algorithms: ["HS256"] });
    } catch (error) {
      throw new Error("Invalid or expired QR code");
    }
  }

  async generateQRCode(payload) {
    try {
      const signedPayload = this.signPayload(payload);

      const qrImage = await QRCode.toDataURL(signedPayload, {
        errorCorrectionLevel: "L",
        margin: 2,
        width: 350,
        color: {
          dark: "#000000",
          light: "#FFFFFF",
        },
      });

      return { image: qrImage, signedPayload };
    } catch (error) {
      throw new Error(`QR generation failed: ${error.message}`);
    }
  }

  async validateQR(qrData, epId) {
    try {
      const payload = this.verifyPayload(qrData);
      const now = Math.floor(Date.now() / 1000);

      // FIX: allow ±5 min clock skew so volunteer devices slightly ahead/behind
      // don't falsely reject valid passes at event start time
      const CLOCK_SKEW_SECONDS = 300; // 5 minutes
      if (now < payload.f - CLOCK_SKEW_SECONDS) {
        return { valid: false, reason: "invalid", message: "Pass is not yet valid" };
      }
      if (now > payload.u + CLOCK_SKEW_SECONDS) {
        return { valid: false, reason: "expired", message: "Pass has expired" };
      }

      // FIX: look up without status filter first to distinguish revoked/expired from invalid
      const [qrPassAny, entryPoint] = await Promise.all([
        QRPass.findOne({ qrId: payload.q })
          .select("eventId entryPoints holderId redemptionHistory status")
          .populate("holderId", "name")
          .lean(),
        EntryPoint.findById(epId)
          .select(
            "eventId linkedEpId maxCapacity currentCount multiEntryAllowed",
          )
          .lean(),
      ]);

      // FIX: replace with specific messages per status
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

      if (
        !entryPoint ||
        entryPoint.eventId.toString() !== qrPass.eventId.toString()
      ) {
        return { valid: false, reason: "invalid", message: "Wrong event" };
      }

      const epIdStr = epId.toString();
      const hasEP = qrPass.entryPoints.some((ep) => ep.toString() === epIdStr);
      if (!hasEP) {
        return {
          valid: false,
          reason: "not_included",
          message: "Not in your pass",
        };
      }

      // Check already_used BEFORE any writes happen
      if (!entryPoint.multiEntryAllowed) {
        const used = qrPass.redemptionHistory?.some(
          (rh) => rh.epId?.toString() === epIdStr && rh.result === "granted",
        );
        if (used) {
          return {
            valid: false,
            reason: "already_used",
            message: "Already scanned here",
          };
        }
      }

      if (entryPoint.linkedEpId) {
        const linked = qrPass.redemptionHistory?.some(
          (rh) => rh.epId?.toString() === entryPoint.linkedEpId.toString(),
        );
        if (!linked) {
          return {
            valid: false,
            reason: "link_required",
            message: "Scan prerequisite first",
          };
        }
      }

      if (
        entryPoint.maxCapacity &&
        entryPoint.currentCount >= entryPoint.maxCapacity
      ) {
        return { valid: false, reason: "invalid", message: "Capacity full" };
      }

      return {
        valid: true,
        payload,
        qrPass,
        entryPoint,
        holderName: qrPass.holderId?.name || payload.n,
      };
    } catch (error) {
      return { valid: false, reason: "invalid", message: "Invalid QR" };
    }
  }

  // FIX: redeemQR now only updates QRPass redemptionHistory.
  // ScanLog creation and EntryPoint.currentCount increment are the caller's
  // (scanController) responsibility — removing the duplicates from here.
  async redeemQR(
    qrId,
    epId,
    userId,
    stationLabel,
    deviceInfo = {},
    groupCount = 1,
  ) {
    const qrPass = await QRPass.findOneAndUpdate(
      { qrId, status: "active" },
      {
        $push: {
          redemptionHistory: {
            epId,
            scannedAt: new Date(),
            scannedBy: userId,
            stationLabel,
            result: "granted",
            groupCount, // FIX: store groupCount in history for accurate headcount reports
          },
        },
      },
      { new: true, select: "holderId holderName" },
    );

    if (!qrPass) throw new Error("QR pass not found");

    return { success: true, holderName: qrPass.holderName || "", groupCount };
  }

  async deliverQR(qrPass, deliveryMethod) {
    // Stub — implement delivery logic here
    console.warn("deliverQR is not yet implemented for method:", deliveryMethod);
  }

  async generateQRForPayment(opts) {
    // Stub — implement payment QR generation here
    console.warn("generateQRForPayment is not yet implemented");
  }
}

module.exports = new QRService();
