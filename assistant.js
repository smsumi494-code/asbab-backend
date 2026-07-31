// assistant.js — "AI-এর সাথে আলোচনা" — a natural-language business
// assistant (OpenAI-powered) that answers questions like "আজকে কয়টা
// ডেলিভারি হয়েছে?" or "গত সপ্তাহে কে সবচেয়ে বেশি সেল করলো?"
//
// Two-step process:
//   1) Ask OpenAI to figure out WHICH date range the question is about
//      (today, yesterday, last week, etc.) — returns {startDate, endDate}.
//   2) Actually query the database for that range ourselves (never let
//      the AI touch the database directly), then hand the real numbers
//      back to OpenAI and ask it to answer the original question in
//      plain Bengali, using ONLY that data.
//
// Admin-only — this surfaces the same kind of business-sensitive figures
// as Sales Summary.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

async function callOpenAI(userText, systemPrompt, wantJson) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY সেট করা নেই");
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  };
  if (wantJson) body.response_format = { type: "json_object" };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI থেকে উত্তর পাওয়া যায়নি");
  return text;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/assistant/ask — Admin only. { question: "আজকে কয়টা ডেলিভারি হয়েছে?" }
router.post("/ask", requireAuth, requireAdmin, async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: "প্রশ্ন লিখুন" });
  }

  try {
    // ---- Step 1: figure out the date range being asked about ----
    const today = todayISO();
    const rangePrompt = `আজকের তারিখ: ${today} (YYYY-MM-DD, বাংলাদেশ সময়)।
ব্যবহারকারীর প্রশ্ন থেকে বুঝে নিন তিনি কোন তারিখ/সময়সীমার তথ্য জানতে চাইছেন
(যেমন "আজকে", "গতকাল", "গত সপ্তাহ", "এই মাসে", নির্দিষ্ট কোনো তারিখ, ইত্যাদি)।
কোনো সময়সীমা স্পষ্ট না থাকলে ধরে নিন "আজকে"।
শুধু এই JSON ফরম্যাটে উত্তর দিন, অন্য কিছু লিখবেন না:
{"startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD"}`;

    let range;
    try {
      const rangeRaw = await callOpenAI(question, rangePrompt, true);
      range = JSON.parse(rangeRaw);
      if (!range.startDate || !range.endDate) throw new Error("bad range");
    } catch {
      range = { startDate: today, endDate: today };
    }

    // ---- Step 2: gather the REAL numbers ourselves ----
    const cutoffRes = await pool.query("SELECT value FROM app_settings WHERE key = 'sales_summary_start_at'");
    const cutoff = cutoffRes.rows[0]?.value;

    const allOrderRes = await pool.query(
      `SELECT moderator, page_name, estimated_amount, estimated_quantity, courier_status
       FROM entries
       WHERE group_name = 'all_order'
         AND sales_date >= $1::date AND sales_date <= $2::date
         ${cutoff ? "AND created_at >= $3::timestamptz" : ""}`,
      cutoff ? [range.startDate, range.endDate, cutoff] : [range.startDate, range.endDate]
    );

    let delivered = 0, partialDelivered = 0, cancelled = 0, pendingOrOther = 0;
    let totalSales = 0;
    const byModerator = {};

    allOrderRes.rows.forEach((r) => {
      const amt = Number(r.estimated_amount) || 0;
      const qty = Number(r.estimated_quantity) || 1;
      const status = (r.courier_status || "").toLowerCase();

      if (status === "delivered") delivered += qty;
      else if (status === "partial_delivered") partialDelivered += qty;
      else if (status === "cancelled") cancelled += qty;
      else pendingOrOther += qty;

      totalSales += amt;

      const mod = r.moderator || "অজানা";
      if (!byModerator[mod]) byModerator[mod] = { orders: 0, amount: 0 };
      byModerator[mod].orders += qty;
      byModerator[mod].amount += amt;
    });

    const emergencyRes = await pool.query(
      `SELECT raw_text, moderator, page_name, created_at
       FROM entries
       WHERE group_name = 'emergency'
         AND created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
       ORDER BY created_at DESC
       LIMIT 20`,
      [range.startDate, range.endDate]
    );

    const statsPayload = {
      dateRange: `${range.startDate} থেকে ${range.endDate}`,
      totalOrders: allOrderRes.rows.reduce((s, r) => s + (Number(r.estimated_quantity) || 1), 0),
      delivered,
      partialDelivered,
      cancelled,
      pendingOrOther,
      totalSalesTaka: Math.round(totalSales),
      byModerator: Object.entries(byModerator).map(([name, v]) => ({
        moderator: name,
        orders: v.orders,
        salesTaka: Math.round(v.amount),
      })),
      emergencyOrders: emergencyRes.rows.map((r) => ({
        moderator: r.moderator,
        page: r.page_name,
        preview: (r.raw_text || "").split("\n")[0].slice(0, 80),
        time: r.created_at,
      })),
      emergencyOrderCount: emergencyRes.rows.length,
    };

    // ---- Step 3: let OpenAI phrase the actual answer ----
    const answerPrompt = `আপনি Asbab Abaya-র একজন সহকারী, যিনি নিচের প্রকৃত বিক্রয়/অর্ডার তথ্য দেখে
মডারেটর/Admin-কে বাংলায় সহজ, সংক্ষিপ্ত ও সরাসরি উত্তর দেন। শুধু নিচের ডেটার উপর
ভিত্তি করে উত্তর দিন — কোনো তথ্য নিজে থেকে অনুমান/আবিষ্কার করবেন না। প্রাসঙ্গিক
সংখ্যাগুলো স্পষ্টভাবে উল্লেখ করুন। উত্তর ছোট রাখুন (৩-৫ বাক্যের মধ্যে), প্রয়োজনে
তালিকা আকারে।

ডেটা:
${JSON.stringify(statsPayload, null, 2)}`;

    const answer = await callOpenAI(question, answerPrompt, false);

    res.json({ answer: answer.trim(), stats: statsPayload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "উত্তর দেওয়া যায়নি" });
  }
});

module.exports = router;
