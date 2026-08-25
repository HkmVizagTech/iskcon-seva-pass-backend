# ISKCON Seva Pass — Integration API Documentation

> **For:** Mobile App / Community App Team (harekrishnavizag.co.in)
> **Base URL:** `https://iskcon-seva-pass-backend-production.up.railway.app`
> **Last Updated:** August 2026

---

## Authentication

All requests require an API key sent via header:

```
X-API-Key: <your-api-key>
```

Or alternatively:

```
Authorization: Bearer <your-api-key>
```

> The API key is shared separately. Do not expose it in client-side code.

---

## 1. Generate QR for Volunteers (Single)

Issue a QR pass for a single volunteer for a specific event.

```
POST /api/integration/generate-volunteer-qr
```

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | string | Yes | Event ID (eventCode, thirdPartyEventId, or MongoDB _id) |
| `user_phone_number` | string | Yes | 10-digit mobile number of the volunteer |
| `name` | string | No | Volunteer name (auto-generated if not provided) |
| `user_email` | string | No | Email address |
| `category` | string | No | Pass type code (e.g. `INV`, `SP`, `DN`, `VL`). Defaults to Invitee |
| `preacher` | string | No | Preacher name or short code for attribution |

### Example Request

```json
POST /api/integration/generate-volunteer-qr
Content-Type: application/json
X-API-Key: your-api-key-here

{
  "event_id": "TST2",
  "user_phone_number": "9876543210",
  "name": "Ramesh Kumar",
  "category": "INV"
}
```

### Success Response

```json
{
  "status": true,
  "message": "QR code generated successfully",
  "qr_id": "TST2-INV-0001"
}
```

### Existing Pass Response (Duplicate)

If the volunteer already has an active QR for this event, the existing pass is returned:

```json
{
  "status": true,
  "message": "QR code already exists — returning existing pass",
  "qr_id": "TST2-INV-0001"
}
```

> **Use `qr_id`** to generate the QR image on your side.

---

## 2. Generate QR for Volunteers (Bulk) — PRIMARY ENDPOINT

Issue QR passes for multiple volunteers at once. **This is the main endpoint the app should use when a devotee selects volunteers and clicks "Generate QR".**

```
POST /api/integration/generate-volunteer-qr/bulk
```

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | string | Yes | Event ID (eventCode, thirdPartyEventId, or MongoDB _id) |
| `holders` | array | Yes | Array of volunteer objects (max **200**) |
| `holders[].user_phone_number` | string | Yes | 10-digit mobile number |
| `holders[].name` | string | No | Volunteer name (auto-generated if not provided) |
| `category` | string | No | Pass type code (e.g. `INV`, `SP`, `DN`). Defaults to Invitee |
| `preacher` | string | No | Preacher name or short code for attribution |

### Example Request

```json
POST /api/integration/generate-volunteer-qr/bulk
Content-Type: application/json
X-API-Key: your-api-key-here

{
  "event_id": "TST2",
  "category": "INV",
  "holders": [
    { "user_phone_number": "9876543210", "name": "Ramesh Kumar" },
    { "user_phone_number": "9123456780", "name": "Suresh Rao" },
    { "user_phone_number": "8765432109", "name": "Prasad Reddy" }
  ]
}
```

### Success Response

```json
{
  "status": true,
  "message": "Processed 3 holders — 3 succeeded, 0 failed",
  "total": 3,
  "succeeded": 3,
  "failed": 0,
  "results": [
    {
      "success": true,
      "reused": false,
      "name": "Ramesh Kumar",
      "phone": "919876543210",
      "qr_id": "TST2-INV-0001"
    },
    {
      "success": true,
      "reused": false,
      "name": "Suresh Rao",
      "phone": "919123456780",
      "qr_id": "TST2-INV-0002"
    },
    {
      "success": true,
      "reused": true,
      "name": "Prasad Reddy",
      "phone": "918765432109",
      "qr_id": "TST2-INV-0003"
    }
  ]
}
```

### Partial Failure Response

```json
{
  "status": true,
  "message": "Processed 3 holders — 2 succeeded, 1 failed",
  "total": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    {
      "success": true,
      "reused": false,
      "name": "Ramesh Kumar",
      "phone": "919876543210",
      "qr_id": "TST2-INV-0001"
    },
    {
      "success": false,
      "error": "Invalid phone number",
      "input": { "user_phone_number": "123" }
    },
    {
      "success": true,
      "reused": true,
      "name": "Suresh Rao",
      "phone": "919123456780",
      "qr_id": "TST2-INV-0002"
    }
  ]
}
```

### Response Fields

| Field | Description |
|-------|-------------|
| `status` | `true` if request was processed (check individual results for failures) |
| `total` | Total number of holders processed |
| `succeeded` | Number of successfully generated QRs |
| `failed` | Number of failures |
| `results[]` | Per-holder result array |
| `results[].success` | Whether this holder's QR was generated |
| `results[].reused` | `true` if an existing QR was returned (holder already had one) |
| `results[].qr_id` | **The QR ID string — use this to render the QR code image** |
| `results[].name` | Volunteer name |
| `results[].phone` | Normalized phone (12-digit with country code) |
| `results[].error` | Error message (only when `success: false`) |

