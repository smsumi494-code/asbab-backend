// webhooks.js — receives "order created" events from the WooCommerce
// website and drops them straight into the "All Order" group, exactly as
// if a moderator had typed them in. From there the existing auto-forward
// to Pending/Making kicks in automatically.
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { createEntry } = require("./entries");

// Converts a WooCommerce order object into the same kind of free-text
// message a moderator would normally paste in.
function buildRawTextFromOrder(order) {
  const b = order.billing || {};
  const name = [b.first_name, b.last_name].filter(Boolean).join(" ") || "N/A";
  const phone = b.phone || "N/A";
  const address = [b.address_1, b.address_2, b.city, b.state, b.postcode]
    .filter(Boolean)
    .join(", ");

  const items = (order.line_items || [])
    .map((item) => `${item.name} x${item.quantity}`)
    .join("\n");

  const lines = [
    `Order #${order.number || order.id}`,
    name,
    phone,
    address ? `Address: ${address}` : null,
    "",
    items || null,
    "",
    `বিল: ${order.total} টাকা`,
  ].filter((l) => l !== null);

  return lines.join("\n");
}

// POST /api/webhooks/woocommerce
router.post("/woocommerce", async (req, res) => {
  // Verify this really came from your WooCommerce site using the shared
  // secret set when the webhook was created (Settings → Advanced →
  // Webhooks in WordPress admin).
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers["x-wc-webhook-signature"];
    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest("base64");
    if (!signature || signature !== expected) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
  }

  // WooCommerce sends a test ping with no order data when the webhook is
  // first created — just acknowledge it.
  if (!req.body || !req.body.id) {
    return res.status(200).json({ ok: true });
  }

  try {
    const rawText = buildRawTextFromOrder(req.body);
    const imageUrls = []; // WooCommerce orders don't include a photo
    await createEntry({ rawText, imageUrls, moderator: "ওয়েবসাইট", group: "all_order" });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WooCommerce webhook failed:", err);
    // Still respond 200 so WooCommerce doesn't keep retrying forever —
    // the error is logged for you to check.
    res.status(200).json({ ok: false });
  }
});

module.exports = router;
