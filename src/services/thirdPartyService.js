// ─── Community App integration (harekrishnavizag.co.in) ────────────────────
// Pushes every QR we issue to their register-volunteer API so it shows up
// in their community app too.
//
// Their API doc:
//   POST https://harekrishnavizag.co.in/api/v1/user/festivals/register-volunteer
//   Content-Type: multipart/form-data
//   Access restricted by IP whitelist — no API key/bearer token needed.
//   Fields: event_id, event_start_date, event_end_date,
//           user_phone_number, user_email, qr_code (base64/URL)
//
// event_id mapping: each of OUR events can optionally have a
// `thirdPartyEventId` field set (e.g. "event_5") which is what gets sent
// as their event_id. If not set for an event, the push is skipped.
//
// Config (env vars):
//   THIRD_PARTY_API_URL       — base URL, defaults to https://harekrishnavizag.co.in
//   THIRD_PARTY_SYNC_ENABLED  — set to "true" to enable push (default off)

const axios = require("axios");
const FormData = require("form-data");

class ThirdPartyService {
  constructor() {
    this.baseUrl = (process.env.THIRD_PARTY_API_URL || "https://harekrishnavizag.co.in").replace(/\/$/, "");
    this.enabled = process.env.THIRD_PARTY_SYNC_ENABLED === "true";
  }

  isConfigured() {
    return this.enabled && !!this.baseUrl;
  }

  /**
   * Push a holder's QR pass to the community app.
   * Called after every successful QR issuance (single or bulk).
   * Non-fatal — never blocks our own issuance flow.
   */
  async pushHolder({ holder, qrPass, qrImageBase64, event }) {
    if (!this.isConfigured()) return { skipped: true, reason: "sync disabled" };

    // Only push if this event is mapped to a community app event_id
    const thirdPartyEventId = event?.thirdPartyEventId;
    if (!thirdPartyEventId) {
      return { skipped: true, reason: "event has no thirdPartyEventId mapped" };
    }

    try {
      const form = new FormData();
      form.append("event_id", thirdPartyEventId);
      form.append("event_start_date", this._toDateTimeStr(event.dateStart));
      form.append("event_end_date", this._toDateTimeStr(event.dateEnd));

      // Their doc shows a bare 10-digit number in the example payload
      const bare10 = String(holder.phone || "").replace(/^91/, "").slice(-10);
      form.append("user_phone_number", bare10);

      if (holder.email) form.append("user_email", holder.email);

      // qr_code — base64 (without the data: prefix) or a hosted URL.
      const base64Only = String(qrImageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
      form.append("qr_code", base64Only);

      const response = await axios.post(
        `${this.baseUrl}/api/v1/user/festivals/register-volunteer`,
        form,
        {
          headers: { ...form.getHeaders(), Accept: "application/json" },
          timeout: 15000,
        },
      );

      const ok = response.data?.success === true;
      console.log(
        `[CommunityApp] register-volunteer ${ok ? "OK" : "non-success"} for ${bare10} → event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 200),
      );
      return { success: ok, response: response.data };
    } catch (error) {
      // Non-fatal — log and continue. Never block local issuance.
      const detail = error.response?.data || error.message;
      console.error(
        `[CommunityApp] register-volunteer FAILED for ${holder.phone}:`,
        JSON.stringify(detail).slice(0, 300),
      );
      return { success: false, error: detail };
    }
  }

  /**
   * Push a sponsor/donor/invitee record to the community app.
   * Called after QR issuance for SP/DN/INV categories.
   */
  async pushSevaSponsor({ holder, event, qrPass, catCode, categoryName, sevaSlotName }) {
    if (!this.isConfigured()) return { skipped: true, reason: "sync disabled" };

    const thirdPartyEventId = event?.thirdPartyEventId;
    if (!thirdPartyEventId) {
      return { skipped: true, reason: "event has no thirdPartyEventId mapped" };
    }

    try {
      const bare10 = String(holder.phone || "").replace(/^91/, "").slice(-10);

      const categoryMap = { SP: "sponsor", DN: "donor", INV: "invitee" };
      const category = categoryMap[(catCode || "").toUpperCase()] || "donor";

      const sevaTypeMap = { sponsor: "abhisekam", donor: "darshan", invitee: "darshan" };

      const body = {
        devotee_mobile_number: bare10,
        donor_name: holder.name || "",
        donor_mobile_number: bare10,
        date_time: this._toDateTimeStr(new Date()).slice(0, 16),
        category,
        qrcode: qrPass?.qrId || "",
        seva_type: sevaTypeMap[category] || "darshan",
        holder: holder.name || "",
        instruction: sevaSlotName || categoryName || event?.name || "",
      };

      const response = await axios.post(
        `${this.baseUrl}/api/v1/user/festivals/seva-sponsor`,
        body,
        { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 15000 },
      );

      const ok = response.data?.success === true;
      console.log(
        `[CommunityApp] seva-sponsor ${ok ? "OK" : "non-success"} for ${bare10} → event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 200),
      );
      return { success: ok, response: response.data };
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error(
        `[CommunityApp] seva-sponsor FAILED for ${holder.phone}:`,
        JSON.stringify(detail).slice(0, 300),
      );
      return { success: false, error: detail };
    }
  }

  /**
   * Push a volunteer QR code to the community app.
   * Called after QR issuance for VL category.
   */
  async pushStoreQrCode({ holder, event, qrPass }) {
    if (!this.isConfigured()) return { skipped: true, reason: "sync disabled" };

    const thirdPartyEventId = event?.thirdPartyEventId;
    if (!thirdPartyEventId) {
      return { skipped: true, reason: "event has no thirdPartyEventId mapped" };
    }

    try {
      const bare10 = String(holder.phone || "").replace(/^91/, "").slice(-10);

      const body = {
        volunteer_mobile_number: bare10,
        event_id: thirdPartyEventId,
        qrcode: qrPass?.qrId || "",
      };

      const response = await axios.post(
        `${this.baseUrl}/api/v1/user/festivals/store-qr-code`,
        body,
        { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 15000 },
      );

      const ok = response.data?.success === true;
      console.log(
        `[CommunityApp] store-qr-code ${ok ? "OK" : "non-success"} for ${bare10} → event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 200),
      );
      return { success: ok, response: response.data };
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error(
        `[CommunityApp] store-qr-code FAILED for ${holder.phone}:`,
        JSON.stringify(detail).slice(0, 300),
      );
      return { success: false, error: detail };
    }
  }

  /**
   * Format a Date/ISO string as "YYYY-MM-DD HH:MM:SS" in IST
   * (their docs require this exact format).
   */
  _toDateTimeStr(date) {
    if (!date) return "";
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    return d
      .toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" })
      .replace("T", " ")
      .slice(0, 19);
  }
}

module.exports = new ThirdPartyService();
