// entries.js
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { randomUUID } = require("crypto");

// Map a DB row to the shape the frontend expects.
function toApiShape(row) {
  return {
    id: row.id,
    rawText: row.raw_text,
    imageUrl: row.image_url,
    moderator: row.moderator,
    group: row.group_name,
    batchId: row.batch_id,
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

// Uses Claude to read the moderator's free-form pasted message and pull out
// exactly the fields Steadfast needs. Runs only when "Send to Courier" is
// pressed — the moderator never sees or fills these fields directly.
async function extractOrderInfo(rawText) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        "You extract delivery-order details from a Bengali/English mixed message written by a shop moderator. " +
        "The message may contain Bangla numerals (convert to normal digits), a product/order code, " +
        "customer name, address, an 11-digit phone number starting with 01, and a bill/total amount " +
        "(sometimes shown as a calculation like 2250+150=2400-500=1900 — use the FINAL result). " +
        "Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: " +
        '{"recipient_name":"","recipient_phone":"","recipient_address":"","cod_amount":0,"invoice":""}. ' +
        "If a field truly cannot be found, use an empty string (or 0 for cod_amount).",
      messages: [{ role: "user", content: rawText }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
  }
  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in Claude response");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
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

// Builds the trimmed-down message that goes to the "Making" group:
// order number, Long / হাতা সাইজ / বডি সাইজ (whichever are mentioned),
// and any garment/inclusion tags.
function buildMakingText(rawText) {
  let text = toEnglishDigits(rawText);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let orderNumber = null;
  for (const line of lines) {
    const m = line.match(/\b\d{4,6}\b/);
    if (m) {
      orderNumber = m[0];
      break;
    }
  }

  let hataSize = null;
  const hataMatch = text.match(/(?:হাতা\s*সাইজ|হাতা|hata|sleeve)[:\s=-]*?(\d{1,3})/i);
  if (hataMatch) {
    hataSize = hataMatch[1];
    text = text.replace(hataMatch[0], "");
  }

  let bodySize = null;
  const bodyMatch = text.match(/(?:বডি\s*সাইজ|body\s*size)[:\s=-]*?(\d{1,3})/i);
  if (bodyMatch) {
    bodySize = bodyMatch[1];
    text = text.replace(bodyMatch[0], "");
  }

  const longMatch = text.match(/(?:long|size|সাইজ|লং|লম্বা)[:\s=-]*?(\d{2,3})/i);
  const long = longMatch ? longMatch[1] : null;

  const tags = extractTags(rawText);

  const parts = [];
  if (orderNumber) parts.push(`অর্ডার নাম্বার: ${orderNumber}`);
  if (long) parts.push(`Long: ${long}`);
  if (hataSize) parts.push(`হাতা সাইজ: ${hataSize}`);
  if (bodySize) parts.push(`বডি সাইজ: ${bodySize}`);
  tags.forEach((t) => parts.push(t));

  return parts.length ? parts.join("\n") : null;
}

// GET /api/entries — list all entries, newest first
router.get("/", async (req, res) => {
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

// POST /api/entries — create a new entry (just the raw message + image)
// Special rule: anything posted to "All Order" is automatically forwarded
// (as its own copy, with the same image) into "Pending" too.
router.post("/", async (req, res) => {
  const { rawText, imageUrl, moderator, group } = req.body;
  const targetGroup = group || "pending";
  const batchId = randomUUID();

  try {
    const result = await pool.query(
      `INSERT INTO entries (raw_text, image_url, moderator, group_name, batch_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [rawText, imageUrl, moderator, targetGroup, batchId]
    );

    if (targetGroup === "all_order") {
      await pool.query(
        `INSERT INTO entries (raw_text, image_url, moderator, group_name, batch_id)
         VALUES ($1, $2, $3, 'pending', $4)`,
        [rawText, imageUrl, moderator, batchId]
      );

      const makingText = buildMakingText(rawText);
      if (makingText) {
        await pool.query(
          `INSERT INTO entries (raw_text, image_url, moderator, group_name, batch_id)
           VALUES ($1, $2, $3, 'making', $4)`,
          [makingText, imageUrl, moderator, batchId]
        );
      }
    }

    res.status(201).json(toApiShape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create entry" });
  }
});

// PUT /api/entries/:id — edit the raw message, image, or moderator
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const fields = {
    raw_text: req.body.rawText,
    image_url: req.body.imageUrl,
    moderator: req.body.moderator,
    group_name: req.body.group,
  };

  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (keys.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map((k) => fields[k]);

  try {
    const result = await pool.query(
      `UPDATE entries SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    res.json(toApiShape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update entry" });
  }
});

// DELETE /api/entries/:id — removes from OUR database only.
// This never touches Steadfast — an already-sent consignment stays exactly
// as it is on their side even after we delete it here.
// Special rule: deleting a Pending entry also deletes its matching Making
// entry (same batch_id), since Making was auto-forwarded from it.
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = existing.rows[0];

    await pool.query("DELETE FROM entries WHERE id = $1", [id]);

    if (entry.group_name === "pending" && entry.batch_id) {
      await pool.query(
        "DELETE FROM entries WHERE batch_id = $1 AND group_name = 'making'",
        [entry.batch_id]
      );
    }

    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete entry" });
  }
});

// POST /api/entries/:id/mark-done — used only by the Making group's
// "Send Making" button. Just flips status to done; never touches Steadfast.
router.post("/:id/mark-done", async (req, res) => {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update entry" });
  }
});

// POST /api/entries/:id/send-to-courier
// Reads the raw pasted message, asks Claude to extract the delivery fields
// in the background, then creates the order on Steadfast.
router.post("/:id/send-to-courier", async (req, res) => {
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
      extracted = await extractOrderInfo(entry.raw_text);
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

    const steadfastRes = await fetch(
      "https://portal.packzy.com/api/v1/create_order",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Api-Key": process.env.STEADFAST_API_KEY,
          "Secret-Key": process.env.STEADFAST_SECRET_KEY,
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

    const data = await steadfastRes.json();

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

    res.json(toApiShape(updated.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send to courier" });
  }
});

module.exports = router;
