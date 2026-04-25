const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, ".env") });

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

const BASE_URL = process.env.WHATSAPP_API_URL || "https://wapi.flaxxa.com/api/v1";
const TOKEN = process.env.WHATSAPP_API_KEY;

async function testSimple() {
  console.log("🧪 Testing simple message (no template)\n");

  const form = new FormData();
  form.append("token", TOKEN);
  form.append("phone", "916301393962");
  form.append("message", "*ISKCON Seva Pass* 🕉️\n\nHare Krishna! 🙏\n\nThis is a test message from ISKCON Seva Pass system.\n\nYour QR pass will be sent shortly.");

  try {
    const response = await axios.post(`${BASE_URL}/sendmessage`, form, {
      headers: form.getHeaders(),
    });
    console.log("✅ Simple message:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Failed:", error.response?.data || error.message);
  }
}

async function testWithImage() {
  console.log("\n🧪 Testing message with attachment\n");

  const qrPath = path.join(__dirname, "uploads", "test-qr.png");

  const form = new FormData();
  form.append("token", TOKEN);
  form.append("phone", "916301393962");
  form.append("message", "*ISKCON Seva Pass* 🕉️\n\nDear Rajesh,\n\nYour pass for Janmashtami 2025 is ready!\n\nAccess: Darshan, Prasadam\nValid: 26th Apr, 4:00 PM\n\nPlease show this QR code at the respective counters.\n\nHare Krishna! 🙏");
  form.append("header", "ISKCON Seva Pass");
  form.append("footer", "Hare Krishna 🙏");
  form.append("buttons", "");
  form.append("header_attachment", fs.createReadStream(qrPath), {
    filename: "QR-Pass.png",
    contentType: "image/png",
  });

  try {
    const response = await axios.post(`${BASE_URL}/sendmessagewithattachment`, form, {
      headers: form.getHeaders(),
    });
    console.log("✅ Message with image:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Failed:", error.response?.data || error.message);
  }
}

async function run() {
  await testSimple();
  await new Promise(r => setTimeout(r, 2000));
  await testWithImage();
}

run();
