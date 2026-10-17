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
  status        TEXT NOT NULL,              -- pending | payment_submitted | confirmed | collected | cancelled | expired | blocked
  utr           TEXT,                       -- UPI transaction reference entered by customer
  source        TEXT,                       -- utm / referrer info
  created_at    TEXT NOT NULL,
  expires_at    TEXT,                       -- payment hold expiry for pending bookings
  paid_at       TEXT,
  updated_at    TEXT NOT NULL
);

-- Only one PAID booking can hold a slot. Unpaid (pending), expired and cancelled rows do not count.
CREATE UNIQUE INDEX IF NOT EXISTS one_paid_booking_per_slot
  ON bookings(date, slot)
  WHERE status IN ('payment_submitted', 'confirmed', 'collected', 'blocked');

CREATE INDEX IF NOT EXISTS bookings_by_date ON bookings(date, slot);
CREATE INDEX IF NOT EXISTS bookings_by_status ON bookings(status);
