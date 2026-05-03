const QRCode = require("qrcode");
const jwt = require("jsonwebtoken");
const QRPass = require("../models/QRPass");
const EntryPoint = require("../models/EntryPoint");
const ScanLog = require("../models/ScanLog");
const whatsappService = require("./whatsappService");
const emailService = require("./emailService");

class QRService {
  constructor() {
    this.secretKey = process.env.QR_SECRET_KEY || "iskcon-secret-key-2024";
  }

  async generateQRId(eventCode, catCode) {
    const count = await QRPass.countDocuments({
      qrId: new RegExp(`^ISK-${eventCode}-${catCode}-`),
    });
    const serial = (count + 1).toString().padStart(5, "0");
    return `ISK-${eventCode}-${catCode}-${serial}`;
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

      if (now < payload.f || now > payload.u) {
        return {
          valid: false,
          reason: "invalid",
          message: "QR expired or not yet valid",
        };
      }

      const [qrPass, entryPoint] = await Promise.all([
        QRPass.findOne({ qrId: payload.q, status: "active" })
          .select("eventId entryPoints holderId redemptionHistory")
          .populate("holderId", "name")
          .lean(),
        EntryPoint.findById(epId)
          .select(
            "eventId linkedEpId maxCapacity currentCount multiEntryAllowed",
          )
          .lean(),
      ]);

      if (!qrPass) {
        return { valid: false, reason: "invalid", message: "Invalid QR" };
      }

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

      // ✅ FIX: Check already_used BEFORE any writes happen
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

  async redeemQR(
    qrId,
    epId,
    userId,
    stationLabel,
    deviceInfo = {},
    groupCount = 1,
    prefetchedPass = null,
  ) {
    const qrPass = prefetchedPass
      ? await QRPass.findOneAndUpdate(
          { qrId, status: "active" },
          {
            $push: {
              redemptionHistory: {
                epId,
                scannedAt: new Date(),
                scannedBy: userId,
                stationLabel,
                result: "granted",
                groupCount: groupCount, // ✅ Add group count
              },
            },
          },
          { new: true, select: "holderId holderName" },
        )
      : await QRPass.findOneAndUpdate(
          { qrId, status: "active" },
          {
            $push: {
              redemptionHistory: {
                epId,
                scannedAt: new Date(),
                scannedBy: userId,
                stationLabel,
                result: "granted",
                groupCount: groupCount, // ✅ Add group count
              },
            },
          },
          { new: true, select: "holderId holderName" },
        );

    if (!qrPass) throw new Error("QR pass not found");

    // ✅ Use groupCount for incrementing
    await Promise.all([
      ScanLog.create({
        qrId,
        epId,
        holderId: qrPass.holderId,
        scannedBy: userId,
        stationLabel,
        result: "granted",
        deviceInfo: {
          ...deviceInfo,
          groupCount: groupCount, // ✅ Store group count
        },
      }),
      EntryPoint.findByIdAndUpdate(epId, {
        $inc: { currentCount: groupCount }, // ✅ Increment by group count
      }),
    ]);

    return { success: true, holderName: qrPass.holderName || "", groupCount };
  }

  async deliverQR(qrPass, deliveryMethod) {
    /* unchanged */
  }
  async generateQRForPayment(opts) {
    /* unchanged */
  }
}

module.exports = new QRService();
