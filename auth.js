// auth.js — login endpoint + middleware for checking who's logged in.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "please-set-a-real-secret";

// Simple in-memory brute-force guard: max 5 attempts per phone number per
// 15 minutes. Resets automatically after the window passes.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(phone) {
  const record = loginAttempts.get(phone);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    loginAttempts.delete(phone);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(phone) {
  const record = loginAttempts.get(phone);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    loginAttempts.set(phone, { count: 1, first: Date.now() });
  } else {
    record.count += 1;
  }
}

function clearAttempts(phone) {
  loginAttempts.delete(phone);
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password required" });
  }

  if (isRateLimited(phone)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE phone = $1", [phone]);
    let user = result.rows[0];

    if (!user) {
      // First-ever login: if no users exist yet and these credentials match
      // the bootstrap admin variables set in Railway, create the first
      // admin account automatically.
      const countRes = await pool.query("SELECT COUNT(*)::int AS c FROM users");
      const noUsersYet = countRes.rows[0].c === 0;
      const bootstrapPhone = process.env.BOOTSTRAP_ADMIN_PHONE;
      const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

      if (
        noUsersYet &&
        bootstrapPhone &&
        bootstrapPassword &&
        phone === bootstrapPhone &&
        password === bootstrapPassword
      ) {
        const hash = await bcrypt.hash(password, 10);
        const created = await pool.query(
          `INSERT INTO users (phone, password_hash, name, role, active)
           VALUES ($1, $2, $3, 'admin', true) RETURNING *`,
          [phone, hash, "Admin"]
        );
        user = created.rows[0];
      } else {
        recordFailedAttempt(phone);
        return res.status(401).json({ error: "Invalid phone or password" });
      }
    } else {
      if (!user.active) {
        return res.status(403).json({ error: "This account is deactivated" });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        recordFailedAttempt(phone);
        return res.status(401).json({ error: "Invalid phone or password" });
      }
    }

    clearAttempts(phone);

    const token = jwt.sign(
      { sub: user.id, role: user.role, name: user.name, phone: user.phone },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, role: user.role, name: user.name, phone: user.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Requires a valid token (any role)
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

// Requires role === 'admin'
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admins only" });
  }
  next();
}

// Used by the SSE stream route, which can't send an Authorization header
// (EventSource doesn't support custom headers), so the token comes as a
// query parameter instead and is verified manually here.
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { router, requireAuth, requireAdmin, verifyToken };
