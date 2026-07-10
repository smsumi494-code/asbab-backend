// entries.js
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { randomUUID } = require("crypto");
const { requireAuth, requireAdmin, verifyToken } = require("./auth");
const { getCredential, getPreferredAiCredential, getPageCredential, getPagePreferredAiCredential, getPageAiCredentials } = require("./settings");
const { notifyAll } = require("./push");
const { addClient, removeClient, broadcastRefresh } = require("./sse");

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
  };
}

// ---- Generic AI calling (Gemini / OpenAI / Anthropic) --------------------
// Used both for reading delivery details (Send to Courier) and for
// building the Making group's production-only summary.

function stripJsonFences(text) {
  return text.replace(/```json|```/g, "").trim();
}

async function callGemini(userText, systemPrompt, apiKey, wantJson) {
  const body = {
    contents: [{ parts: [{ text: `${systemPrompt}\n\nMessage:\n${userText}` }] }],
  };
  if (wantJson) body.generationConfig = { responseMimeType: "application/json" };
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
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
async function callAI(userText, systemPrompt, { json = false, pageId = null } = {}) {
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
        raw = await callGemini(userText, systemPrompt, saved.api_key, json);
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
  throw lastError || new Error("All AI keys failed");
}

// Reads the moderator's free-form pasted message and pulls out exactly the
// fields Steadfast needs. Runs only when "Send to Courier" is pressed —
// the moderator never sees or fills these fields directly.
const EXTRACTION_SYSTEM_PROMPT =
  "You extract delivery-order details from a Bengali/English mixed message written by a shop moderator. " +
  "The message may contain Bangla numerals (convert to normal digits), a product/order code, " +
  "customer name, address, an 11-digit phone number starting with 01, and a bill/total amount " +
  "(sometimes shown as a calculation like 2250+150=2400-500=1900 — use the FINAL result). " +
  "Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: " +
  '{"recipient_name":"","recipient_phone":"","recipient_address":"","cod_amount":0,"invoice":""}. ' +
  "If a field truly cannot be found, use an empty string (or 0 for cod_amount).";

async function extractOrderInfo(rawText, pageId) {
  return callAI(rawText, EXTRACTION_SYSTEM_PROMPT, { json: true, pageId });
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
async function createEntry({ rawText, imageUrls, moderator, group, pageId, pageName, status, customerPhone, customerDevice }) {
  const targetGroup = group || "pending";
  const batchId = randomUUID();
  const images = JSON.stringify(imageUrls || []);

  const result = await pool.query(
    `INSERT INTO entries (raw_text, image_urls, moderator, group_name, batch_id, page_id, page_name, status, customer_phone, customer_device)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, COALESCE($8, 'pending'), $9, $10)
     RETURNING *`,
    [rawText, images, moderator, targetGroup, batchId, pageId || null, pageName || null, status || null, customerPhone || null, customerDevice || null]
  );

  if (targetGroup === "all_order") {
    await pool.query(
      `INSERT INTO entries (raw_text, image_urls, moderator, group_name, batch_id, page_id, page_name)
       VALUES ($1, $2::jsonb, $3, 'pending', $4, $5, $6)`,
      [rawText, images, moderator, batchId, pageId || null, pageName || null]
    );

    let makingText;
    try {
      makingText = await extractMakingInfo(rawText, pageId);
    } catch (err) {
      console.error("Making-group AI extraction failed, using fallback:", err);
      makingText = buildMakingText(rawText);
    }
    if (makingText) {
      await pool.query(
        `INSERT INTO entries (raw_text, image_urls, moderator, group_name, batch_id, page_id, page_name)
         VALUES ($1, $2::jsonb, $3, 'making', $4, $5, $6)`,
        [makingText, images, moderator, batchId, pageId || null, pageName || null]
      );
    }
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

// GET /api/entries — list all entries, newest first (any logged-in user)
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM entries ORDER BY created_at DESC"
    );
    res.json(result.rows.map(toApiShape));
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

    const entry = await createEntry({ ...req.body, rawText, pageName });
    res.status(201).json(toApiShape(entry));
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
      }
    }

    res.json(toApiShape(updated));
    broadcastRefresh();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update entry" });
  }
});

