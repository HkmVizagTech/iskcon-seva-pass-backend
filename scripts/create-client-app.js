// ─── Register a client app and print its API key (shown once) ─────────────────
//
// Usage:
//   node scripts/create-client-app.js --name "Vaikuntham app" --preset prasadam --events PRASADAM,SKJ26 --types PR
//   node scripts/create-client-app.js --name "Seva Pass app" --preset seva-pass-app
//   node scripts/create-client-app.js --name "FOLK" --scopes passes:issue,passes:read --events FOLK26 --rate 120
//
// --preset   prasadam | seva-pass-app | full         (or --scopes a,b,c)
// --events   event codes the app may use, or * (default *)
// --types    pass type codes (catCode) it may issue, or * (default *)
// --rate     requests per minute (default 300)
// --slug     short id (default: made from the name)
//
// The same thing is available over the API: POST /api/clients (super_admin).

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../.env") });

const ClientApp = require("../src/models/ClientApp");
const { SCOPES, generateKey, hashKey, keyHint } = require("../src/utils/clientKeys");

const PRESETS = {
  prasadam: ["prasadam:issue", "passes:read"],
  "seva-pass-app": ["events:read", "events:write", "passes:issue", "passes:read", "preachers:manage"],
  full: Object.keys(SCOPES),
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};
const list = (v, def) => (v ? v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : def);

async function main() {
  const name = arg("name");
  if (!name) throw new Error('--name is required, e.g. --name "Vaikuntham app"');
  const slug = (arg("slug") || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
  const scopes = arg("scopes") ? arg("scopes").split(",").map((s) => s.trim()) : PRESETS[arg("preset")];
  if (!scopes || !scopes.length || scopes.some((s) => !SCOPES[s])) {
    throw new Error(`--preset (${Object.keys(PRESETS).join("|")}) or --scopes (${Object.keys(SCOPES).join(",")}) is required`);
  }
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(process.env.MONGODB_URI);

  if (await ClientApp.findOne({ slug })) throw new Error(`A client with slug "${slug}" already exists`);

  const apiKey = generateKey();
  await ClientApp.create({
    name,
    slug,
    keyHash: hashKey(apiKey),
    keyHint: keyHint(apiKey),
    scopes,
    allowedEvents: list(arg("events"), ["*"]),
    allowedPassTypes: list(arg("types"), ["*"]),
    rateLimitPerMin: Number(arg("rate")) || 300,
  });

  console.log(`\nClient "${name}" (${slug}) created with scopes: ${scopes.join(", ")}`);
  console.log("\nAPI key (shown once — copy it now, send it as the X-API-Key header):\n");
  console.log(`  ${apiKey}\n`);
}

main()
  .catch((e) => {
    console.error("Failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
