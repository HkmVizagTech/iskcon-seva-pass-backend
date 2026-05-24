// ─── IST date utilities ───────────────────────────────────────────────────────
// Dates are stored as UTC in MongoDB. App operates in IST (UTC+05:30).

/**
 * Returns the start of today in IST as a UTC Date for DB queries.
 * new Date().setHours(0,0,0,0) gives UTC midnight = 5:30 AM IST — wrong.
 * This gives the real IST midnight.
 */
function startOfTodayIST() {
  const istDateStr = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  }); // "YYYY-MM-DD"
  return new Date(`${istDateStr}T00:00:00+05:30`);
}

/**
 * Format a UTC date for display in IST.
 * Returns { date, time } strings.
 * Use this on the server when building WhatsApp/email message bodies.
 */
function toISTDisplay(utcDateOrIso) {
  const d =
    utcDateOrIso instanceof Date ? utcDateOrIso : new Date(utcDateOrIso);
  if (isNaN(d.getTime())) return { date: "—", time: "—" };
  const opts = { timeZone: "Asia/Kolkata" };
  return {
    date: d.toLocaleDateString("en-IN", {
      ...opts, day: "numeric", month: "short", year: "numeric",
    }),
    time: d.toLocaleTimeString("en-IN", {
      ...opts, hour: "numeric", minute: "2-digit", hour12: true,
    }),
  };
}

module.exports = { startOfTodayIST, toISTDisplay };
