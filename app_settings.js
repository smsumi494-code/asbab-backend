// app_settings.js — generic app-wide key-value settings. Currently just
// the "which day is this order for" prompt config (shown for posts made
// between 12:01 AM and a configurable cutoff time).
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

const DEFAULTS = {
  late_post_prompt_enabled: "true",
  late_post_prompt_cutoff_hour: "12",
  late_post_prompt_cutoff_minute: "30",
};

async function getSetting(key) {
  const result = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? DEFAULTS[key];
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, String(value)]
  );
}

// GET /api/app-settings — any logged-in user (moderators need this too,
// to know whether to show the day-choice prompt when they post).
router.get("/", requireAuth, async (req, res) => {
  try {
    const enabled = await getSetting("late_post_prompt_enabled");
    const cutoffHour = await getSetting("late_post_prompt_cutoff_hour");
    const cutoffMinute = await getSetting("late_post_prompt_cutoff_minute");
    const salesStartRes = await pool.query("SELECT value FROM app_settings WHERE key = 'sales_summary_start_at'");
    res.json({
      latePostPromptEnabled: enabled === "true",
      latePostPromptCutoffHour: Number(cutoffHour),
      latePostPromptCutoffMinute: Number(cutoffMinute),
      salesSummaryStartAt: salesStartRes.rows[0]?.value || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load settings" });
  }
});

// PUT /api/app-settings — Admin only.
router.put("/", requireAuth, requireAdmin, async (req, res) => {
  const { latePostPromptEnabled, latePostPromptCutoffHour, latePostPromptCutoffMinute } = req.body;
  try {
    if (latePostPromptEnabled !== undefined) {
      await setSetting("late_post_prompt_enabled", latePostPromptEnabled ? "true" : "false");
    }
    if (latePostPromptCutoffHour !== undefined) {
      await setSetting("late_post_prompt_cutoff_hour", latePostPromptCutoffHour);
    }
    if (latePostPromptCutoffMinute !== undefined) {
      await setSetting("late_post_prompt_cutoff_minute", latePostPromptCutoffMinute);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save settings" });
  }
});

module.exports = { router };
