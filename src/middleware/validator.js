const { body, validationResult } = require("express-validator");

const validate = (method) => {
  switch (method) {
    case "register": {
      return [
        body("name").notEmpty().withMessage("Name is required"),
        body("email").isEmail().withMessage("Invalid email"),
        body("phone").notEmpty().withMessage("Phone is required"),
        body("password")
          .isLength({ min: 6 })
          .withMessage("Password must be at least 6 characters"),
        (req, res, next) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
          }
          next();
        },
      ];
    }
    case "login": {
      return [
        body("email").isEmail().withMessage("Invalid email"),
        body("password").notEmpty().withMessage("Password is required"),
        (req, res, next) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
          }
          next();
        },
      ];
    }
    default:
      return [];
  }
};

module.exports = { validate };
