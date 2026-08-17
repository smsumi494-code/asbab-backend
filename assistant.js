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
// IMPORTANT distinction the data-gathering step makes: "কয়টা ডেলিভারি
// হয়েছে আজকে" means orders whose status BECAME delivered/cancelled
// today (courier_status_updated_at) — completely different from orders
// POSTED today (sales_date). An order posted 15 days ago that gets
// delivered today must count as "delivered today", not get missed just
// because it wasn't POSTED today. Both perspectives are computed and
// clearly labeled for the AI to pick from correctly.
//
// Admin-only — this surfaces the same kind of business-sensitive figures
// as Sales Summary.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");
const { getPageCredential } = require("./settings");

async function getOpenAiKey() {
  // This feature isn't tied to any one page, so — same fallback pattern
  // used elsewhere in the app for "no specific page context" — it uses
  // whatever OpenAI key is saved on the Al-Haya page. Falls back to a
  // Railway env var if nothing is saved in the app itself.
  try {
    const alHayaPage = await pool.query("SELECT id FROM pages WHERE name = 'Al-Haya' LIMIT 1");
    const cred = alHayaPage.rows.length
      ? await getPageCredential("ai", "openai", alHayaPage.rows[0].id)
      : null;
    if (cred?.api_key) return cred.api_key;
  } catch (err) {
    console.warn("Could not load saved OpenAI credential, falling back to env var:", err.message);
  }
  return process.env.OPENAI_API_KEY || null;
}

async function callOpenAI(userText, systemPrompt, wantJson) {
  const apiKey = await getOpenAiKey();
  if (!apiKey) throw new Error("কোনো OpenAI key পাওয়া যায়নি (অ্যাপের সেটিংসেও না, Railway-তেও না)");
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

// Uses Bangladesh's calendar day (UTC+6), not the server's own timezone
// (Railway runs in UTC) — otherwise "আজকে" could silently mean the wrong
// day for several hours around midnight, and any date-range query built
// from it would be wrong too.
function todayISO() {
  const bdNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return bdNow.toISOString().slice(0, 10);
}

// GET /api/assistant/messages — Admin only. Loads saved conversation
// history so it survives navigating away and coming back, or reloading.
router.get("/messages", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, question, answer, created_at FROM ai_assistant_messages ORDER BY id ASC LIMIT 200"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load conversation history" });
  }
});

