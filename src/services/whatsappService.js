const axios = require("axios");
const FormData = require("form-data");

class WhatsAppService {
  constructor() {
    this.baseUrl =
      process.env.WHATSAPP_API_URL || "https://wapi.flaxxa.com/api/v1";
    this.token = process.env.WHATSAPP_API_KEY;
  }

  // Build the date string from validFrom (IST)
  _formatDate(validFrom) {
    if (!validFrom) return "Event Date";
    try {
      const d = new Date(validFrom);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "numeric", month: "short", year: "numeric",
        });
      }
    } catch (_) {}
    return "Event Date";
  }

  // Send via Flaxxa and return { success, messageId, phone, flaxxaStatus }
  async _sendTemplate(phone, imageBuffer, templateName, parameters) {
    const form = new FormData();
    form.append("token", this.token);
    form.append("phone", phone);
    form.append("template_name", templateName);
    form.append("template_language", "en");
    form.append("components", JSON.stringify([{ type: "body", parameters }]));
    form.append("header_attachment", imageBuffer, {
      filename: "QR-Pass.png", contentType: "image/png",
    });

    const response = await axios.post(
      `${this.baseUrl}/sendtemplatemessage_withattachment`,
      form,
      { headers: form.getHeaders(), timeout: 30000 },
    );

    const status = response.data?.status;
    const msgId  = response.data?.message_id || response.data?.id;

    console.log("✅ Flaxxa response:", JSON.stringify({
      status, message_id: msgId, phone, template: templateName,
      error: response.data?.error || response.data?.message || null,
      raw: JSON.stringify(response.data).slice(0, 200),
    }));

    if (status !== "success" && status !== "sent") {
      console.warn("⚠️ Flaxxa non-success:", status, JSON.stringify(response.data).slice(0, 200));
    }

    return { success: true, messageId: msgId, phone, flaxxaStatus: status };
  }

  async sendQRMessage(to, qrImageBase64, holderName, eventName, passDetails) {
    if (!this.token) throw new Error("WHATSAPP_API_KEY is required");

    const phone = this.formatPhone(to);
    const entries = this.formatEntryPoints(passDetails.entryPoints || []);
    const venue   = passDetails.venue || "ISKCON Temple, Visakhapatnam";
    const dateStr = this._formatDate(passDetails.validFrom);
    const help    = process.env.HELP_CONTACT || "8977761187";

    const base64Data  = qrImageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");

    const isSponsor = !!passDetails.sevaSlot;

    console.log("📤 WhatsApp Send:");
    console.log("  Phone:", phone);
    console.log("  Holder:", holderName);
    console.log("  Event:", eventName);
    console.log("  Venue:", venue);
    console.log("  Date:", dateStr);
    console.log("  Sponsor:", isSponsor);
    if (isSponsor) {
      const sl = passDetails.sevaSlot;
      console.log("  Seva Slot:", sl.displayLabel || sl.name);
    }

    if (isSponsor) {
      // ── SPONSOR TEMPLATE ────────────────────────────────────────────────
      // Template: iskcon_sponsor_pass  (7 variables)
      // {{1}} Name  {{2}} Event  {{3}} Date  {{4}} Venue
      // {{5}} Seva slot ("A — Pratistha Abhisheka · 7:00 AM")
      // {{6}} Access points  {{7}} Help
      const sl = passDetails.sevaSlot;
      const slotName = sl.name + (sl.time ? ` · ${sl.time}` : "");
      // Prepend bahumana tier so recipient sees "B — Prathama Abhisheka · 7:00 AM"
      const tier = passDetails.tier || ""; // e.g. "B"
      const sevaLabel = tier ? `${tier} — ${slotName}` : slotName;

      // Template: sponsor_qr_message (5 variables)
      // {{1}} Name  {{2}} Event name  {{3}} Date  {{4}} Venue  {{5}} Seva Slot
      return this._sendTemplate(phone, imageBuffer,
        process.env.WA_TEMPLATE_SPONSOR || "sponsor_qr_message",
        [
          { type: "text", text: holderName },  // {{1}} Hare Krishna {{1}}!
          { type: "text", text: eventName },   // {{2}} Seva Pass for {{2}}
          { type: "text", text: dateStr },     // {{3}} Date
          { type: "text", text: venue },       // {{4}} Venue
          { type: "text", text: sevaLabel },   // {{5}} Seva Slot
        ],
      );
    } else {
      // ── GENERAL TEMPLATE ────────────────────────────────────────────────
      // Template: iskcon_common_pass  (6 variables)
      // {{1}} Name  {{2}} Event  {{3}} Date  {{4}} Venue
      // {{5}} Access points  {{6}} Help
      return this._sendTemplate(phone, imageBuffer,
        process.env.WA_TEMPLATE_GENERAL || "iskcon_common_pass",
        [
          { type: "text", text: holderName },  // {{1}}
          { type: "text", text: eventName },   // {{2}}
          { type: "text", text: dateStr },     // {{3}}
          { type: "text", text: venue },       // {{4}}
          { type: "text", text: entries },     // {{5}}
          { type: "text", text: help },        // {{6}}
        ],
      );
    }
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
