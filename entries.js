// entries.js
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { randomUUID } = require("crypto");
const { requireAuth, requireAdmin, verifyToken } = require("./auth");
const { getCredential, getPreferredAiCredential, getPageCredential, getPagePreferredAiCredential, getPageAiCredentials } = require("./settings");
const { notifyAll } = require("./push");
const { addClient, removeClient, broadcastRefresh } = require("./sse");
const { getConsignmentTracking } = require("./steadfast_tracking");
const { sendFacebookEvent, updateWooOrderStatus } = require("./facebook");

// Sends an order-confirmation SMS via Alpha SMS (api.sms.net.bd) — one
// shared account/API key for the whole business (set as an env var),
// but the message text itself is customized per page/brand. Fails
// silently (logs only) so a missing/invalid SMS setup never blocks an
// order from being posted.
// Fills {name}, {order}, {amount} placeholders in a page's SMS template
// with the actual customer/order details.
function fillSmsTemplate(template, { name, orderNumber, amount, size }) {
  return template
    .replace(/\{name\}/gi, name || "")
    .replace(/\{order\}/gi, orderNumber || "")
    .replace(/\{amount\}/gi, amount != null && amount !== "" ? amount : "")
    .replace(/\{size\}/gi, size || "");
}

async function sendSMS(phone, message, token, purpose = "order_confirmation") {
  const finalToken = (token || process.env.SMS_API_KEY || "").trim();
  const logResult = async (success, error) => {
    try {
      await pool.query(
        "INSERT INTO sms_delivery_log (phone, purpose, success, error) VALUES ($1, $2, $3, $4)",
        [phone || null, purpose, success, error || null]
      );
    } catch (err) {
      console.warn("Could not write sms_delivery_log:", err.message);
    }
  };

  if (!finalToken || !phone || !message) {
    await logResult(false, "SMS সেটআপ করা হয়নি");
    return { success: false, error: "SMS সেটআপ করা হয়নি" };
  }
  try {
    const digits = phone.replace(/\D/g, "");
    const to = digits.startsWith("880") ? digits : `880${digits.replace(/^0/, "")}`;
    const res = await fetch("https://api.bdbulksms.net/api.php?json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: finalToken, to, message }),
    });
    const rawText = await res.text();

    // Confirmed response shape: a JSON array, one entry per recipient —
    // [{ to, message, status: "SENT"|"FAILED", statusmsg }]
    let results;
    try {
      results = JSON.parse(rawText);
    } catch {
      console.warn("SMS response wasn't valid JSON:", rawText);
      await logResult(false, "অপ্রত্যাশিত রেসপন্স");
      return { success: false, error: "অপ্রত্যাশিত রেসপন্স" };
    }

    const result = Array.isArray(results) ? results[0] : results;
    if (!result) {
      await logResult(false, "কোনো ফলাফল পাওয়া যায়নি");
      return { success: false, error: "কোনো ফলাফল পাওয়া যায়নি" };
    }
    if (result.status === "SENT") {
      await logResult(true, null);
      return { success: true, error: null };
    }
    console.warn("SMS send failed:", result.statusmsg || rawText);
    await logResult(false, result.statusmsg || "SMS পাঠানো যায়নি");
    return { success: false, error: result.statusmsg || "SMS পাঠানো যায়নি" };
  } catch (err) {
    console.warn("SMS send failed:", err.message);
    await logResult(false, err.message);
    return { success: false, error: err.message };
  }
}

// Looks up a page's SMS settings (Admin toggles + message template).
async function getPageSmsSettings(pageId) {
  if (!pageId) return null;
  const result = await pool.query(
    "SELECT sms_on_website_order, sms_on_all_order, sms_message FROM pages WHERE id = $1",
    [pageId]
  );
  if (result.rows.length === 0) return null;
  const tokenRes = await pool.query(
    "SELECT api_key FROM api_credentials WHERE page_id = $1 AND type = 'sms' LIMIT 1",
    [pageId]
  );
  return {
    onWebsiteOrder: result.rows[0].sms_on_website_order,
    onAllOrder: result.rows[0].sms_on_all_order,
    message: result.rows[0].sms_message,
    token: tokenRes.rows[0]?.api_key || null,
  };
}

// Map a DB row to the shape the frontend expects.
function toApiShape(row) {
  return {
    id: row.id,
    rawText: row.raw_text,
    imageUrls: row.image_urls && row.image_urls.length ? row.image_urls : row.image_url ? [row.image_url] : [],
    moderator: row.moderator,
    group: row.group_name,
    batchId: row.batch_id,
    pageId: row.page_id,
    pageName: row.page_name,
    note: row.note,
    status: row.status,
    // Filled in automatically by AI once the entry is sent to courier
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    amount: row.amount,
    productCode: row.product_code,
    consignmentId: row.consignment_id,
    trackingCode: row.tracking_code,
    createdAt: row.created_at,
    salesDate: row.sales_date instanceof Date ? row.sales_date.toISOString().slice(0, 10) : row.sales_date,
  };
}

// ---- Generic AI calling (Gemini / OpenAI / Anthropic) --------------------
// Used both for reading delivery details (Send to Courier) and for
// building the Making group's production-only summary.

function stripJsonFences(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  // The model sometimes appends extra content after a valid JSON object
  // despite being told not to — find the first balanced {...} block and
  // use just that, instead of assuming the whole string is clean JSON.
  const start = cleaned.indexOf("{");
  if (start === -1) return cleaned;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned;
}

async function callGemini(userText, systemPrompt, apiKey, wantJson, patient = false) {
  const body = {
    contents: [{ parts: [{ text: `${systemPrompt}\n\nMessage:\n${userText}` }] }],
  };
  if (wantJson) body.generationConfig = { responseMimeType: "application/json", maxOutputTokens: 2048 };

  const attempt = async () =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  let response = await attempt();
  if (response.status === 429 || response.status === 503) {
    // 429 = our rate limit. 503 = Google's own servers overloaded.
    // "patient" mode (background bulk recalculation, nobody waiting on
    // a click) retries more with a growing wait (3/6/9/12s). Normal mode
    // (someone waiting on Send to Courier etc.) fails fast with one
    // short retry, so a slow moment doesn't turn into a 30+ second
    // freeze — they can just tap the button again.
    const retries = patient ? 4 : 1;
    for (let i = 0; i < retries && (response.status === 429 || response.status === 503); i++) {
      await new Promise((resolve) => setTimeout(resolve, patient ? 3000 * (i + 1) : 2000));
      response = await attempt();
    }
  }

  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text === undefined) throw new Error("No text in Gemini response");
  return text;
}

async function callOpenAI(userText, systemPrompt, apiKey, wantJson) {
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
  if (!text) throw new Error("No text in OpenAI response");
  return text;
}

async function callAnthropic(userText, systemPrompt, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in Anthropic response");
  return textBlock.text;
}

