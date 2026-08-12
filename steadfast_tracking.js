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

// Reads a specific cookie's value out of a "k=v; k2=v2" cookie header
// string — used to mirror XSRF-TOKEN (set as a cookie) back as a
// request header, which is how Laravel's CSRF protection expects it.
function getCookieValue(cookieHeader, name) {
  const match = (cookieHeader || "")
    .split("; ")
    .find((pair) => pair.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

// Writes a new note onto an existing parcel — this is NOT an official
// API (Steadfast has none for this), it's the same AJAX call the
// Moderator Panel's "Edit Parcel" page itself makes when you click
// Submit, reverse-engineered from the browser's Network tab.
//
// IMPORTANT: this endpoint updates the WHOLE parcel record in one call
// — it's not "just change the note", it expects the other fields
// (name/phone/address/etc.) too. Sending them empty risks Steadfast
// overwriting real customer data with blanks. So this function first
// GETs the edit page to read the CURRENT values, then POSTs them all
// back unchanged except for the new note.
//
// This is more fragile than the read-only tracking scraper above: it
// also depends on a CSRF meta tag and an XSRF-TOKEN cookie that
// Laravel issues, and possibly Cloudflare bot-protection on top. If
// Steadfast changes their edit-parcel page, or Cloudflare starts
// challenging plain server-to-server requests here, this specific
// function is what breaks — not the rest of the app.
async function updateParcelNote(pageId, email, password, consignmentId, newNote) {
  if (!email || !password) {
    throw new Error("Steadfast Moderator credentials not set up for this page");
  }

  let cookie = await getSessionCookie(pageId, email, password);

  const fetchEditPage = async () =>
    fetch(`https://steadfast.com.bd/user/edit-parcel/${consignmentId}`, { headers: { Cookie: cookie } });

  let editRes = await fetchEditPage();
  let editHtml = await editRes.text();

  if (editHtml.includes("Moderator Login")) {
    sessionCache.delete(pageId);
    cookie = await getSessionCookie(pageId, email, password);
    editRes = await fetchEditPage();
    editHtml = await editRes.text();
  }
  if (editHtml.includes("Moderator Login")) {
    throw new Error("Could not log into Steadfast Moderator panel — check email/password");
  }

  // Any Set-Cookie from THIS page load (e.g. a fresh XSRF-TOKEN) also
  // needs folding into the cookie jar we send back.
  cookie = cookieHeaderFrom(extractSetCookies(editRes), cookie);

  const $ = cheerio.load(editHtml);

  // Laravel's usual CSRF meta tag: <meta name="csrf-token" content="...">
  const csrfToken = $('meta[name="csrf-token"]').attr("content") || "";
  const xsrfToken = getCookieValue(cookie, "XSRF-TOKEN") || "";

  // Read the CURRENT values straight out of the edit form so nothing
  // else gets accidentally wiped out — field ids are assumed to match
  // the payload key names (e.g. id="cus_phone" for the cus_phone field).
  const fieldVal = (id) => $(`#${id}`).val() || $(`#${id}`).attr("value") || "";

  const form = new FormData();
  form.append("consignment_id", String(consignmentId));
  form.append("cus_name", fieldVal("cus_name"));
  form.append("cus_phone", fieldVal("cus_phone"));
  form.append("cus_address", fieldVal("cus_address"));
  form.append("alt_phone", fieldVal("alt_phone"));
  form.append("email", fieldVal("email"));
  form.append("item_description", fieldVal("item_description"));
  form.append("invoice", fieldVal("invoice"));
  form.append("cod_amount", fieldVal("cod_amount") || "0");
  form.append("policestation_id", fieldVal("policestation_id"));
  form.append("pickup_address_id", fieldVal("pickup_address_id"));
  form.append("exchange", "false");
  form.append("note", newNote.slice(0, 500)); // Steadfast's own stated max

  const updateRes = await fetch("https://steadfast.com.bd/user/consignment/single/update", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-Csrf-Token": csrfToken,
      "X-Xsrf-Token": xsrfToken,
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://steadfast.com.bd/user/edit-parcel/${consignmentId}`,
    },
    body: form,
  });

  const resultText = await updateRes.text();
  if (!updateRes.ok) {
    throw new Error(`Steadfast note update failed (${updateRes.status}): ${resultText.slice(0, 200)}`);
  }
  return { success: true, raw: resultText.slice(0, 200) };
}

module.exports = { getConsignmentTracking, updateParcelNote };