// DELETE /api/entries/:id — removes from OUR database only (Admin only).
// This never touches Steadfast — an already-sent consignment stays exactly
// as it is on their side even after we delete it here.
// Special rule: deleting a Pending entry also deletes its matching Making
// entry (same batch_id), since Making was auto-forwarded from it.
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
      if (entry.batch_id) {
        await pool.query(
          "DELETE FROM entries WHERE batch_id = $1 AND group_name IN ('pending', 'making')",
          [entry.batch_id]
        );
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
  const { pageId } = req.body;
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
    });

    await pool.query("DELETE FROM entries WHERE id = $1", [id]);

    res.json({ deleted: true, id });
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
// customer's delivery history using THREE sources: our own in-house
// history (from the Steadfast delivery-status webhook), Steadfast's own
// official fraud_check endpoint (same api-key/secret-key as order
// creation — no merchant login needed, discovered from their official WP
// plugin source), and fraudbd.com (covers Pathao/Paperfly/RedX, plus
// Steadfast as a fallback).
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
    // webhook) — more accurate than third-party data, but only exists
    // for customers who've ordered from us before.
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

    const apiKey = (process.env.FRAUDBD_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(500).json({ error: "Fraud checker এখনো সেটআপ করা হয়নি" });
    }

    // 7-day cache by phone — same phone in ANY group reuses this instead
    // of calling fraudbd.com / Steadfast's own fraud_check again (the
    // Steadfast endpoint has its own daily attempt limit, so this cache
    // matters for it too, not just for saving fraudbd.com calls).
    const cached = await pool.query(
      "SELECT data FROM fraud_check_cache WHERE phone = $1 AND checked_at > NOW() - INTERVAL '7 days'",
      [phone]
    );
    if (cached.rows.length) {
      const { steadfastOfficial: cachedSteadfast, ...rest } = cached.rows[0].data;
      return res.json({ phone, cached: true, ownSummary, steadfastOfficial: cachedSteadfast, ...rest });
    }

    // Official Steadfast fraud-check — uses the SAME api-key/secret-key
    // we already use for courier orders (no merchant login needed). This
    // is the real, accurate Steadfast history, better than fraudbd.com's
    // Steadfast numbers. Discovered from Steadfast's own official WP
    // plugin source — undocumented publicly, but a real endpoint of
    // theirs.
    let steadfastOfficial = null;
    try {
      const courierCred = await getPageCredential("courier", "steadfast", entry.page_id);
      const sfKey = courierCred?.api_key || process.env.STEADFAST_API_KEY;
      const sfSecret = courierCred?.secret_key || process.env.STEADFAST_SECRET_KEY;
      if (sfKey && sfSecret) {
        const sfRes = await fetch(`https://portal.packzy.com/api/v1/fraud_check/${phone}`, {
          method: "GET",
          headers: { "content-type": "application/json", "api-key": sfKey, "secret-key": sfSecret },
        });
        const sfData = await sfRes.json();
        if (sfData?.message) {
          // Rate-limited or informational response from Steadfast
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
      }
    } catch (err) {
      console.warn("Steadfast official fraud_check failed (non-fatal):", err.message);
    }

    const fraudRes = await fetch("https://fraudbd.com/api/check-courier-info", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Key": apiKey },
      body: JSON.stringify({ phone_number: phone }),
    });
    const data = await fraudRes.json();
    if (!data.status) {
      return res.status(400).json({ error: data.message || "চেক করা যায়নি" });
    }

    const combined = { ...data.data, steadfastOfficial };
    await pool.query(
      `INSERT INTO fraud_check_cache (phone, data, checked_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (phone) DO UPDATE SET data = $2::jsonb, checked_at = NOW()`,
      [phone, JSON.stringify(combined)]
    );

    res.json({ phone, cached: false, ownSummary, ...combined });
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send to courier" });
  }
});

module.exports = { router, createEntry };
