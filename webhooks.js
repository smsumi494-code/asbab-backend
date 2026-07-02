// webhooks.js — receives "order created" events from the WooCommerce
// website and drops them straight into the "All Order" group, exactly as
// if a moderator had typed them in. From there the existing auto-forward
// to Pending/Making kicks in automatically.
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { createEntry } = require("./entries");

// Fetches the featured image for each product in the order, using the
// WooCommerce REST API (needs read-only API keys — see setup notes).
// Skips gracefully (no image) if the keys aren't set or a lookup fails,
// so a missing image never blocks the order from coming through.
async function getProductImages(order) {
  const siteUrl = process.env.WC_SITE_URL || "https://asbababaya.com";
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!key || !secret) return [];

  const authHeader = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
  const lineItems = order.line_items || [];

  const images = await Promise.all(
    lineItems.map(async (item) => {
      if (!item.product_id) return null;
      try {
        const res = await fetch(`${siteUrl}/wp-json/wc/v3/products/${item.product_id}`, {
          headers: { Authorization: authHeader },
        });
        if (!res.ok) return null;
        const product = await res.json();
        return product.images?.[0]?.src || null;
      } catch {
        return null;
      }
    })
  );

  return images.filter(Boolean);
}

// Your checkout page has a custom field ("বোরকার লং") where the customer
// types their size — WooCommerce stores this in the order's meta_data.
// This pulls it out (matching loosely on the label/key so small wording
// changes on the site don't break it).
function extractCustomFields(order) {
  console.log("ORDER META_DATA:", JSON.stringify(order.meta_data, null, 2));
  const keywords = ["লং", "size", "সাইজ"];
  const lines = [];
  for (const meta of order.meta_data || []) {
    const label = meta.display_key || meta.key || "";
    const value = meta.display_value ?? meta.value;
    if (!value) continue;
    if (keywords.some((k) => label.toLowerCase().includes(k.toLowerCase()))) {
      lines.push(`বোরকার লং: ${value}`);
    }
  }
  return lines;
}

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

  const customFields = extractCustomFields(order);

  const lines = [
    `Order #${order.number || order.id}`,
    name,
    phone,
    address ? `Address: ${address}` : null,
    "",
    items || null,
    ...customFields,
    "",
    `বিল: ${order.total} টাকা`,
  ].filter((l) => l !== null);

  return lines.join("\n");
}

// POST /api/webhooks/woocommerce
router.post("/woocommerce", async (req, res) => {
  // Verify this really came from your WooCommerce site using the shared
  // secret set when the webhook was created (Settings → Advanced →
  // Webhooks in WordPress admin). Mismatches are logged rather than
  // blocked for now, so real orders still come through while we debug —
  // check the logs if you want to tighten this later.
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
  if (secret && req.rawBody) {
    const signature = req.headers["x-wc-webhook-signature"];
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
    if (!signature || signature !== expected) {
      console.warn("WooCommerce webhook signature mismatch — received:", signature, "expected:", expected);
    }
  }

  // WooCommerce sends a test ping with no order data when the webhook is
  // first created — just acknowledge it.
  if (!req.body || !req.body.id) {
    return res.status(200).json({ ok: true });
  }

  try {
    const rawText = buildRawTextFromOrder(req.body);
    const imageUrls = await getProductImages(req.body);
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
