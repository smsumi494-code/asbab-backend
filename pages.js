// pages.js — lets an Admin add multiple "pages" (brands like Asbab, Al
// Haya, Abaya House), each with its own Courier + AI API keys. Every
// entry belongs to one page, and courier/AI calls for that entry always
// use that page's own credentials.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

// GET /api/pages — list all pages (any logged-in user, needed to show the
// "কোন পেইজের পোস্ট?" picker when posting).
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, created_at FROM pages ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load pages" });
  }
});

// POST /api/pages — add a new page with its Courier + AI keys (Admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { name, courierApiKey, courierSecretKey, aiProvider, aiApiKey } = req.body;
  if (!name || !courierApiKey || !courierSecretKey || !aiProvider || !aiApiKey) {
    return res.status(400).json({ error: "Page name, courier keys, and AI key are all required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pageResult = await client.query(
      "INSERT INTO pages (name) VALUES ($1) RETURNING *",
      [name]
    );
    const page = pageResult.rows[0];

    await client.query(
      `INSERT INTO api_credentials (type, provider, api_key, secret_key, page_id)
       VALUES ('courier', 'steadfast', $1, $2, $3)`,
      [courierApiKey, courierSecretKey, page.id]
    );
    await client.query(
      `INSERT INTO api_credentials (type, provider, api_key, page_id)
       VALUES ('ai', $1, $2, $3)`,
      [aiProvider, aiApiKey, page.id]
    );

    await client.query("COMMIT");
    res.status(201).json(page);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not add page" });
  } finally {
    client.release();
  }
});

// DELETE /api/pages/:id — removes the page and its credentials (Admin
// only). Entries that belonged to this page keep their page_name label,
// they just lose the live link (page_id becomes null).
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM pages WHERE id = $1", [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete page" });
  }
});

module.exports = router;
