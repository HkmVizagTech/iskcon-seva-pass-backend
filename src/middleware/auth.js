const jwt = require("jsonwebtoken");
const User = require("../models/User");

const protect = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ error: "Not authorized, no token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.userId).select("-password");

    if (!req.user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (!req.user.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    next();
  } catch (error) {
    res.status(401).json({ error: "Not authorized, token failed" });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Role ${req.user.role} is not authorized to access this route`,
      });
    }
    next();
  };
};

// Gates a route on a boolean permission flag on the User document
// (canViewReports, canViewScanFeed, ...).
//
// Only an explicit `false` denies, so a flag absent from an older user document
// behaves as allowed — same reasoning as the schema defaults. super_admin
// always passes, so an admin can never lock themselves out of their own system.
const requirePermission = (flag) => {
  return (req, res, next) => {
    if (String(req.user?.role || "") === "super_admin") return next();
    if (req.user?.[flag] === false) {
      return res.status(403).json({
        code: "PERMISSION_DENIED",
        permission: flag,
        error: "Your account does not have access to this section.",
      });
    }
    next();
  };
};

module.exports = { protect, authorize, requirePermission };
