// public.js — Endpoints called directly from the WordPress site (not a
// logged-in moderator), so these use a shared secret instead of JWT auth
// — same pattern as the WooCommerce webhook.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { getPageCredential } = require("./settings");
const { sendSMS } = require("./entries");

function checkSecret(req, res) {
  const provided = req.body?.secret || req.query?.secret;
  const expected = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
  if (!expected || provided !== expected) {
    res.status(403).json({ error: "Invalid secret" });
    return false;
  }
  return true;
}

function normalizeBDPhone(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("880")) return "0" + digits.slice(3);
  if (digits.length === 10) return "0" + digits;
  return digits;
}

// GET /api/public/risk-check?phone=...&pageId=...&secret=...
// Checks Steadfast's own fraud history for this phone and decides
// whether checkout should require OTP verification, using the rule:
// fewer than 3 total orders, OR success rate under 60%, requires OTP.
router.get("/risk-check", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const phone = normalizeBDPhone(req.query.phone);
  const pageId = req.query.pageId || null;
  if (!phone || phone.length !== 11) {
    return res.status(400).json({ error: "Invalid phone" });
  }
  try {
    const courierCred = await getPageCredential("courier", "steadfast", pageId);
    const sfKey = (courierCred?.api_key || process.env.STEADFAST_API_KEY || "").trim();
    const sfSecret = (courierCred?.secret_key || process.env.STEADFAST_SECRET_KEY || "").trim();
    if (!sfKey || !sfSecret) {
      // Fail safe — if we can't check, don't block checkout.
      return res.json({ needsOtp: false, reason: "no_courier_key" });
    }
    const sfRes = await fetch(`https://portal.packzy.com/api/v1/fraud_check/${phone}`, {
      method: "GET",
      headers: { "content-type": "application/json", "api-key": sfKey, "secret-key": sfSecret },
    });
    const sfData = await sfRes.json();
    if (sfData?.message || sfData?.error) {
      // Rate-limited or an error on Steadfast's side — fail safe.
      return res.json({ needsOtp: false, reason: "fraud_check_unavailable" });
    }
    const total = Number(sfData?.total_parcels) || 0;
    const delivered = Number(sfData?.total_delivered) || 0;
    const successRate = total > 0 ? (delivered / total) * 100 : 0;

    const needsOtp = total < 3 || successRate < 60;

    res.json({ needsOtp, total, delivered, successRate: Math.round(successRate * 100) / 100 });
  } catch (err) {
    console.error("risk-check failed:", err.message);
    res.json({ needsOtp: false, reason: "error" });
  }
});

// POST /api/public/send-otp — body: { phone, secret, pageId? }
router.post("/send-otp", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const phone = normalizeBDPhone(req.body.phone);
  if (!phone || phone.length !== 11) {
    return res.status(400).json({ error: "Invalid phone" });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  try {
    await pool.query("INSERT INTO otp_verifications (phone, code, expires_at) VALUES ($1, $2, $3)", [
      phone,
      code,
      expiresAt,
    ]);

    // Uses the Al-Haya page's SMS token by default (same fallback pattern
    // used elsewhere for website-related things where the page isn't
    // known yet) — pass pageId if the checkout knows which brand it is.
    let smsToken = null;
    const pageId = req.body.pageId || null;
    if (pageId) {
      const cred = await getPageCredential("sms", "bdbulksms", pageId);
      smsToken = cred?.api_key || null;
    }
    if (!smsToken) {
      const alHaya = await pool.query("SELECT id FROM pages WHERE name = 'Al-Haya' LIMIT 1");
      if (alHaya.rows.length) {
        const cred = await getPageCredential("sms", "bdbulksms", alHaya.rows[0].id);
        smsToken = cred?.api_key || null;
      }
    }

    const message = `আপনার Asbab Abaya OTP কোড: ${code}। এটি ৫ মিনিটের জন্য বৈধ। কারো সাথে শেয়ার করবেন না।`;
    const smsResult = await sendSMS(phone, message, smsToken);
    res.json({ sent: smsResult.success, error: smsResult.error || null });
  } catch (err) {
    console.error("send-otp failed:", err.message);
    res.status(500).json({ error: "OTP পাঠানো যায়নি" });
  }
});

// POST /api/public/verify-otp — body: { phone, code, secret }
router.post("/verify-otp", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const phone = normalizeBDPhone(req.body.phone);
  const code = String(req.body.code || "").trim();
  if (!phone || !code) return res.json({ verified: false });
  try {
    const result = await pool.query(
      `SELECT id FROM otp_verifications
       WHERE phone = $1 AND code = $2 AND expires_at > NOW() AND verified = false
       ORDER BY created_at DESC LIMIT 1`,
      [phone, code]
    );
    if (result.rows.length === 0) {
      return res.json({ verified: false });
    }
    await pool.query("UPDATE otp_verifications SET verified = true WHERE id = $1", [result.rows[0].id]);
    res.json({ verified: true });
  } catch (err) {
    console.error("verify-otp failed:", err.message);
    res.status(500).json({ error: "Could not verify" });
  }
});

// GET /api/public/otp-status?phone=...&secret=... — used server-side by
// the WordPress checkout validation hook, to confirm (without trusting
// the browser) that this phone was actually OTP-verified recently.
router.get("/otp-status", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const phone = normalizeBDPhone(req.query.phone);
  try {
    const result = await pool.query(
      `SELECT id FROM otp_verifications
       WHERE phone = $1 AND verified = true AND created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    res.json({ verified: result.rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ verified: false });
  }
});

module.exports = { router };