// Routes to whichever AI is configured for this page. If the page has
// multiple AI keys saved (up to 5), tries them in order — the moment one
// fails (rate limit, invalid key, network error, etc.) it moves on to the
// next automatically, so a single exhausted quota never blocks posting.
async function callAI(userText, systemPrompt, { json = false, pageId = null, patient = false } = {}) {
  const candidates = await getPageAiCredentials(pageId);

  if (candidates.length === 0) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const raw = await callAnthropic(userText, systemPrompt, anthropicKey);
    return json ? JSON.parse(stripJsonFences(raw)) : raw.trim();
  }

  let lastError;
  for (const saved of candidates) {
    try {
      let raw;
      if (saved.provider === "google") {
        raw = await callGemini(userText, systemPrompt, saved.api_key, json, patient);
      } else if (saved.provider === "openai") {
        raw = await callOpenAI(userText, systemPrompt, saved.api_key, json);
      } else {
        raw = await callAnthropic(userText, systemPrompt, saved.api_key);
      }
      return json ? JSON.parse(stripJsonFences(raw)) : raw.trim();
    } catch (err) {
      console.warn(`AI key (${saved.provider}) failed, trying next if available:`, err.message);
      lastError = err;
    }
  }
  const finalError = lastError || new Error("All AI keys failed");
  try {
    await pool.query("INSERT INTO ai_failure_log (context, error) VALUES ($1, $2)", [
      systemPrompt.slice(0, 60),
      finalError.message,
    ]);
  } catch (err) {
    console.warn("Could not write ai_failure_log:", err.message);
  }
  throw finalError;
}

// Reads the moderator's free-form pasted message and pulls out exactly the
// fields Steadfast needs. Runs only when "Send to Courier" is pressed —
// the moderator never sees or fills these fields directly.
const EXTRACTION_SYSTEM_PROMPT =
  "You extract delivery-order details from a Bengali/English mixed message written by a shop moderator. " +
  "The message may contain Bangla numerals (convert to normal digits), a product/order code, " +
  "customer name, address, an 11-digit phone number starting with 01, a bill/total amount " +
  "(sometimes shown as a calculation like 2250+150=2400-500=1900 — use the FINAL result), and a " +
  "Long/size measurement (e.g. '52', '54/56' — keep multiple values exactly as written, e.g. '54/56'). " +
  "Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: " +
  '{"recipient_name":"","recipient_phone":"","recipient_address":"","cod_amount":0,"invoice":"","size":""}. ' +
  "If a field truly cannot be found, use an empty string (or 0 for cod_amount).";

async function extractOrderInfo(rawText, pageId) {
  return callAI(rawText, EXTRACTION_SYSTEM_PROMPT, { json: true, pageId });
}

// Sales Summary needs its own extraction, kept deliberately separate from
// the Send-to-Courier/SMS one above — it needs the bill AND how many
// MAIN GARMENTS (borka/abaya) this order actually represents, since one
// post sometimes covers 2+ pieces in a single message.
const SALES_EXTRACTION_SYSTEM_PROMPT =
  "You read a Bengali/English shop order message for a borka/abaya business and extract two things: " +
  "1) cod_amount — the final bill/total (sometimes shown as a calculation like 2250+150=2400-500=1900 — use " +
  "the FINAL result; Bangla numerals count as normal digits). " +
  "2) garment_quantity — how many MAIN GARMENT pieces (borka/abaya) this order is for. Count ONLY the main " +
  "garment itself. Accessories like hijab (হিজাব), niqab (নিকাব), and inner (ইনার) do NOT add to the count — " +
  "e.g. '১ পিছ বোরকা হিজাবসহ', 'বোরকা + ইনার', 'বোরকা + নিকাব', 'বোরকা + হিজাব' are all garment_quantity 1. " +
  "But '২ পিছ বোরকা' or a plain '২ পিছ' clearly referring to garments is garment_quantity 2, and so on. " +
  "IMPORTANT: if the message mentions ONLY accessories with NO borka/abaya at all (e.g. 'ইনার হিজাব', just a " +
  "niqab, just a hijab order) — garment_quantity is 0, since no main garment was actually ordered. Do not " +
  "default an accessories-only order to 1. " +
  "EXCEPTION: 'কটি' (kuti) is a special accessory item — even when it's the ONLY thing ordered (e.g. 'শুধু কটি " +
  "৩ পিছ' with no borka mentioned), still count it normally as its own quantity (3 in that example), NOT 0. " +
  "'কটি' is the one accessory that counts on its own; other accessories (hijab/niqab/inner) alone still mean 0. " +
  "CROSS-CHECK using the Long/size measurement (সাইজ/Long field) as a second signal: a SINGLE size value " +
  "(e.g. Long: 54) means 1 piece. MULTIPLE size values listed together (e.g. '54,56' or '52 + 54' or '৫৪/৫৬') " +
  "mean multiple pieces — count how many size values are listed and use that as the garment_quantity if it's " +
  "higher than what the explicit quantity wording alone suggested (the two signals should agree; if they " +
  "conflict, trust whichever one indicates the HIGHER count, since under-counting a real order is worse than " +
  "over-counting). " +
  "If a borka/abaya IS clearly present but the exact count truly isn't stated anywhere (no quantity wording, " +
  "single size value), default garment_quantity to 1. " +
  "Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: " +
  '{"cod_amount":0,"garment_quantity":1}.';

async function extractSalesInfo(rawText, pageId) {
  return callAI(rawText, SALES_EXTRACTION_SYSTEM_PROMPT, { json: true, pageId });
}

// Reads the same message but pulls out ONLY what the Making (production)
// team needs: order number(s) exactly as written, size/measurement lines
// exactly as written (so combos like "54/56" or "2 pieces each" survive),
// and garment/quantity details. Customer name, phone, address, and price
// are deliberately excluded — production doesn't need them.
const MAKING_SYSTEM_PROMPT =
  "You read a Bengali/English shop order message and extract ONLY the details a garment-making/production " +
  "team needs — nothing about the customer or the price. Include, each on its own line, exactly as written " +
  "in the original message (keep Bangla text as Bangla): " +
  "1) the order number(s) (e.g. '7425' or '7425/7426'), " +
  "2) any Long/size measurements, preserving multiple values exactly (e.g. '54/56', not just '54'), " +
  "3) any হাতা (sleeve) or বডি (body) size if separately mentioned, " +
  "4) quantity and garment-type details (e.g. '2 pieces Borka, 2 Niqab', 'এক পিস বোরকা হিজাব সহ', 'ফুল সেট'). " +
  "STRICTLY EXCLUDE: customer name, phone number, address, and any bill/price/টাকা amount — even if a number " +
  "near a size looks like it could be a price, only include it if it is clearly a measurement or quantity, never " +
  "a currency amount. If nothing relevant is found, respond with an empty string. " +
  "Respond with ONLY the extracted lines as plain text — no JSON, no markdown, no explanation.";

