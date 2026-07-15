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

  // Customer details — each is a <p><small>Label :</small> <span>Value</span></p>
  const clientInfo = {};
  $(".client-info p").each((_, el) => {
    const label = $(el).find("small").first().text().trim().replace(/:\s*$/, "");
    const value = $(el).find("span").first().text().trim();
    if (label) clientInfo[label] = value;
  });
  console.log("Tracking parse — client-info found:", JSON.stringify(clientInfo)); // temporary debug
  console.log("Tracking parse — .client-info p count:", $(".client-info p").length); // temporary debug
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

module.exports = { getConsignmentTracking };
