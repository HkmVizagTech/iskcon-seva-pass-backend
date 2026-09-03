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
      // BUG FIX: this used to only console.warn and then still resolve with
      // success:true. Every caller relies on this promise REJECTING to know
      // delivery failed (holderController wraps it in try/catch and sets
      // deliveryStatus="failed" only in the catch) — so a Flaxxa error like
      // "Invalid template" was silently recorded as "sent" and the pass was
      // never actually delivered. Throwing here is what makes that catch
      // block — and the deliveryStatus/deliveryError shown in the dashboard —
      // reflect reality.
      const errMsg = response.data?.error || response.data?.message || `Flaxxa status "${status}"`;
      throw new Error(`Flaxxa: ${errMsg}`);
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
      // Same bug as Flaxxa below: must throw, not just warn, or the caller
      // records "sent" for a message Gupshup never actually queued.
      const errMsg = response.data?.message || response.data?.status || `Gupshup status "${status}"`;
      throw new Error(`Gupshup: ${errMsg}`);
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

    // GUPSHUP_TEMPLATE_GENERAL is the approved template for the non-sponsor
    // (common) pass message — same shape as GUPSHUP_TEMPLATE_SPONSOR but for
    // Donor/Invitee/Volunteer/General passes, which is the vast majority of
    // what gets issued. Previously ONLY sponsor passes ever went to Gupshup —
    // everything else always fell through to Flaxxa, whose "iskcon_common_pass"
    // template Flaxxa now rejects outright ("Invalid template"), so almost
    // every non-sponsor WhatsApp send was failing. Until GUPSHUP_TEMPLATE_GENERAL
    // is set, general passes still fall back to Flaxxa below — but that failure
    // is now reported honestly instead of recorded as "sent" (see _sendFlaxxa).
    const gupshupTemplateId = useGupshup && passDetails.qrId
      ? (isSponsor
          // NOTE: corrected on 2026-09-03 — a9fd6274-a5ec-49f4-bd36-2fb3aee66611
          // was the wrong ID (message got a "submitted" status from Gupshup
          // but never actually reached WhatsApp). This ID IS the confirmed
          // approved sponsor template.
          ? (process.env.GUPSHUP_TEMPLATE_SPONSOR || "2ef7edc8-bed6-45f3-9688-8b6ff0fa0710")
          // "qr_issue_skj" — same 4 params as the sponsor template (Name,
          // Event, Date, Venue). Approved in Gupshup as of 2026-09-03.
          // NOTE: this ID was corrected on 2026-09-03 — the user supplied a
          // second, different template ID for the same approved message text
          // (likely Gupshup's actual template ID vs. an earlier WhatsApp
          // Business Manager ID). This hardcoded ID IS the approved template,
          // so General/Donor/Invitee/Volunteer sends now go through Gupshup
          // with no further deploy.
          : (process.env.GUPSHUP_TEMPLATE_GENERAL || "3011315279202116"))
      : null;

    if (gupshupTemplateId) {
      // Both templates currently take the same 4 body params. If the approved
      // general template needs more (entry point / help contact), extend this
      // params array and GUPSHUP_TEMPLATE_GENERAL's template definition together.
      return this._sendGupshup(phone, passDetails.qrId, gupshupTemplateId, [
        holderName,  // {{1}} Name
        eventName,   // {{2}} Event
        dateStr,     // {{3}} Date
        venue,       // {{4}} Venue
      ]);
    }

    // ── Flaxxa path (fallback when Gupshup isn't configured for this kind
    //    of pass yet) ────────────────────────────────────────────────────
    if (!this.token) {
      throw new Error(
        useGupshup
          ? "GUPSHUP_TEMPLATE_GENERAL is not set, and no Flaxxa WHATSAPP_API_KEY is configured as fallback — general passes cannot be sent via WhatsApp right now."
          : "WHATSAPP_API_KEY required for Flaxxa (non-Gupshup path)",
      );
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
