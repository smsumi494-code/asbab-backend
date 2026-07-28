// chat.js — simple team chat (all moderators + admins in one shared
// room), with WhatsApp-style "reply to a specific message" support.
// Text only for now — images/video can be added later.
const express = require("express");
const router = express.Router();
const pool = require("./db");
const { requireAuth } = require("./auth");
const { broadcastRefresh } = require("./sse");

function toApiShape(row) {
  return {
    id: row.id,
    senderName: row.sender_name,
    senderPhone: row.sender_phone,
    senderProfilePictureUrl: row.sender_profile_picture_url || null,
    messageText: row.message_text,
    createdAt: row.created_at,
    replyTo: row.reply_to_id
      ? {
          id: row.reply_to_id,
          senderName: row.reply_sender_name,
          messageText: row.reply_message_text,
        }
      : null,
  };
}

// GET /api/chat/messages?limit=100 — any logged-in user (moderator or
// admin). Returns the most recent messages, oldest-first (ready to
// render top-to-bottom).
router.get("/messages", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const result = await pool.query(
      `SELECT cm.*, r.sender_name AS reply_sender_name, r.message_text AS reply_message_text,
              u.profile_picture_url AS sender_profile_picture_url
       FROM chat_messages cm
       LEFT JOIN chat_messages r ON r.id = cm.reply_to_id
       LEFT JOIN users u ON u.phone = cm.sender_phone
       ORDER BY cm.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows.reverse().map(toApiShape));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load chat messages" });
  }
});

// POST /api/chat/messages — send a message, optionally replying to an
// existing one (replyToId).
router.post("/messages", requireAuth, async (req, res) => {
  const { messageText, replyToId } = req.body;
  if (!messageText || !messageText.trim()) {
    return res.status(400).json({ error: "মেসেজ খালি রাখা যাবে না" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO chat_messages (sender_name, sender_phone, message_text, reply_to_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.name || req.user.phone, req.user.phone, messageText.trim(), replyToId || null]
    );
    const withReply = await pool.query(
      `SELECT cm.*, r.sender_name AS reply_sender_name, r.message_text AS reply_message_text,
              u.profile_picture_url AS sender_profile_picture_url
       FROM chat_messages cm
       LEFT JOIN chat_messages r ON r.id = cm.reply_to_id
       LEFT JOIN users u ON u.phone = cm.sender_phone
       WHERE cm.id = $1`,
      [result.rows[0].id]
    );
    broadcastRefresh();
    res.status(201).json(toApiShape(withReply.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "মেসেজ পাঠানো যায়নি" });
  }
});

module.exports = router;
