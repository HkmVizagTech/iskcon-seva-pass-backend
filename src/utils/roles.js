// Role hierarchy for account management. A user may only create, edit, or
// remove accounts that rank strictly below their own; super_admin outranks all.
const ROLE_RANK = {
  super_admin: 100,
  event_admin: 80,
  campaign_manager: 60,
  issuer: 40,
  announcer: 30,
  preacher: 20,
  volunteer: 10,
  self: 0,
};

const VALID_ROLES = Object.keys(ROLE_RANK);

// Accounts that may read holder PII and reports. Excludes volunteer, preacher
// (own /preachers/me/* routes), self, and announcer (bahumana view only).
const HOLDER_READ_ROLES = ["super_admin", "event_admin", "campaign_manager", "issuer"];

const rankOf = (role) => (role in ROLE_RANK ? ROLE_RANK[role] : -1);

const isValidRole = (role) => typeof role === "string" && VALID_ROLES.includes(role);

// May `actor` create an account with, or assign, `role`?
const canAssignRole = (actor, role) => {
  if (!isValidRole(role)) return false;
  if (actor?.role === "super_admin") return true;
  return rankOf(role) < rankOf(actor?.role);
};

// May `actor` edit or remove an existing `target` account?
const canManageUser = (actor, target) => {
  if (actor?.role === "super_admin") return true;
  return rankOf(target?.role) < rankOf(actor?.role);
};

module.exports = {
  ROLE_RANK,
  VALID_ROLES,
  HOLDER_READ_ROLES,
  rankOf,
  isValidRole,
  canAssignRole,
  canManageUser,
};
