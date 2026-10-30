// steadfast_fraud.js — Steadfast's customer fraud check.
//
// Steadfast RETIRED the old `GET /fraud_check/{phone}` endpoint on
// 27 Sep 2026 (it now answers HTTP 200 with every count = 0). The
// replacement is `GET /fraud_check/score/{phone}`, which no longer gives
// exact parcel counts — only:
//   delivery_ratio / cancellation_ratio  whole percent of FINISHED parcels
//                                        (null when nothing has finished)
//   volume_band   none | low (1-5) | medium (6-20) | high (21-200) | very_high (200+)
//   total_reports number of fraud reports
const pool = require("./db");

const BASE = "https://portal.packzy.com/api/v1";

const BAND_BN = {
  none: "কোনো পার্সেল নেই (নতুন কাস্টমার)",
  low: "১–৫টি পার্সেল",
  medium: "৬–২০টি পার্সেল",
  high: "২১–২০০টি পার্সেল",
  very_high: "২০০+ পার্সেল",
};

let columnsReady = null;
// Adds the new columns once (safe to run repeatedly) and clears the
// all-zero rows the retired endpoint cached after 27 Sep 2026.
function ensureFraudColumns() {
  if (!columnsReady) {
    columnsReady = (async () => {
      await pool.query(`ALTER TABLE fraud_check_results ADD COLUMN IF NOT EXISTS cancellation_ratio NUMERIC`);
      await pool.query(`ALTER TABLE fraud_check_results ADD COLUMN IF NOT EXISTS volume_band TEXT`);
      await pool.query(`ALTER TABLE fraud_check_results ADD COLUMN IF NOT EXISTS total_reports INTEGER`);
      for (const col of ["total", "delivered", "cancelled", "success_rate"]) {
        await pool.query(`ALTER TABLE fraud_check_results ALTER COLUMN ${col} DROP NOT NULL`).catch(() => {});
      }
      await pool.query(
        `DELETE FROM fraud_check_results WHERE volume_band IS NULL AND COALESCE(total,0)=0 AND COALESCE(delivered,0)=0 AND COALESCE(cancelled,0)=0`
      );
    })().catch((err) => {
      columnsReady = null; // retry next time
      throw err;
    });
  }
  return columnsReady;
}

// Returns one of:
//   { message, attemptsLeft }        rate-limit style notice
//   { error, current, limit }        any failure (includes HTTP status + real reply snippet)
//   { deliveryRatio, cancellationRatio, volumeBand, volumeLabel, totalReports,
//     successRate }                  success (successRate = deliveryRatio, may be null)
async function steadfastFraudCheck(phone, sfKey, sfSecret) {
  const res = await fetch(`${BASE}/fraud_check/score/${phone}`, {
    method: "GET",
    headers: { "content-type": "application/json", Accept: "application/json", "api-key": sfKey, "secret-key": sfSecret },
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const snippet = raw.replace(/\s+/g, " ").slice(0, 160);

  if (res.status === 429) {
    return { message: "Steadfast রেট-লিমিট — একটু পরে আবার চেষ্টা করুন", attemptsLeft: null };
  }
  if (!body || typeof body !== "object") {
    console.warn(`Steadfast fraud score non-JSON (HTTP ${res.status}):`, snippet);
    return { error: `Steadfast-এর উত্তর বোঝা যায়নি (HTTP ${res.status}): ${snippet}`, current: null, limit: null };
  }
  const d = body.data && typeof body.data === "object" ? { ...body, ...body.data } : body;
  const hasScoreFields = "delivery_ratio" in d || "cancellation_ratio" in d || "volume_band" in d;
  if (!hasScoreFields) {
    if (body.message || body.error) {
      const msg = typeof (body.error || body.message) === "string" ? body.error || body.message : JSON.stringify(body.error || body.message);
      return { error: `${msg} (HTTP ${res.status})`, current: body.current ?? null, limit: body.limit ?? null };
    }
    console.warn(`Steadfast fraud score unexpected reply (HTTP ${res.status}):`, snippet);
    return { error: `Steadfast-এর উত্তরের ফরম্যাট বদলেছে (HTTP ${res.status}): ${snippet}`, current: null, limit: null };
  }

  const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const deliveryRatio = num(d.delivery_ratio);
  const cancellationRatio = num(d.cancellation_ratio);
  const volumeBand = typeof d.volume_band === "string" ? d.volume_band : null;
  return {
    deliveryRatio,
    cancellationRatio,
    volumeBand,
    volumeLabel: BAND_BN[volumeBand] || volumeBand || null,
    totalReports: num(d.total_reports) || 0,
    successRate: deliveryRatio,
  };
}

async function saveFraudResult(phone, r) {
  await ensureFraudColumns();
  await pool.query(
    `INSERT INTO fraud_check_results (phone, success_rate, cancellation_ratio, volume_band, total_reports, checked_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       success_rate = $2, cancellation_ratio = $3, volume_band = $4, total_reports = $5,
       total = NULL, delivered = NULL, cancelled = NULL, checked_at = NOW()`,
    [phone, r.deliveryRatio, r.cancellationRatio, r.volumeBand, r.totalReports]
  );
}

module.exports = { steadfastFraudCheck, saveFraudResult, ensureFraudColumns, BAND_BN };
