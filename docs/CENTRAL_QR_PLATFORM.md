# Central QR platform — integration guide

One system issues and scans QR passes for every temple event and for anything else that needs a QR:
event entry, prasadam coupons, volunteer passes, sevas. Apps (Vaikuntham, the Seva Pass devotee app,
FOLK, ...) call this API to issue passes; volunteers scan them with the scanner app.

## Concepts

| Term | Meaning |
|---|---|
| **Event** | Something passes belong to, with a code (`SKJ26`). A *standing event* (e.g. `PRASADAM`) never ends and serves many dated sessions. |
| **Pass type** | `catCode` of a pass (`SP` sponsor, `PR` prasadam coupon, ...). It decides which counters/gates accept the QR. |
| **Entry point** | A gate or counter where QRs are scanned. Volunteers are assigned to entry points in the dashboard. |
| **Session** | One dated occasion on a standing event ("Sunday Feast, 11 Oct"). A person gets one QR per session, valid only in that window. |
| **Client app** | A registered consumer of this API with its own key, scopes, event allowlist and rate limit. |

## Authentication

Send the client's key as `X-API-Key: skp_live_...` (or `Authorization: Bearer ...`).

Keys are created by a super admin, once per app, and shown only once:

```bash
node scripts/create-client-app.js --name "Vaikuntham app" --preset prasadam --events PRASADAM --types PR
```

or `POST /api/clients` (super admin JWT). Manage with `GET /api/clients`, `PATCH /api/clients/:id`
(scopes, events, status `active|disabled`, rate limit), `POST /api/clients/:id/rotate-key`,
`DELETE /api/clients/:id`. `GET /api/clients/scopes` lists scopes and presets.

| Scope | Allows |
|---|---|
| `events:read` | list events, venues, entry points, pass types |
| `events:write` | change which pass types the devotee app may use |
| `passes:issue` | seva pass issue, volunteer QR, `POST /passes` |
| `prasadam:issue` | `POST /prasadam/qr`, `/prasadam/qr/bulk` |
| `passes:read` | `GET /qr/:qrId` (status + scan history) |
| `preachers:manage` | create / list / remove preachers |

A request outside the key's scopes gets `403`; an event or pass type outside its allowlist gets `403`
(or `404` when reading a pass). The old shared `INTEGRATION_API_KEY` still works as an unrestricted
"legacy" client; give each app its own key and then remove it.

## Issue a pass (any purpose)

`POST /api/integration/passes`

```json
{
  "event_id": "PRASADAM",
  "type": "PR",
  "phone": "9951141915",
  "name": "Devotee",
  "valid_for_date": "2026-10-11",
  "valid_from": "2026-10-11T04:00:00Z",
  "valid_until": "2026-10-11T09:30:00Z",
  "session_ref": "42"
}
```

* `event_id`, `phone` required. `type` defaults to `PR`.
* **Session fields** (all optional): `valid_for_date` (an IST day), `valid_from` / `valid_until` (ISO),
  `session_ref` (your id for the session). `session_ref` needs a date or `valid_until`.
  Window may not exceed 31 days and may not already be over.
* With a session: one QR per phone per `(your app, session_ref)`. Same session again returns the same
  `qr_id` (and follows a changed window); a new session returns a fresh one. The pass scans only inside
  its window and only once.
* Without session fields: one QR per phone per event.

`POST /api/integration/prasadam/qr` is the same call with `type` fixed to `PR`.

Response: `{ status, message, qr_id, name, phone, holder, category, valid_from?, valid_until?, session_ref? }`.
Render `qr_id` as the QR. Pass ids are unguessable (60 random bits), so the bare id is accepted by the scanner.

## Check whether it was used

`GET /api/integration/qr/:qrId` → `{ status, redemptionHistory: [{ result, scannedAt, stationLabel }], validFrom, validUntil, ... }`.
A `granted` entry means it was scanned.

## Standing events

```bash
node scripts/create-standing-event.js --code PRASADAM --name "Weekend Prasadam"
```

Creates the event, its "Prasadam Coupon Counter" and the `PR` pass type. Then assign the counter to the
volunteers who run it (dashboard → Volunteers). For another purpose, create another standing event and a
client (or allowlist entry) for it; no code change.

## Scan from your own app

`POST /api/integration/scan` (scope `passes:scan`) lets an app run its own counter scanners while
this system still decides "valid, once only, inside its window".

```json
{ "qr": "ISK-PRASADAM-PR-...", "event_id": "PRASADAM", "client_scan_id": "8f3c...",
  "scanned_by": { "ref": "user-42", "name": "Ramesh", "phone": "9000000007" } }
```

* `station` (optional): an entry point id of that event, or a type — default `prasadam_coupon`.
* `client_scan_id` (required, unique per scan): a retry with the same id returns the original verdict.
* `scanned_by.ref` (required): your id for the person; the app is responsible for who may scan.
* Only pass types in the key's `allowedPassTypes` are redeemed; others answer `not_included`
  without revealing the holder.
* Response = the volunteer scanner's verdict: `result` granted | already_used | expired | not_yet_valid |
  not_included | revoked | invalid | duplicate, `holderName`, `categoryName`, `windowed`/`validFrom`/`validUntil`,
  and on `already_used` a `lastUsed: { at, station, by }`.
