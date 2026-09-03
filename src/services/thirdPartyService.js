// ─── Community App integration (harekrishnavizag.co.in) ────────────────────
// Pushes every QR we issue to their APIs so it shows up in their community
// app too. There are three distinct push flows depending on category:
//   - pushHolder        → register-volunteer   (used for every holder)
//   - pushSevaSponsor   → seva-sponsor          (SP / DN / INV categories)
//   - pushStoreQrCode   → store-qr-code         (VL — volunteer category)
//
// IMPORTANT: their server runs a ModSecurity WAF that returns 406 for any
// request without a realistic browser-like User-Agent header — this fires
// BEFORE their app-level IP whitelist check even runs. Every request below
// MUST include the same headers or it gets silently blocked at the WAF.
//
// Access is otherwise restricted purely by IP whitelist — no API key needed.
//
// Config (env vars):
//   THIRD_PARTY_API_URL       — base URL, defaults to https://harekrishnavizag.co.in
//   THIRD_PARTY_SYNC_ENABLED  — set to "true" to enable push (default off)

const axios = require("axios");
const FormData = require("form-data");

const COMMON_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; ISKCON-SevaPass/1.0; +https://harekrishnavizag.org)",
};

class ThirdPartyService {
  constructor() {
    this.baseUrl = (process.env.THIRD_PARTY_API_URL || "https://harekrishnavizag.co.in").replace(/\/$/, "");
    this.enabled = process.env.THIRD_PARTY_SYNC_ENABLED === "true";

    // ── Outbound throttle ────────────────────────────────────────────────
    // A bulk import fires one background push per row with no gap between
    // them (the 500ms sleep in the import loop only paces WhatsApp sends —
    // these community-app pushes are fire-and-forget and were going out
    // essentially back-to-back). Their Laravel endpoint throttles per IP,
    // so a large import reliably hit 429 "Too Many Attempts" partway
    // through, and those rows never synced (nor retried). Every request
    // below now goes through _axiosPostThrottled, which serializes all
    // outbound calls with a minimum gap and retries once on 429.
    this._queue = Promise.resolve();
    this._lastCallAt = 0;
    this._minGapMs = Number(process.env.THIRD_PARTY_MIN_GAP_MS || 400);
  }