// POST /api/assistant/ask — Admin only. { question, history: [{question, answer}, ...] }
// history = the last few turns of this conversation, so a bare follow-up
// like "লাস্ট ৩০ দিনে?" (with no restated subject) is understood as
// continuing the PREVIOUS question, not a brand new unrelated one.
router.post("/ask", requireAuth, requireAdmin, async (req, res) => {
  const { question, history } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: "প্রশ্ন লিখুন" });
  }

  const recentHistory = Array.isArray(history) ? history.slice(-5) : [];
  const historyText = recentHistory.length
    ? recentHistory.map((h) => `প্রশ্ন: ${h.question}\nউত্তর: ${h.answer}`).join("\n\n")
    : null;

  try {
    // ---- Step 1: figure out the date range being asked about ----
    const today = todayISO();
    const rangePrompt = `আজকের তারিখ: ${today} (YYYY-MM-DD, বাংলাদেশ সময়)।
${historyText ? `এর আগের কথোপকথন (প্রয়োজনে প্রসঙ্গ বুঝতে ব্যবহার করুন):\n${historyText}\n\n` : ""}ব্যবহারকারীর সর্বশেষ প্রশ্ন থেকে বুঝে নিন তিনি কোন তারিখ/সময়সীমার তথ্য জানতে চাইছেন
(যেমন "আজকে", "গতকাল", "গত সপ্তাহ", "এই মাসে", নির্দিষ্ট কোনো তারিখ, ইত্যাদি)।
প্রশ্নটা ছোট/অসম্পূর্ণ হলে (যেমন শুধু "লাস্ট ৩০ দিনে?") সেটা আগের কথোপকথনেরই
ধারাবাহিকতা ধরে নিন। কোনো সময়সীমা স্পষ্ট না থাকলে ধরে নিন "আজকে"।
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

    const cutoffRes = await pool.query("SELECT value FROM app_settings WHERE key = 'sales_summary_start_at'");
    const cutoff = cutoffRes.rows[0]?.value;

    // ---- Dataset A: orders PLACED in this range (sales_date) ----
    // Answers "কয়টা অর্ডার এসেছে", "কত টাকার সেল হয়েছে", "কে কত
    // অর্ডার নিয়েছে", "অর্ডার নাম্বারগুলো কী" — regardless of whether
    // they've been delivered yet.
    const placedRes = await pool.query(
      `SELECT id, product_code, moderator, page_name, estimated_amount, estimated_quantity, courier_status
       FROM entries
       WHERE group_name = 'all_order'
         AND sales_date >= $1::date AND sales_date <= $2::date
         ${cutoff ? "AND created_at >= $3::timestamptz" : ""}`,
      cutoff ? [range.startDate, range.endDate, cutoff] : [range.startDate, range.endDate]
    );

    let totalSales = 0;
    const byModeratorPlaced = {};
    const byPagePlaced = {};
    placedRes.rows.forEach((r) => {
      const amt = Number(r.estimated_amount) || 0;
      const qty = Number(r.estimated_quantity) || 1;
      totalSales += amt;
      const mod = r.moderator || "অজানা";
      if (!byModeratorPlaced[mod]) byModeratorPlaced[mod] = { orders: 0, amount: 0, orderNumbers: [] };
      byModeratorPlaced[mod].orders += qty;
      byModeratorPlaced[mod].amount += amt;
      byModeratorPlaced[mod].orderNumbers.push(r.product_code || `#${r.id}`);

      const page = r.page_name || "কোনো পেইজ নেই";
      if (!byPagePlaced[page]) byPagePlaced[page] = { orders: 0, amount: 0 };
      byPagePlaced[page].orders += qty;
      byPagePlaced[page].amount += amt;
    });

    // ---- Dataset B: orders whose STATUS CHANGED in this range ----
    // Answers "কয়টা ডেলিভারি হয়েছে আজকে" — an order posted 15 days ago
    // but delivered TODAY belongs here, even though it's not in Dataset A
    // for today's range. courier_status_updated_at is stored as a naive
    // UTC-wall-clock timestamp (server default) — converting it through
    // UTC → Asia/Dhaka before comparing (the same pattern already used
    // for sales_date elsewhere in this codebase) keeps the day boundary
    // aligned with Bangladesh time instead of the server's own.
    const statusChangedRes = await pool.query(
      `SELECT moderator, page_name, estimated_amount, estimated_quantity, courier_status, sales_date
       FROM entries
       WHERE group_name = 'all_order'
         AND courier_status_updated_at::date >= $1::date
         AND courier_status_updated_at::date <= $2::date
         AND courier_status IS NOT NULL AND courier_status != 'pending' AND courier_status != 'in_review' AND courier_status != 'hold'`,
      [range.startDate, range.endDate]
    );

    let delivered = 0, partialDelivered = 0, cancelled = 0;
    const byModeratorDelivered = {};
    const byPageDelivered = {};
    statusChangedRes.rows.forEach((r) => {
      const qty = Number(r.estimated_quantity) || 1;
      const status = (r.courier_status || "").toLowerCase();
      // Steadfast uses variants beyond the plain word (e.g.
      // "delivered_approval_pending" — rider marked it delivered, office
      // hasn't confirmed cash collection yet, but the customer DID
      // receive the product) — matching on "contains" instead of exact
      // equality catches these instead of silently missing them.
      if (status.includes("partial")) partialDelivered += qty;
      else if (status.includes("cancel")) cancelled += qty;
      else if (status.includes("delivered")) delivered += qty;
      else return; // some other in-progress status — don't count it yet

      const mod = r.moderator || "অজানা";
      if (!byModeratorDelivered[mod]) byModeratorDelivered[mod] = 0;
      byModeratorDelivered[mod] += qty;

      const page = r.page_name || "কোনো পেইজ নেই";
      if (!byPageDelivered[page]) byPageDelivered[page] = 0;
      byPageDelivered[page] += qty;
    });

    // ---- Rider notes — two views: ALL currently-unseen ones (regardless
    // of date, since they're pending action), AND all of TODAY's notes
    // regardless of seen-status (someone asking "রাইডার কি নোট দিয়েছে"
    // usually means "what did the rider say today", not just "what
    // haven't I dismissed yet").
    const riderNotesRes = await pool.query(
      `SELECT ra.note_message, ra.note_date, ra.note_time, ra.created_at, e.moderator, e.page_name, e.raw_text
       FROM rider_note_alerts ra
       JOIN entries e ON e.id = ra.entry_id
       WHERE ra.seen = false
       ORDER BY ra.created_at DESC
       LIMIT 30`
    );
    const riderNotesTodayRes = await pool.query(
      `SELECT ra.note_message, ra.note_date, ra.note_time, ra.created_at, e.moderator, e.page_name, e.raw_text
       FROM rider_note_alerts ra
       JOIN entries e ON e.id = ra.entry_id
       WHERE ra.created_at::date = $1::date
       ORDER BY ra.created_at DESC
       LIMIT 50`,
      [today]
    );

    // ---- Emergency orders posted in this range ----
    const emergencyRes = await pool.query(
      `SELECT raw_text, moderator, page_name, created_at
       FROM entries
       WHERE group_name = 'emergency'
         AND created_at::date >= $1::date
         AND created_at::date <= $2::date
       ORDER BY created_at DESC
       LIMIT 20`,
      [range.startDate, range.endDate]
    );

    // ---- Purchase Cost / supplier dues — a running total, not
    // date-bound (answers "আমাদের কত দেনা আছে", "মোট কত টাকার মাল
    // কেনা হয়েছে" — always the current overall picture) ----
    let purchaseCost = null;
    try {
      const entriesTotal = await pool.query("SELECT COALESCE(SUM(total_amount), 0) AS total FROM purchase_entries");
      const paymentsTotal = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM purchase_payments");
      const totalPurchased = Number(entriesTotal.rows[0].total);
      const totalPaid = Number(paymentsTotal.rows[0].total);
      purchaseCost = {
        note: "প্রোডাক্ট কেনা/দেনার সার্বিক চিত্র (কোনো নির্দিষ্ট তারিখ-সীমা না, সবসময়ের সর্বমোট) — 'কত দেনা আছে', 'কত টাকার মাল কেনা হয়েছে' জাতীয় প্রশ্নের জন্য",
        totalPurchasedTaka: Math.round(totalPurchased),
        totalPaidTaka: Math.round(totalPaid),
        currentDueTaka: Math.round(totalPurchased - totalPaid),
      };
    } catch (err) {
      console.warn("Could not load purchase cost data for assistant:", err.message);
    }

    // ---- Website Order — how many came in this range, and how many
    // are still sitting incomplete (abandoned checkouts) ----
    let websiteOrders = null;
    try {
      const woRes = await pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM entries
         WHERE group_name = 'website_order'
           AND created_at::date >= $1::date AND created_at::date <= $2::date
         GROUP BY status`,
        [range.startDate, range.endDate]
      );
      const total = woRes.rows.reduce((s, r) => s + r.count, 0);
      const incomplete = woRes.rows.find((r) => r.status === "incomplete")?.count || 0;
      websiteOrders = {
        note: "ওয়েবসাইট থেকে আসা অর্ডারের সারসংক্ষেপ এই সময়সীমায় — 'ওয়েবসাইটে কয়টা অর্ডার এসেছে', 'কয়টা অসম্পূর্ণ/abandoned' জাতীয় প্রশ্নের জন্য",
        totalWebsiteOrders: total,
        incompleteOrders: incomplete,
      };
    } catch (err) {
      console.warn("Could not load website order data for assistant:", err.message);
    }

    const statsPayload = {
      dateRange: `${range.startDate} থেকে ${range.endDate}`,

      ordersPlacedInThisRange: {
        note: "এই সময়ে যত অর্ডার POST করা হয়েছে (এখনো ডেলিভার নাও হতে পারে) — 'কয়টা অর্ডার এসেছে'/'কত টাকার সেল হয়েছে'/'অর্ডার নাম্বারগুলো কী' জাতীয় প্রশ্নের জন্য। orderNumbers-এ প্রতিটা অর্ডারের প্রকৃত নাম্বার আছে।",
        totalOrders: placedRes.rows.reduce((s, r) => s + (Number(r.estimated_quantity) || 1), 0),
        totalSalesTaka: Math.round(totalSales),
        byModerator: Object.entries(byModeratorPlaced).map(([name, v]) => ({
          moderator: name,
          orders: v.orders,
          salesTaka: Math.round(v.amount),
          orderNumbers: v.orderNumbers,
        })),
        byPage: Object.entries(byPagePlaced).map(([name, v]) => ({
          page: name,
          orders: v.orders,
          salesTaka: Math.round(v.amount),
        })),
      },

      deliveryEventsInThisRange: {
        note: "এই সময়ে যেসব অর্ডারের status ডেলিভার/পার্শিয়াল/ক্যান্সেল-এ পরিণত হয়েছে (অর্ডারটা যেদিনই পোস্ট করা হোক না কেন) — 'কয়টা ডেলিভারি হয়েছে আজকে/এই সপ্তাহে' জাতীয় প্রশ্নের জন্য এটাই আসল উত্তর",
        delivered,
        partialDelivered,
        cancelled,
        byModerator: Object.entries(byModeratorDelivered).map(([name, count]) => ({ moderator: name, delivered: count })),
        byPage: Object.entries(byPageDelivered).map(([name, count]) => ({ page: name, delivered: count })),
      },

      emergencyOrders: emergencyRes.rows.map((r) => ({
        moderator: r.moderator,
        page: r.page_name,
        preview: (r.raw_text || "").split("\n")[0].slice(0, 80),
        time: r.created_at,
      })),
      emergencyOrderCount: emergencyRes.rows.length,

      purchaseCost,
      websiteOrders,

      unseenRiderNotes: {
        note: "রাইডার (ডেলিভারিম্যান) যেসব নোট/মেসেজ দিয়েছে যা এখনো কেউ 'Read' করেননি — এখনো মনোযোগ দরকার এমন নোট",
        notes: riderNotesRes.rows.map((r) => ({
          moderator: r.moderator,
          page: r.page_name,
          orderPreview: (r.raw_text || "").split("\n")[0].slice(0, 60),
          riderNote: r.note_message,
          noteDate: r.note_date,
          noteTime: r.note_time,
        })),
        count: riderNotesRes.rows.length,
      },

      allRiderNotesToday: {
        note: "আজকে রাইডার যত নোট দিয়েছে, তার সম্পূর্ণ তালিকা (Read করা হয়েছে এমনগুলোও সহ) — 'রাইডার কি নোট দিয়েছে', 'নোটগুলো দেখাও' জাতীয় যেকোনো প্রশ্নের জন্য এটাই প্রধানত ব্যবহার করুন, প্রশ্নের ভাষা যেভাবেই হোক না কেন",
        notes: riderNotesTodayRes.rows.map((r) => ({
          moderator: r.moderator,
          page: r.page_name,
          orderPreview: (r.raw_text || "").split("\n")[0].slice(0, 60),
          riderNote: r.note_message,
          noteDate: r.note_date,
          noteTime: r.note_time,
        })),
        count: riderNotesTodayRes.rows.length,
      },
    };

    // ---- Step 3: let OpenAI phrase the actual answer ----
    const appKnowledge = `আমাদের অ্যাপ সম্পর্কে সাধারণ জ্ঞান (কেউ "কীভাবে করব"/"এটা কী" জাতীয় প্রশ্ন করলে এখান থেকে উত্তর দিন, ডেটা লাগবে না):
- All Order = সব অর্ডারের মূল/উৎস তালিকা, এখানেই নতুন পোস্ট হয়।
- Pending = All Order-এর স্বয়ংক্রিয় প্রতিচ্ছবি — যেগুলো এখনো কুরিয়ারে পাঠানো হয়নি।
- Making = কারিগরদের কাজের জন্য (সাইজ/প্রোডাক্ট তথ্য, AI দিয়ে বের করা)।
- Emergency = জরুরি অর্ডারের আলাদা তালিকা, All Order/Pending থেকে কপি করে পাঠানো হয়।
- All Exchange Order = এক্সচেঞ্জ অর্ডারের জন্য আলাদা গ্রুপ, কারণ + রাইডার-নোট লিখে পোস্ট করতে হয়, এটা সেল/অর্ডার-সংখ্যায় গণনা হয় না।
- Website Order = ওয়েবসাইট থেকে সরাসরি আসা অর্ডার।
- Fraud Check = কোনো ফোন নাম্বারের আগের ডেলিভারি/ক্যান্সেলের ইতিহাস Steadfast থেকে যাচাই করা।
- Send to Courier = Steadfast-এ পার্সেল তৈরি করে পাঠানো।
- Purchase Cost = প্রোডাক্ট কেনা ও পেমেন্টের হিসাব রাখার আলাদা সেকশন (Admin-only, পাসওয়ার্ড-সুরক্ষিত)।
- মডারেটরের এডিট/ডিলিট Admin-এর অনুমোদন ছাড়া সরাসরি প্রয়োগ হয় না, Notification স্ক্রিনে Approve/Decline করতে হয়।
- রাইডার নোট = Steadfast-এর ডেলিভারিম্যান পার্সেলে যে মন্তব্য দেন, সেটা Notification স্ক্রিনে দেখা যায়, রিপ্লাইও দেওয়া যায়।`;

    const answerPrompt = `আপনি Asbab Abaya-র একজন সহকারী, যিনি নিচের প্রকৃত বিক্রয়/অর্ডার তথ্য দেখে
মডারেটর/Admin-কে বাংলায় সহজ, সংক্ষিপ্ত ও সরাসরি উত্তর দেন। শুধু নিচের ডেটার উপর
ভিত্তি করে উত্তর দিন — কোনো তথ্য নিজে থেকে অনুমান/আবিষ্কার করবেন না।

${appKnowledge}

${historyText ? `\nএর আগের কথোপকথন — ব্যবহারকারীর সর্বশেষ প্রশ্নটা যদি ছোট/অসম্পূর্ণ হয় (যেমন\nশুধু "লাস্ট ৩০ দিনে?"), সেটা এই আগের প্রসঙ্গেরই ধারাবাহিকতা হিসেবে ধরে নিয়ে\nএকই বিষয়ে (যেমন কে কত সেল করলো) নতুন সময়সীমার উত্তর দিন:\n${historyText}\n` : ""}
"purchaseCost" (দেনা/মোট কেনা/মোট পরিশোধ) এবং "websiteOrders" (ওয়েবসাইট
অর্ডার সংখ্যা/অসম্পূর্ণ) সংক্রান্ত প্রশ্নেও সরাসরি সেই অংশ থেকে উত্তর দিন।
"byPage" থাকা অংশগুলো থেকে "কোন পেইজে বেশি বিক্রি/ডেলিভারি হয়েছে" জাতীয়
প্রশ্নেরও উত্তর দিতে পারবেন।

গুরুত্বপূর্ণ: নিচের ডেটাতে দুটো ভিন্ন অংশ আছে — "ordersPlacedInThisRange" (এই
সময়ে POST করা অর্ডার) এবং "deliveryEventsInThisRange" (এই সময়ে যেসব অর্ডারের
status ডেলিভার/ক্যান্সেল হয়েছে, তা যেদিনই পোস্ট হোক না কেন)। প্রশ্নটা "কয়টা
ডেলিভারি হয়েছে" জাতীয় হলে অবশ্যই "deliveryEventsInThisRange" থেকে উত্তর দিন,
"ordersPlacedInThisRange" থেকে না। প্রশ্নটা "কয়টা অর্ডার এসেছে"/"সেল কত হয়েছে"
জাতীয় হলে "ordersPlacedInThisRange" ব্যবহার করুন।

রাইডার/ডেলিভারিম্যানের নোট সংক্রান্ত যেকোনো প্রশ্নে (যেমন "রাইডার কি নোট
দিয়েছে", "নোটগুলো দেখাও", "ডেলিভারিম্যান কি বলেছে" — প্রশ্নের ভাষা/গঠন যাই হোক
না কেন) "allRiderNotesToday" অংশ থেকে উত্তর দিন — প্রতিটা নোট কোন অর্ডারের, কোন
মডারেটরের, এবং রাইডার ঠিক কী লিখেছে তা স্পষ্টভাবে জানান। প্রশ্নে যদি বিশেষভাবে
"এখনো দেখিনি"/"নতুন"/"অপেক্ষমাণ" জাতীয় কিছু থাকে, তাহলে "unseenRiderNotes"
ব্যবহার করুন। কোনো নোট না থাকলে সরাসরি বলুন কোনো নোট নেই।

অত্যন্ত গুরুত্বপূর্ণ — বাংলা প্রশ্নের বাক্যগঠন প্রায়ই দ্ব্যর্থবোধক হয় (যেমন "কোন
পেইজে কোন ডেলিভারি হয়নি" — এটা "কোনো ডেলিভারি হয়নি" (নেতিবাচক দাবি) নাকি
"কোন কোন পেইজে ডেলিভারি হয়েছে/হয়নি" (তথ্য জিজ্ঞাসা) দুই রকমই বোঝাতে পারে)।
ব্যবহারকারী যা-ই লিখুন না কেন, ধরে নিন তিনি **সবসময় প্রকৃত তথ্য জানতে চাইছেন**,
কখনো কোনো ভুল/অনুমাননির্ভর দাবি নিশ্চিত করতে বলছেন না। নিচের ডেটায় যা সত্যিই
আছে (যেমন সত্যিকারের ডেলিভারির সংখ্যা), সেটাই সবসময় জানান — প্রশ্নের বাক্যে
নেতিবাচক/অস্পষ্ট শব্দ থাকলেও ডেটা যদি ভিন্ন কিছু বলে, ডেটাকেই প্রাধান্য দিন এবং
প্রয়োজনে স্পষ্ট করে দিন (যেমন "না, আজকে আসলে ৫টা ডেলিভারি হয়েছে")। কখনোই
প্রশ্নের ভাষার সাথে মিলিয়ে ভুল/অসম্পূর্ণ উত্তর দেবেন না।

অত্যন্ত গুরুত্বপূর্ণ — উত্তরে সবসময় নিচের "dateRange" ফিল্ডে যে সময়সীমা দেওয়া আছে সেটাই
উল্লেখ করুন। ব্যবহারকারী যদি "গতকাল" জিজ্ঞেস করেন, উত্তরেও "গতকাল" বলুন —
ভুলবশত "আজকে" বলে ফেলবেন না বা এই দুটো গুলিয়ে ফেলবেন না। প্রশ্নে অর্ডার
নাম্বার/আইডি জানতে চাইলে (যেমন "অর্ডার নাম্বারগুলো বলো"), ডেটার
"orderNumbers" তালিকা থেকে প্রতিটা নাম্বার স্পষ্টভাবে উল্লেখ করুন — "নেই" বলে
এড়িয়ে যাবেন না যদি ডেটায় নাম্বার থেকে থাকে।

উত্তর ছোট রাখুন (৩-৫ বাক্যের
মধ্যে), প্রয়োজনে তালিকা আকারে, প্রাসঙ্গিক সংখ্যা স্পষ্টভাবে উল্লেখ করে।

ডেটা:
${JSON.stringify(statsPayload, null, 2)}`;

    const answer = await callOpenAI(question, answerPrompt, false);
    const trimmedAnswer = answer.trim();

    await pool.query(
      "INSERT INTO ai_assistant_messages (asked_by, question, answer) VALUES ($1, $2, $3)",
      [req.user.name || req.user.phone, question, trimmedAnswer]
    );

    res.json({ answer: trimmedAnswer, stats: statsPayload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "উত্তর দেওয়া যায়নি" });
  }
});

module.exports = router;
