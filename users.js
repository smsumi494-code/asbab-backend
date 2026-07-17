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
      "SELECT id, phone, name, role, active, allowed_groups, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        name: r.name,
        role: r.role,
        active: r.active,
        allowedGroups: r.allowed_groups || null,
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load users" });
  }
});

// POST /api/users — add a new admin or moderator (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { phone, password, name, role, allowedGroups } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password required" });
  }
  if (!["admin", "moderator"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or moderator" });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (phone, password_hash, name, role, active, allowed_groups)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, phone, name, role, active, allowed_groups, created_at`,
      [phone, hash, name || "", role, allowedGroups && allowedGroups.length ? allowedGroups : null]
    );
    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      phone: row.phone,
      name: row.name,
      role: row.role,
      active: row.active,
      allowedGroups: row.allowed_groups || null,
      createdAt: row.created_at,
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "This phone number is already added" });
    }
    console.error(err);
    res.status(500).json({ error: "Could not add user" });
  }
});

// PATCH /api/users/:id — activate/deactivate, and/or update which groups
// this moderator is allowed to see (admin only). Sending allowedGroups as
// an empty array means "no groups at all" (fully locked out of every
// group); omitting it leaves the current setting untouched.
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { active, allowedGroups } = req.body;

  const sets = [];
  const values = [];
  if (active !== undefined) {
    sets.push(`active = $${values.length + 1}`);
    values.push(active);
  }
  if (allowedGroups !== undefined) {
    sets.push(`allowed_groups = $${values.length + 1}`);
    values.push(allowedGroups === null ? null : allowedGroups);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${values.length + 1}
       RETURNING id, phone, name, role, active, allowed_groups, created_at`,
      [...values, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const row = result.rows[0];
    res.json({
      id: row.id,
      phone: row.phone,
      name: row.name,
      role: row.role,
      active: row.active,
      allowedGroups: row.allowed_groups || null,
      createdAt: row.created_at,
    });
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
