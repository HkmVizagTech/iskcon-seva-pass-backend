const axios = require("axios");
const FormData = require("form-data");

class WhatsAppService {
  constructor() {
    // Flaxxa (legacy provider)
    this.baseUrl =
      process.env.WHATSAPP_API_URL || "https://wapi.flaxxa.com/api/v1";
    this.token = process.env.WHATSAPP_API_KEY;

    // Gupshup
    this.gupshupEnabled = process.env.GUPSHUP_ENABLED === "true";
    this.gupshupApiKey = process.env.GUPSHUP_API_KEY || "";
    this.gupshupSourceNumber = process.env.GUPSHUP_SOURCE_NUMBER || "";
    this.gupshupAppName = process.env.GUPSHUP_APP_NAME || "";
    this.backendPublicUrl = (process.env.BACKEND_PUBLIC_URL || "").replace(/\/$/, "");
  }

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

  // ── Flaxxa provider ────────────────────────────────────────────────────────
  async _sendFlaxxa(phone, imageBuffer, templateName, parameters) {
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

    console.log("[WhatsApp] Flaxxa response:", JSON.stringify({
      status, message_id: msgId, phone, template: templateName,
      error: response.data?.error || response.data?.message || null,
      raw: JSON.stringify(response.data).slice(0, 200),
    }));

    if (status !== "success" && status !== "sent") {
      console.warn("[WhatsApp] Flaxxa non-success:", status, JSON.stringify(response.data).slice(0, 200));
    }

    return { success: true, messageId: msgId, phone, provider: "flaxxa", flaxxaStatus: status };
  }

  // ── Gupshup provider ──────────────────────────────────────────────────────
  async _sendGupshup(phone, qrId, templateId, params) {
    if (!this.backendPublicUrl) {
      throw new Error("BACKEND_PUBLIC_URL is required for Gupshup (QR image must be publicly accessible)");
    }

    const imageUrl = `${this.backendPublicUrl}/api/qr/${qrId}/image`;

    const body = new URLSearchParams();
    body.append("channel", "whatsapp");
    body.append("source", this.gupshupSourceNumber);
    body.append("src.name", this.gupshupAppName);
    body.append("destination", phone);
    body.append("template", JSON.stringify({ id: templateId, params }));
    body.append("message", JSON.stringify({ type: "image", image: { link: imageUrl } }));

    console.log("[WhatsApp] Gupshup request:", JSON.stringify({
      phone, templateId, params, imageUrl,
    }));

    const response = await axios.post(
      "https://api.gupshup.io/wa/api/v1/template/msg",
      body.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          apikey: this.gupshupApiKey,
        },
        timeout: 30000,
      },
    );

    const msgId = response.data?.messageId;
    const status = response.data?.status;

    console.log("[WhatsApp] Gupshup response:", JSON.stringify({
      status, messageId: msgId, phone,
      raw: JSON.stringify(response.data).slice(0, 200),
    }));

    if (status !== "submitted" && status !== "success") {
      console.warn("[WhatsApp] Gupshup non-success:", status, JSON.stringify(response.data).slice(0, 300));
    }

    return { success: true, messageId: msgId, phone, provider: "gupshup" };
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  async sendQRMessage(to, qrImageBase64, holderName, eventName, passDetails) {
    const useGupshup = this.gupshupEnabled && this.gupshupApiKey;
    if (!useGupshup && !this.token) {
      throw new Error("No WhatsApp provider configured (set GUPSHUP_ENABLED+GUPSHUP_API_KEY or WHATSAPP_API_KEY)");
    }

    const phone = this.formatPhone(to);
    const venue   = passDetails.venue || "ISKCON Temple, Visakhapatnam";
    const dateStr = this._formatDate(passDetails.validFrom);

    const isSponsor = passDetails.isSponsor === true || !!passDetails.sevaSlot;

    console.log("[WhatsApp] Send:", JSON.stringify({
      phone, holder: holderName, event: eventName,
      venue, date: dateStr, sponsor: isSponsor,
      provider: useGupshup ? "gupshup" : "flaxxa",
      sevaSlot: isSponsor && passDetails.sevaSlot
        ? (passDetails.sevaSlot.displayLabel || passDetails.sevaSlot.name)
        : null,
    }));

    if (isSponsor && useGupshup && passDetails.qrId) {
      // ── GUPSHUP: sponsor template (4 body params + image header) ────────
      // "Hare Krishna {{1}}! ... Seva Pass for {{2}} ... Date: {{3}} ... Venue: {{4}}"
      const templateId = process.env.GUPSHUP_TEMPLATE_SPONSOR
        || "a9fd6274-a5ec-49f4-bd36-2fb3aee66611";

      return this._sendGupshup(phone, passDetails.qrId, templateId, [
        holderName,  // {{1}} Name
        eventName,   // {{2}} Event
        dateStr,     // {{3}} Date
        venue,       // {{4}} Venue
      ]);
    }

    // ── Flaxxa path (general template or sponsor fallback) ────────────────
    if (!this.token) {
      throw new Error("WHATSAPP_API_KEY required for Flaxxa (non-Gupshup path)");
    }

    const base64Data  = qrImageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");
    const entries = this.formatEntryPoints(passDetails.entryPoints || []);
    const help    = process.env.HELP_CONTACT || "8977761187";

    if (isSponsor) {
      const sl = passDetails.sevaSlot;
      const slotName = sl.name + (sl.time ? ` · ${sl.time}` : "");
      const tier = passDetails.tier || "";
      const sevaLabel = tier ? `${tier} — ${slotName}` : slotName;

      return this._sendFlaxxa(phone, imageBuffer,
        process.env.WA_TEMPLATE_SPONSOR || "sponsor_qr_message",
        [
          { type: "text", text: holderName },
          { type: "text", text: eventName },
          { type: "text", text: dateStr },
          { type: "text", text: venue },
          { type: "text", text: sevaLabel },
        ],
      );
    }

    return this._sendFlaxxa(phone, imageBuffer,
      process.env.WA_TEMPLATE_GENERAL || "iskcon_common_pass",
      [
        { type: "text", text: holderName },
        { type: "text", text: eventName },
        { type: "text", text: dateStr },
        { type: "text", text: venue },
        { type: "text", text: entries },
        { type: "text", text: help },
      ],
    );
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