// Combines what used to be two separate background AI calls (Making
// extraction + Sales-info extraction) into ONE — cuts AI call volume per
// post by a third, which matters a lot for Gemini's free-tier rate limit.
const COMBINED_MAKING_SALES_PROMPT =
  "You read a Bengali/English shop order message for a borka/abaya business and extract THREE things as JSON.\n\n" +
  "IMPORTANT — output cod_amount and garment_quantity FIRST, making_text LAST, in that exact order, since " +
  "making_text is the longest field and must never risk pushing the other two out if output space runs low.\n\n" +
  "1) cod_amount — the final bill/total (sometimes shown as a calculation like 2250+150=2400-500=1900 — use " +
  "the FINAL result; Bangla numerals count as normal digits; amounts may end in '/-' or '/=' which just means " +
  "'only', e.g. '2300/-' is 2300).\n\n" +
  "2) garment_quantity — how many MAIN GARMENT pieces (borka/abaya) this order is for. Count ONLY the main " +
  "garment itself. Accessories like hijab (হিজাব), niqab (নিকাব), and inner (ইনার) do NOT add to the count — " +
  "e.g. '১ পিছ বোরকা হিজাবসহ', 'বোরকা + ইনার', 'বোরকা + নিকাব', 'বোরকা + হিজাব' are all garment_quantity 1. " +
  "But '২ পিছ বোরকা' or a plain '২ পিছ' clearly referring to garments is garment_quantity 2, and so on. " +
  "If the message mentions ONLY accessories with NO borka/abaya at all (e.g. 'ইনার হিজাব', just a niqab, just " +
  "a hijab order) — garment_quantity is 0. EXCEPTION: 'কটি' (kuti) is a special accessory item — even when " +
  "it's the ONLY thing ordered (e.g. 'শুধু কটি ৩ পিছ' with no borka mentioned), count it normally as its own " +
  "quantity (3 in that example), NOT 0 — 'কটি' is the one accessory that counts on its own; other accessories " +
  "alone still mean 0. CROSS-CHECK using the Long/size measurement as a second signal: a SINGLE size value " +
  "means 1 piece; MULTIPLE size values listed together (e.g. '54,56' or '52 + 54') mean multiple pieces — if " +
  "the two signals conflict, trust whichever indicates the HIGHER count. If a borka/abaya IS clearly present " +
  "but the exact count truly isn't stated anywhere, default garment_quantity to 1.\n\n" +
  "3) making_text — details a garment-making/production team needs, nothing about the customer or price. " +
  "Include, each on its own line, exactly as written in the original message (keep Bangla text as Bangla): " +
  "the order number(s) (e.g. '7425' or '7425/7426'); any Long/size measurements, preserving multiple values " +
  "exactly (e.g. '54/56', not just '54'); any হাতা (sleeve) or বডি (body) size if separately mentioned; " +
  "quantity and garment-type details (e.g. '2 pieces Borka, 2 Niqab', 'এক পিস বোরকা হিজাব সহ', 'ফুল সেট'). " +
  "Keep this field concise (a few short lines, not a full essay). STRICTLY EXCLUDE customer name, phone, " +
  "address, and any bill/price/টাকা amount. If nothing relevant is found, use an empty string.\n\n" +
  "Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: " +
  '{"cod_amount":0,"garment_quantity":1,"making_text":""}.';

// District/Thana extraction — used for the area-wise cancel-rate report,
// pulled from the delivery address (Bangladesh addresses commonly name
// the district and thana/upazila, but not always in a fixed order/format).
const LOCATION_EXTRACTION_PROMPT =
  "You read a Bangladesh delivery address (Bengali/English mixed) and identify the DISTRICT (জেলা) and " +
  "THANA/UPAZILA (থানা/উপজেলা) it belongs to. Bangladeshi addresses often name these explicitly (e.g. 'জেলা: " +
  "মৌলভীবাজার', 'থানা: কমলগঞ্জ') but sometimes only imply them from a known place name (e.g. a village or " +
  "bazar name that you recognize as belonging to a specific district/thana) — use your knowledge of " +
  "Bangladesh's geography to fill in what's implied, not just what's literally labeled. " +
  "If the district or thana truly cannot be determined, use an empty string for that field — do not guess " +
  "randomly. " +
  "Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: " +
  '{"district":"","thana":""}.';

async function extractLocationInfo(address, pageId, patient = false) {
  return callAI(address, LOCATION_EXTRACTION_PROMPT, { json: true, pageId, patient });
}

async function extractCombinedInfo(rawText, pageId, patient = false) {
  return callAI(rawText, COMBINED_MAKING_SALES_PROMPT, { json: true, pageId, patient });
}

async function extractMakingInfo(rawText, pageId) {
  const text = await callAI(rawText, MAKING_SYSTEM_PROMPT, { json: false, pageId });
  return text && text.length ? text : null;
}

// Converts Bangla digits (০-৯) to normal digits so regex matching works.
function toEnglishDigits(str) {
  const map = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
  return str.replace(/[০-৯]/g, (d) => map[d]);
}

// Detects which garment/inclusion words are mentioned — any combination
// can appear together (e.g. "এক পিস বোরকা + হিজাব").
function extractTags(rawText) {
  const tags = [];
  let borkaConsumed = false;

  if (/এক\s*পিস\s*বোরকা/.test(rawText)) {
    tags.push("এক পিস বোরকা");
    borkaConsumed = true;
  }
  if (/ফুল\s*সেট/.test(rawText)) tags.push("ফুল সেট");
  if (/আবায়া/.test(rawText)) tags.push("আবায়া");
  if (/হিজাব/.test(rawText)) tags.push("হিজাব সহ");
  if (/নিকাব/.test(rawText)) tags.push("নিকাব সহ");
  if (/ইনার/.test(rawText)) tags.push("ইনার সহ");
  if (!borkaConsumed && /বোরকা/.test(rawText)) tags.push("বোরকা");

  return tags;
}

// Builds the trimmed-down message that goes to the "Making" group. Instead
// of extracting single numbers (which loses info like "54/56" or "2 pieces
// each"), this keeps whole lines that mention order numbers, sizes, or
// quantities — so multi-item orders don't lose data.
function buildMakingText(rawText) {
  const text = toEnglishDigits(rawText);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const orderLine = lines.find((l) => /\b\d{4,6}\b/.test(l));
  const sizeLine = lines.find((l) => /(long|size|সাইজ|লং|লম্বা)/i.test(l));
  const hataLine = lines.find((l) => /(হাতা|hata|sleeve)/i.test(l) && l !== sizeLine);
  const bodyLine = lines.find((l) => /(বডি\s*সাইজ|body\s*size)/i.test(l) && l !== sizeLine);
  const quantityLines = lines.filter((l) => /\d+\s*(টা(?!কা)|পিস|piece)/i.test(l));

  const parts = [];
  if (orderLine) parts.push(`অর্ডার: ${orderLine}`);
  if (sizeLine) parts.push(sizeLine);
  if (hataLine) parts.push(hataLine);
  if (bodyLine) parts.push(bodyLine);

  if (quantityLines.length) {
    quantityLines.forEach((l) => parts.push(l));
  } else {
    extractTags(rawText).forEach((t) => parts.push(t));
  }

  return parts.length ? parts.join("\n") : null;
}

// GET /api/entries/stream — Server-Sent Events connection. Every logged-in
// device keeps one of these open; the moment anything changes, everyone
// connected gets pinged instantly and refetches — this is what makes the
// app feel live, like Telegram, instead of only updating every so often.
router.get("/stream", (req, res) => {
  try {
    verifyToken(req.query.token);
  } catch {
    return res.status(401).end();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  addClient(res);

  // Keep the connection alive through proxies/load balancers
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeClient(res);
  });
});

