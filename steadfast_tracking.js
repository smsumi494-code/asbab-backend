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
function parseConsignmentHtml(html) {
  const $ = cheerio.load(html);

  // Rider name — the visible text is inside a <small> that also contains
  // a "Rate Me" link; strip the link's text to get just the name.
  const riderNameEl = $(".rider-info .rider-name small.txt-black").first().clone();
  riderNameEl.find("a").remove();
  const riderName = riderNameEl.text().trim() || null;

  const riderPhone = $(".rider-info .cell span").first().text().trim() || null;

  const status = $(".parcel-short-info label.alert, .parcel-information label.alert").first().text().trim() || null;

  // COD amount — shown as "COD: ৳ 2230" in an <h6>, no reliable unique
  // class, so match by its text content instead.
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

  // Customer details — each is a <p><small>Label :</small> <span>Value</span></p>
  const clientInfo = {};
  $(".client-info p").each((_, el) => {
    const label = $(el)
      .find("small")
      .first()
      .text()
      .replace(/\s*:\s*$/, "")
      .trim();
    const value = $(el).find("span").first().text().replace(/\s+/g, " ").trim();
    if (label) clientInfo[label] = value;
  });
  const customerName = clientInfo["Name"] || null;
  const customerAddress = clientInfo["Address"] || null;
  const customerPhone = clientInfo["Phone Number"] || null;
  const customerAltPhone =
    clientInfo["Alternative Number"] && clientInfo["Alternative Number"] !== "N/A" ? clientInfo["Alternative Number"] : null;
  const customerPoliceStation = clientInfo["Policestation"] || null;

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
    riderName,
    riderPhone,
    status,
    codAmount,
    deliveryCharge,
    customerName,
    customerAddress,
    customerPhone,
    customerAltPhone,
    customerPoliceStation,
    trackingSteps,
  };
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

  if (html.includes("Moderator Login")) {
    // Session expired — force a fresh login and retry once.
    sessionCache.delete(pageId);
    cookie = await getSessionCookie(pageId, email, password);
    res = await fetch(`https://steadfast.com.bd/user/consignment/${consignmentId}`, {
      headers: { Cookie: cookie },
    });
    html = await res.text();
  }

  if (html.includes("Moderator Login")) {
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
      await page.goto(`https://steadfast.com.bd/user/edit-parcel/${consignmentId}`, { waitUntil: "networkidle2" });
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
      await page.waitForSelector('input[name="email"]', { timeout: 15000 });
      await page.type('input[name="email"]', email, { delay: 20 });
      await page.type('input[name="password"]', password, { delay: 20 });
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
      await page.goto(`https://steadfast.com.bd/user/edit-parcel/${consignmentId}`, { waitUntil: "networkidle2" });
    }

    try {
      await page.waitForSelector("#note", { timeout: 15000 });
    } catch {
      // Capture exactly what page we're actually stuck on, so the next
      // failure tells us whether login silently failed, Cloudflare
      // blocked us, or the note field's id is simply something else now.
      const stuckUrl = page.url();
      const bodySnippet = await page
        .evaluate(() => document.body.innerText.slice(0, 400))
        .catch(() => "(could not read page text)");
      throw new Error(
        `#note খুঁজে পাওয়া যায়নি। বর্তমান URL: ${stuckUrl} | পেজের টেক্সট: ${bodySnippet}`
      );
    }

    // Give Steadfast's own JS a moment to finish populating
    // District/Thana/amount from the parcel's real data before we touch
    // anything — we're not filling these in ourselves, just waiting for
    // the page to be fully ready like it would be for a human.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // ---- Step 3: type ONLY into the note box ----
    await page.click("#note", { clickCount: 3 }); // select any existing text
    await page.keyboard.press("Backspace");
    await page.type("#note", newNote.slice(0, 500), { delay: 15 });

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

module.exports = { getConsignmentTracking, updateParcelNote };
