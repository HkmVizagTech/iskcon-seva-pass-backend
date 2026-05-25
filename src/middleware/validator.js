const { body, validationResult } = require("express-validator");

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
        body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
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

module.exports = { validate };
