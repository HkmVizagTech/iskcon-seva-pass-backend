# Hare Krishna Vizag

# Seva Pass API Documentation

## Generate QR Pass

---

**Base URL**

```
https://iskcon-seva-pass-backend-production.up.railway.app
```

---

**General Notes**

- All endpoints are prefixed with: `api/integration/`
- The Generate QR endpoint uses the HTTP POST method.
- Request bodies are sent as JSON.
- If a volunteer does not already exist by mobile number, the system automatically creates one.
- No authentication is required for the Generate QR endpoint.

---

**Standard Response Format**

Every endpoint in this API returns a response in the following shape:

```json
{
  "status": true,
  "message": "string",
  "total": 0,
  "succeeded": 0,
  "failed": 0,
  "results": []
}
```

- **status** (boolean) — true if the request was processed successfully, false on validation/error.
- **message** (string) — Human-readable description of the result.
- **total** (number) — Total number of holders processed.
- **succeeded** (number) — Number of QR passes successfully generated.
- **failed** (number) — Number of failures.
- **results** (array) — Per-holder result array. See Response Fields below.

---

### 1. Generate QR Pass (Bulk)

Generates QR passes for multiple volunteers at once for a specific festival/event. If a volunteer does not already exist (matched by mobile number), a new holder record is created automatically. If a volunteer already has an active QR pass for the given event, the existing QR ID is returned instead of creating a duplicate.

```
POST /api/integration/generate-volunteer-qr
```

---

**Request Body Parameters**

- **event_id** (string, required) — Event ID of the festival. Matches by event code (e.g. "TST2"), third-party event ID, or MongoDB ObjectId.
- **holders** (array, required) — Array of volunteer objects. Maximum 200 per request.
- **holders[].user_phone_number** (string, required) — Exactly 10 digits. Mobile number of the volunteer. New holder is created if not found.
- **holders[].name** (string, optional) — Full name of the volunteer. If not provided, auto-generated as "Devotee" followed by the last 4 digits of the phone number.

---

**Sample Request**

```
POST https://iskcon-seva-pass-backend-production.up.railway.app/api/integration/generate-volunteer-qr
Content-Type: application/json

{
  "event_id": "TST2",
  "holders": [
    { "user_phone_number": "9876543210", "name": "Ramesh Kumar" },
    { "user_phone_number": "9123456780", "name": "Suresh Rao" },
    { "user_phone_number": "8765432109" }
  ]
}
```

---

**Sample Responses**

Success — All volunteers processed:

```
HTTP 200 OK
```

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

Success — Volunteer already has an active QR (duplicate check):

```json
{
  "success": true,
  "reused": true,
  "name": "Prasad Reddy",
  "phone": "918765432109",
  "qr_id": "TST2-INV-0003"
}
```

> Note: A duplicate is detected by the combination of event and phone number. If a holder already has an active QR pass for the given event, the existing qr_id is returned with "reused": true. No duplicate QR pass is created.

Partial failure — Some holders succeeded, some failed:

```
HTTP 200 OK
```

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

---

**Response Fields**

- **results[].success** (boolean) — Whether this holder's QR pass was generated successfully.
- **results[].reused** (boolean) — true if an existing QR pass was returned (holder already had one for this event).
- **results[].qr_id** (string) — The QR pass identifier. Use this value to render the QR code image on the client side.
- **results[].name** (string) — Name of the volunteer.
- **results[].phone** (string) — Normalized phone number (12-digit with country code, e.g. "919876543210").
- **results[].error** (string) — Error description. Only present when success is false.

---

**QR ID Format**

QR IDs follow the pattern: {eventCode}-{categoryCode}-{sequence}

Example: TST2-INV-0001, TST2-SP-0042

The mobile app should convert this QR ID string into a QR code image for display.

---

**Event ID Resolution**

The event_id field is matched in the following order:

1. Event code (e.g. "TST2") — case-insensitive
2. Third-party event ID (e.g. "EVT1024") — if configured on the event
3. MongoDB ObjectId (e.g. "507f1f77bcf86cd799439011")

---

**Phone Number Format**

- Send exactly 10-digit mobile numbers (e.g. "9876543210")
- The system normalizes to 12-digit with country code (e.g. "919876543210")

---

**Category Resolution**

The pass type (category) is automatically resolved by the system in the following order if not specified:

1. Invitee (code: INV) — default
2. General Public (code: GN)
3. Any category named "volunteer"

No category parameter needs to be sent in the request.

---

**Limits**

- Maximum 200 holders per request
- For more than 200 volunteers, split into multiple requests

---

**Error Responses**

All endpoints validate incoming data before processing. If validation fails, the following format is returned:

```
HTTP 400 Bad Request
```

```json
{
  "status": false,
  "message": "event_id is required"
}
```

```
HTTP 400 Bad Request
```

```json
{
  "status": false,
  "message": "holders must be a non-empty array"
}
```

```
HTTP 400 Bad Request
```

```json
{
  "status": false,
  "message": "Maximum 200 holders per bulk request"
}
```

```
HTTP 404 Not Found
```

```json
{
  "status": false,
  "message": "Event not found for event_id: INVALID_CODE"
}
```

```
HTTP 500 Internal Server Error
```

```json
{
  "status": false,
  "message": "Failed to process bulk QR generation"
}
```

---

**Common Validation Failure Reasons**

- A required field (event_id or holders) is missing from the request body.
- The holders array is empty or exceeds 200 entries.
- event_id does not match any record in the system.
- A mobile number field is not exactly 10 digits.
