// users.js — admin adds/manages Admin & Moderator accounts.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const bcrypt = require("bcryptjs");
const { requireAuth, requireAdmin } = require("./auth");

// GET /api/users — list all admins/moderators (admin only)
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, phone, name, role, active, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load users" });
  }
});

// POST /api/users — add a new admin or moderator (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { phone, password, name, role } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password required" });
  }
  if (!["admin", "moderator"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or moderator" });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (phone, password_hash, name, role, active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, phone, name, role, active, created_at`,
      [phone, hash, name || "", role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "This phone number is already added" });
    }
    console.error(err);
    res.status(500).json({ error: "Could not add user" });
  }
});

// PATCH /api/users/:id — activate/deactivate (admin only)
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  try {
    const result = await pool.query(
      "UPDATE users SET active = $1 WHERE id = $2 RETURNING id, phone, name, role, active, created_at",
      [active, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update user" });
  }
});

// DELETE /api/users/:id (admin only)
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete user" });
  }
});

module.exports = router;
