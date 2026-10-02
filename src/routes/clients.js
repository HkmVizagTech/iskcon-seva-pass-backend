const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth");
const clientController = require("../controllers/clientController");

// Registered client apps (Vaikuntham, Seva Pass app, ...): who may call the
// integration API, with which key, scopes and limits. Super admin only.
router.use(protect, authorize("super_admin"));

router.get("/scopes", clientController.listScopes);
router.get("/", clientController.list);
router.post("/", clientController.create);
router.patch("/:id", clientController.update);
router.post("/:id/rotate-key", clientController.rotateKey);
router.delete("/:id", clientController.remove);

module.exports = router;
