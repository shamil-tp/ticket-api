-- shamiltp.me Inquiry Ticket Pass — Cloudflare D1 (SQLite) Schema
-- Apply locally:  npx wrangler d1 execute shamiltp-tickets --local --file=./schema.sql
-- Apply remotely: npx wrangler d1 execute shamiltp-tickets --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id        TEXT PRIMARY KEY,
  access_token     TEXT NOT NULL UNIQUE,
  admin_token_hash TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'RECEIVED'
                   CHECK (status IN ('RECEIVED', 'AI_REPLIED', 'SHAMIL_REPLIED', 'CLOSED')),
  visitor_name     TEXT NOT NULL,
  masked_email     TEXT NOT NULL,
  masked_phone     TEXT,
  raw_email        TEXT NOT NULL,
  raw_phone        TEXT,
  submitted_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_access_token ON tickets(access_token);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at   ON tickets(created_at);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  sender      TEXT NOT NULL CHECK (sender IN ('VISITOR', 'AI', 'SHAMIL')),
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket_created ON messages(ticket_id, created_at ASC);