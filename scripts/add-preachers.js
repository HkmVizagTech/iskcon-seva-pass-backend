// ─── Bulk-add preacher accounts from a CSV ───────────────────────────────────
// Creates User documents with role "preacher" — the same thing the dashboard's
// Preachers page does one at a time, and with the SAME validation rules as
// POST /api/preachers (see controllers/preacherController.js):
//
//   • name       required
//   • shortCode  required, 2–10 letters/digits, uppercased, must be unique.
//                This is the value the bulk-import CSV's "Preacher" column
//                matches on, so it has to be right.
//   • email or phone — at least one required; email must be unique if given
//   • password   at least 6 chars. Leave the column blank and a strong random
//                one is generated and printed for you to hand over.
//
// Idempotent: a row whose shortCode or email already exists is SKIPPED and
// reported, never overwritten — so you can re-run the same file after fixing
// two bad rows without creating duplicates.
//
// Usage:
//   node scripts/add-preachers.js --file=scripts/preachers.csv [--dry-run]
//
//   --dry-run   validate and report, write nothing. Always do this first.
//   --file=     path to the CSV (default scripts/preachers.csv)
//
// CSV columns (header row required, order and case don't matter):
//   Name,ShortCode,Email,Phone,Password
//
// The CSV holds personal data and possibly passwords: keep it out of git
// (scripts/preachers*.csv is gitignored) and delete it once you're done.

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

dotenv.config({ path: path.join(__dirname, "../.env") });

const User = require("../src/models/User");

const DRY_RUN = process.argv.includes("--dry-run");
const fileArg = process.argv.find((a) => a.startsWith("--file="));
const CSV_PATH = path.resolve(
  process.cwd(),
  fileArg ? fileArg.slice("--file=".length) : path.join(__dirname, "preachers.csv"),
);
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/iskcon_seva_pass";

// ── Minimal CSV reader ───────────────────────────────────────────────────────
// Deliberately dependency-free (handles quoted fields, embedded commas,
// escaped "" quotes and CRLF) so this script has nothing to install.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = text.replace(/^﻿/, ""); // strip BOM Excel likes to add
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

// Mirrors validateShortCode() in preacherController.js — keep in sync.
function validateShortCode(code) {
  const clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 2 || clean.length > 10) {
    throw new Error("Short code must be 2–10 letters/numbers (e.g. MKGD)");
  }
  return clean;
}

// Readable but strong: 12 chars from an unambiguous alphabet (no O/0, l/1/I).
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(12))
    .map((b) => alphabet[b % alphabet.length])
    .join("");
}

