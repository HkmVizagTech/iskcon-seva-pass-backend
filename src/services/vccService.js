// ─── VCC (Volunteer Care Cell) integration ─────────────────────────────────
// QR is the source of truth for events. An event marked "needs volunteers"
// is pushed to VCC (vcc-client, Next.js on Vercel) so it does not have to be
// created there by hand. The SAME event code is used in QR, VCC and the
// Vaikuntham community app.
//
// VCC endpoints (all require the shared key):
//   GET /api/integration/coordinators      → people who can own a VCC event
//   GET /api/integration/events/:code      → { exists, event }
//   PUT /api/integration/events/:code      → create, or update shared fields
//
// Config (env vars):
//   VCC_API_URL          — base URL, defaults to https://vcc-client.vercel.app
//   VCC_INTEGRATION_KEY  — must equal QR_INTEGRATION_KEY on the VCC side.
//                          When unset, the integration is off.

const axios = require("axios");

const TIMEOUT_MS = 15000;

function baseUrl() {
  return (process.env.VCC_API_URL || "https://vcc-client.vercel.app").replace(/\/$/, "");
}

function isEnabled() {
  return !!process.env.VCC_INTEGRATION_KEY;
}

function client() {
  return axios.create({
    baseURL: `${baseUrl()}/api/integration`,
    timeout: TIMEOUT_MS,
    headers: {
      "X-API-Key": process.env.VCC_INTEGRATION_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

function errorMessage(err) {
  return (
    err?.response?.data?.message ||
    (err?.response ? `VCC responded ${err.response.status}` : null) ||
    err?.message ||
    "Unknown error"
  );
}

// QR stores a list of venues; VCC has a single venue line.
function venueLine(venues) {
  return (venues || [])
    .map((v) => String(v?.name || "").trim())
    .filter(Boolean)
    .join(", ");
}

// The fields QR owns. Sent on every sync.
function sharedPayload(event) {
  return {
    name: event.name,
    description: event.description || "",
    venue: venueLine(event.venue),
    bannerImage: event.bannerImage || undefined,
    eventStart: event.dateStart,
    eventEnd: event.dateEnd,
  };
}

// VCC-only settings chosen in the QR form. Sent only when provided — on later
// syncs they are left alone so edits made inside VCC are not overwritten.
// availabilitySlots / customFields / services are sent as given (VCC
// validates them); an empty array is meaningful for slots/fields (clears them).
const VCC_ONLY = ["coordinatorId", "registrationStart", "registrationEnd", "photoRequired", "status"];
const VCC_LISTS = ["availabilitySlots", "customFields", "services"];
function vccOnlyPayload(opts = {}) {
  const out = {};
  for (const k of VCC_ONLY) {
    if (opts[k] !== undefined && opts[k] !== null && opts[k] !== "") out[k] = opts[k];
  }
  for (const k of VCC_LISTS) {
    if (Array.isArray(opts[k])) out[k] = opts[k];
  }
  return out;
}

async function listCoordinators() {
  if (!isEnabled()) throw new Error("VCC integration is not configured (VCC_INTEGRATION_KEY)");
  try {
    const { data } = await client().get("/coordinators");
    return data.coordinators || [];
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

async function getEvent(code) {
  if (!isEnabled()) throw new Error("VCC integration is not configured (VCC_INTEGRATION_KEY)");
  try {
    const { data } = await client().get(`/events/${encodeURIComponent(code)}`);
    return data;
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

// Volunteer numbers for an event: totals by status, per service, per day.
async function getStats(code) {
  if (!isEnabled()) throw new Error("VCC integration is not configured (VCC_INTEGRATION_KEY)");
  try {
    const { data } = await client().get(`/events/${encodeURIComponent(code)}/stats`);
    return data;
  } catch (err) {
    if (err?.response?.status === 404) return { exists: false };
    throw new Error(errorMessage(err));
  }
}

// Creates or updates the event in VCC. Never throws: returns the sync record
// to store on Event.vccSync.
async function pushEvent(event, vccOptions = {}) {
  const now = new Date();
  if (!isEnabled()) {
    return { status: "failed", error: "VCC integration is not configured on the QR server", lastAttemptAt: now };
  }
  try {
    const { data } = await client().put(
      `/events/${encodeURIComponent(event.eventCode)}`,
      { ...sharedPayload(event), ...vccOnlyPayload(vccOptions) },
    );
    const svcErrors = data?.services?.errors || [];
    return {
      status: svcErrors.length ? "failed" : "synced",
      error: svcErrors.length ? `Event synced, but some services failed: ${svcErrors.join("; ")}` : null,
      error: null,
      lastAttemptAt: now,
      syncedAt: now,
      vccEventObjectId: data?.event?._id ? String(data.event._id) : undefined,
    };
  } catch (err) {
    console.error(`VCC sync failed for ${event.eventCode}:`, errorMessage(err));
    return { status: "failed", error: errorMessage(err), lastAttemptAt: now };
  }
}

// Saves a pushEvent() result onto the event, keeping fields it did not return.
async function recordSync(Event, eventId, result) {
  const $set = {};
  for (const [k, v] of Object.entries(result)) {
    if (v !== undefined) $set[`vccSync.${k}`] = v;
  }
  await Event.updateOne({ _id: eventId }, { $set });
}

module.exports = { isEnabled, listCoordinators, getEvent, getStats, pushEvent, recordSync, baseUrl };
