const { body, validationResult } = require("express-validator");
const mongoose = require("mongoose");

// For router.param(): rejects a malformed ObjectId with 400 instead of letting
// Mongoose throw a CastError that surfaces as a 500.
const objectIdParam = (req, res, next, value) => {
  if (!mongoose.isObjectIdOrHexString(value)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  next();
};

// Same check as a plain middleware for params merged in from a parent router.
const requireObjectIdParams = (...names) => (req, res, next) => {
  for (const n of names) {
    if (req.params[n] !== undefined && !mongoose.isObjectIdOrHexString(req.params[n])) {
      return res.status(400).json({ error: "Invalid id" });
    }
  }
  next();
};

const runValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const validate = (method) => {
  switch (method) {
    case "register":
      return [
        body("name").notEmpty().withMessage("Name is required"),
        // FIX: email is optional — volunteers register with phone only
        body("email").optional().isEmail().withMessage("Invalid email"),
        body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
        runValidation,
      ];

    case "login":
      return [
        // FIX: accept email OR phone — previously required email always
        body("email").optional().isEmail().withMessage("Invalid email"),
        body("password").notEmpty().withMessage("Password is required"),
        (req, res, next) => {
          if (!req.body.email && !req.body.phone) {
            return res.status(400).json({ errors: [{ msg: "Email or phone is required" }] });
          }
          runValidation(req, res, next);
        },
      ];

    default:
      return [];
  }
};

module.exports = { validate, objectIdParam, requireObjectIdParams };
