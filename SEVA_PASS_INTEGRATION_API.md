# Seva Pass — QR Generation API

> **For:** Mobile App Team
> **Base URL:** `https://iskcon-seva-pass-backend-production.up.railway.app`
> **Version:** 2.0 — August 2026

---

## Endpoint

```
POST /api/integration/generate-volunteer-qr
```

No authentication required.

---

## Request

Send the event ID and a list of volunteer phone numbers. The system auto-creates holders if they don't exist, and returns existing QRs for duplicates.

```json
{
  "event_id": "TST2",
  "holders": [
    { "user_phone_number": "9876543210", "name": "Ramesh Kumar" },
    { "user_phone_number": "9123456780", "name": "Suresh Rao" },
    { "user_phone_number": "8765432109" }
  ]
}
```

### Fields

| Field                        | Type   | Required | Description                                  |
| ---------------------------- | ------ | -------- | -------------------------------------------- |
| `event_id`                   | string | Yes      | Event code (e.g. `TST2`) or MongoDB ID       |
| `holders`                    | array  | Yes      | List of volunteers (max **200**)              |
| `holders[].user_phone_number`| string | Yes      | 10-digit mobile number                       |
| `holders[].name`             | string | No       | Volunteer name (auto-generated if omitted)   |

---

## Response

### All Success

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

### Partial Failure

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

| Field               | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `status`            | `true` if request was processed                            |
| `total`             | Total holders processed                                    |
| `succeeded`         | Number of QRs generated                                    |
| `failed`            | Number of failures                                         |
| `results[].success` | Whether this holder's QR was generated                     |
| `results[].reused`  | `true` if holder already had an active QR (existing returned) |
| `results[].qr_id`   | **The QR ID — render this as a QR image on your side**     |
| `results[].name`    | Volunteer name                                             |
| `results[].phone`   | Normalized phone (12-digit with country code)              |
| `results[].error`   | Error message (only when `success: false`)                 |

---

## Behaviour

**Event Resolution** — `event_id` matches in order: event code, third-party event ID, MongoDB ObjectId.

**Phone Numbers** — Send 10-digit. System normalizes to 12-digit with country code (e.g. `9876543210` → `919876543210`).

**Auto-Creation** — If the phone doesn't exist as a holder for that event, a new holder is created automatically. Name defaults to `Devotee <last 4 digits>` if not provided.

**Duplicate Handling** — If a holder already has an active QR for that event, the existing `qr_id` is returned with `"reused": true`. No duplicates are created.

**QR ID Format** — `{eventCode}-{catCode}-{sequence}` (e.g. `TST2-INV-0001`).

**Category** — Auto-resolved (Invitee → General Public → Volunteer). No need to send.

**Limits** — Max 200 holders per request. Split larger batches into multiple calls.
