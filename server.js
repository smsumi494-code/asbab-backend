// server.js — the main entry point. Railway runs this file (via `npm start`).
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { router: entriesRouter } = require("./entries");
const { router: authRouter } = require("./auth");
const usersRouter = require("./users");
const { router: settingsRouter } = require("./settings");
const { router: pushRouter } = require("./push");
const webhooksRouter = require("./webhooks");

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
app.use("/api/entries", entriesRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

