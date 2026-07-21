// analytics.js — Admin-only sales/order analytics. Counts every entry
// posted to All Order in the selected date range (regardless of whether
// it was ever sent to courier) — but counts by GARMENT PIECES
// (estimated_quantity), not by post, since one post sometimes covers 2+
// borka/abaya in a single message. Separately sums the taka amount.
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
    const cutoffRes = await pool.query("SELECT value FROM app_settings WHERE key = 'sales_summary_start_at'");
    const cutoff = cutoffRes.rows[0]?.value;

    const result = await pool.query(
      `SELECT id, product_code, moderator, page_id, page_name, estimated_amount, estimated_quantity
       FROM entries
       WHERE group_name = 'all_order'
         AND sales_date >= $1::date
         AND sales_date <= $2::date
         ${cutoff ? "AND created_at >= $3::timestamptz" : ""}
       ORDER BY created_at DESC`,
      cutoff ? [start, end, cutoff] : [start, end]
    );
    const rows = result.rows;

    let totalOrders = 0;
    let totalWebsiteOrders = 0;
    let totalManualOrders = 0;
    let totalAmount = 0;
    let totalWebsiteAmount = 0;
    let totalManualAmount = 0;

    const byPageMap = {};
    const byModeratorMap = {};

    rows.forEach((r) => {
      const isWebsite = r.moderator === "ওয়েবসাইট";
      const amt = Number(r.estimated_amount) || 0;
      const qty = Number(r.estimated_quantity) || 1;

      totalOrders += qty;
      if (isWebsite) {
        totalWebsiteOrders += qty;
        totalWebsiteAmount += amt;
      } else {
        totalManualOrders += qty;
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
          // Just the AI's OUTPUT for each order in this page, for the
          // drill-down view — never the original message/images.
          orders: [],
        };
      }
      const p = byPageMap[pageKey];
      p.totalOrders += qty;
      p.totalAmount += amt;
      if (isWebsite) {
        p.websiteOrders += qty;
        p.websiteAmount += amt;
      } else {
        p.manualOrders += qty;
        p.manualAmount += amt;
      }
      p.orders.push({
        id: r.id,
        orderNumber: r.product_code || null,
        amount: amt,
        quantity: qty,
        isWebsite,
      });

      // Moderator breakdown is about human performance — website-sourced
      // orders aren't posted by a person, so they're excluded here (they
      // already show up in the website/manual totals above).
      if (!isWebsite) {
        const modKey = r.moderator || "অজানা";
        byModeratorMap[modKey] = (byModeratorMap[modKey] || 0) + qty;
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

// GET /api/analytics/by-location — Admin only. Area-wise (district +
// thana) breakdown of delivery success — total sent to courier,
// delivered, cancelled/returned, and the cancel rate. Only counts orders
// that were actually sent to courier (consignment_id set), since that's
// the only group with a real delivery outcome to measure.
router.get("/by-location", requireAuth, requireAdmin, async (req, res) => {
  const { source } = req.query; // "website" | "manual" | undefined (both)
  try {
    const result = await pool.query(
      `SELECT district, thana, courier_status, moderator
       FROM entries
       WHERE consignment_id IS NOT NULL`
    );
    const map = {};
    result.rows.forEach((r) => {
      const isWebsite = r.moderator === "ওয়েবসাইট";
      if (source === "website" && !isWebsite) return;
      if (source === "manual" && isWebsite) return;

      const district = r.district || "অজানা";
      const thana = r.thana || "অজানা";
      const key = `${district}|${thana}`;
      if (!map[key]) {
        map[key] = {
          district,
          thana,
          total: 0,
          delivered: 0,
          cancelled: 0,
          websiteTotal: 0,
          websiteCancelled: 0,
          manualTotal: 0,
          manualCancelled: 0,
        };
      }
      const row = map[key];
      row.total += 1;
      const status = (r.courier_status || "").toLowerCase();
      const isCancelled = status.includes("cancel") || status.includes("return");
      if (status.includes("deliver")) row.delivered += 1;
      else if (isCancelled) row.cancelled += 1;

      if (isWebsite) {
        row.websiteTotal += 1;
        if (isCancelled) row.websiteCancelled += 1;
      } else {
        row.manualTotal += 1;
        if (isCancelled) row.manualCancelled += 1;
      }
    });

    const rows = Object.values(map)
      .map((r) => ({ ...r, cancelRate: r.total > 0 ? Math.round((r.cancelled / r.total) * 1000) / 10 : 0 }))
      .sort((a, b) => b.cancelRate - a.cancelRate);

    res.json({ locations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load location report" });
  }
});

module.exports = { router };
