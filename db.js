// db.js — connects to Railway's Postgres using the DATABASE_URL env variable.
// Railway auto-creates DATABASE_URL when you add a Postgres service. You don't
// need to write this value yourself — just reference it (see .env.example).

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

module.exports = pool;
