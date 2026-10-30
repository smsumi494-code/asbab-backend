// public.js — Endpoints called directly from the WordPress site (not a
// logged-in moderator), so these use a shared secret instead of JWT auth
// — same pattern as the WooCommerce webhook.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { getPageCredential } = require("./settings");
const { sendSMS } = require("./entries");
const { steadfastFraudCheck } = require("./steadfast_fraud");

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

// GET /api/public/risk-check?phone=...&pageId=...&secret=...&threshold=...&blockMode=...
// Checks Steadfast's own fraud history for this phone and decides
// whether checkout should require OTP verification (or be blocked
// outright), using the rule: 0 orders = verify; 1-3 orders with any
// cancel = verify; success rate under the configured threshold (default
// 65%) = block. If blockMode is "1", every "verify" case becomes a
// "block" instead (no OTP option at all).
router.get("/risk-check", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const phone = normalizeBDPhone(req.query.phone);
  const pageId = req.query.pageId || null;
  const threshold = Number(req.query.threshold) || 65;
  const blockMode = req.query.blockMode === "1";

  // An invalid/malformed phone number is itself a risk signal (can't be
  // delivered to, can't be verified) — never silently let this through.
  if (!phone || phone.length !== 11) {
    return res.json({ needsOtp: !blockMode, blocked: blockMode, reason: "invalid_phone" });
  }
  try {
    const courierCred = await getPageCredential("courier", "steadfast", pageId);
    const sfKey = (courierCred?.api_key || process.env.STEADFAST_API_KEY || "").trim();
    const sfSecret = (courierCred?.secret_key || process.env.STEADFAST_SECRET_KEY || "").trim();
    if (!sfKey || !sfSecret) {
      // Fail safe — if we can't check, don't block checkout.
      return res.json({ needsOtp: false, blocked: false, reason: "no_courier_key" });
    }
    // Steadfast retired the old count-based endpoint (27 Sep 2026); the
    // score endpoint gives only ratios (% of FINISHED parcels) + a volume
    // band, so the rule is rebuilt on those:
    //   no parcels at all / nothing finished yet  -> verify (new customer)
    //   small history (1-5 parcels) with any cancel -> verify
    //   otherwise delivery ratio under threshold    -> block
    const r = await steadfastFraudCheck(phone, sfKey, sfSecret);
    if (r.message || r.error) {
      // Rate-limited or an error on Steadfast's side — fail safe.
      return res.json({ needsOtp: false, blocked: false, reason: "fraud_check_unavailable" });
    }
    const deliveryRatio = r.deliveryRatio;
    const cancellationRatio = r.cancellationRatio;

    let needsOtp = false;
    let blocked = false;
    if (r.volumeBand === "none" || deliveryRatio === null) {
      needsOtp = true; // brand new / nothing finished yet — verify, don't block
    } else if (r.volumeBand === "low") {
      if ((cancellationRatio || 0) > 0) needsOtp = true; // small history with a cancel — verify
    } else {
      if (deliveryRatio < threshold) blocked = true; // established customer, bad rate — hard stop
    }

    // "Block instead of verify" mode — skip the OTP chance entirely.
    if (blockMode && needsOtp) {
      needsOtp = false;
      blocked = true;
    }

    res.json({
      needsOtp,
      blocked,
      volumeBand: r.volumeBand,
      deliveryRatio,
      cancellationRatio,
      successRate: deliveryRatio,
    });
  } catch (err) {
    console.error("risk-check failed:", err.message);
    res.json({ needsOtp: false, blocked: false, reason: "error" });
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
  let rowId = null;
  try {
    const inserted = await pool.query(
      "INSERT INTO otp_verifications (phone, code, expires_at) VALUES ($1, $2, $3) RETURNING id",
      [phone, code, expiresAt]
    );
    rowId = inserted.rows[0].id;

    let smsResult;
    try {
      // Uses the Al-Haya page's SMS token by default (same fallback
      // pattern used elsewhere for website-related things where the page
      // isn't known yet) — pass pageId if the checkout knows the brand.
      let smsToken = null;
      let pageName = null;
      const pageId = req.body.pageId || null;
      if (pageId) {
        const cred = await getPageCredential("sms", "bdbulksms", pageId);
        smsToken = cred?.api_key || null;
        const pageRes = await pool.query("SELECT name FROM pages WHERE id = $1", [pageId]);
        pageName = pageRes.rows[0]?.name || null;
      }
      if (!smsToken) {
        const alHaya = await pool.query("SELECT id, name FROM pages WHERE name = 'Al-Haya' LIMIT 1");
        if (alHaya.rows.length) {
          const cred = await getPageCredential("sms", "bdbulksms", alHaya.rows[0].id);
          smsToken = cred?.api_key || null;
          pageName = alHaya.rows[0].name;
        }
      }

      const message = `আপনার ${pageName || "Asbab Abaya"} OTP কোড: ${code}। এটি ৫ মিনিটের জন্য বৈধ। কারো সাথে শেয়ার করবেন না।`;

      // Retry a few times fast before giving up — most failures here are
      // transient (a momentary network/API blip), and the customer should
      // never see one unless it genuinely keeps failing.
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        smsResult = await sendSMS(phone, message, smsToken, "otp");
        if (smsResult.success) break;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    } catch (innerErr) {
      // Anything above (credential lookup, page-name lookup) failing
      // shouldn't leave the OTP log blank — record what actually broke.
      console.error("send-otp credential/setup failed:", innerErr.message);
      smsResult = { success: false, error: `সেটআপ ব্যর্থ: ${innerErr.message}` };
    }

    await pool.query("UPDATE otp_verifications SET sent = $1, send_error = $2 WHERE id = $3", [
      smsResult.success,
      smsResult.error || null,
      rowId,
    ]);

    res.json({ sent: smsResult.success, error: smsResult.error || null });
  } catch (err) {
    console.error("send-otp failed:", err.message);
    // Last-resort safety net — if rowId exists but we never got to record
    // an outcome (e.g. the UPDATE query itself failed), mark it here so
    // the OTP log never shows a blank/unexplained failure.
    if (rowId) {
      try {
        await pool.query("UPDATE otp_verifications SET sent = false, send_error = $1 WHERE id = $2", [
          `অপ্রত্যাশিত এরর: ${err.message}`,
          rowId,
        ]);
      } catch (loggingErr) {
        console.error("Could not even log the failure:", loggingErr.message);
      }
    }
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

// Called periodically (see server.js) — finds OTP attempts that were
// sent but never verified (the 5-minute code window expired), and
// surfaces them in Website Order → Incomplete, so admins know a
// customer got as far as the OTP screen but gave up.
async function sweepAbandonedOtps() {
  const { createEntry } = require("./entries");
  const result = await pool.query(
    `SELECT id, phone FROM otp_verifications
     WHERE sent = true AND verified = false AND expires_at < NOW()
       AND (converted_to_incomplete IS NULL OR converted_to_incomplete = false)`
  );
  for (const row of result.rows) {
    try {
      await createEntry({
        rawText: `ফোন: ${row.phone}\nকাস্টমার OTP ভেরিফাই করেননি (চেকআউট শেষ করেননি)`,
        imageUrls: [],
        moderator: "ওয়েবসাইট",
        group: "website_order",
        status: "incomplete",
        customerPhone: row.phone,
      });
      await pool.query("UPDATE otp_verifications SET converted_to_incomplete = true WHERE id = $1", [row.id]);
    } catch (err) {
      console.error("Could not convert abandoned OTP to incomplete entry:", err.message);
    }
  }
}

module.exports = { router, sweepAbandonedOtps };
