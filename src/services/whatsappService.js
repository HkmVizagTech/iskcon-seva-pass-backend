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

    // Date only — no event time (ceremony time is in the seva slot line)
    let dateStr = "Event Date";
    if (passDetails.validFrom) {
      try {
        const d = new Date(passDetails.validFrom);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "numeric",
            month: "short",
            year: "numeric",
          });
        }
      } catch (e) {
        console.log("Date parse error:", e.message);
      }
    }

    // Seva slot line — shows for sponsors, "-" for all others
    // For sponsors: "A — Pratistha Abhisheka · 7:00 AM"
    // For others:   "-"
    const sevaSlot = passDetails.sevaSlot
      ? passDetails.sevaSlot.displayLabel
        || (passDetails.sevaSlot.name
            + (passDetails.sevaSlot.time ? ` · ${passDetails.sevaSlot.time}` : ""))
        || "-"
      : "-";

    console.log("📤 WhatsApp Send:");
    console.log("  Phone:", phone);
    console.log("  Holder:", holderName);
    console.log("  Event:", eventName);
    console.log("  Venue:", venue);
    console.log("  Date:", dateStr);
    console.log("  Seva Slot:", sevaSlot);
    console.log("  Entries:", entries);

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
            { type: "text", text: holderName },                               // {{1}} Name
            { type: "text", text: eventName },                               // {{2}} Event
            { type: "text", text: dateStr },                                 // {{3}} Date
            { type: "text", text: venue },                                   // {{4}} Venue
            { type: "text", text: sevaSlot },                                // {{5}} Seva Slot (or "-")
            { type: "text", text: entries },                                 // {{6}} Access points
            { type: "text", text: process.env.HELP_CONTACT || "8977761187" }, // {{7}} Help
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

    console.log("✅ Flaxxa response:", JSON.stringify({
      status,
      message_id: msgId,
      phone,
      holderName,
      error: response.data?.error || response.data?.message || null,
      raw: JSON.stringify(response.data).slice(0, 300),
    }));

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
