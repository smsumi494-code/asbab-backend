// server.js — the main entry point. Railway runs this file (via `npm start`).
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const entriesRouter = require("./entries");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Simple health check — visiting your Railway URL directly will show this.
app.get("/", (req, res) => {
  res.json({ status: "Asbab Abaya backend is running" });
});

app.use("/api/entries", entriesRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
