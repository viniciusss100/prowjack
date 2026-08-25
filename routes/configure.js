const express = require("express");
const { sendConfigurePage } = require("../routeHelpers");

const router = express.Router();

router.get("/configure", (_, res) => sendConfigurePage(res));
router.get("/:userConfig/configure", (_, res) => sendConfigurePage(res));
router.get("/", (_, res) => sendConfigurePage(res));
router.get("/health", (_, res) => res.status(200).send("OK"));

module.exports = router;