// Shared creation logic — inserts the entry, and if it's posted to "All
// Order", auto-forwards copies into "Pending" and "Making" too. Used by
// both the app's POST route and the WooCommerce webhook.
async function createEntry({ rawText, imageUrls, moderator, group, pageId, pageName, status, customerPhone, customerDevice, salesDateChoice, wooOrderId }) {
  const targetGroup = group || "pending";
  const batchId = randomUUID();
  const images = JSON.stringify(imageUrls || []);
  const isYesterday = salesDateChoice === "yesterday";

  const result = await pool.query(
    `INSERT INTO entries (raw_text, image_urls, moderator, group_name, batch_id, page_id, page_name, status, customer_phone, customer_device, sales_date, woo_order_id)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, COALESCE($8, 'pending'), $9, $10,
       CASE WHEN $11 THEN ((NOW() AT TIME ZONE 'Asia/Dhaka')::date - INTERVAL '1 day') ELSE ((NOW() AT TIME ZONE 'Asia/Dhaka')::date) END,
       $12)
     RETURNING *`,
    [rawText, images, moderator, targetGroup, batchId, pageId || null, pageName || null, status || null, customerPhone || null, customerDevice || null, isYesterday, wooOrderId || null]
  );

  if (targetGroup === "all_order") {
    await pool.query(
      `INSERT INTO entries (raw_text, image_urls, moderator, group_name, batch_id, page_id, page_name, sales_date)
       VALUES ($1, $2::jsonb, $3, 'pending', $4, $5, $6,
         CASE WHEN $7 THEN ((NOW() AT TIME ZONE 'Asia/Dhaka')::date - INTERVAL '1 day') ELSE ((NOW() AT TIME ZONE 'Asia/Dhaka')::date) END)`,
      [rawText, images, moderator, batchId, pageId || null, pageName || null, isYesterday]
    );

    // Making group's text, the bill, AND the garment-piece count all come
    // from ONE combined AI call now (used to be two separate calls) —
    // cuts AI request volume per post by a third, which matters a lot
    // for API rate limits. Runs in the background so the post itself
    // confirms instantly; the Making card pops in moments later via the
    // normal live SSE refresh. Sales Summary's numbers are completely
    // independent of Send to Courier — whatever's found here is kept
    // forever, even if the order ships with a slightly different bill.
    (async () => {
      try {
        let makingText = null;
        let estimatedAmount = 0;
        let estimatedQuantity = 1;
        try {
          const extracted = await extractCombinedInfo(rawText, pageId);
          makingText = extracted.making_text || null;
          estimatedAmount = Number(extracted.cod_amount) || 0;
          estimatedQuantity = Number(extracted.garment_quantity) || 1;
        } catch (err) {
          console.error("Combined AI extraction failed, using fallback:", err);
          makingText = buildMakingText(rawText);
        }

        if (makingText) {
          await pool.query(
            `INSERT INTO entries (raw_text, image_urls, moderator, group_name, batch_id, page_id, page_name)
             VALUES ($1, $2::jsonb, $3, 'making', $4, $5, $6)`,
            [makingText, images, moderator, batchId, pageId || null, pageName || null]
          );
        }
        await pool.query("UPDATE entries SET estimated_amount = $1, estimated_quantity = $2 WHERE id = $3", [
          estimatedAmount,
          estimatedQuantity,
          result.rows[0].id,
        ]);
        broadcastRefresh();
      } catch (err) {
        console.error("Background combined extraction failed:", err);
      }
    })();
  }

  broadcastRefresh();

  const groupTitles = { pending: "Pending", all_order: "All Order", making: "Making", website_order: "Website Order" };
  notifyAll({
    title: `নতুন এন্ট্রি — ${groupTitles[targetGroup] || targetGroup}`,
    body: (rawText || "").split("\n")[0]?.slice(0, 80) || "নতুন একটা এন্ট্রি এসেছে",
    group: targetGroup,
  });

  return result.rows[0];
}

// GET /api/entries/sms-balance — Admin only. Checks the remaining SMS
// credit for every page that has its own SMS token configured.
router.get("/sms-balance", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT p.id, p.name, c.api_key AS token
       FROM pages p JOIN api_credentials c ON c.page_id = p.id
       WHERE c.type = 'sms'`
    );
    const results = await Promise.all(
      rows.rows.map(async (page) => {
        try {
          const url = `https://api.bdbulksms.net/g_api.php?token=${encodeURIComponent(page.token)}&balance&json`;
          const r = await fetch(url);
          const text = await r.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          const balance =
            (data && !Array.isArray(data) && data.balance) ??
            (Array.isArray(data) && data[0]?.balance) ??
            null;
          if (balance === null) console.warn(`SMS balance (${page.name}) — unexpected response:`, text);
          return { pageId: page.id, pageName: page.name, balance, raw: text };
        } catch (err) {
          return { pageId: page.id, pageName: page.name, balance: null, error: err.message };
        }
      })
    );
    res.json(results);
  } catch (err) {
    console.error("SMS balance check failed:", err.message);
    res.status(500).json({ error: "ব্যালেন্স আনা যায়নি" });
  }
});

// GET /api/entries/:id/tracking — Admin only. Logs into Steadfast's
// Moderator panel (per-page account, view-only) and returns the rider's
// name/phone plus the full tracking timeline for this entry's parcel.
router.get("/:id/tracking", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = existing.rows[0];
    if (!entry.consignment_id) {
      return res.status(400).json({ error: "এই এন্ট্রি এখনো কুরিয়ারে পাঠানো হয়নি" });
    }
    if (!entry.page_id) {
      return res.status(400).json({ error: "এই এন্ট্রির সাথে কোনো পেইজ যুক্ত নেই" });
    }

    const modRes = await pool.query(
      "SELECT api_key, secret_key FROM api_credentials WHERE page_id = $1 AND type = 'steadfast_moderator' LIMIT 1",
      [entry.page_id]
    );
    if (modRes.rows.length === 0) {
      return res.status(400).json({ error: "এই পেইজের জন্য Steadfast Moderator অ্যাকাউন্ট সেটআপ করা হয়নি" });
    }

    const tracking = await getConsignmentTracking(
      entry.page_id,
      modRes.rows[0].api_key,
      modRes.rows[0].secret_key,
      entry.consignment_id
    );
    res.json(tracking);
  } catch (err) {
    console.error("Tracking fetch failed:", err);
    res.status(500).json({ error: err.message || "ট্র্যাকিং তথ্য আনা যায়নি" });
  }
});

// GET /api/entries/fraud-results — all previously-saved fraud-check
// results, as a { phone: {total, delivered, cancelled, successRate} }
// map, so the app can show them automatically under phone numbers
// everywhere without a fresh check each time.
router.get("/fraud-results", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fraud_check_results");
    const map = {};
    result.rows.forEach((row) => {
      map[row.phone] = {
        total: row.total,
        delivered: row.delivered,
        cancelled: row.cancelled,
        successRate: Number(row.success_rate),
      };
    });
    res.json(map);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load fraud results" });
  }
});

// GET /api/entries — list all entries, newest first (any logged-in user)
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM entries ORDER BY created_at DESC"
    );
    let rows = result.rows;
    // Group access control — admins always see everything. A moderator
    // with allowedGroups set only gets entries from those groups; NULL
    // means unrestricted (the default, so nobody is locked out until an
    // admin deliberately sets specific permissions for them).
    if (req.user.role !== "admin" && req.user.allowedGroups) {
      rows = rows.filter((r) => req.user.allowedGroups.includes(r.group_name));
    }
    res.json(rows.map(toApiShape));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load entries" });
  }
});

// POST /api/entries — create a new entry (Admin AND Moderator can post)
// Special rule: anything posted to "All Order" is automatically forwarded
// (as its own copy, with the same image) into "Pending" too.
// Checks the raw text for a valid Bangladeshi mobile number in any common
// format: 01XXXXXXXXX, +8801XXXXXXXXX, 8801XXXXXXXXX, with or without
// spaces/dashes anywhere in it (e.g. "+880 160-394 3448").
function hasValidBangladeshiPhone(text) {
  const cleaned = (text || "").replace(/[\s-]/g, "");
  return /(?:\+?880|0)1[3-9]\d{8}/.test(cleaned);
}