  // Serializes every outbound POST through one queue (never more than one
  // in flight, spaced at least _minGapMs apart) and retries once on a 429,
  // honoring Retry-After when they send one. Drop-in replacement for a bare
  // axios.post — same return value, same thrown-error behaviour.
  _axiosPostThrottled(url, data, config) {
    const run = this._queue.then(async () => {
      const wait = this._minGapMs - (Date.now() - this._lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastCallAt = Date.now();
      try {
        return await axios.post(url, data, config);
      } catch (error) {
        if (error.response?.status === 429) {
          const retryAfterSec = Number(error.response.headers?.["retry-after"]);
          const backoffMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : 3000;
          console.warn(`[CommunityApp] 429 rate-limited — retrying once in ${backoffMs}ms`);
          await new Promise((r) => setTimeout(r, backoffMs));
          this._lastCallAt = Date.now();
          return await axios.post(url, data, config);
        }
        throw error;
      }
    });
    // Detach from the chain with .catch() so one failed/rate-limited push
    // doesn't leave `_queue` permanently rejected and stall every push
    // after it — the caller below still sees the real rejection from `run`.
    this._queue = run.catch(() => {});
    return run;
  }

  isConfigured() {
    return this.enabled && !!this.baseUrl;
  }

  _skipResult(reason) {
    return { attempted: false, skipped: true, success: false, reason };
  }

  _checkPrereqs(event) {
    if (!this.isConfigured()) return this._skipResult("Sync disabled (THIRD_PARTY_SYNC_ENABLED not set)");
    if (!event?.thirdPartyEventId) return this._skipResult("Event has no thirdPartyEventId mapped");
    return null;
  }

  async pushHolder({ holder, qrPass, qrImageBase64, event }) {
    const skip = this._checkPrereqs(event);
    if (skip) return skip;
    const thirdPartyEventId = event.thirdPartyEventId;

    try {
      const form = new FormData();
      form.append("event_id", thirdPartyEventId);
      form.append("event_start_date", this._toDateTimeStr(event.dateStart));
      form.append("event_end_date", this._toDateTimeStr(event.dateEnd));

      const bare10 = String(holder.phone || "").replace(/^91/, "").slice(-10);
      form.append("user_phone_number", bare10);
      if (holder.email) form.append("user_email", holder.email);

      const base64Only = String(qrImageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
      form.append("qr_code", base64Only);

      const response = await this._axiosPostThrottled(
        `${this.baseUrl}/api/v1/user/festivals/register-volunteer`,
        form,
        { headers: { ...form.getHeaders(), ...COMMON_HEADERS }, timeout: 15000 },
      );

      const ok = response.data?.success === true;
      console.log(`[CommunityApp] register-volunteer ${ok ? "OK" : "non-success"} for ${bare10} → event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 200));
      return { attempted: true, success: ok, skipped: false, responseBody: JSON.stringify(response.data).slice(0, 500) };
    } catch (error) {
      return this._logAndReturnError("register-volunteer", holder.phone, error);
    }
  }

  async pushSevaSponsor({ holder, event, qrPass, catCode, categoryName, subCategory, preacherPhone, sevaSlotName, instruction }) {
    const skip = this._checkPrereqs(event);
    if (skip) return skip;
    const thirdPartyEventId = event.thirdPartyEventId;

    try {
      const bare10 = String(holder.phone || "").replace(/^91/, "").slice(-10);
      // seva_type still needs the machine pass-type value internally —
      // kept as a local lookup, no longer sent as the "category" field.
      const passTypeMap = { SP: "sponsor", DN: "donor", INV: "invitee" };
      const passType = passTypeMap[(catCode || "").toUpperCase()] || "donor";
      const sevaTypeMap = { sponsor: "abhisekam", donor: "darshan", invitee: "darshan" };

      // devotee_mobile_number = the PREACHER's phone, so the community app
      // can recognise which devotee this sponsor/donor was brought in by.
      // Falls back to the sponsor's own number if no preacher is on record,
      // so the field is never left empty.
      const preacherBare10 = preacherPhone
        ? String(preacherPhone).replace(/^91/, "").slice(-10)
        : bare10;

      // "holder" field carries the pass TYPE name (Sponsor / Donor / Invitee).
      const holderLabel = categoryName || catCode || "";

      // "category" field carries the A/B/C sub-category tier — sponsors
      // usually have one, donors and invitees usually do not.
      //
      // It used to be mandatory on their side: real null, "" and an omitted
      // key were all rejected with 422 "category field is required", so we
      // sent the literal string "null" for tier-less holders. That string
      // then printed as "null" on the donor's pass card in their app.
      //
      // They have since made the field optional, so we now OMIT the key
      // entirely when there is no tier. Omitting rather than sending ""
      // satisfies both a `nullable` and a `sometimes` validation rule.
      const categoryLabel = String(subCategory || "").trim();

      const body = {
        event_id: thirdPartyEventId,
        devotee_mobile_number: preacherBare10,
        donor_name: holder.name || "",
        donor_mobile_number: bare10,
        ...(categoryLabel ? { category: categoryLabel } : {}),
        qrcode: qrPass?.qrId || "",
        seva_type: sevaTypeMap[passType] || "darshan",
        holder: holderLabel,
        // Custom instruction (rich HTML) typed by the admin takes priority.
        // Falls back to seva slot / category / event name when not set,
        // preserving the previous auto-derived behaviour.
        instruction: instruction || sevaSlotName || categoryName || event?.name || "",
      };

      const response = await this._axiosPostThrottled(
        `${this.baseUrl}/api/v1/user/festivals/seva-sponsor`,
        body,
        { headers: { "Content-Type": "application/json", ...COMMON_HEADERS }, timeout: 15000 },
      );

      const ok = response.data?.success === true;
      console.log(`[CommunityApp] seva-sponsor ${ok ? "OK" : "non-success"} for ${bare10} ` +
        `[${holderLabel || catCode}, category ${categoryLabel ? `"${categoryLabel}"` : "omitted"}] ` +
        `→ event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 200));
      return { attempted: true, success: ok, skipped: false, responseBody: JSON.stringify(response.data).slice(0, 500) };
    } catch (error) {
      return this._logAndReturnError("seva-sponsor", holder.phone, error);
    }
  }

  async pushStoreQrCode({ holder, event, qrPass }) {
    const skip = this._checkPrereqs(event);
    if (skip) return skip;
    const thirdPartyEventId = event.thirdPartyEventId;

    try {
      const bare10 = String(holder.phone || "").replace(/^91/, "").slice(-10);
      // Their API requires an array payload even for a single entry.
      const body = [{
        volunteer_mobile_number: bare10,
        event_id: thirdPartyEventId,
        qrcode: qrPass?.qrId || "",
      }];

      const response = await this._axiosPostThrottled(
        `${this.baseUrl}/api/v1/user/festivals/store-qr-code`,
        body,
        { headers: { "Content-Type": "application/json", ...COMMON_HEADERS }, timeout: 15000 },
      );

      const ok = response.data?.success === true;
      console.log(`[CommunityApp] store-qr-code ${ok ? "OK" : "non-success"} for ${bare10} → event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 200));
      return { attempted: true, success: ok, skipped: false, responseBody: JSON.stringify(response.data).slice(0, 500) };
    } catch (error) {
      return this._logAndReturnError("store-qr-code", holder.phone, error);
    }
  }

  async pushStoreQrCodeBulk(entries, event) {
    const skip = this._checkPrereqs(event);
    if (skip) return skip;
    if (!entries || entries.length === 0) return this._skipResult("No entries to push");
    const thirdPartyEventId = event.thirdPartyEventId;

    try {
      const body = entries.map((e) => ({
        volunteer_mobile_number: String(e.phone || "").replace(/^91/, "").slice(-10),
        event_id: thirdPartyEventId,
        qrcode: e.qrId || "",
      }));

      const response = await this._axiosPostThrottled(
        `${this.baseUrl}/api/v1/user/festivals/store-qr-code`,
        body,
        { headers: { "Content-Type": "application/json", ...COMMON_HEADERS }, timeout: 30000 },
      );

      const ok = response.data?.success === true;
      console.log(`[CommunityApp] store-qr-code BULK (${entries.length} entries) ${ok ? "OK" : "non-success"} → event_id ${thirdPartyEventId}:`,
        JSON.stringify(response.data).slice(0, 300));
      return { attempted: true, success: ok, skipped: false, count: entries.length, responseBody: JSON.stringify(response.data).slice(0, 500) };
    } catch (error) {
      return this._logAndReturnError("store-qr-code-bulk", `${entries.length} entries`, error);
    }
  }

  _logAndReturnError(label, phone, error) {
    const status = error.response?.status;
    const detail = error.response?.data || error.message;
    const detailStr = typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300);
    console.error(`[CommunityApp] ${label} FAILED for ${phone} (HTTP ${status || "?"}):`, detailStr);
    return {
      attempted: true,
      success: false,
      skipped: false,
      reason: `HTTP ${status || "?"}: ${detailStr}`,
      responseBody: detailStr,
    };
  }

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
