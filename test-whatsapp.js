const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, ".env") });

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

const BASE_URL = "https://wapi.flaxxa.com/api/v1";
const TOKEN = process.env.WHATSAPP_API_KEY;
const PHONE = process.argv[2] || "916301393962";

function cleanPhone(p) {
  let cleaned = p.replace(/[\+\s\-\(\)]/g, "");
  if (cleaned.length === 10) cleaned = "91" + cleaned;
  return cleaned.startsWith("91") ? cleaned : `91${cleaned}`;
}

async function test() {
  console.log("🧪 Testing Template with Attachment (FIXED)\n");

  const qrPath = path.join(__dirname, "uploads", "test-qr.png");
  const phone = cleanPhone(PHONE);
  console.log("📱 Phone:", phone);

  // EXACTLY matching the working pattern
  const form = new FormData();
  form.append("token", TOKEN);
  form.append("phone", phone);
  form.append("template_name", "common_qr_template");
  form.append("template_language", "en");
  form.append(
    "components",  // ← KEY: "components" NOT "components[]"
    JSON.stringify([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Rajesh Kumar" },
          { type: "text", text: "Janmashtami 2025" },
          { type: "text", text: "26th Apr" },
          { type: "text", text: "4:00 PM" },
          { type: "text", text: "ISKCON Temple, Vizag" },
          { type: "text", text: "8977761187" },
          { type: "text", text: "Darshan, Prasadam" },
        ],
      },
    ]),
  );
  form.append("header_attachment", fs.createReadStream(qrPath), {
    filename: "QR-Pass.png",
    contentType: "image/png",
  });

  try {
    console.log("📤 Sending...");
    const response = await axios.post(
      `${BASE_URL}/sendtemplatemessage_withattachment`,
      form,
      { headers: form.getHeaders() },
    );
    console.log("✅ SUCCESS:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Failed:", error.response?.data || error.message);
  }
}

test();
