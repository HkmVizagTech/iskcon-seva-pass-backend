const axios = require("axios");
const FormData = require("form-data");

class WhatsAppService {
  constructor() {
    this.baseUrl =
      process.env.WHATSAPP_API_URL || "https://wapi.flaxxa.com/api/v1";
    this.token = process.env.WHATSAPP_API_KEY;
  }

  async sendQRMessage(to, qrImageBase64, holderName, eventName, passDetails) {
    if (!this.token) throw new Error("WHATSAPP_API_KEY is required");

    const phone = this.formatPhone(to);
    const entries = this.formatEntryPoints(passDetails.entryPoints || []);
    const venue = passDetails.venue || "ISKCON Temple, Visakhapatnam";

    // {{8}} Seva slot — for sponsors show "Code — Name · Time", else "-"
    const sevaSlot = passDetails.sevaSlot
      ? passDetails.sevaSlot.displayLabel || passDetails.sevaSlot.name || "-"
      : "-";

    let dateStr = "Event Date";
    let timeStr = "Event Time";

    if (passDetails.validFrom) {
      try {
        const d = new Date(passDetails.validFrom);
        if (!isNaN(d.getTime())) {
          // FIX: always format in IST regardless of server timezone (Cloud Run = UTC).
          // Without timeZone: "Asia/Kolkata", a date stored as 02:30Z (= 8:00 IST)
          // displayed as "2:30 am" on WhatsApp instead of "8:00 am".
          const istOpts = { timeZone: "Asia/Kolkata" };
          dateStr = d.toLocaleDateString("en-IN", {
            ...istOpts,
            day: "numeric",
            month: "short",
            year: "numeric",
          });
          timeStr = d.toLocaleTimeString("en-IN", {
            ...istOpts,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
        }
      } catch (e) {
        console.log("Date parse error:", e.message);
      }
    }

    console.log("📤 WhatsApp Send:");
    console.log("  Phone:", phone);
    console.log("  Holder:", holderName);
    console.log("  Event:", eventName);
    console.log("  Venue:", venue);
    console.log("  Date:", dateStr);
    console.log("  Time:", timeStr);
    console.log("  Entries:", entries);
    console.log("  Seva Slot:", sevaSlot);

    const base64Data = qrImageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");

    const form = new FormData();
    form.append("token", this.token);
    form.append("phone", phone);
    form.append("template_name", "common_qr_template");
    form.append("template_language", "en");
    form.append(
      "components",
      JSON.stringify([
        {
          type: "body",
          parameters: [
            { type: "text", text: holderName },                              // {{1}} Name
            { type: "text", text: eventName },                              // {{2}} Event
            { type: "text", text: dateStr },                                // {{3}} Date
            { type: "text", text: timeStr },                                // {{4}} Time
            { type: "text", text: venue },                                  // {{5}} Venue
            { type: "text", text: process.env.HELP_CONTACT || "8977761187" }, // {{6}} Help
            { type: "text", text: entries },                                // {{7}} Access
            { type: "text", text: sevaSlot },                               // {{8}} Seva Slot
          ],
        },
      ]),
    );

    form.append("header_attachment", imageBuffer, {
      filename: "QR-Pass.png",
      contentType: "image/png",
    });

    const response = await axios.post(
      `${this.baseUrl}/sendtemplatemessage_withattachment`,
      form,
      { headers: form.getHeaders(), timeout: 30000 },
    );

    const status = response.data?.status;
    const msgId = response.data?.message_id || response.data?.id;

    // Log full response so we can diagnose delivery issues
    console.log("✅ Flaxxa response:", JSON.stringify({
      status,
      message_id: msgId,
      phone,
      holderName,
      // any error detail Flaxxa includes even on "success" responses
      error: response.data?.error || response.data?.message || null,
      raw: JSON.stringify(response.data).slice(0, 300),
    }));

    // Flaxxa returns status:"success" even when the message is queued but
    // not yet confirmed by Meta. Log it explicitly so we can track.
    if (status !== "success" && status !== "sent") {
      console.warn("⚠️ Flaxxa non-success status:", status, JSON.stringify(response.data).slice(0, 300));
    }

    return {
      success: true,
      messageId: msgId,
      phone: phone,
      flaxxaStatus: status,
    };
  }

  formatPhone(phone) {
    if (!phone) return "";
    let cleaned = phone.replace(/[\+\s\-\(\)]/g, "");
    if (cleaned.length === 10) cleaned = "91" + cleaned;
    return cleaned.startsWith("91") ? cleaned : `91${cleaned}`;
  }

  formatEntryPoints(entryPoints) {
    if (!entryPoints || entryPoints.length === 0) return "N/A";
    return entryPoints
      .map((ep) =>
        typeof ep === "string" ? ep : ep.name || ep.stationLabel || "",
      )
      .filter(Boolean)
      .join(", ");
  }

  isValidPhone(phone) {
    if (!phone) return false;
    return /^\d{10,15}$/.test(phone.replace(/[\+\s\-\(\)]/g, ""));
  }
}

module.exports = new WhatsAppService();
