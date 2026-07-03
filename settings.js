// settings.js — lets an Admin add/remove Courier and AI API keys from the
// app itself instead of Railway's Variables tab. Moderators can't see or
// touch any of this.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth, requireAdmin } = require("./auth");

// GET /api/settings — list saved credentials (admin only). Keys are masked
// so the full value is never shown again after saving.
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, type, provider, api_key, secret_key, created_at FROM api_credentials ORDER BY created_at DESC"
    );
    const masked = result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      provider: r.provider,
      apiKeyMasked: r.api_key ? r.api_key.slice(0, 4) + "••••" + r.api_key.slice(-4) : null,
      hasSecret: !!r.secret_key,
      createdAt: r.created_at,
    }));
    res.json(masked);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load settings" });
  }
});

// POST /api/settings — add/replace a credential (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { type, provider, apiKey, secretKey } = req.body;
  if (!type || !provider || !apiKey) {
    return res.status(400).json({ error: "Type, provider, and API key are required" });
  }
  try {
    // Replace any existing credential for the same type+provider
    await pool.query("DELETE FROM api_credentials WHERE type = $1 AND provider = $2", [type, provider]);
    const result = await pool.query(
      `INSERT INTO api_credentials (type, provider, api_key, secret_key)
       VALUES ($1, $2, $3, $4) RETURNING id, type, provider, created_at`,
      [type, provider, apiKey, secretKey || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save credential" });
  }
});

// DELETE /api/settings/:id (admin only)
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM api_credentials WHERE id = $1", [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete credential" });
  }
});

// Used internally by entries.js: fetches a saved credential for a given
// type+provider from the DB. Falls back to env vars if nothing is saved.
// This is the OLD global (non-page) lookup — kept as a fallback for any
// entry that predates the multi-page feature (page_id is null).
async function getCredential(type, provider) {
  const result = await pool.query(
    "SELECT api_key, secret_key FROM api_credentials WHERE type = $1 AND provider = $2 AND page_id IS NULL ORDER BY created_at DESC LIMIT 1",
    [type, provider]
  );
  return result.rows[0] || null;
}

// Fetches whichever AI credential was saved most recently, regardless of
// provider (Anthropic / OpenAI / Google). Global (non-page) fallback only.
async function getPreferredAiCredential() {
  const result = await pool.query(
    "SELECT provider, api_key, secret_key FROM api_credentials WHERE type = 'ai' AND page_id IS NULL ORDER BY created_at DESC LIMIT 1"
  );
  return result.rows[0] || null;
}

// Page-scoped versions — every entry belongs to a page (once pages are
// set up), and courier/AI calls for that entry must use THAT page's own
// keys, not a shared global set. Falls back to the global functions above
// if the page has no pageId (legacy entries from before this feature).
async function getPageCredential(type, provider, pageId) {
  if (!pageId) return getCredential(type, provider);
  const result = await pool.query(
    "SELECT api_key, secret_key FROM api_credentials WHERE type = $1 AND provider = $2 AND page_id = $3 ORDER BY created_at DESC LIMIT 1",
    [type, provider, pageId]
  );
  return result.rows[0] || getCredential(type, provider);
}

async function getPagePreferredAiCredential(pageId) {
  if (!pageId) return getPreferredAiCredential();
  const result = await pool.query(
    "SELECT provider, api_key, secret_key FROM api_credentials WHERE type = 'ai' AND page_id = $1 ORDER BY priority ASC LIMIT 1",
    [pageId]
  );
  return result.rows[0] || getPreferredAiCredential();
}

// Returns ALL AI keys saved for a page, in the order they should be tried
// (priority ascending — first one added is tried first). Used for
// failover: if key #1 fails or hits its quota, key #2 is tried, and so on.
async function getPageAiCredentials(pageId) {
  if (!pageId) {
    const fallback = await getPreferredAiCredential();
    return fallback ? [fallback] : [];
  }
  const result = await pool.query(
    "SELECT provider, api_key, secret_key FROM api_credentials WHERE type = 'ai' AND page_id = $1 ORDER BY priority ASC",
    [pageId]
  );
  if (result.rows.length) return result.rows;
  const fallback = await getPreferredAiCredential();
  return fallback ? [fallback] : [];
}

module.exports = {
  router,
  getCredential,
  getPreferredAiCredential,
  getPageCredential,
  getPagePreferredAiCredential,
  getPageAiCredentials,
};
