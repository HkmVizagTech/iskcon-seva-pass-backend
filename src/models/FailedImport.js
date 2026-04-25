const mongoose = require("mongoose");

const failedImportSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: true,
  },
  batchId: {
    type: String,
    required: true,
  },
  records: [{
    name: String,
    phone: String,
    email: String,
    error: String,
    rowData: mongoose.Schema.Types.Mixed,
  }],
  totalCount: Number,
  failedCount: Number,
  successCount: Number,
  importedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("FailedImport", failedImportSchema);
