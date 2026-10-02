// Session window for session-scoped passes (e.g. a prasadam coupon for one Sunday Feast).
//
// A caller scopes a pass to a session with any of:
//   valid_for_date  "YYYY-MM-DD" (an IST calendar day)
//   valid_from / valid_until  ISO timestamps (override the day's bounds)
//   session_ref     caller's own id for the session (dedupe key; needs a window)
// With none of them the pass is not session-scoped and behaves exactly as before.

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function istDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  if (isNaN(start.getTime())) return null;
  // Reject calendar overflow such as 2026-02-31 (Date rolls it into March)
  const back = start.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (back !== dateStr) return null;
  return { start, end: new Date(`${dateStr}T23:59:59.999+05:30`) };
}

function parseInstant(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// -> null (not session-scoped) | { error } | { sessionKey, validFrom, validUntil, sessionRef }
function parseSessionWindow(body = {}, now = new Date()) {
  const { valid_for_date, valid_from, valid_until, session_ref } = body;
  const hasWindowInput = [valid_for_date, valid_from, valid_until].some(
    (v) => v !== undefined && v !== null && v !== "",
  );
  const ref = session_ref === undefined || session_ref === null ? "" : String(session_ref).trim();

  if (!hasWindowInput && !ref) return null;
  if (!hasWindowInput) {
    return { error: "session_ref needs valid_for_date or valid_until so the coupon has a validity window" };
  }

  let day = null;
  if (valid_for_date !== undefined && valid_for_date !== null && valid_for_date !== "") {
    if (!DATE_RE.test(String(valid_for_date))) return { error: "valid_for_date must be YYYY-MM-DD" };
    day = istDay(String(valid_for_date));
    if (!day) return { error: "valid_for_date is not a real calendar date" };
  }

  const from = parseInstant(valid_from);
  const until = parseInstant(valid_until);
  if (from === null) return { error: "valid_from is not a valid date-time" };
  if (until === null) return { error: "valid_until is not a valid date-time" };
  if (!day && !until) return { error: "valid_for_date or valid_until is required" };

  const validFrom = from || (day ? day.start : now);
  const validUntil = until || day.end;

  if (validUntil.getTime() <= validFrom.getTime()) return { error: "valid_until must be after valid_from" };
  if (validUntil.getTime() < now.getTime()) return { error: "This session has already ended" };
  if (validUntil.getTime() - validFrom.getTime() > MAX_WINDOW_MS) return { error: "Validity window cannot exceed 31 days" };

  const sessionRef = ref ? ref.slice(0, 64) : null;
  const sessionKey = sessionRef || (day ? `date:${String(valid_for_date)}` : `until:${validUntil.toISOString()}`);
  return { sessionKey, sessionRef, validFrom, validUntil };
}

module.exports = { parseSessionWindow, MAX_WINDOW_MS };
