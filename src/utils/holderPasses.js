// Helpers for holders that own several passes (one per session on a standing
// event such as PRASADAM, or a revoked pass plus its replacement).

const ms = (d) => (d ? new Date(d).getTime() : 0);

// "Collected" = at least one granted redemption; failed scans do not count.
const isCollected = (pass) =>
  (pass?.redemptionHistory || []).some((r) => r && r.result === "granted");

// Newest session first; ties (same window, e.g. a replacement) by creation time.
function sortNewestFirst(passes) {
  return [...(passes || [])].sort(
    (a, b) => ms(b.validFrom) - ms(a.validFrom) || ms(b.createdAt) - ms(a.createdAt),
  );
}

const isOpenNow = (p, now) =>
  !p.windowed || (ms(p.validFrom) <= now.getTime() && now.getTime() <= ms(p.validUntil));

// The pass a one-row view shows: an active pass usable right now, else the newest.
function primaryPass(passes, now = new Date()) {
  const sorted = sortNewestFirst(passes);
  return sorted.find((p) => p.status === "active" && isOpenNow(p, now)) || sorted[0] || null;
}

function groupByHolder(passes) {
  const map = new Map();
  for (const p of passes || []) {
    const id = String(p.holderId?._id || p.holderId);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(p);
  }
  return map;
}

// A pass is a no-show once it can no longer be used: active, never collected and,
// for a session pass, its window has closed. Open/upcoming session passes are
// "pending". Holders who collected any pass of the event are not no-show people.
function classifyNoShows(uncollected, collectedHolderIds, now = new Date()) {
  const noShows = [];
  const pending = [];
  for (const p of uncollected || []) {
    if (p.status !== "active" || isCollected(p)) continue;
    if (p.windowed && ms(p.validUntil) >= now.getTime()) pending.push(p);
    else noShows.push(p);
  }
  const collected = new Set([...(collectedHolderIds || [])].map(String));
  const people = new Set(
    noShows.map((p) => String(p.holderId?._id || p.holderId)).filter((id) => !collected.has(id)),
  );
  return { noShows, pending, holderCount: people.size };
}

// Per-session roll-up of a standing event's windowed passes, newest first.
function sessionRollup(passes, now = new Date()) {
  const map = new Map();
  for (const p of passes || []) {
    if (!p.sessionKey) continue;
    let s = map.get(p.sessionKey);
    if (!s) {
      s = {
        sessionKey: p.sessionKey,
        validFrom: p.validFrom,
        validUntil: p.validUntil,
        issued: 0, collected: 0, missed: 0, pending: 0, revoked: 0,
        clientIds: new Set(),
      };
      map.set(p.sessionKey, s);
    }
    if (ms(p.validFrom) < ms(s.validFrom)) s.validFrom = p.validFrom;
    if (ms(p.validUntil) > ms(s.validUntil)) s.validUntil = p.validUntil;
    if (p.issuedByClient) s.clientIds.add(String(p.issuedByClient));
    s.issued++;
    if (p.status === "revoked" || p.status === "expired") s.revoked++;
    else if (isCollected(p)) s.collected++;
    else if (ms(p.validUntil) < now.getTime()) s.missed++;
    else s.pending++;
  }
  return [...map.values()]
    .map(({ clientIds, ...s }) => ({ ...s, clientIds: [...clientIds] }))
    .sort((a, b) => ms(b.validFrom) - ms(a.validFrom));
}

module.exports = { isCollected, sortNewestFirst, primaryPass, groupByHolder, classifyNoShows, sessionRollup };
