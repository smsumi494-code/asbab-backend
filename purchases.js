// purchases.js — "Product Purchase Cost" tracking. Separate from the
// order-management entries; a simple ledger of products bought from
// suppliers, quantities taken, and payments made against the running
// balance. Gated behind a password on the frontend (this router itself
// just requires normal Admin login — the password is an extra UI gate on
// top, not a replacement for it).
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

// ---- Products (what we buy, and their price) ----------------------------

// GET /api/purchases/products — list all products
router.get("/products", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM purchase_products ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load products" });
  }
});

// POST /api/purchases/products — add a new product
router.post("/products", requireAuth, requireAdmin, async (req, res) => {
  const { name, pricePerUnit } = req.body;
  if (!name || !pricePerUnit) {
    return res.status(400).json({ error: "Product name and price are required" });
  }
  try {
    const result = await pool.query(
      "INSERT INTO purchase_products (name, price_per_unit) VALUES ($1, $2) RETURNING *",
      [name, pricePerUnit]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add product" });
  }
});

// PUT /api/purchases/products/:id — edit a product
router.put("/products/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, pricePerUnit } = req.body;
  if (!name || !pricePerUnit) {
    return res.status(400).json({ error: "Product name and price are required" });
  }
  try {
    const result = await pool.query(
      "UPDATE purchase_products SET name = $1, price_per_unit = $2, updated_at = NOW() WHERE id = $3 RETURNING *",
      [name, pricePerUnit, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update product" });
  }
});

// DELETE /api/purchases/products/:id
router.delete("/products/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM purchase_products WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete product" });
  }
});

// ---- Entries (how much we took, calculated automatically) ---------------

// GET /api/purchases/entries — list all purchase entries, newest first
router.get("/entries", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM purchase_entries ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load entries" });
  }
});

// POST /api/purchases/entries — record taking some quantity of a product.
// Snapshots the product's CURRENT price at the time of the entry, so
// later price changes don't retroactively change old entries' totals.
router.post("/entries", requireAuth, requireAdmin, async (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity) {
    return res.status(400).json({ error: "Product and quantity are required" });
  }
  try {
    const productRes = await pool.query("SELECT * FROM purchase_products WHERE id = $1", [productId]);
    if (productRes.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    const product = productRes.rows[0];

    const unitPrice = Number(product.price_per_unit);
    const totalAmount = unitPrice * Number(quantity);

    const result = await pool.query(
      `INSERT INTO purchase_entries (product_id, product_name, quantity, unit_price, total_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [productId, product.name, quantity, unitPrice, totalAmount]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add entry" });
  }
});

// PUT /api/purchases/entries/:id — edit an entry (quantity, or switch
// product). Recalculates the total using the CURRENT price of whichever
// product ends up selected.
router.put("/entries/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { productId, quantity } = req.body;
  if (!productId || !quantity) {
    return res.status(400).json({ error: "Product and quantity are required" });
  }
  try {
    const productRes = await pool.query("SELECT * FROM purchase_products WHERE id = $1", [productId]);
    if (productRes.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    const product = productRes.rows[0];

    const unitPrice = Number(product.price_per_unit);
    const totalAmount = unitPrice * Number(quantity);

    const result = await pool.query(
      `UPDATE purchase_entries
       SET product_id = $1, product_name = $2, quantity = $3, unit_price = $4, total_amount = $5
       WHERE id = $6 RETURNING *`,
      [productId, product.name, quantity, unitPrice, totalAmount, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Entry not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update entry" });
  }
});

// DELETE /api/purchases/entries/:id
router.delete("/entries/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM purchase_entries WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete entry" });
  }
});

// ---- Payments -------------------------------------------------------------

// GET /api/purchases/payments — list all payments, newest first
router.get("/payments", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM purchase_payments ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load payments" });
  }
});

// POST /api/purchases/payments — record a payment made
router.post("/payments", requireAuth, requireAdmin, async (req, res) => {
  const { note, amount } = req.body;
  if (!amount) {
    return res.status(400).json({ error: "Amount is required" });
  }
  try {
    const result = await pool.query(
      "INSERT INTO purchase_payments (note, amount) VALUES ($1, $2) RETURNING *",
      [note || null, amount]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add payment" });
  }
});

// PUT /api/purchases/payments/:id — edit a payment
router.put("/payments/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { note, amount } = req.body;
  if (!amount) return res.status(400).json({ error: "Amount is required" });
  try {
    const result = await pool.query(
      "UPDATE purchase_payments SET note = $1, amount = $2 WHERE id = $3 RETURNING *",
      [note || null, amount, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Payment not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update payment" });
  }
});

// DELETE /api/purchases/payments/:id
router.delete("/payments/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM purchase_payments WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete payment" });
  }
});

// ---- Summary — the "Total Summary" cash-memo view ------------------------

// GET /api/purchases/summary — every entry + payment merged into one
// chronological ledger, plus running totals (total purchased, total
// paid, current due).
router.get("/summary", requireAuth, requireAdmin, async (req, res) => {
  try {
    const entriesRes = await pool.query("SELECT * FROM purchase_entries ORDER BY created_at ASC");
    const paymentsRes = await pool.query("SELECT * FROM purchase_payments ORDER BY created_at ASC");

    const ledger = [
      ...entriesRes.rows.map((e) => ({
        type: "purchase",
        id: e.id,
        productId: e.product_id,
        productName: e.product_name,
        quantity: Number(e.quantity),
        unitPrice: Number(e.unit_price),
        amount: Number(e.total_amount),
        createdAt: e.created_at,
      })),
      ...paymentsRes.rows.map((p) => ({
        type: "payment",
        id: p.id,
        note: p.note,
        amount: Number(p.amount),
        createdAt: p.created_at,
      })),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const totalPurchased = entriesRes.rows.reduce((sum, e) => sum + Number(e.total_amount), 0);
    const totalPaid = paymentsRes.rows.reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({
      ledger,
      totalPurchased,
      totalPaid,
      due: totalPurchased - totalPaid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load summary" });
  }
});

module.exports = { router };
