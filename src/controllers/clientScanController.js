// ─── Scanning from a registered client app ───────────────────────────────────
// POST /api/integration/scan   (scope passes:scan, event allowlist enforced)
//
// Lets an app such as the community app scan passes at a counter with its own
// scanners (people the app has authorised), while the decision — valid, once
// only, inside its window — stays here, exactly as for the volunteer scanner.
// The app vouches for who scanned; we record it with the scan.
//
// Body: { qr, event_id, station?, client_scan_id, scanned_by: { ref, name?, phone? }, venue? }
//   station: an entry point id of that event, or an entry point TYPE
//            (default "prasadam_coupon" — the event's coupon counter).

const Event = require("../models/Event");
const EntryPoint = require("../models/EntryPoint");
const { isObjectId } = require("../utils/objectId");
const { processScan } = require("./scanController");

const str = (v, max) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "");

exports.scan = async (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    let qr = typeof b.qr === "string" ? b.qr.trim() : "";
    // Some barcode readers wrap the text as {"String": "..."}
    if (qr.startsWith("{")) {
      try { const o = JSON.parse(qr); if (typeof o.String === "string") qr = o.String.trim(); } catch (_) { /* keep */ }
    }
    const eventRef = str(b.event_id, 60);
    const scanId = str(b.client_scan_id, 80);
    const scanner = b.scanned_by && typeof b.scanned_by === "object" ? b.scanned_by : {};
    const scannerRef = str(scanner.ref, 60);

    if (!qr || qr.length > 2000) return res.status(400).json({ success: false, result: "invalid", message: "qr is required" });
    if (!eventRef) return res.status(400).json({ success: false, result: "invalid", message: "event_id is required" });
    if (!scanId) return res.status(400).json({ success: false, result: "invalid", message: "client_scan_id is required" });
    if (!scannerRef) return res.status(400).json({ success: false, result: "invalid", message: "scanned_by.ref is required" });

    const event = await Event.findOne({
      $or: [
        { eventCode: eventRef.toUpperCase() },
        { thirdPartyEventId: eventRef },
        { _id: /^[0-9a-fA-F]{24}$/.test(eventRef) ? eventRef : null },
      ],
    }).select("_id eventCode").lean();
    if (!event) return res.status(404).json({ success: false, result: "invalid", message: `Event not found: ${eventRef}` });

    const station = str(b.station, 40) || "prasadam_coupon";
    const ep = isObjectId(station)
      ? await EntryPoint.findOne({ _id: station, eventId: event._id }).select("_id stationLabel").lean()
      : await EntryPoint.findOne({ eventId: event._id, type: station }).select("_id stationLabel").lean();
    if (!ep) return res.status(404).json({ success: false, result: "invalid", message: `No ${station} counter for event ${event.eventCode}` });

    const out = await processScan({
      client: req.client,
      scanner: { ref: scannerRef, name: str(scanner.name, 80) || undefined, phone: str(scanner.phone, 20) || undefined },
      qrData: qr,
      epId: String(ep._id),
      stationLabel: ep.stationLabel || "",
      venue: str(b.venue, 120) || undefined,
      // Namespaced per app so two apps' scan ids can never collide
      clientScanId: `${req.client.slug}:${scanId}`,
      deviceInfo: {},
      ip: req.ip,
      // client_scan_id makes retries idempotent; a second scanner must see
      // "already used", not a silent duplicate (redemption itself is atomic).
      useMemoryDedup: false,
    });
    return res.status(out.status).json(out.body);
  } catch (error) {
    console.error("[Integration] client scan error:", error);
    return res.status(500).json({ success: false, result: "invalid", message: "Scan processing failed" });
  }
};