function pick(row, headers, ...names) {
  for (const n of names) {
    const i = headers.indexOf(n.toLowerCase());
    if (i !== -1 && String(row[i] ?? "").trim()) return String(row[i]).trim();
  }
  return "";
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(
      `CSV not found: ${CSV_PATH}\n` +
      `Create it with a header row:  Name,ShortCode,Email,Phone,Password`,
    );
  }

  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  if (rows.length < 2) throw new Error("CSV has a header but no data rows.");

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const dataRows = rows.slice(1);

  console.log(`📄 ${CSV_PATH}`);
  console.log(`   ${dataRows.length} data row(s)${DRY_RUN ? "  (dry run)" : ""}\n`);

  console.log(`📡 Connecting to MongoDB...`);
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected\n");

  const created = [], skipped = [], failed = [];
  // Catches duplicates WITHIN the file itself, which the DB checks alone would
  // only surface on the second insert.
  const seenCodes = new Set(), seenEmails = new Set();

  for (let i = 0; i < dataRows.length; i++) {
    const rowNo = i + 2; // 1-based, +1 for the header
    const row = dataRows[i];
    const name = pick(row, headers, "name", "full name", "preacher");
    const rawCode = pick(row, headers, "shortcode", "short code", "code");
    const email = pick(row, headers, "email", "email address").toLowerCase();
    const phone = pick(row, headers, "phone", "phone number", "mobile");
    let password = pick(row, headers, "password", "pass");

    const fail = (msg) => failed.push({ rowNo, name: name || "(blank)", error: msg });

    if (!name) { fail("Name is required"); continue; }
    if (!rawCode) { fail("ShortCode is required (e.g. MKGD)"); continue; }
    if (!email && !phone) { fail("Email or Phone is required"); continue; }

    let shortCode;
    try { shortCode = validateShortCode(rawCode); }
    catch (e) { fail(e.message); continue; }

    let generated = false;
    if (!password) { password = generatePassword(); generated = true; }
    if (password.length < 6) { fail("Password must be at least 6 characters"); continue; }

    if (seenCodes.has(shortCode)) {
      fail(`ShortCode '${shortCode}' appears more than once in this file`);
      continue;
    }
    if (email && seenEmails.has(email)) {
      fail(`Email '${email}' appears more than once in this file`);
      continue;
    }

    const byCode = await User.findOne({ shortCode }).select("name role").lean();
    if (byCode) {
      skipped.push({ rowNo, name, shortCode,
        reason: `ShortCode already used by ${byCode.name} (${byCode.role})` });
      continue;
    }
    if (email) {
      const byEmail = await User.findOne({ email }).select("name role").lean();
      if (byEmail) {
        skipped.push({ rowNo, name, shortCode,
          reason: `Email already registered to ${byEmail.name} (${byEmail.role})` });
        continue;
      }
    }

    seenCodes.add(shortCode);
    if (email) seenEmails.add(email);

    if (DRY_RUN) {
      created.push({ rowNo, name, shortCode, email, phone, password: generated ? "(would generate)" : "(from CSV)" });
      continue;
    }

    try {
      // Via the model, so the pre-save hook hashes the password.
      const doc = await User.create({
        name,
        shortCode,
        email: email || undefined,
        phone: phone || undefined,
        password,
        role: "preacher",
        isActive: true,
        // No allowedEvents — preachers work across all festivals, matching
        // createPreacher() in the controller.
      });
      created.push({ rowNo, name: doc.name, shortCode: doc.shortCode,
        email: doc.email || "", phone: doc.phone || "",
        password: generated ? password : "(as supplied)" });
    } catch (e) {
      fail(e.code === 11000 ? "Email or short code already in use" : e.message);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const line = (n) => "─".repeat(n);
  console.log(`${DRY_RUN ? "WOULD CREATE" : "CREATED"}: ${created.length}   SKIPPED: ${skipped.length}   FAILED: ${failed.length}\n`);

  if (created.length) {
    console.log(DRY_RUN ? "── Would create ──" : "── Created — hand these credentials over, then delete the CSV ──");
    console.log(`${"CODE".padEnd(11)}${"NAME".padEnd(26)}${"LOGIN".padEnd(30)}PASSWORD`);
    console.log(line(90));
    for (const c of created) {
      console.log(
        `${c.shortCode.padEnd(11)}${c.name.slice(0, 25).padEnd(26)}` +
        `${(c.email || c.phone).slice(0, 29).padEnd(30)}${c.password}`,
      );
    }
    console.log("");
  }

  if (skipped.length) {
    console.log("── Skipped (already exist — nothing was changed) ──");
    for (const s of skipped) console.log(`  row ${s.rowNo}  ${s.name} [${s.shortCode}] — ${s.reason}`);
    console.log("");
  }

  if (failed.length) {
    console.log("── Failed (fix these rows and re-run; created rows are skipped) ──");
    for (const f of failed) console.log(`  row ${f.rowNo}  ${f.name} — ${f.error}`);
    console.log("");
  }

  if (DRY_RUN) {
    console.log("🔍 Dry run — nothing was written. Re-run without --dry-run to apply.");
  } else if (created.length) {
    console.log("⚠️  The passwords above are shown ONCE. Copy them now.");
    console.log("   Preachers can change theirs from Settings after logging in.");
  }

  await mongoose.disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\n❌ Failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