router.post("/", requireAuth, async (req, res) => {
  try {
    const targetGroup = req.body.group || "pending";

    // A manual post must include a real phone number — this is the only
    // place moderators free-type an order, so it's the right place to
    // enforce this (auto-forwarded/webhook entries are exempt).
    if (targetGroup === "all_order" && !hasValidBangladeshiPhone(req.body.rawText)) {
      return res.status(400).json({
        error: "সঠিক ১১ সংখ্যার ফোন নাম্বার ছাড়া পোস্ট করা যাবে না (যেমন: 01xxxxxxxxx)",
      });
    }

    let pageName = null;
    if (req.body.pageId) {
      const pageRes = await pool.query("SELECT name FROM pages WHERE id = $1", [req.body.pageId]);
      pageName = pageRes.rows[0]?.name || null;
    }

    // Auto-number every manual All Order post — the moderator never
    // types the order number, it's assigned automatically in sequence.
    let rawText = req.body.rawText;
    if (targetGroup === "all_order") {
      const numResult = await pool.query("SELECT nextval('order_number_seq') AS n");
      rawText = `${numResult.rows[0].n}\n${rawText}`;
    }

    // "গতকালের" day-choice only shifts sales_date (Sales Summary bucket)
    // — created_at (real posting time, used for normal list ordering)
    // stays exactly as-is.
    const entry = await createEntry({ ...req.body, rawText, pageName, salesDateChoice: req.body.dayChoice });

    // Order-confirmation SMS — All Order posts only, if this page has it
    // turned on. Uses AI extraction (same as Send to Courier) to fill in
    // the customer's name, order number, and bill amount.
    let smsResult = null;
    if (targetGroup === "all_order" && req.body.pageId) {
      const smsSettings = await getPageSmsSettings(req.body.pageId);
      if (smsSettings?.onAllOrder && smsSettings.message) {
        const cleaned = rawText.replace(/[\s-]/g, "");
        const phoneMatch = cleaned.match(/(?:\+?880|0)1[3-9]\d{8}/);
        if (phoneMatch) {
          let extracted = {};
          try {
            extracted = await extractOrderInfo(rawText, req.body.pageId);
          } catch (err) {
            console.warn("SMS detail extraction failed, sending with blanks:", err.message);
          }
          const filled = fillSmsTemplate(smsSettings.message, {
            name: extracted.recipient_name,
            orderNumber: extracted.invoice,
            size: extracted.size,
            amount: extracted.cod_amount,
          });
          smsResult = await sendSMS(phoneMatch[0], filled, smsSettings.token);
        }
      }
    }

    res.status(201).json({ ...toApiShape(entry), smsResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create entry" });
  }
});

// PUT /api/entries/:id — edit the raw message, image, or moderator
// (Admin only — moderators cannot edit)
router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const fields = {
    raw_text: req.body.rawText,
    moderator: req.body.moderator,
    group_name: req.body.group,
  };

  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  const setParts = keys.map((k, i) => `${k} = $${i + 1}`);
  const values = keys.map((k) => fields[k]);

  if (req.body.imageUrls !== undefined) {
    setParts.push(`image_urls = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(req.body.imageUrls));
  }

  if (setParts.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    const result = await pool.query(
      `UPDATE entries SET ${setParts.join(", ")} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const updated = result.rows[0];

    // If this edit was made in "All Order", push the same changes down to
    // its linked Pending copy, and a freshly-filtered version down to its
    // linked Making copy — so all three stay in sync.
    if (
      updated.group_name === "all_order" &&
      updated.batch_id &&
      (req.body.rawText !== undefined || req.body.imageUrls !== undefined)
    ) {
      const pendingParts = [];
      const pendingValues = [];
      if (req.body.rawText !== undefined) {
        pendingParts.push(`raw_text = $${pendingValues.length + 1}`);
        pendingValues.push(req.body.rawText);
      }
      if (req.body.imageUrls !== undefined) {
        pendingParts.push(`image_urls = $${pendingValues.length + 1}::jsonb`);
        pendingValues.push(JSON.stringify(req.body.imageUrls));
      }
      if (pendingParts.length) {
        await pool.query(
          `UPDATE entries SET ${pendingParts.join(", ")} WHERE batch_id = $${pendingValues.length + 1} AND group_name = 'pending'`,
          [...pendingValues, updated.batch_id]
        );
      }

      // Making's re-sync needs an AI call (1-3s) — run this in the
      // background so the edit itself confirms instantly, instead of
      // making the moderator wait for it every time they fix a typo.
      (async () => {
        try {
          const makingParts = [];
          const makingValues = [];
          if (req.body.rawText !== undefined) {
            let makingText;
            try {
              makingText = await extractMakingInfo(req.body.rawText, updated.page_id);
            } catch (err) {
              console.error("Making-group AI extraction failed, using fallback:", err);
              makingText = buildMakingText(req.body.rawText);
            }
            if (makingText) {
              makingParts.push(`raw_text = $${makingValues.length + 1}`);
              makingValues.push(makingText);
            }
          }
          if (req.body.imageUrls !== undefined) {
            makingParts.push(`image_urls = $${makingValues.length + 1}::jsonb`);
            makingValues.push(JSON.stringify(req.body.imageUrls));
          }
          if (makingParts.length) {
            await pool.query(
              `UPDATE entries SET ${makingParts.join(", ")} WHERE batch_id = $${makingValues.length + 1} AND group_name = 'making'`,
              [...makingValues, updated.batch_id]
            );
            broadcastRefresh();
          }
        } catch (err) {
          console.error("Background Making-group sync failed:", err);
        }
      })();
    }

    res.json(toApiShape(updated));
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update entry" });
  }
});

// POST /api/entries/recalculate-sales — Admin only. Re-runs the AI
// analysis (bill + garment count) for EVERY All Order post made today
// (Bangladesh time), not just the previously-failed ones — a full
// refresh of today's summary. Processed sequentially to avoid
// re-triggering rate limits.
router.post("/recalculate-sales", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, raw_text, page_id FROM entries
       WHERE group_name = 'all_order'
         AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date = (NOW() AT TIME ZONE 'Asia/Dhaka')::date
       ORDER BY created_at DESC`
    );
    let fixed = 0;
    let stillFailed = 0;
    for (const row of result.rows) {
      try {
        const extracted = await extractCombinedInfo(row.raw_text, row.page_id, true);
        const estimatedAmount = Number(extracted.cod_amount) || 0;
        const estimatedQuantity = Number(extracted.garment_quantity) || 1;
        if (estimatedAmount === 0) {
          console.log("Recalculate — got 0 for entry", row.id, "| input:", JSON.stringify(row.raw_text)); // temporary debug
          console.log("Recalculate — AI output:", JSON.stringify(extracted)); // temporary debug
        }
        await pool.query("UPDATE entries SET estimated_amount = $1, estimated_quantity = $2 WHERE id = $3", [
          estimatedAmount,
          estimatedQuantity,
          row.id,
        ]);
        fixed += 1;
      } catch (err) {
        console.log("Recalculate — threw for entry", row.id, "| error:", err.message); // temporary debug
        stillFailed += 1;
      }
    }
    res.json({ checked: result.rows.length, fixed, stillFailed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not recalculate" });
  }
});

// POST /api/entries/backfill-locations — Admin only. For orders already
// sent to courier (so they have a real delivery address + courier
// status) but missing district/thana, runs the AI extraction now. A
// one-time catch-up for old orders — new ones get this automatically at
// Send to Courier time. Processes up to 50 at a time, patiently.
router.post("/backfill-locations", requireAuth, requireAdmin, async (req, res) => {
  const websiteOnly = req.query.source === "website";
  const websiteClause = websiteOnly ? "AND moderator = 'ওয়েবসাইট'" : "";
  try {
    const result = await pool.query(
      `SELECT id, batch_id, customer_address, page_id FROM entries
       WHERE consignment_id IS NOT NULL AND customer_address IS NOT NULL
         AND (district IS NULL OR thana IS NULL)
         ${websiteClause}
       ORDER BY created_at DESC LIMIT 50`
    );
    let fixed = 0;
    let stillFailed = 0;
    for (const row of result.rows) {
      try {
        const loc = await extractLocationInfo(row.customer_address, row.page_id, true);
        if (row.batch_id) {
          await pool.query("UPDATE entries SET district = $1, thana = $2 WHERE batch_id = $3", [
            loc.district || null,
            loc.thana || null,
            row.batch_id,
          ]);
        } else {
          await pool.query("UPDATE entries SET district = $1, thana = $2 WHERE id = $3", [
            loc.district || null,
            loc.thana || null,
            row.id,
          ]);
        }
        fixed += 1;
      } catch (err) {
        stillFailed += 1;
      }
    }
    const remainingRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM entries
       WHERE consignment_id IS NOT NULL AND customer_address IS NOT NULL
         AND (district IS NULL OR thana IS NULL)
         ${websiteClause}`
    );
    res.json({ checked: result.rows.length, fixed, stillFailed, remaining: remainingRes.rows[0].c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not backfill locations" });
  }
});

