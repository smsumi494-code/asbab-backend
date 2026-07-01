-- Run this once to create the entries table.
-- On Railway: open your Postgres service -> "Query" tab -> paste this -> Run.

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  product_code TEXT,
  image_url TEXT,
  hata TEXT,
  long_size TEXT,
  tag TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  amount NUMERIC,
  moderator TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' or 'sent'
  consignment_id TEXT,
  tracking_code TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
