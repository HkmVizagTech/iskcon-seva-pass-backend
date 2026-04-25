const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

const fileFilter = (req, file, cb) => {
  console.log(
    "📁 Uploading file:",
    file.originalname,
    "| MIME:",
    file.mimetype,
  );

  // Check by extension (more reliable than MIME)
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = [".csv", ".xlsx", ".xls"];

  if (allowedExtensions.includes(ext)) {
    return cb(null, true);
  }

  // Also check MIME types
  const allowedMimes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream", // Some browsers send this for Excel
  ];

  if (allowedMimes.includes(file.mimetype)) {
    return cb(null, true);
  }

  cb(
    new Error(
      `Invalid file type. Allowed: CSV, Excel (.xlsx, .xls). Got: ${ext} (${file.mimetype})`,
    ),
  );
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: fileFilter,
});

module.exports = upload;