// GET /api/entries/otp-log — Admin only. Recent OTP send attempts (last
// 100), so delivery problems can be spotted from inside the app instead
// of digging through Railway logs. Never exposes the actual OTP code.
router.get("/otp-log", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT phone, sent, send_error, verified, created_at
       FROM otp_verifications
       ORDER BY created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load OTP log" });
  }
});

// GET /api/entries/facebook-log — Admin only. Recent Facebook
// Complete/Refund event attempts (last 100).
router.get("/facebook-log", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT phone, event_name, success, error, created_at
       FROM facebook_event_log
       ORDER BY created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load Facebook event log" });
  }
});

// GET /api/entries/recycle-bin — Admin only. Auto-deletes anything older
// than 24 hours first, then returns what's left.
router.get("/recycle-bin", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM recycle_bin WHERE deleted_at < NOW() - INTERVAL '24 hours'");
    const result = await pool.query("SELECT * FROM recycle_bin ORDER BY deleted_at DESC");
    res.json(
      result.rows.map((row) => ({
        id: row.id,
        originalGroup: row.original_group,
        rawText: row.raw_text,
        imageUrls: row.image_urls || [],
        moderator: row.moderator,
        pageId: row.page_id,
        pageName: row.page_name,
        deleteReason: row.delete_reason,
        status: row.status,
        customerPhone: row.customer_phone,
        deletedAt: row.deleted_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load Recycle Bin" });
  }
});

// POST /api/entries/recycle-bin/:id/restore — puts it back into its
// original group.
router.post("/recycle-bin/:id/restore", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM recycle_bin WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const item = result.rows[0];

    await createEntry({
      rawText: item.raw_text,
      imageUrls: item.image_urls || [],
      moderator: item.moderator,
      group: item.original_group,
      pageId: item.page_id,
      pageName: item.page_name,
      status: item.original_group === "website_order" ? item.status || "processing" : undefined,
      customerPhone: item.customer_phone,
    });

    await pool.query("DELETE FROM recycle_bin WHERE id = $1", [id]);
    res.json({ restored: true });
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not restore" });
  }
});

// DELETE /api/entries/recycle-bin/:id — permanently deletes one item
// right now, instead of waiting for the 24-hour auto-expiry.
router.delete("/recycle-bin/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM recycle_bin WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete" });
  }
});

// DELETE /api/entries/:id — removes from OUR database only (Admin only).
// This never touches Steadfast — an already-sent consignment stays exactly
// as it is on their side even after we delete it here.
// Special rule: deleting a Pending entry also deletes its matching Making
// entry (same batch_id), since Making was auto-forwarded from it.
// Also: All Order entries deleted BEFORE being sent to courier, and
// Website Order entries deleted before being forwarded, both get archived
// into the Recycle Bin (auto-expires after 24 hours).
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = existing.rows[0];

    // All Order is the "source" copy — deleting it requires typing a
    // confirmation password, and removes its linked Pending/Making copies
    // too (so a deleted order can't accidentally still get shipped).
    if (entry.group_name === "all_order") {
      const expected = process.env.ALL_ORDER_DELETE_PASSWORD || "Asbab";
      if (req.body?.password !== expected) {
        return res.status(403).json({ error: "ভুল পাসওয়ার্ড" });
      }

      // Only recycle if it hasn't been sent to courier yet — an already-
      // shipped order doesn't need a "restore" path.
      if (entry.status !== "sent") {
        await pool.query(
          `INSERT INTO recycle_bin (original_group, raw_text, image_urls, moderator, page_id, page_name, status, customer_phone)
           VALUES ('all_order', $1, $2::jsonb, $3, $4, $5, $6, $7)`,
          [entry.raw_text, JSON.stringify(entry.image_urls || []), entry.moderator, entry.page_id, entry.page_name, entry.status, entry.customer_phone]
        );
      }

      if (entry.batch_id) {
        await pool.query(
          "DELETE FROM entries WHERE batch_id = $1 AND group_name IN ('pending', 'making')",
          [entry.batch_id]
        );
      }
    }

    // Website Order — this only applies to the "অর্ডার" sub-tab
    // (Processing/Hold), NOT the "Incomplete" sub-tab. Incomplete entries
    // delete directly, same as before — no reason needed, no recycling
    // (they're just abandoned-checkout noise, not real order data).
    if (entry.group_name === "website_order" && entry.status !== "incomplete") {
      const reason = (req.body?.reason || "").trim();
      if (!reason) {
        return res.status(400).json({ error: "ডিলিট করার কারণ লিখতে হবে" });
      }
      await pool.query(
        `INSERT INTO recycle_bin (original_group, raw_text, image_urls, moderator, page_id, page_name, delete_reason, status, customer_phone)
         VALUES ('website_order', $1, $2::jsonb, $3, $4, $5, $6, $7, $8)`,
        [entry.raw_text, JSON.stringify(entry.image_urls || []), entry.moderator, entry.page_id, entry.page_name, reason, entry.status, entry.customer_phone]
      );

      // Rejected without ever confirming/forwarding it — treat exactly
      // like a cancel/return for Facebook + WooCommerce, in the
      // background so the delete itself stays fast.
      console.log("Refund-sync check — woo_order_id:", entry.woo_order_id, "page_id:", entry.page_id); // temporary debug
      if (entry.woo_order_id) {
        (async () => {
          try {
            const fbResult = await sendFacebookEvent(entry.page_id, entry.customer_phone, "OrderRefunded", entry.customer_name);
            console.log("Refund-sync — Facebook result:", JSON.stringify(fbResult)); // temporary debug
            const wcResult = await updateWooOrderStatus(entry.page_id, entry.woo_order_id, "refunded");
            console.log("Refund-sync — WooCommerce result:", JSON.stringify(wcResult)); // temporary debug
          } catch (err) {
            console.error("Facebook/WC refund sync failed (website order delete):", err.message);
          }
        })();
      } else {
        console.log("Refund-sync skipped — no woo_order_id on this entry"); // temporary debug
      }
    }

    await pool.query("DELETE FROM entries WHERE id = $1", [id]);

    if (entry.group_name === "pending" && entry.batch_id) {
      await pool.query(
        "DELETE FROM entries WHERE batch_id = $1 AND group_name = 'making'",
        [entry.batch_id]
      );
    }

    res.json({ deleted: true, id });
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete entry" });
  }
});

