// ─── Per-account issue restrictions ──────────────────────────────────────────
// Lets an admin create a limited account — e.g. one that may only issue Invitee
// passes, and only via WhatsApp or the mobile app — and have that enforced on
// the SERVER, not merely hidden in the dashboard.
//
// Two allow-lists live on the User document:
//   allowedHolderTypeCodes: ["INV"]                  — by catCode, NOT ObjectId
//   allowedDeliveryMethods: ["whatsapp","mobile"]
//
// An EMPTY array means "no restriction" for that dimension. That keeps every
// existing account working exactly as before without a data migration.
//
// Why catCode and not the HolderType ObjectId: HolderType rows are per-event
// (unique on { eventId, catCode }), so an ObjectId allow-list would silently
// stop working the moment a new event is created. catCode ("INV", "SP", "DN",
// "VL", "GN") is the stable cross-event identifier.

const HolderType = require("../models/HolderType");

// Delivery methods an admin may CHOOSE when issuing. A subset of
// QRPass.deliveryMethod's enum — "third_party", "print" and "screen" are set
// by other code paths and are never offered in the issue UI.
// Keep in sync with the dashboard's lib/deliveryMethods.ts.
const ASSIGNABLE_DELIVERY_METHODS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
  { value: "both", label: "WhatsApp + Email" },
  { value: "mobile", label: "Mobile app" },
  { value: "mobile_whatsapp", label: "Mobile app + WhatsApp" },
  // Issues the pass and sends nothing — the issuer downloads or prints the QR
  // from the confirmation screen.
  { value: "none", label: "No auto-send (download / print)" },
];

const ASSIGNABLE_DELIVERY_VALUES = ASSIGNABLE_DELIVERY_METHODS.map((m) => m.value);

// super_admin is deliberately never restricted — otherwise an admin could lock
// themselves out of their own system with no way back in.
function isUnrestricted(user) {
  return String(user?.role || "") === "super_admin";
}

function normaliseCodes(list) {
  return (Array.isArray(list) ? list : [])
    .map((c) => String(c || "").trim().toUpperCase())
    .filter(Boolean);
}

function normaliseMethods(list) {
  return (Array.isArray(list) ? list : [])
    .map((m) => String(m || "").trim())
    .filter((m) => ASSIGNABLE_DELIVERY_VALUES.includes(m));
}

// ── Event scoping ────────────────────────────────────────────────────────────
// `allowedEvents` has existed on User for a long time but was only ever stored
// and displayed, never enforced. Turning it into a hard limit unconditionally
// would silently re-scope any existing account that happens to have an event
// assigned, so enforcement is opt-in per account via `restrictToAllowedEvents`
// (default false). New issuer accounts get it switched on.
function allowedEventIds(user) {
  return (Array.isArray(user?.allowedEvents) ? user.allowedEvents : [])
    // Populated by some endpoints, raw ObjectIds in others.
    .map((e) => String(e?._id || e || ""))
    .filter(Boolean);
}

/** True when this account's view is limited to specific events. */
function isEventScoped(user) {
  if (isUnrestricted(user)) return false;
  return user?.restrictToAllowedEvents === true && allowedEventIds(user).length > 0;
}

/** True when `user` may act on `eventId`. Unscoped accounts may act on any. */
function isEventAllowed(user, eventId) {
  if (!isEventScoped(user)) return true;
  return allowedEventIds(user).includes(String(eventId || ""));
}

/**
 * Checks whether `user` may issue this pass.
 *
 * Pass EITHER `catId` (it will be looked up) or an already-loaded `holderType`
 * to avoid a second query. `deliveryMethod` should be the EFFECTIVE value —
 * resolve your `|| "none"` default before calling, or an account barred from
 * "none" could slip a pass through by omitting the field.
 *
 * @returns null when allowed, else { status, body } ready to send.
 */
async function checkIssuePermission(user, { eventId, catId, holderType, deliveryMethod } = {}) {
  if (isUnrestricted(user)) return null;

  if (eventId !== undefined && !isEventAllowed(user, eventId)) {
    return {
      status: 403,
      body: {
        code: "EVENT_NOT_ALLOWED",
        error: "Your account is not assigned to this event.",
        allowedEvents: allowedEventIds(user),
      },
    };
  }

  const codes = normaliseCodes(user?.allowedHolderTypeCodes);
  if (codes.length > 0) {
    let type = holderType || null;
    if (!type && catId) {
      type = await HolderType.findById(catId).select("catCode name").lean();
    }
    const code = String(type?.catCode || "").toUpperCase();
    if (!code || !codes.includes(code)) {
      return {
        status: 403,
        body: {
          code: "HOLDER_TYPE_NOT_ALLOWED",
          error:
            `Your account is not allowed to issue ` +
            `"${type?.name || code || "this"}" passes.`,
          allowedHolderTypeCodes: codes,
        },
      };
    }
  }

  const methods = normaliseMethods(user?.allowedDeliveryMethods);
  if (methods.length > 0) {
    const requested = String(deliveryMethod || "");
    if (!methods.includes(requested)) {
      const label =
        ASSIGNABLE_DELIVERY_METHODS.find((m) => m.value === requested)?.label ||
        requested ||
        "(unspecified)";
      return {
        status: 403,
        body: {
          code: "DELIVERY_METHOD_NOT_ALLOWED",
          error: `Your account is not allowed to send passes via "${label}".`,
          allowedDeliveryMethods: methods,
        },
      };
    }
  }

  return null;
}

// ── Who may issue a SECOND pass for the same number + type + category ────────
// Deliberate duplicates are an admin judgement call: they are indistinguishable
// in the data from an accidental double-issue, and getting it wrong means two
// live QRs for one entitlement. Restricted desk accounts (issuer), campaign
// managers and preachers get the duplicate prompt but only the Replace option.
//
// To widen this, add the role here — it is enforced in one place.
const ROLES_MAY_ISSUE_ADDITIONAL = ["super_admin", "event_admin"];

function canIssueAdditionalPass(user) {
  return ROLES_MAY_ISSUE_ADDITIONAL.includes(String(user?.role || ""));
}

/**
 * True when this user may only see the passes they issued themselves.
 * super_admin always sees everything.
 */
function isLimitedToOwnHolders(user) {
  if (isUnrestricted(user)) return false;
  return user?.canViewAllHolders === false;
}

module.exports = {
  ROLES_MAY_ISSUE_ADDITIONAL,
  canIssueAdditionalPass,
  ASSIGNABLE_DELIVERY_METHODS,
  ASSIGNABLE_DELIVERY_VALUES,
  checkIssuePermission,
  isLimitedToOwnHolders,
  isUnrestricted,
  allowedEventIds,
  isEventScoped,
  isEventAllowed,
  normaliseCodes,
  normaliseMethods,
};
