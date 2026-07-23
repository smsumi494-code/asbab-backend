// facebook.js — sends Complete/Refund signals to Facebook's Conversions
// API (CAPI) and updates the matching WooCommerce order's status, so
// Facebook's ad algorithm learns which leads actually turn into real
// deliveries over time (see conversation history for the full reasoning).
const crypto = require("crypto");
const pool = require("./db");
const { getPageCredential } = require("./settings");

function hashPhone(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  const e164 = digits.startsWith("880") ? digits : `880${digits.replace(/^0/, "")}`;
  return crypto.createHash("sha256").update(e164).digest("hex");
}

// Website-order entries don't have a page_id set (the WooCommerce webhook
// doesn't know which of our pages a site maps to) — fall back to Al-Haya
// in that case, same pattern used for OTP SMS sending.
async function resolvePageId(pageId) {
  if (pageId) return pageId;
  const alHaya = await pool.query("SELECT id FROM pages WHERE name = 'Al-Haya' LIMIT 1");
  return alHaya.rows[0]?.id || null;
}

// eventName: "OrderComplete" | "OrderRefunded" (custom events — Facebook
// fully supports these for Custom Conversions / algorithm learning, even
// though they aren't part of the standard event list). name is optional
// but improves match quality when available (already saved on shipped
// orders from the Send to Courier AI extraction).
async function sendFacebookEvent(pageId, phone, eventName, name = null) {
  try {
    const resolvedPageId = await resolvePageId(pageId);
    const cred = await getPageCredential("facebook", "meta", resolvedPageId);
    const pixelId = cred?.api_key;
    const accessToken = cred?.secret_key;
    if (!pixelId || !accessToken) {
      return { success: false, error: "Facebook Pixel/Token সেটআপ করা হয়নি" };
    }

    const userData = { ph: [hashPhone(phone)] };
    if (name) {
      const parts = name.trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(" ");
      const hash = (s) => crypto.createHash("sha256").update(s.toLowerCase()).digest("hex");
      if (firstName) userData.fn = [hash(firstName)];
      if (lastName) userData.ln = [hash(lastName)];
    }

    const body = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: "system_generated",
          user_data: userData,
        },
      ],
    };

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    if (!res.ok || data.error) {
      return { success: false, error: data.error?.message || "Facebook API error" };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Updates a WooCommerce order's status via the REST API (same
// consumer key/secret already used elsewhere for reading product images
// etc.) — status should be a valid WooCommerce order status slug, e.g.
// "completed" or "refunded".
async function updateWooOrderStatus(pageId, wooOrderId, status) {
  try {
    const resolvedPageId = await resolvePageId(pageId);
    const cred = await getPageCredential("woocommerce", "woocommerce", resolvedPageId);
    const key = cred?.api_key || process.env.WC_CONSUMER_KEY;
    const secret = cred?.secret_key || process.env.WC_CONSUMER_SECRET;
    const siteUrl = process.env.WC_SITE_URL || "https://asbababaya.com";
    if (!key || !secret || !wooOrderId) {
      return { success: false, error: "WooCommerce key/order id সেটআপ করা নেই" };
    }
    const authHeader = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
    const res = await fetch(`${siteUrl}/wp-json/wc/v3/orders/${wooOrderId}`, {
      method: "PUT",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `WC update failed: ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendFacebookEvent, updateWooOrderStatus, hashPhone };
