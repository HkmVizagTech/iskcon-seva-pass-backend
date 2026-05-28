// ─── Third-party integration service ─────────────────────────────────────────
// Handles syncing holder/volunteer QR data with the third-party platform.
//
// Flow 1: We → Them (push)
//   After we issue a QR pass (single or bulk), call their
//   POST /api/register-volunteer with the holder + QR details.
//
// Flow 2: Them → Us (receive)
//   Their app calls our POST /api/generate-volunteer-qr when someone
//   marks interest. We create the holder + QR and return the code.
//
// Config (env vars):
//   THIRD_PARTY_API_URL        — base URL of their server
//   THIRD_PARTY_API_KEY        — Bearer token / API key for their server
//   THIRD_PARTY_SYNC_ENABLED   — set to "true" to enable sync (default off)

const axios = require("axios");

class ThirdPartyService {
  constructor() {
    this.baseUrl = (process.env.THIRD_PARTY_API_URL || "").replace(/\/$/, "");
    this.apiKey = process.env.THIRD_PARTY_API_KEY;
    this.enabled = process.env.THIRD_PARTY_SYNC_ENABLED === "true";
  }

  isConfigured() {
    return this.enabled && !!this.baseUrl && !!this.apiKey;
  }

  /**
   * Push a holder's QR pass to the third-party server.
   * Called after every successful QR issuance (single or bulk).
   *
   * Their endpoint: POST /api/register-volunteer
   * Payload shape (as per their docs):
   *   event_id, user_phone_number, user_email (optional),
   *   qr_code (base64 image), event_start_date, event_end_date
   */
  async pushHolder({ holder, qrPass, qrImageBase64, event }) {
    if (!this.isConfigured()) return { skipped: true };

    try {
      const payload = {
        event_id: event.eventCode || event._id.toString(),
        user_phone_number: holder.phone,
        user_email: holder.email || undefined,
        qr_code: qrImageBase64,
        event_start_date: this._toDateTimeStr(event.dateStart),
        event_end_date: this._toDateTimeStr(event.dateEnd),
      };

      const response = await axios.post(
        `${this.baseUrl}/api/register-volunteer`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        },
      );

      console.log(
        `[ThirdParty] Pushed holder ${holder.phone} → event ${event.eventCode}:`,
        response.data,
      );
      return { success: true, response: response.data };
    } catch (error) {
      // Non-fatal — log and continue. Never block local issuance.
      console.error(
        `[ThirdParty] Push failed for ${holder.phone}:`,
        error.response?.data || error.message,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Format a Date/ISO string as "YYYY-MM-DD HH:MM:SS" in IST
   * (their docs expect this format).
   */
  _toDateTimeStr(date) {
    if (!date) return "";
    const d = new Date(date);
    return d
      .toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" })
      .replace("T", " ")
      .slice(0, 19);
  }
}

module.exports = new ThirdPartyService();
