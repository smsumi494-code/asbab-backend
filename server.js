// server.js — the main entry point. Railway runs this file (via `npm start`).
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const entriesRouter = require("./entries");
const { router: authRouter } = require("./auth");
const usersRouter = require("./users");
const { router: settingsRouter } = require("./settings");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Simple health check — visiting your Railway URL directly will show this.
app.get("/", (req, res) => {
  res.json({ status: "Asbab Abaya backend is running" });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/entries", entriesRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
