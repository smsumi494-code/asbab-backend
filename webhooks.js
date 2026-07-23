// webhooks.js — receives "order created" events from the WooCommerce
// website and drops them straight into the "All Order" group, exactly as
// if a moderator had typed them in. From there the existing auto-forward
// to Pending/Making kicks in automatically.
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("./db");
const { createEntry } = require("./entries");
const { broadcastRefresh } = require("./sse");

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
  const keywords = ["লং", "size", "সাইজ"];
  // Checkout Field Editor turns a Bengali field label into a meta key by
  // slugifying it — Bengali characters can't be transliterated, so they
  // get stripped down to just underscores. That's why "বোরকার লং" ends up
  // as a key like "_billing____________" with no readable text at all.
  // This regex catches that pattern directly since keyword matching can't.
  const underscoreOnlyBillingKey = /^_billing_+$/;

  const lines = [];
  for (const meta of order.meta_data || []) {
    const label = meta.display_key || meta.key || "";
    const value = meta.display_value ?? meta.value;
    if (!value) continue;
    const isKeywordMatch = keywords.some((k) => label.toLowerCase().includes(k.toLowerCase()));
    const isUnderscoreBillingField = underscoreOnlyBillingKey.test(meta.key || "");
    if (isKeywordMatch || isUnderscoreBillingField) {
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
  console.log("Woo webhook hit — body has id:", !!req.body?.id); // temporary debug, remove once confirmed working

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
    const completedPhone = (req.body.billing?.phone || "").replace(/\D/g, "");
    const completedDevice = (req.body.meta_data || []).find((m) => m.key === "_cooldown_device")?.value || null;

    await createEntry({
      rawText,
      imageUrls,
      moderator: "ওয়েবসাইট",
      group: "website_order",
      status: "processing",
      customerPhone: completedPhone || null,
      wooOrderId: req.body.id,
    });

    // They finished checkout after all — remove any lingering "Incomplete"
    // entry for this phone/device (same group, status='incomplete') so it
    // doesn't sit around as a stale duplicate. Matching by device too
    // handles the case where they changed their phone number mid-way.
    if (completedPhone || completedDevice) {
      await pool.query(
        `DELETE FROM entries
         WHERE group_name = 'website_order' AND status = 'incomplete'
           AND (customer_phone = $1 OR ($2::text IS NOT NULL AND customer_device = $2))`,
        [completedPhone, completedDevice]
      );
      broadcastRefresh();
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WooCommerce webhook failed:", err);
    // Still respond 200 so WooCommerce doesn't keep retrying forever —
    // the error is logged for you to check.
    res.status(200).json({ ok: false });
  }
});

// POST /api/webhooks/woocommerce-incomplete — called live from the
// checkout page (via the WordPress plugin) as the customer types their
// phone/name/address, BEFORE they click "Place Order". These land in the
// Website Order group too, as a separate "Incomplete" status, so you can
// follow up on likely-abandoned checkouts from the same place. Upserts by
// phone number so typing more characters updates the same entry instead
// of spamming new ones every few seconds.
router.post("/woocommerce-incomplete", async (req, res) => {
  const configuredSecret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
  if (configuredSecret && req.body?.secret !== configuredSecret) {
    return res.status(401).json({ error: "Invalid secret" });
  }

  const phone = (req.body?.phone || "").replace(/\D/g, "");
  const device = req.body?.device || null;
  if (!phone) return res.status(200).json({ ok: true }); // nothing usable yet, ignore quietly

  const name = req.body?.name || "";
  const address = req.body?.address || "";
  const lineItems = req.body?.lineItems || [];
  const productsText = lineItems.map((item) => `${item.name} x${item.quantity}`).join(", ");

  const rawText = [
    name ? `নাম: ${name}` : null,
    `ফোন: ${phone}`,
    address ? `ঠিকানা: ${address}` : null,
    productsText ? `প্রোডাক্ট: ${productsText}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const imageUrls = await getProductImages({ line_items: lineItems });

    // Match by device first — this is what lets us recognize the SAME
    // customer even if they change the phone number mid-way through
    // checkout, instead of treating it as a new/separate lead. Falls
    // back to matching by phone if no device id is available.
    const existing = await pool.query(
      `SELECT id FROM entries
       WHERE group_name = 'website_order'
         AND status = 'incomplete'
         AND created_at > NOW() - INTERVAL '2 hours'
         AND (($1::text IS NOT NULL AND customer_device = $1) OR customer_phone = $2)
       ORDER BY created_at DESC LIMIT 1`,
      [device, phone]
    );

    if (existing.rows.length) {
      await pool.query(
        "UPDATE entries SET raw_text = $1, image_urls = $2::jsonb, customer_phone = $3, customer_device = $4 WHERE id = $5",
        [rawText, JSON.stringify(imageUrls), phone, device, existing.rows[0].id]
      );
      broadcastRefresh();
    } else {
      await createEntry({
        rawText,
        imageUrls,
        moderator: "ওয়েবসাইট",
        group: "website_order",
        status: "incomplete",
        customerPhone: phone,
        customerDevice: device,
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Incomplete-order capture failed:", err);
    res.status(200).json({ ok: false });
  }
});

module.exports = router;
