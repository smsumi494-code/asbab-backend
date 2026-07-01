// routes/entries.js
const express = require("express");
const router = express.Router();
const pool = require("./db");

// Map a DB row to the shape the frontend expects.
function toApiShape(row) {
  return {
    id: row.id,
    productCode: row.product_code,
    imageUrl: row.image_url,
    hata: row.hata,
    long: row.long_size,
    tag: row.tag,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    amount: row.amount,
    moderator: row.moderator,
    status: row.status,
    consignmentId: row.consignment_id,
    trackingCode: row.tracking_code,
    createdAt: row.created_at,
  };
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

// POST /api/entries — create a new entry
router.post("/", async (req, res) => {
  const {
    productCode,
    imageUrl,
    hata,
    long,
    tag,
    customerName,
    customerPhone,
    customerAddress,
    amount,
    moderator,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO entries
        (product_code, image_url, hata, long_size, tag, customer_name, customer_phone, customer_address, amount, moderator)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        productCode,
        imageUrl,
        hata,
        long,
        tag,
        customerName,
        customerPhone,
        customerAddress,
        amount,
        moderator,
      ]
    );
    res.status(201).json(toApiShape(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create entry" });
  }
});

// PUT /api/entries/:id — edit any field(s) of an entry
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const fields = {
    product_code: req.body.productCode,
    image_url: req.body.imageUrl,
    hata: req.body.hata,
    long_size: req.body.long,
    tag: req.body.tag,
    customer_name: req.body.customerName,
    customer_phone: req.body.customerPhone,
    customer_address: req.body.customerAddress,
    amount: req.body.amount,
    moderator: req.body.moderator,
  };

  // Only update fields that were actually sent
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
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM entries WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete entry" });
  }
});

// POST /api/entries/:id/send-to-courier — creates the order on Steadfast
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
    if (!entry.customer_name || !entry.customer_phone || !entry.customer_address) {
      return res.status(400).json({
        error: "Customer name, phone, and address are required before sending",
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
          invoice: entry.product_code || `ASBAB-${entry.id}`,
          recipient_name: entry.customer_name,
          recipient_phone: entry.customer_phone,
          recipient_address: entry.customer_address,
          cod_amount: entry.amount || 0,
          note: entry.tag || "",
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
       SET status = 'sent', consignment_id = $1, tracking_code = $2
       WHERE id = $3
       RETURNING *`,
      [consignment.consignment_id, consignment.tracking_code, id]
    );

    res.json(toApiShape(updated.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send to courier" });
  }
});

module.exports = router;