---

## 3. Get QR Pass Status

Check the live status and scan history of a QR pass.

```
GET /api/integration/qr/:qrId
```

### Example Request

```
GET /api/integration/qr/TST2-INV-0001
X-API-Key: your-api-key-here
```

### Response

```json
{
  "status": "active",
  "qrId": "TST2-INV-0001",
  "holder": {
    "name": "Ramesh Kumar",
    "phone": "919876543210",
    "email": null
  },
  "event": {
    "name": "Rath Yatra 2026",
    "eventCode": "TST2"
  },
  "category": {
    "name": "Invitee",
    "catCode": "INV"
  },
  "entryPoints": [
    { "name": "Main Gate", "stationLabel": "MG-01" }
  ],
  "validFrom": "2026-08-20T00:00:00.000Z",
  "validUntil": "2026-08-25T23:59:59.000Z",
  "redemptionHistory": [
    {
      "scannedAt": "2026-08-20T08:30:00.000Z",
      "epId": "...",
      "result": "granted",
      "stationLabel": "Main Gate"
    }
  ]
}
```

---

## 4. Health Check

Verify the API is reachable (no auth required).

```
GET /api/integration/status
```

### Response

```json
{
  "status": true,
  "message": "ISKCON Seva Pass API is operational",
  "timestamp": "2026-08-20T10:30:00.000Z"
}
```

---

## 5. List Events

Get all events to sync into the mobile app.

```
GET /api/integration/events
```

### Query Params

| Param | Values | Description |
|-------|--------|-------------|
| `status` | `upcoming`, `active`, `completed` | Filter by date-derived status |
| `search` | string | Search by name or eventCode |

### Response

```json
[
  {
    "_id": "...",
    "name": "Rath Yatra 2026",
    "eventCode": "TST2",
    "dateStart": "2026-08-20T00:00:00.000Z",
    "dateEnd": "2026-08-25T23:59:59.000Z",
    "venue": [{ "name": "ISKCON Temple", "address": "Visakhapatnam" }],
    "description": "Annual Rath Yatra festival"
  }
]
```

---

## 6. Get Event Categories (Pass Types)

Get available pass types for an event (for the category picker in the app).

```
GET /api/integration/events/:eventCode/categories
```

### Response

```json
[
  {
    "_id": "...",
    "name": "Invitee",
    "catCode": "INV",
    "entryPoints": [
      { "name": "Main Gate", "stationLabel": "MG-01", "type": "venue_entry" }
    ],
    "limit": 100,
    "used": 23,
    "remaining": 77
  }
]
```

---

## How It Works — End-to-End Flow

```
Devotee App                    Seva Pass Backend              Community App
    |                                |                              |
    |  1. GET /events                |                              |
    |  ─────────────────────────────>│                              |
    |  <────── event list            │                              |
    |                                |                              |
    |  2. GET /events/:code/categories                              |
    |  ─────────────────────────────>│                              |
    |  <────── category list         │                              |
    |                                |                              |
    |  3. User selects volunteers    │                              |
    |     clicks "Generate QR"      │                              |
    |                                │                              |
    |  4. POST /generate-volunteer-qr/bulk                          |
    |     { event_id, holders[] }    │                              |
    |  ─────────────────────────────>│                              |
    |                                │── push register-volunteer ──>│
    |                                │── push seva-sponsor ────────>│
    |                                │── push store-qr-code ───────>│
    |  <────── results[{qr_id}]      │                              |
    |                                │                              |
    |  5. App renders QR images      │                              |
    |     using qr_id strings        │                              |
    |                                │                              |
    |  6. GET /qr/:qrId              │                              |
    |     (check scan status)        │                              |
    |  ─────────────────────────────>│                              |
    |  <────── status + history      │                              |
```

---

## Important Notes

### Event ID Resolution
The `event_id` field accepts any of these formats:
- **Event code** (e.g. `TST2`) — case-insensitive
- **Third-party event ID** (e.g. `EVT1024`) — if configured
- **MongoDB ObjectId** (e.g. `507f1f77bcf86cd799439011`)

### Phone Number Format
- Send **10-digit** numbers (e.g. `9876543210`)
- The system normalizes to 12-digit with country code (e.g. `919876543210`)

### Category Resolution
If no `category` is sent, the system tries in order:
1. `INV` (Invitee) — default for devotee app
2. `GN` (General Public)
3. Any category named "volunteer"

### Duplicate Handling
- If a holder already exists for that phone + event, the **existing QR is returned**
- `reused: true` in the response indicates this
- No duplicate QRs are created

### Auto-Creation
- If the phone number doesn't exist as a holder for that event, a new holder is **automatically created**
- Name defaults to `Devotee <last 4 digits of phone>` if not provided

### QR ID Format
QR IDs follow the pattern: `{eventCode}-{catCode}-{sequence}`
Example: `TST2-INV-0001`, `TST2-SP-0042`

### Limits
- Single endpoint: 1 holder per call
- Bulk endpoint: max **200 holders** per call
- For more than 200, split into multiple requests
