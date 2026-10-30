// courier_pending.js — "All Courier Pending" group. Shows every parcel that
// is still PENDING at Steadfast, read straight from Steadfast (nothing is
// stored here). A parcel disappears from the list by itself the moment
// Steadfast moves it out of Pending (delivered, cancelled, etc.).
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth } = require("./auth");
const { getPendingParcels, getConsignmentTracking } = require("./steadfast_tracking");

const NOTE_TTL_MS = 3 * 60 * 1000; // how long a parcel's "last rider note" is reused before re-checking
const NOTE_CONCURRENCY = 4; // parallel Steadfast page fetches while collecting notes
const noteCache = new Map(); // parcelId -> { at, note: {text,date,time} | null }
const credByPage = new Map(); // pageId -> { email, password }
let noteWorker = null;

const CACHE_MS = 45 * 1000; // protects Steadfast from repeated hits (many moderators, polling)
let cache = null; // { at, data }
let inflight = null;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "30 Oct 2026" + "12:00 AM" -> sortable number (Dhaka wall-clock, only used for ordering)
function sortKey(date, time) {
  const d = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(date || "");
  if (!d) return 0;
  let h = 0, m = 0;
  const t = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(time || "");
  if (t) {
    h = parseInt(t[1], 10) % 12;
    if (t[3].toUpperCase() === "PM") h += 12;
    m = parseInt(t[2], 10);
  }
  return Date.UTC(+d[3], MONTHS[d[2].toLowerCase()] ?? 0, +d[1], h, m);
}

async function loadAll() {
  const creds = await pool.query(
    `SELECT c.page_id, c.api_key, c.secret_key, p.name AS page_name
     FROM api_credentials c LEFT JOIN pages p ON p.id = c.page_id
     WHERE c.type = 'steadfast_moderator'`
  );
  creds.rows.forEach((r) => credByPage.set(String(r.page_id), { email: r.api_key, password: r.secret_key }));
  const errors = [];
  const results = await Promise.all(
    creds.rows.map(async (row) => {
      try {
        const items = await getPendingParcels(row.page_id, row.api_key, row.secret_key);
        return items.map((i) => ({ ...i, pageId: row.page_id, pageName: row.page_name || null, sortKey: sortKey(i.date, i.time) }));
      } catch (err) {
        console.error(`Courier pending failed for page ${row.page_name || row.page_id}:`, err.message);
        errors.push({ pageName: row.page_name || String(row.page_id), message: err.message });
        return [];
      }
    })
  );
  const items = results.flat().sort((a, b) => b.sortKey - a.sortKey);
  return { items, errors, fetchedAt: new Date().toISOString(), accounts: creds.rows.length };
}

async function getCached(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!inflight) {
    inflight = loadAll()
      .then((data) => {
        // Keep the last good list if every account failed this time.
        if (data.items.length === 0 && data.errors.length > 0 && cache) {
          return { ...cache.data, errors: data.errors, stale: true };
        }
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}


// The list page doesn't show rider notes — they only exist on each parcel's
// own page ("Rider Note: ..." lines in the tracking timeline). So notes are
// collected in the BACKGROUND (a few parcels at a time, cached for a few
// minutes) and attached to the list as they arrive; the list itself never
// waits for them.
function pickLastRiderNote(steps) {
  const hit = (steps || []).find((st) => st.message && st.message.includes("Rider Note:")); // steps are newest-first
  if (!hit) return null;
  return { text: hit.message.replace(/^.*?Rider Note:\s*/i, "").trim(), date: hit.date, time: hit.time };
}

function startNoteWorker(items) {
  if (noteWorker) return;
  const ids = new Set(items.map((i) => i.parcelId));
  for (const k of noteCache.keys()) if (!ids.has(k)) noteCache.delete(k); // parcel left Pending
  const todo = items.filter((i) => {
    const c = noteCache.get(i.parcelId);
    return !c || Date.now() - c.at > NOTE_TTL_MS;
  });
  if (todo.length === 0) return;
  noteWorker = (async () => {
    let next = 0;
    const run = async () => {
      while (next < todo.length) {
        const item = todo[next++];
        const cred = credByPage.get(String(item.pageId));
        if (!cred) continue;
        try {
          const t = await getConsignmentTracking(item.pageId, cred.email, cred.password, item.parcelId);
          noteCache.set(item.parcelId, { at: Date.now(), note: pickLastRiderNote(t.trackingSteps) });
        } catch (err) {
          console.warn(`Rider note fetch failed for ${item.parcelId}:`, err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: NOTE_CONCURRENCY }, run));
  })().finally(() => {
    noteWorker = null;
  });
}

// Adds lastRiderNote to each item (undefined = not collected yet, null = none).
function withNotes(data) {
  startNoteWorker(data.items);
  const items = data.items.map((i) => {
    const c = noteCache.get(i.parcelId);
    return c ? { ...i, lastRiderNote: c.note } : i;
  });
  const notesPending = items.filter((i) => i.lastRiderNote === undefined).length;
  return { ...data, items, notesPending };
}

// GET /api/courier-pending?refresh=1&countOnly=1
router.get("/", requireAuth, async (req, res) => {
  try {
    const data = await getCached(req.query.refresh === "1");
    if (req.query.countOnly === "1") {
      return res.json({ count: data.items.length, fetchedAt: data.fetchedAt, hasErrors: data.errors.length > 0 });
    }
    res.json(withNotes(data));
  } catch (err) {
    console.error("Courier pending failed:", err);
    res.status(500).json({ error: err.message || "কুরিয়ার পেন্ডিং তালিকা আনা যায়নি" });
  }
});

// GET /api/courier-pending/:parcelId/tracking?pageId=...
router.get("/:parcelId/tracking", requireAuth, async (req, res) => {
  try {
    const parcelId = String(req.params.parcelId).replace(/\D/g, "");
    const pageId = req.query.pageId;
    if (!parcelId || !pageId) return res.status(400).json({ error: "parcelId ও pageId দরকার" });
    const cred = await pool.query(
      "SELECT api_key, secret_key FROM api_credentials WHERE page_id = $1 AND type = 'steadfast_moderator' LIMIT 1",
      [pageId]
    );
    if (cred.rows.length === 0) return res.status(400).json({ error: "এই পেইজের জন্য Steadfast Moderator অ্যাকাউন্ট সেটআপ করা হয়নি" });
    const tracking = await getConsignmentTracking(pageId, cred.rows[0].api_key, cred.rows[0].secret_key, parcelId);
    res.json(tracking);
  } catch (err) {
    console.error("Courier pending tracking failed:", err);
    res.status(500).json({ error: err.message || "ট্র্যাকিং তথ্য আনা যায়নি" });
  }
});

module.exports = router;
