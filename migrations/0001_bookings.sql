-- Bookings for home sample collection. One active booking per (date, slot).
CREATE TABLE IF NOT EXISTS bookings (
  id            TEXT PRIMARY KEY,           -- short reference shown to customer, e.g. DSL-7K3Q9P
  token         TEXT NOT NULL,              -- secret the customer's browser uses to submit payment
  date          TEXT NOT NULL,              -- YYYY-MM-DD (IST)
  slot          TEXT NOT NULL,              -- HH:MM start time (IST), 30-minute slots
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  address       TEXT NOT NULL,
  pincode       TEXT NOT NULL,
  cycle         TEXT,
  notes         TEXT,
  amount        INTEGER NOT NULL,           -- rupees
  status        TEXT NOT NULL,              -- pending | payment_submitted | confirmed | collected | report_ready | completed | no_show | cancelled | expired | blocked
  utr           TEXT,                       -- UPI transaction reference entered by customer
  source        TEXT,                       -- utm / referrer info
  created_at    TEXT NOT NULL,
  expires_at    TEXT,                       -- payment hold expiry for pending bookings
  paid_at       TEXT,
  updated_at    TEXT NOT NULL,
  city TEXT, state TEXT,
  vial_no TEXT, collected_at TEXT,            -- tracker entered when the sample is collected
  report_name TEXT, report_size INTEGER, report_token TEXT, report_at TEXT, completed_at TEXT,
  fee_due INTEGER, fee_paid_at TEXT, missed_slot TEXT   -- "reached, patient unavailable" visit fee
);

-- Only one PAID booking can hold a slot. Unpaid (pending), expired and cancelled rows do not count.
CREATE UNIQUE INDEX IF NOT EXISTS slot_holder_v3
  ON bookings(date, slot)
  WHERE status IN ('payment_submitted', 'confirmed', 'collected', 'report_ready', 'completed', 'no_show', 'blocked');

CREATE INDEX IF NOT EXISTS bookings_by_date ON bookings(date, slot);
CREATE INDEX IF NOT EXISTS bookings_by_status ON bookings(status);

CREATE TABLE IF NOT EXISTS payment_proofs (booking_id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS report_chunks (booking_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (booking_id, idx));
CREATE TABLE IF NOT EXISTS msg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL);
-- (The Worker creates / upgrades all of this automatically; this file is for reference.)
