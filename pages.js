// pages.js — lets an Admin add multiple "pages" (brands like Asbab, Al
// Haya, Abaya House), each with its own Courier key and UP TO 5 AI keys.
// The AI keys are tried in order — if one fails or hits its quota, the
// next is tried automatically (see getPageAiCredentials in settings.js).
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

const MAX_AI_KEYS = 5;

// GET /api/pages — list all pages (any logged-in user, needed to show the
// "কোন পেইজের পোস্ট?" picker when posting). No key values here.
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, tagline, created_at FROM pages ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load pages" });
  }
});

// GET /api/pages/:id — full details for editing (Admin only). Returns the
// actual key values (not masked) since only Admins can reach this screen
// anyway, and they need to see what's there to edit it sensibly.
router.get("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const pageRes = await pool.query("SELECT * FROM pages WHERE id = $1", [id]);
    if (pageRes.rows.length === 0) return res.status(404).json({ error: "Page not found" });

    const courierRes = await pool.query(
      "SELECT api_key, secret_key FROM api_credentials WHERE page_id = $1 AND type = 'courier' AND provider = 'steadfast' LIMIT 1",
      [id]
    );
    const aiRes = await pool.query(
      "SELECT provider, api_key FROM api_credentials WHERE page_id = $1 AND type = 'ai' ORDER BY priority ASC",
      [id]
    );
    const wcRes = await pool.query(
      "SELECT api_key, secret_key FROM api_credentials WHERE page_id = $1 AND type = 'woocommerce' LIMIT 1",
      [id]
    );
    const smsRes = await pool.query(
      "SELECT api_key FROM api_credentials WHERE page_id = $1 AND type = 'sms' LIMIT 1",
      [id]
    );

    res.json({
      ...pageRes.rows[0],
      courierApiKey: courierRes.rows[0]?.api_key || "",
      courierSecretKey: courierRes.rows[0]?.secret_key || "",
      aiCredentials: aiRes.rows.map((r) => ({ provider: r.provider, apiKey: r.api_key })),
      wcConsumerKey: wcRes.rows[0]?.api_key || "",
      wcConsumerSecret: wcRes.rows[0]?.secret_key || "",
      smsToken: smsRes.rows[0]?.api_key || "",
      deliveryNote: pageRes.rows[0].delivery_note || "",
      smsOnWebsiteOrder: pageRes.rows[0].sms_on_website_order,
      smsOnAllOrder: pageRes.rows[0].sms_on_all_order,
      smsMessage: pageRes.rows[0].sms_message || "",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load page" });
  }
});

