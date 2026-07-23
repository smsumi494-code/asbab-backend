// server.js — the main entry point. Railway runs this file (via `npm start`).
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { router: entriesRouter, checkCourierStatusesAndSyncFacebook } = require("./entries");
const { router: authRouter } = require("./auth");
const usersRouter = require("./users");
const { router: settingsRouter } = require("./settings");
const { router: pushRouter } = require("./push");
const webhooksRouter = require("./webhooks");
const pagesRouter = require("./pages");
const { router: purchasesRouter } = require("./purchases");
const { router: analyticsRouter } = require("./analytics");
const { router: appSettingsRouter } = require("./app_settings");
const { router: publicRouter } = require("./public");
const { router: systemAlertsRouter } = require("./system_alerts");

const app = express();

// Only our own frontend is allowed to call this API. Add more origins
// here (comma-separated in the FRONTEND_URL env var) if you set up a
// custom domain later.
const allowedOrigins = (
  process.env.FRONTEND_URL || "https://asbab-frontend-production.up.railway.app"
).split(",").map((s) => s.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);
// Keeps a copy of the raw request body so the WooCommerce webhook route
// can verify its signature (which is computed over the exact raw bytes).
app.use(
  express.json({
    limit: "5mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Simple health check — visiting your Railway URL directly will show this.
app.get("/", (req, res) => {
  res.json({ status: "Asbab Abaya backend is running" });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/push", pushRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/pages", pagesRouter);
app.use("/api/entries", entriesRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/app-settings", appSettingsRouter);
app.use("/api/public", publicRouter);
app.use("/api/system-alerts", systemAlertsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Checks delivery status for shipped website orders and syncs
// Complete/Refund to Facebook + WooCommerce. Re-reads the configured
// interval before each run and reschedules itself, so changing the
// interval in Settings takes effect on the very next run — no restart
// needed. Defaults to 30 minutes if never configured.
async function scheduleCourierCheck() {
  try {
    await checkCourierStatusesAndSyncFacebook();
  } catch (err) {
    console.error("Courier/Facebook sync failed:", err.message);
  }
  let minutes = 30;
  try {
    const { getSetting } = require("./app_settings");
    minutes = Number(await getSetting("courier_check_interval_minutes")) || 30;
  } catch (err) {
    console.error("Could not read courier check interval, using default:", err.message);
  }
  setTimeout(scheduleCourierCheck, minutes * 60 * 1000);
}
setTimeout(scheduleCourierCheck, 10 * 1000);
