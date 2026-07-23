// system_alerts.js — Admin-only dashboard surfacing failures that would
// otherwise go unnoticed: SMS delivery failures, AI extraction outages,
// courier status stuck (webhook maybe not firing), and a rough check for
// website orders that may not have made it into our system at all.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    // 1) Order-confirmation SMS failures in the last 24 hours (excludes
    // OTP sends, which have their own separate log/screen).
    const smsRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM sms_delivery_log
       WHERE purpose != 'otp' AND success = false AND created_at > NOW() - INTERVAL '24 hours'`
    );

    // 2) Times ALL AI keys failed at once, last 24 hours.
    const aiRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_failure_log WHERE created_at > NOW() - INTERVAL '24 hours'`
    );

    // 3) Orders sent to courier 3+ days ago that still have no delivery
    // status at all — usually means Steadfast's status webhook isn't
    // reaching us for these.
    const stuckRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM entries
       WHERE consignment_id IS NOT NULL
         AND (courier_status IS NULL OR courier_status = '')
         AND created_at < NOW() - INTERVAL '3 days'`
    );

    // 4) Rough website-order gap check — compares how many orders
    // WooCommerce says came in over the last 48 hours against how many
    // "ওয়েবসাইট"-sourced entries we actually have in the same window.
    // This is an approximate signal, not an exact reconciliation.
    let websiteGap = null;
    try {
      const wcKey = process.env.WC_CONSUMER_KEY;
      const wcSecret = process.env.WC_CONSUMER_SECRET;
      const wcSite = process.env.WC_SITE_URL;
      if (wcKey && wcSecret && wcSite) {
        const after = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const wcRes = await fetch(
          `${wcSite}/wp-json/wc/v3/orders?after=${after}&per_page=100&consumer_key=${wcKey}&consumer_secret=${wcSecret}`
        );
        if (wcRes.ok) {
          const wcOrders = await wcRes.json();
          const wcCount = Array.isArray(wcOrders) ? wcOrders.length : 0;

          const ourRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM entries
             WHERE moderator = 'ওয়েবসাইট' AND created_at > NOW() - INTERVAL '48 hours'`
          );
          const ourCount = ourRes.rows[0].c;
          websiteGap = { wcCount, ourCount, gap: Math.max(0, wcCount - ourCount) };
        }
      }
    } catch (err) {
      console.warn("Website order gap check failed:", err.message);
    }

    res.json({
      smsFailures24h: smsRes.rows[0].c,
      aiFailures24h: aiRes.rows[0].c,
      stuckCourierOrders: stuckRes.rows[0].c,
      websiteGap,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load system alerts" });
  }
});

module.exports = { router };
