// push.js — lets each device subscribe for push notifications, and
// broadcasts a notification to every subscribed device when needed.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const webpush = require("web-push");
const { requireAuth } = require("./auth");

webpush.setVapidDetails(
  "mailto:admin@asbababaya.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// GET /api/push/public-key — frontend needs this to subscribe
router.get("/public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — save this device's push subscription
router.post("/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription" });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [req.user.sub, endpoint, keys.p256dh, keys.auth]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save subscription" });
  }
});

// DELETE /api/push/subscribe — stop notifying this device
router.delete("/subscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  try {
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove subscription" });
  }
});

// Sends a notification to every subscribed device. Used internally by
// entries.js right after a new entry is posted. Optionally skips the
// poster's own device(s) so they don't get notified about their own post.
async function notifyAll(payload, excludeUserId = null) {
  try {
    const result = await pool.query(
      excludeUserId
        ? "SELECT * FROM push_subscriptions WHERE user_id IS DISTINCT FROM $1"
        : "SELECT * FROM push_subscriptions",
      excludeUserId ? [excludeUserId] : []
    );

    const body = JSON.stringify(payload);
    await Promise.all(
      result.rows.map((sub) =>
        webpush
          .sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body
          )
          .catch(async (err) => {
            // 410/404 means the subscription is dead (uninstalled, expired) — clean it up
            if (err.statusCode === 410 || err.statusCode === 404) {
              await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]);
            } else {
              console.error("Push send failed:", err.message);
            }
          })
      )
    );
  } catch (err) {
    console.error("notifyAll failed:", err);
  }
}

module.exports = { router, notifyAll };