// POST /api/pages — add a new page with its Courier key + up to 5 AI keys
// (Admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const {
    name, tagline, siteUrl, courierApiKey, courierSecretKey, aiCredentials, wcConsumerKey, wcConsumerSecret,
    smsOnWebsiteOrder, smsOnAllOrder, smsMessage, smsToken, deliveryNote,
  } = req.body;
  const cleanAiCreds = (aiCredentials || []).filter((c) => c?.provider && c?.apiKey).slice(0, MAX_AI_KEYS);

  if (!name || !courierApiKey || !courierSecretKey || cleanAiCreds.length === 0) {
    return res.status(400).json({ error: "Page name, courier keys, and at least one AI key are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pageResult = await client.query(
      `INSERT INTO pages (name, tagline, site_url, sms_on_website_order, sms_on_all_order, sms_message, delivery_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, tagline || null, siteUrl || null, !!smsOnWebsiteOrder, !!smsOnAllOrder, smsMessage || null, deliveryNote || null]
    );
    const page = pageResult.rows[0];

    if (smsToken) {
      await client.query(
        `INSERT INTO api_credentials (type, provider, api_key, page_id)
         VALUES ('sms', 'bdbulksms', $1, $2)`,
        [smsToken, page.id]
      );
    }

    await client.query(
      `INSERT INTO api_credentials (type, provider, api_key, secret_key, page_id)
       VALUES ('courier', 'steadfast', $1, $2, $3)`,
      [courierApiKey, courierSecretKey, page.id]
    );

    if (wcConsumerKey && wcConsumerSecret) {
      await client.query(
        `INSERT INTO api_credentials (type, provider, api_key, secret_key, page_id)
         VALUES ('woocommerce', 'woocommerce', $1, $2, $3)`,
        [wcConsumerKey, wcConsumerSecret, page.id]
      );
    }

    for (let i = 0; i < cleanAiCreds.length; i++) {
      await client.query(
        `INSERT INTO api_credentials (type, provider, api_key, page_id, priority)
         VALUES ('ai', $1, $2, $3, $4)`,
        [cleanAiCreds[i].provider, cleanAiCreds[i].apiKey, page.id, i]
      );
    }

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

// PUT /api/pages/:id — edit a page's name, Courier key, and AI key list
// (Admin only). AI keys are fully replaced with whatever list is sent.
router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    name, tagline, siteUrl, courierApiKey, courierSecretKey, aiCredentials, wcConsumerKey, wcConsumerSecret,
    smsOnWebsiteOrder, smsOnAllOrder, smsMessage, smsToken, deliveryNote,
  } = req.body;
  const cleanAiCreds = (aiCredentials || []).filter((c) => c?.provider && c?.apiKey).slice(0, MAX_AI_KEYS);

  if (!name || !courierApiKey || !courierSecretKey || cleanAiCreds.length === 0) {
    return res.status(400).json({ error: "Page name, courier keys, and at least one AI key are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const pageResult = await client.query(
      `UPDATE pages SET name = $1, tagline = $2, site_url = $3,
         sms_on_website_order = $4, sms_on_all_order = $5, sms_message = $6, delivery_note = $7
       WHERE id = $8 RETURNING *`,
      [name, tagline || null, siteUrl || null, !!smsOnWebsiteOrder, !!smsOnAllOrder, smsMessage || null, deliveryNote || null, id]
    );

    if (smsToken) {
      const existingSms = await client.query(
        "SELECT id FROM api_credentials WHERE page_id = $1 AND type = 'sms'",
        [id]
      );
      if (existingSms.rows.length) {
        await client.query("UPDATE api_credentials SET api_key = $1 WHERE id = $2", [smsToken, existingSms.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO api_credentials (type, provider, api_key, page_id) VALUES ('sms', 'bdbulksms', $1, $2)`,
          [smsToken, id]
        );
      }
    }
    if (pageResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Page not found" });
    }

    const existingCourier = await client.query(
      "SELECT id FROM api_credentials WHERE page_id = $1 AND type = 'courier' AND provider = 'steadfast'",
      [id]
    );
    if (existingCourier.rows.length) {
      await client.query(
        "UPDATE api_credentials SET api_key = $1, secret_key = $2 WHERE id = $3",
        [courierApiKey, courierSecretKey, existingCourier.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO api_credentials (type, provider, api_key, secret_key, page_id)
         VALUES ('courier', 'steadfast', $1, $2, $3)`,
        [courierApiKey, courierSecretKey, id]
      );
    }

    if (wcConsumerKey && wcConsumerSecret) {
      const existingWc = await client.query(
        "SELECT id FROM api_credentials WHERE page_id = $1 AND type = 'woocommerce'",
        [id]
      );
      if (existingWc.rows.length) {
        await client.query(
          "UPDATE api_credentials SET api_key = $1, secret_key = $2 WHERE id = $3",
          [wcConsumerKey, wcConsumerSecret, existingWc.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO api_credentials (type, provider, api_key, secret_key, page_id)
           VALUES ('woocommerce', 'woocommerce', $1, $2, $3)`,
          [wcConsumerKey, wcConsumerSecret, id]
        );
      }
    }

    await client.query("DELETE FROM api_credentials WHERE page_id = $1 AND type = 'ai'", [id]);
    for (let i = 0; i < cleanAiCreds.length; i++) {
      await client.query(
        `INSERT INTO api_credentials (type, provider, api_key, page_id, priority)
         VALUES ('ai', $1, $2, $3, $4)`,
        [cleanAiCreds[i].provider, cleanAiCreds[i].apiKey, id, i]
      );
    }

    await client.query("COMMIT");
    res.json(pageResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not update page" });
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
