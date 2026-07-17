// analytics.js — Admin-only sales/order analytics. Counts every entry
// posted to All Order in the selected date range (regardless of whether
// it was ever sent to courier), and separately sums the taka amount
// (which only exists once an order has actually been sent to courier —
// so "total sales in taka" naturally reflects confirmed, priced orders).
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

router.get("/", requireAuth, requireAdmin, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: "start and end dates are required" });
  }
  try {
    const result = await pool.query(
      `SELECT moderator, page_id, page_name, amount
       FROM entries
       WHERE group_name = 'all_order'
         AND created_at >= $1::date
         AND created_at < ($2::date + INTERVAL '1 day')`,
      [start, end]
    );
    const rows = result.rows;

    let totalOrders = rows.length;
    let totalWebsiteOrders = 0;
    let totalManualOrders = 0;
    let totalAmount = 0;
    let totalWebsiteAmount = 0;
    let totalManualAmount = 0;

    const byPageMap = {};
    const byModeratorMap = {};

    rows.forEach((r) => {
      const isWebsite = r.moderator === "ওয়েবসাইট";
      const amt = Number(r.amount) || 0;

      if (isWebsite) {
        totalWebsiteOrders += 1;
        totalWebsiteAmount += amt;
      } else {
        totalManualOrders += 1;
        totalManualAmount += amt;
      }
      totalAmount += amt;

      const pageKey = r.page_id || "no_page";
      if (!byPageMap[pageKey]) {
        byPageMap[pageKey] = {
          pageId: r.page_id,
          pageName: r.page_name || "কোনো পেইজ নেই",
          totalOrders: 0,
          totalAmount: 0,
          websiteOrders: 0,
          websiteAmount: 0,
          manualOrders: 0,
          manualAmount: 0,
        };
      }
      const p = byPageMap[pageKey];
      p.totalOrders += 1;
      p.totalAmount += amt;
      if (isWebsite) {
        p.websiteOrders += 1;
        p.websiteAmount += amt;
      } else {
        p.manualOrders += 1;
        p.manualAmount += amt;
      }

      // Moderator breakdown is about human performance — website-sourced
      // orders aren't posted by a person, so they're excluded here (they
      // already show up in the website/manual totals above).
      if (!isWebsite) {
        const modKey = r.moderator || "অজানা";
        byModeratorMap[modKey] = (byModeratorMap[modKey] || 0) + 1;
      }
    });

    res.json({
      totalOrders,
      totalWebsiteOrders,
      totalManualOrders,
      totalAmount,
      totalWebsiteAmount,
      totalManualAmount,
      byPage: Object.values(byPageMap).sort((a, b) => b.totalOrders - a.totalOrders),
      byModerator: Object.entries(byModeratorMap)
        .map(([moderator, count]) => ({ moderator, count }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load analytics" });
  }
});

module.exports = { router };