// POST /api/entries/:id/mark-done — used only by the Making group's
// "Send Making" button (Admin only). Just flips status to done; never
// touches Steadfast.
// PATCH /api/entries/:id/status — used by Website Order group's
// Processing/Hold workflow (Admin only). "Hold" typically comes with a
// note explaining why (e.g. "customer didn't answer, call back later").
router.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body;
  if (!["processing", "hold", "incomplete"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    const result = await pool.query(
      "UPDATE entries SET status = $1, note = $2 WHERE id = $3 RETURNING *",
      [status, note || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    res.json(toApiShape(result.rows[0]));
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update status" });
  }
});

// POST /api/entries/:id/send-to-all-order — used by the Website Order
// group's "Send to All Order" button (Admin only, for both regular and
// Incomplete entries). After the admin has confirmed the order (by
// phone), this copies it into All Order (which triggers the normal
// Pending/Making auto-forward) and REMOVES the Website Order entry
// entirely — it's done its job, no need to keep a stale copy around.
router.post("/:id/send-to-all-order", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { pageId, dayChoice } = req.body;
  try {
    const existing = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = existing.rows[0];

    let pageName = null;
    if (pageId) {
      const pageRes = await pool.query("SELECT name FROM pages WHERE id = $1", [pageId]);
      pageName = pageRes.rows[0]?.name || null;
    }

    await createEntry({
      rawText: entry.raw_text,
      imageUrls: entry.image_urls || [],
      moderator: entry.moderator,
      group: "all_order",
      pageId,
      pageName,
      salesDateChoice: dayChoice,
      wooOrderId: entry.woo_order_id,
    });

    // Order-confirmation SMS, if this page has it turned on. Uses AI
    // extraction (same as Send to Courier) to fill in the customer's
    // name, order number, and bill amount.
    let smsResult = null;
    if (pageId) {
      const smsSettings = await getPageSmsSettings(pageId);
      if (smsSettings?.onAllOrder && smsSettings.message) {
        const phone =
          entry.customer_phone ||
          (entry.raw_text || "").replace(/[\s-]/g, "").match(/(?:\+?880|0)1[3-9]\d{8}/)?.[0];
        if (phone) {
          let extracted = {};
          try {
            extracted = await extractOrderInfo(entry.raw_text, pageId);
          } catch (err) {
            console.warn("SMS detail extraction failed, sending with blanks:", err.message);
          }
          const filled = fillSmsTemplate(smsSettings.message, {
            name: extracted.recipient_name,
            orderNumber: extracted.invoice,
            size: extracted.size,
            amount: extracted.cod_amount,
          });
          smsResult = await sendSMS(phone, filled, smsSettings.token);
        }
      }
    }

    await pool.query("DELETE FROM entries WHERE id = $1", [id]);

    res.json({ deleted: true, id, smsResult });
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send to All Order" });
  }
});

router.post("/:id/mark-done", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "UPDATE entries SET status = 'sent' WHERE id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    res.json(toApiShape(result.rows[0]));
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update entry" });
  }
});

// POST /api/entries/:id/send-to-courier (Admin only)
// Reads the raw pasted message, asks Claude to extract the delivery fields
// in the background, then creates the order on Steadfast.
// Turns any phone number format into fraudbd.com's expected "01XXXXXXXXX".
function normalizeBDPhone(raw) {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.startsWith("880")) digits = digits.slice(3);
  if (!digits.startsWith("0") && digits.length === 10) digits = "0" + digits;
  return digits;
}

// POST /api/entries/:id/fraud-check — Admin only. Looks up the
// customer's delivery history using TWO Steadfast-only sources: our own
// in-house history (from the Steadfast delivery-status webhook), and
// Steadfast's own official fraud_check endpoint (same api-key/secret-key
// as order
// creation — no merchant login needed, discovered from their official WP
// plugin source).
router.post("/:id/fraud-check", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = existing.rows[0];

    let phone = entry.customer_phone;
    if (!phone) {
      const cleaned = (entry.raw_text || "").replace(/[\s-]/g, "");
      const match = cleaned.match(/(?:\+?880|0)1[3-9]\d{8}/);
      phone = match ? match[0] : null;
    }
    phone = normalizeBDPhone(phone);
    if (!phone || phone.length !== 11) {
      return res.status(400).json({ error: "এই এন্ট্রিতে সঠিক ফোন নাম্বার পাওয়া যায়নি" });
    }

    // Our own delivery history with this customer (from the Steadfast
    // webhook) — accurate, but only exists for customers who've ordered
    // from us before.
    const ownHistory = await pool.query(
      `SELECT courier_status, COUNT(*)::int AS count
       FROM entries
       WHERE customer_phone = $1 AND courier_status IS NOT NULL
       GROUP BY courier_status`,
      [phone]
    );
    const ownSummary = { total: 0, delivered: 0, cancelled: 0, other: 0 };
    ownHistory.rows.forEach((row) => {
      ownSummary.total += row.count;
      const s = (row.courier_status || "").toLowerCase();
      if (s === "delivered") ownSummary.delivered += row.count;
      else if (s === "cancelled") ownSummary.cancelled += row.count;
      else ownSummary.other += row.count;
    });

    // Official Steadfast fraud-check — uses the SAME api-key/secret-key
    // we already use for courier orders (no merchant login needed).
    // Discovered from Steadfast's own official WP plugin source —
    // undocumented publicly, but a real endpoint of theirs. Always
    // checked live (never cached) — it's rate-limited per page/key.
    //
    // Website Order entries always use "Al Haya" page's key specifically
    // (they don't reliably carry the right page_id yet), everything else
    // uses its own linked page's key.
    let steadfastOfficial = null;
    try {
      let courierCred;
      if (entry.group_name === "website_order") {
        const alHayaPage = await pool.query("SELECT id FROM pages WHERE name = 'Al-Haya' LIMIT 1");
        courierCred = alHayaPage.rows.length
          ? await getPageCredential("courier", "steadfast", alHayaPage.rows[0].id)
          : null;
      } else {
        courierCred = await getPageCredential("courier", "steadfast", entry.page_id);
      }
      const sfKey = (courierCred?.api_key || process.env.STEADFAST_API_KEY || "").trim();
      const sfSecret = (courierCred?.secret_key || process.env.STEADFAST_SECRET_KEY || "").trim();
      if (sfKey && sfSecret) {
        const sfRes = await fetch(`https://portal.packzy.com/api/v1/fraud_check/${phone}`, {
          method: "GET",
          headers: { "content-type": "application/json", "api-key": sfKey, "secret-key": sfSecret },
        });
        const sfData = await sfRes.json();
        if (sfData?.message) {
          steadfastOfficial = { message: sfData.message, attemptsLeft: sfData.attempts_left ?? null };
        } else if (sfData?.error) {
          steadfastOfficial = { error: sfData.error, current: sfData.current, limit: sfData.limit };
        } else {
          const total = Number(sfData?.total_parcels) || 0;
          const delivered = Number(sfData?.total_delivered) || 0;
          const cancelled = Number(sfData?.total_cancelled) || 0;
          steadfastOfficial = {
            total,
            delivered,
            cancelled,
            successRate: total > 0 ? Math.round((delivered / total) * 10000) / 100 : 0,
          };
        }
      } else {
        steadfastOfficial = { error: "কুরিয়ার key পাওয়া যায়নি", current: null, limit: null };
      }
    } catch (err) {
      console.warn("Steadfast official fraud_check failed:", err.message);
      steadfastOfficial = { error: "Steadfast-এ যোগাযোগ করা যায়নি", current: null, limit: null };
    }

    // Save a successful result permanently (not the rate-limit/error
    // ones) so it can show automatically under this phone everywhere,
    // without needing to click Fraud Check again.
    if (steadfastOfficial && !steadfastOfficial.message && !steadfastOfficial.error) {
      await pool.query(
        `INSERT INTO fraud_check_results (phone, total, delivered, cancelled, success_rate, checked_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (phone) DO UPDATE SET
           total = $2, delivered = $3, cancelled = $4, success_rate = $5, checked_at = NOW()`,
        [phone, steadfastOfficial.total, steadfastOfficial.delivered, steadfastOfficial.cancelled, steadfastOfficial.successRate]
      );
    }

    res.json({ phone, ownSummary, steadfastOfficial });
  } catch (err) {
    console.error("Fraud check failed:", err);
    res.status(500).json({ error: "Fraud check ব্যর্থ হয়েছে" });
  }
});

