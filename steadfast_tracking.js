// steadfast_tracking.js — logs into Steadfast's Moderator panel (a
// per-page account with VIEW-ONLY parcel access — confirmed with
// Steadfast as an acceptable use) and scrapes a consignment's rider
// name/phone and tracking timeline. There's no public API for this, so
// this does a real browser-style login (CSRF token + session cookie)
// and reads the same HTML a human moderator would see.
const cheerio = require("cheerio");

// In-memory session cache, keyed by page_id — avoids logging in on every
// single tracking view. Re-logs in automatically if a session has expired.
const sessionCache = new Map(); // page_id -> { cookie, loggedInAt }
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function extractSetCookies(res) {
  // Node 18.14+/undici support getSetCookie() for multiple Set-Cookie
  // headers; fall back to a single header if not available.
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieHeaderFrom(setCookies, existing) {
  const jar = {};
  (existing || "").split("; ").forEach((pair) => {
    const [k, v] = pair.split("=");
    if (k) jar[k] = v;
  });
  setCookies.forEach((sc) => {
    const [pair] = sc.split(";");
    const [k, v] = pair.split("=");
    if (k) jar[k] = v;
  });
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function login(email, password) {
  // Step 1 — GET the login page for a fresh CSRF token + initial cookies.
  const loginPageRes = await fetch("https://www.steadfast.com.bd/moderator/login");
  const loginPageHtml = await loginPageRes.text();
  let cookie = cookieHeaderFrom(extractSetCookies(loginPageRes), "");

  const $ = cheerio.load(loginPageHtml);
  const token = $('input[name="_token"]').attr("value");
  if (!token) throw new Error("Could not find login CSRF token");

  // Step 2 — POST credentials, following the resulting redirect manually
  // so we can capture the NEW (authenticated) session cookie.
  const params = new URLSearchParams({ _token: token, email, password });
  const loginRes = await fetch("https://steadfast.com.bd/moderator/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: params.toString(),
    redirect: "manual",
  });
  cookie = cookieHeaderFrom(extractSetCookies(loginRes), cookie);

  if (loginRes.status !== 302 && loginRes.status !== 200) {
    throw new Error("Steadfast moderator login failed");
  }

  return cookie;
}

async function getSessionCookie(pageId, email, password) {
  const cached = sessionCache.get(pageId);
  if (cached && Date.now() - cached.loggedInAt < SESSION_MAX_AGE_MS) {
    return cached.cookie;
  }
  const cookie = await login(email, password);
  sessionCache.set(pageId, { cookie, loggedInAt: Date.now() });
  return cookie;
}

// Parses a consignment detail page's HTML into a clean, structured shape.
const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

// Splits "30 Oct 2026, 07:32 PM" into { date: "30 Oct 2026", time: "07:32 PM" }.
function splitDateTime(text) {
  const t = clean(text);
  const idx = t.lastIndexOf(",");
  if (idx === -1) return { date: t, time: "" };
  return { date: t.slice(0, idx).trim(), time: t.slice(idx + 1).trim() };
}

// ---- Steadfast's NEW (2026) merchant UI: classes are "sf-parcel__*" ----
function parseNewLayout($) {
  const root = $("[data-sf-parcel]").first();
  if (!root.length) return null;

  const status = clean(root.find(".sf-parcel__status-title .sf-badge").first().text()) || null;

  // Money box: <div><span>COD</span><b>৳2,400</b></div> (+ others, e.g. delivery charge)
  const money = {};
  root.find(".sf-parcel__money > div").each((_, el) => {
    const label = clean($(el).find("span").first().text());
    const value = clean($(el).find("b").first().text());
    if (label) money[label.toLowerCase()] = value;
  });
  const stripTaka = (v) => (v ? v.replace(/^৳\s*/, "") : null);
  const codAmount = stripTaka(money["cod"]);
  const deliveryCharge = stripTaka(money["delivery charge"] || money["charge"]);

  // Recipient card
  const rec = root.find(".sf-parcel__card--recipient").first();
  const customerName = clean(rec.find(".sf-parcel__person b").first().text()) || null;
  const personPs = rec.find(".sf-parcel__person p");
  const customerAddress = clean(personPs.not(".sf-parcel__area").first().text()) || null;
  const area = clean(rec.find(".sf-parcel__area").first().text()) || null; // "Thana, District"
  const customerPoliceStation = area ? clean(area.split(",")[0]) : null;
  const phones = [];
  rec.find(".sf-parcel__contacts li").each((_, el) => {
    const label = clean($(el).find(".sf-parcel__contact-label").text()).toLowerCase();
    const num = clean($(el).find(".sf-parcel__mono").first().text());
    if (num) phones.push({ label, num });
  });
  const customerPhone = (phones.find((p) => p.label === "phone") || phones[0] || {}).num || null;
  const alt = phones.find((p) => p !== phones[0] && p.num !== customerPhone);
  const customerAltPhone = alt ? alt.num : null;

  // Delivery card (rider)
  const riderBox = root.find(".sf-parcel__rider").first();
  const riderName = clean(riderBox.find("b").first().text()) || null;
  const riderPhone = clean(riderBox.find(".sf-parcel__mono").first().text()) || null;
  const hub = clean(root.find(".sf-parcel__hub span").first().text()) || null;

  // Facts (tracking code, invoice, weight ...)
  const facts = {};
  root.find(".sf-parcel__facts > div").each((_, el) => {
    const k = clean($(el).find("dt").text());
    const v = clean($(el).find("dd").text());
    if (k) facts[k] = v;
  });

  const noteForDelivery = clean(root.find(".sf-parcel__card--contents .sf-parcel__text").first().text()) || null;

  // Tracking timeline — newest first, same order as before.
  const trackingSteps = [];
  root.find(".sf-parcel__timeline > li").each((_, el) => {
    const $el = $(el);
    const message = clean($el.find(".sf-parcel__step").first().text());
    const when = splitDateTime($el.find("time").first().text());
    if (message) trackingSteps.push({ date: when.date, time: when.time, message });
  });

  return {
    riderName, riderPhone, status, codAmount, deliveryCharge,
    customerName, customerAddress, customerPhone, customerAltPhone, customerPoliceStation,
    hub, trackingCode: facts["Tracking code"] || null, invoice: facts["Invoice"] || null,
    noteForDelivery, trackingSteps,
  };
}

// ---- Steadfast's OLD moderator-panel layout (kept as a fallback) ----
function parseLegacyLayout($) {
  const riderNameEl = $(".rider-info .rider-name small.txt-black").first().clone();
  riderNameEl.find("a").remove();
  const riderName = riderNameEl.text().trim() || null;
  const riderPhone = $(".rider-info .cell span").first().text().trim() || null;
  const status = $(".parcel-short-info label.alert, .parcel-information label.alert").first().text().trim() || null;

  let codAmount = null;
  $("h6").each((_, el) => {
    const t = $(el).text().trim();
    if (t.startsWith("COD")) codAmount = t.replace(/^COD:?\s*/i, "").trim();
  });
  let deliveryCharge = null;
  $("p").each((_, el) => {
    const t = $(el).text().trim();
    if (t.startsWith("Delivery Charge")) {
      deliveryCharge = $(el).find("span").first().text().trim() || t.replace(/^Delivery Charge\s*:?\s*/i, "").trim();
    }
  });

  const clientInfo = {};
  $(".client-info p").each((_, el) => {
    const label = $(el).find("small").first().text().replace(/\s*:\s*$/, "").trim();
    const value = $(el).find("span").first().text().replace(/\s+/g, " ").trim();
    if (label) clientInfo[label] = value;
  });

  const trackingSteps = [];
  $(".tracking-steps .step").each((_, el) => {
    const $el = $(el);
    const dateTime = $el.children(".date-time");
    const date = dateTime.find("p").eq(0).text().trim();
    const time = dateTime.find("p").eq(1).text().trim();
    const message = $el.find(".tracking_content > p.txt-black").first().text().trim();
    if (message) trackingSteps.push({ date, time, message });
  });

  return {
    riderName, riderPhone, status, codAmount, deliveryCharge,
    customerName: clientInfo["Name"] || null,
    customerAddress: clientInfo["Address"] || null,
    customerPhone: clientInfo["Phone Number"] || null,
    customerAltPhone:
      clientInfo["Alternative Number"] && clientInfo["Alternative Number"] !== "N/A" ? clientInfo["Alternative Number"] : null,
    customerPoliceStation: clientInfo["Policestation"] || null,
    trackingSteps,
  };
}

// Parses a consignment detail page. Tries the new layout first, then the
// old one. If NEITHER finds anything, Steadfast changed the page again —
// throw a clear error instead of silently returning an empty result.
function parseConsignmentHtml(html) {
  const $ = cheerio.load(html);
  const result = parseNewLayout($) || parseLegacyLayout($);
  const gotAnything = result.status || result.riderName || (result.trackingSteps && result.trackingSteps.length);
  if (!gotAnything) {
    throw new Error("Steadfast পেজের গঠন বদলেছে — ট্র্যাকিং পড়া যায়নি (পার্সার আপডেট দরকার)");
  }
  return result;
}

// True when Steadfast sent back a login form instead of the parcel page.
function isLoginPage(html) {
  return (
    html.includes("Moderator Login") ||
    (/name=["']password["']/i.test(html) && !html.includes("data-sf-parcel") && !html.includes("sf-shell"))
  );
}


// ---------------------------------------------------------------------
// Pending parcels list (https://steadfast.com.bd/user/consignment/status/pending)
// Steadfast's new "Parcels" page renders a table; its columns are mapped by
// HEADER TEXT (Consignment / Invoice / Recipient / Address / Date / COD /
// Status) so reordering columns won't break it. Throws a clear error if
// the page says there are parcels but no rows can be read.
// ---------------------------------------------------------------------
function parsePendingListHtml(html) {
  const $ = cheerio.load(html);
  const root = $(".sf-parcels").first();
  if (!root.length) {
    throw new Error("Steadfast পেজের গঠন বদলেছে — পেন্ডিং তালিকা পড়া যায়নি (পার্সার আপডেট দরকার)");
  }
  const countText = clean(root.find(".sf-parcels__count").first().text());
  const declaredCount = parseInt((countText.match(/\d+/) || [])[0], 10);

  const table = root.find("table.sf-table").first();
  const cols = {};
  table.find("thead th").each((i, el) => {
    const t = clean($(el).text()).toLowerCase();
    if (t) cols[t] = i;
  });
  const idx = (name, fallback) => (cols[name] !== undefined ? cols[name] : fallback);
  const cId = idx("consignment", 1), cInv = idx("invoice", 2), cName = idx("recipient", 3);
  const cAddr = idx("address", 4), cDate = idx("date", 5), cCod = idx("cod", 6), cStatus = idx("status", 7);

  const items = [];
  table.find("tbody tr").each((_, tr) => {
    const tds = $(tr).children("td");
    const parcelId = clean(tds.eq(cId).find("a.sf-parcels__id").first().text()) || clean(tds.eq(cId).text());
    if (!/^\d+$/.test(parcelId)) return;
    const dateCell = tds.eq(cDate).clone();
    const time = clean(dateCell.find("span").text());
    dateCell.find("span").remove();
    items.push({
      parcelId,
      invoice: clean(tds.eq(cInv).text()),
      name: clean(tds.eq(cName).text()),
      address: clean(tds.eq(cAddr).text()),
      date: clean(dateCell.text()),
      time,
      cod: clean(tds.eq(cCod).text()),
      riderStatus: clean(tds.eq(cStatus).find(".sf-badge").first().text()) || null,
    });
  });

  if (items.length === 0 && declaredCount > 0) {
    throw new Error("Steadfast পেজের গঠন বদলেছে — পেন্ডিং তালিকার সারি পড়া যায়নি (পার্সার আপডেট দরকার)");
  }
  return { items, declaredCount: Number.isNaN(declaredCount) ? items.length : declaredCount };
}

// Fetches ALL pending parcels for one Steadfast moderator account
// (follows ?page=N while the page says there are more than collected).
async function getPendingParcels(pageId, email, password) {
  if (!email || !password) throw new Error("Steadfast Moderator credentials not set up for this page");
  const fetchPage = async (n) => {
    const url = `https://steadfast.com.bd/user/consignment/status/pending${n > 1 ? `?page=${n}` : ""}`;
    let cookie = await getSessionCookie(pageId, email, password);
    let html = await (await fetch(url, { headers: { Cookie: cookie } })).text();
    if (isLoginPage(html)) {
      sessionCache.delete(pageId);
      cookie = await getSessionCookie(pageId, email, password);
      html = await (await fetch(url, { headers: { Cookie: cookie } })).text();
    }
    if (isLoginPage(html)) throw new Error("Could not log into Steadfast Moderator panel — check email/password");
    return parsePendingListHtml(html);
  };

  const first = await fetchPage(1);
  const all = [...first.items];
  const seen = new Set(all.map((i) => i.parcelId));
  for (let n = 2; n <= 15 && all.length < first.declaredCount; n++) {
    const next = await fetchPage(n);
    const fresh = next.items.filter((i) => !seen.has(i.parcelId));
    if (fresh.length === 0) break;
    fresh.forEach((i) => seen.add(i.parcelId));
    all.push(...fresh);
  }
  return all;
}

// Fetches + parses one consignment. Retries once with a fresh login if
// the session had expired (Steadfast redirects back to the login page).
async function getConsignmentTracking(pageId, email, password, consignmentId) {
  if (!email || !password) {
    throw new Error("Steadfast Moderator credentials not set up for this page");
  }

  let cookie = await getSessionCookie(pageId, email, password);
  let res = await fetch(`https://steadfast.com.bd/user/consignment/${consignmentId}`, {
    headers: { Cookie: cookie },
  });
  let html = await res.text();

  if (isLoginPage(html)) {
    // Session expired — force a fresh login and retry once.
    sessionCache.delete(pageId);
    cookie = await getSessionCookie(pageId, email, password);
    res = await fetch(`https://steadfast.com.bd/user/consignment/${consignmentId}`, {
      headers: { Cookie: cookie },
    });
    html = await res.text();
  }

  if (isLoginPage(html)) {
    throw new Error("Could not log into Steadfast Moderator panel — check email/password");
  }

  return parseConsignmentHtml(html);
}

// Writes a new note onto an existing parcel — this is NOT an official
// API (Steadfast has none for this). Earlier versions of this function
// tried to reverse-engineer Steadfast's AJAX call directly (reading
// current field values via HTML scraping and re-POSTing them all) —
// that broke because some fields (District → Thana especially) are
// filled in by STEADFAST'S OWN JavaScript after the page loads, not
// present in the raw HTML at all, so guessing them wrong tripped
// Steadfast's anti-fraud checks ("permission to change amount", etc.).
//
// This version instead drives a REAL headless browser (Puppeteer) —
// logs in, opens the edit-parcel page exactly like a moderator would,
// lets Steadfast's own page JavaScript populate every field correctly,
// only TYPES into the note box, and clicks Submit. Slower and heavier
// than the old fetch-based approach, but far more reliable since
// nothing about District/Thana/amount is ever guessed — the real page
// handles all of it, same as a human clicking through it manually.
// The edit-parcel page is a Vue app: the form only exists after Steadfast's
// JS runs, but the raw page source carries the parcel's data as a
// `:consignment="{...}"` prop. Reading the CURRENT note from it lets us
// find the right textarea by its value, which survives layout changes.
function extractCurrentNote(rawHtml) {
  try {
    const m = rawHtml.match(/<edit-parcel[^>]*?:consignment="([^"]*)"/);
    if (!m) return null;
    const json = m[1]
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const note = JSON.parse(json).note;
    return typeof note === "string" ? note.trim() : null;
  } catch {
    return null;
  }
}

const puppeteer = require("puppeteer");

// Caches the LOGGED-IN BROWSER COOKIES per page_id (not a live browser —
// a fresh browser+page is still launched each call, but pre-loaded with
// saved cookies) so most calls can skip the slow email/password login
// flow entirely and jump straight to the edit-parcel page. Same 1-hour
// freshness window as the fetch-based session cache above.
const browserCookieCache = new Map(); // page_id -> { cookies, savedAt }
const BROWSER_SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

async function updateParcelNote(pageId, email, password, consignmentId, newNote) {
  if (!email || !password) {
    throw new Error("Steadfast Moderator credentials not set up for this page");
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    let editResp = null;
    const cached = browserCookieCache.get(pageId);
    const hasCachedSession = cached && Date.now() - cached.savedAt < BROWSER_SESSION_MAX_AGE_MS;

    if (hasCachedSession) {
      // Reuse the saved session — go straight to the target page,
      // skipping the login form entirely.
      // Strip partitionKey before restoring — some Puppeteer/Chrome
      // version combinations save it in a shape that Network.setCookies
      // can't deserialize back (a known compatibility issue), causing a
      // "CBOR: map start expected" protocol error.
      const restorable = cached.cookies.map(({ partitionKey, ...rest }) => rest);
      await page.setCookie(...restorable);
      editResp = await page.goto(`https://steadfast.com.bd/user/edit-parcel/${consignmentId}`, { waitUntil: "networkidle2" });
    }

    // Either there was no cached session, or the cached one turned out
    // to be expired/invalid (Steadfast bounced us back to /login) — do
    // a real login and save fresh cookies for next time.
    if (!hasCachedSession || page.url().includes("/login")) {
      // ---- Step 1: log in exactly like a human moderator would ----
      // IMPORTANT: stays on the non-www domain throughout — logging in
      // on www.steadfast.com.bd and then visiting steadfast.com.bd (no
      // www) for the edit page is what caused the session cookie to not
      // carry over (browsers treat www vs non-www as different origins
      // for cookies unless the site explicitly sets Domain=.steadfast.com.bd).
      await page.goto("https://steadfast.com.bd/moderator/login", { waitUntil: "networkidle2" });
      await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 15000 });
      await page.type('input[name="email"], input[type="email"]', email, { delay: 20 });
      await page.type('input[name="password"], input[type="password"]', password, { delay: 20 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click('button[type="submit"], input[type="submit"]'),
      ]);

      if (page.url().includes("/login")) {
        const bodySnippet = await page
          .evaluate(() => document.body.innerText.slice(0, 300))
          .catch(() => "(could not read page text)");
        throw new Error(
          `লগইন ব্যর্থ — এখনো লগইন পেজেই আছে (${page.url()}). পেজের টেক্সট: ${bodySnippet}`
        );
      }

      // Save the fresh session for next time.
      const freshCookies = await page.cookies();
      browserCookieCache.set(pageId, { cookies: freshCookies, savedAt: Date.now() });

      // ---- Step 2: open the real edit-parcel page ----
      editResp = await page.goto(`https://steadfast.com.bd/user/edit-parcel/${consignmentId}`, { waitUntil: "networkidle2" });
    }

    // Give the page a moment to finish rendering/populating before we
    // search it — networkidle2 above covers network activity, but
    // client-side JS layout can still lag slightly behind that.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // The "Note" and "Item Description" boxes share the exact same
    // placeholder text ("Type Note"), so an id/placeholder-based
    // selector risks landing in the wrong one. Instead, search the page
    // for whichever label/heading text says exactly "Note" (not "Item
    // Description"), find the textarea associated with THAT label, and
    // tag it with a temporary marker attribute so Puppeteer can target
    // it precisely.
    let currentNote = null;
    try {
      currentNote = editResp ? extractCurrentNote(await editResp.text()) : null;
    } catch {
      currentNote = null;
    }

    const found = await page.evaluate((currentNote) => {
      // Strategy 1 (most reliable): the textarea whose value equals the
      // parcel's current note — exactly one match means it's the right box.
      if (currentNote) {
        const matches = Array.from(document.querySelectorAll("textarea")).filter(
          (ta) => (ta.value || "").trim() === currentNote
        );
        if (matches.length === 1) {
          matches[0].setAttribute("data-claude-note-target", "true");
          return { ok: true };
        }
      }
      const isNoteLabel = (text) => {
        const t = (text || "").trim().toLowerCase();
        return t === "note" || t.startsWith("note ") || t.startsWith("note(") || t.startsWith("note:");
      };
      const labelNodes = Array.from(document.querySelectorAll("label, p, span, div, h1, h2, h3, h4, h5, h6"));
      const noteLabel = labelNodes.find((el) => isNoteLabel(el.textContent) && el.children.length === 0);
      if (!noteLabel) return { ok: false, reason: "no label matching exactly 'Note' was found" };

      // Use actual on-screen position, not DOM nesting — the textarea we
      // want is the one that sits visually BELOW this "Note" label
      // (Item Description's own textarea sits ABOVE it, per how the
      // page is laid out), specifically the CLOSEST one below it.
      const labelRect = noteLabel.getBoundingClientRect();
      const textareas = Array.from(document.querySelectorAll("textarea"));
      let best = null;
      let bestDistance = Infinity;
      for (const ta of textareas) {
        const taRect = ta.getBoundingClientRect();
        const verticalGap = taRect.top - labelRect.top;
        if (verticalGap >= 0 && verticalGap < bestDistance) {
          bestDistance = verticalGap;
          best = ta;
        }
      }
      if (!best) return { ok: false, reason: "found the 'Note' label but no textarea positioned below it" };

      best.setAttribute("data-claude-note-target", "true");
      return { ok: true };
    }, currentNote);

    if (!found.ok) {
      const stuckUrl = page.url();
      const bodySnippet = await page
        .evaluate(() => document.body.innerText.slice(0, 400))
        .catch(() => "(could not read page text)");
      throw new Error(
        `সঠিক Note বক্স খুঁজে পাওয়া যায়নি (${found.reason})। URL: ${stuckUrl} | পেজের টেক্সট: ${bodySnippet}`
      );
    }

    const noteSelector = '[data-claude-note-target="true"]';
    await page.waitForSelector(noteSelector, { timeout: 5000 });

    // Give Steadfast's own JS a moment to finish populating
    // District/Thana/amount from the parcel's real data before we touch
    // anything — we're not filling these in ourselves, just waiting for
    // the page to be fully ready like it would be for a human.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ---- Step 3: type ONLY into the confirmed Note box ----
    await page.click(noteSelector, { clickCount: 3 }); // select any existing text
    await page.keyboard.press("Backspace");
    await page.type(noteSelector, newNote.slice(0, 500), { delay: 15 });

    // ---- Step 4: submit, exactly the button a moderator would click ----
    // The submit button's exact selector isn't confirmed — try a few
    // reasonable matches in order rather than guessing just one.
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const target = candidates.find((el) => {
        const text = (el.innerText || el.value || "").trim().toLowerCase();
        return text.includes("submit") || text.includes("update") || text.includes("save");
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    if (!clicked) {
      throw new Error("নোট-এর Submit বাটন খুঁজে পাওয়া যায়নি (Steadfast হয়তো পেজের গঠন বদলেছে)");
    }

    // ---- Step 5: confirm it actually went through ----
    // Steadfast shows a "successful update" toast/message after submit,
    // without navigating away — wait briefly for that confirmation text.
    let confirmed = false;
    try {
      await page.waitForFunction(
        () => document.body.innerText.toLowerCase().includes("successful"),
        { timeout: 8000 }
      );
      confirmed = true;
    } catch {
      confirmed = false;
    }

    if (!confirmed) {
      // Not necessarily a failure — Steadfast's confirmation wording
      // might differ from what we searched for — but we can't claim
      // success we didn't actually verify.
      throw new Error("নোট পাঠানো হয়েছে কিনা নিশ্চিত করা যায়নি — Steadfast-এর নিশ্চিতকরণ বার্তা খুঁজে পাওয়া যায়নি");
    }

    return { success: true };
  } finally {
    await browser.close();
  }
}

module.exports = { getConsignmentTracking, updateParcelNote, getPendingParcels, parsePendingListHtml };
