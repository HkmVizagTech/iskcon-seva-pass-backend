const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, ".env") });

const axios = require("axios");

const API_URL = process.env.WHATSAPP_API_URL || "https://wapi.flaxxa.com/api/v1";
const TOKEN = process.env.WHATSAPP_API_KEY;

async function getTemplates() {
  console.log("📋 Fetching available templates...\n");

  try {
    const response = await axios.get(`${API_URL}/getTemplates`, {
      params: { token: TOKEN },
    });

    console.log("✅ Templates:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Failed:", error.response?.data || error.message);
  }
}

getTemplates();