router.post("/:id/send-to-courier", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = existing.rows[0];

    if (entry.status === "sent") {
      return res.status(400).json({ error: "Already sent to courier" });
    }
    if (!entry.raw_text || !entry.raw_text.trim()) {
      return res.status(400).json({ error: "No message text to read — add details first" });
    }

    let extracted;
    try {
      extracted = await extractOrderInfo(entry.raw_text, entry.page_id);
    } catch (err) {
      console.error("Extraction failed:", err);
      return res.status(502).json({ error: "AI could not read the message — check it manually" });
    }

    if (!extracted.recipient_phone || !extracted.recipient_address) {
      return res.status(400).json({
        error: "AI couldn't find a phone number or address in the message",
        details: extracted,
      });
    }

    const savedCourier = await getPageCredential("courier", "steadfast", entry.page_id);
    const steadfastApiKey = savedCourier?.api_key || process.env.STEADFAST_API_KEY;
    const steadfastSecretKey = savedCourier?.secret_key || process.env.STEADFAST_SECRET_KEY;

    // A per-page delivery note (e.g. "customer sleeps until 10 AM, please
    // don't call early morning") — sent as Steadfast's "note" field so
    // the delivery rider sees it too.
    let deliveryNote = null;
    if (entry.page_id) {
      const pageRes = await pool.query("SELECT delivery_note FROM pages WHERE id = $1", [entry.page_id]);
      deliveryNote = pageRes.rows[0]?.delivery_note || null;
    }
    console.log("Delivery note check — entry.page_id:", entry.page_id, "| note:", deliveryNote); // temporary debug

    const steadfastRes = await fetch(
      "https://portal.packzy.com/api/v1/create_order",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Api-Key": steadfastApiKey,
          "Secret-Key": steadfastSecretKey,
        },
        body: JSON.stringify({
          invoice: extracted.invoice || `ASBAB-${entry.id}`,
          recipient_name: extracted.recipient_name || "N/A",
          recipient_phone: extracted.recipient_phone,
          recipient_address: extracted.recipient_address,
          cod_amount: extracted.cod_amount || 0,
          ...(deliveryNote ? { note: deliveryNote } : {}),
        }),
      }
    );

    let data;
    const rawResponseText = await steadfastRes.text();
    try {
      data = JSON.parse(rawResponseText);
    } catch {
      console.error("Steadfast returned a non-JSON response:", rawResponseText);
      return res.status(502).json({
        error: `Steadfast: ${rawResponseText.slice(0, 200)}`,
      });
    }

    if (!steadfastRes.ok || data.status !== 200) {
      return res.status(502).json({
        error: "Steadfast rejected the order",
        details: data,
      });
    }

    const consignment = data.consignment;
    const updated = await pool.query(
      `UPDATE entries
       SET status = 'sent',
           consignment_id = $1,
           tracking_code = $2,
           customer_name = $3,
           customer_phone = $4,
           customer_address = $5,
           amount = $6,
           product_code = $7
       WHERE id = $8
       RETURNING *`,
      [
        consignment.consignment_id,
        consignment.tracking_code,
        extracted.recipient_name,
        extracted.recipient_phone,
        extracted.recipient_address,
        extracted.cod_amount,
        extracted.invoice,
        id,
      ]
    );

    // Mirror the same result onto the linked "All Order" copy (same
    // batch_id) so it shows the parcel ID/amount too instead of staying
    // stuck on "waiting for courier send".
    if (entry.group_name === "pending" && entry.batch_id) {
      await pool.query(
        `UPDATE entries
         SET status = 'sent',
             consignment_id = $1,
             tracking_code = $2,
             customer_name = $3,
             customer_phone = $4,
             customer_address = $5,
             amount = $6,
             product_code = $7
         WHERE batch_id = $8 AND group_name = 'all_order'`,
        [
          consignment.consignment_id,
          consignment.tracking_code,
          extracted.recipient_name,
          extracted.recipient_phone,
          extracted.recipient_address,
          extracted.cod_amount,
          extracted.invoice,
          entry.batch_id,
        ]
      );
    }

    res.json(toApiShape(updated.rows[0]));
    broadcastRefresh();

    // District/Thana for the area-wise cancel-rate report — extracted in
    // the background so it never slows down Send to Courier itself.
    (async () => {
      try {
        const loc = await extractLocationInfo(extracted.recipient_address, entry.page_id);
        if (entry.batch_id) {
          await pool.query("UPDATE entries SET district = $1, thana = $2 WHERE batch_id = $3", [
            loc.district || null,
            loc.thana || null,
            entry.batch_id,
          ]);
        } else {
          await pool.query("UPDATE entries SET district = $1, thana = $2 WHERE id = $3", [
            loc.district || null,
            loc.thana || null,
            id,
          ]);
        }
      } catch (err) {
        console.error("Background location extraction failed:", err);
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send to courier" });
  }
});

// Periodically called (see server.js) — checks Steadfast's official
// delivery status for every shipped order that came from the website
// (has a woo_order_id) and hasn't been synced to Facebook yet. Delivered
// or partial_delivered → "Complete" (Facebook event + WC status
// "completed"). Cancelled/returned → "Refunded". Anything still
// pending/in-review is left alone and checked again next time.
async function checkCourierStatusesAndSyncFacebook() {
  const result = await pool.query(
    `SELECT id, consignment_id, page_id, customer_phone, customer_name, woo_order_id
     FROM entries
     WHERE group_name = 'all_order' AND consignment_id IS NOT NULL
       AND woo_order_id IS NOT NULL AND fb_event_sent IS NULL`
  );

  for (const entry of result.rows) {
    try {
      const courierCred = await getPageCredential("courier", "steadfast", entry.page_id);
      const sfKey = courierCred?.api_key;
      const sfSecret = courierCred?.secret_key;
      if (!sfKey || !sfSecret) continue;

      const sfRes = await fetch(`https://portal.packzy.com/api/v1/status_by_cid/${entry.consignment_id}`, {
        headers: { "content-type": "application/json", "api-key": sfKey, "secret-key": sfSecret },
      });
      const sfData = await sfRes.json();
      const status = sfData?.delivery_status;
      if (!status) continue;

      let eventName = null;
      let wcStatus = null;
      if (status === "delivered" || status === "partial_delivered") {
        eventName = "OrderComplete";
        wcStatus = "completed";
      } else if (status === "cancelled") {
        eventName = "OrderRefunded";
        wcStatus = "refunded";
      }
      // Anything else (pending, hold, in_review, etc.) — not final yet,
      // leave it for the next periodic check.
      if (!eventName) continue;

      const fbResult = await sendFacebookEvent(entry.page_id, entry.customer_phone, eventName, entry.customer_name);
      const wcResult = await updateWooOrderStatus(entry.page_id, entry.woo_order_id, wcStatus);
      if (!fbResult.success) console.warn("Facebook event failed for entry", entry.id, fbResult.error);
      if (!wcResult.success) console.warn("WC status update failed for entry", entry.id, wcResult.error);

      await pool.query("UPDATE entries SET fb_event_sent = $1 WHERE id = $2", [
        eventName === "OrderComplete" ? "complete" : "refund",
        entry.id,
      ]);
    } catch (err) {
      console.error("Courier status check failed for entry", entry.id, err.message);
    }
  }
}

module.exports = { router, createEntry, sendSMS, getPageSmsSettings, fillSmsTemplate, checkCourierStatusesAndSyncFacebook };
