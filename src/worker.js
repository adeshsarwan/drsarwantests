// Dr. Sarwan Diagnostic Labs – booking backend
// Cloudflare Worker + D1. Static site is served from ./public via the ASSETS binding.

const SLOT_START_MIN = 6 * 60;    // 06:00
const SLOT_END_MIN = 11 * 60;     // last slot ends at 11:00
const SLOT_LEN_MIN = 30;
const BOOK_DAYS_AHEAD = 14;       // how far ahead people can book
const MIN_LEAD_MIN = 180;         // a slot must start at least 3 hours from now
const HOLD_MIN = 120;             // unpaid bookings are marked expired after this (they never hold a slot)
const IST_OFFSET_MIN = 330;       // UTC+05:30

// Statuses that occupy a slot. An unpaid ("pending") booking does NOT hold the slot.
const ACTIVE = ["payment_submitted", "confirmed", "collected", "blocked"];
const ADMIN_SETTABLE = ["payment_submitted", "confirmed", "collected", "cancelled"];

export const SLOTS = (() => {
  const out = [];
  for (let m = SLOT_START_MIN; m + SLOT_LEN_MIN <= SLOT_END_MIN; m += SLOT_LEN_MIN) out.push(hhmm(m));
  return out;
})();

function hhmm(m) {
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
function slotLabel(s) {
  const [h, m] = s.split(":").map(Number);
  const end = h * 60 + m + SLOT_LEN_MIN;
  const f = (x) => {
    const hh = Math.floor(x / 60), mm = x % 60, ap = hh >= 12 ? "PM" : "AM";
    return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
  };
  return `${f(h * 60 + m)} – ${f(end)}`;
}

// ---- time helpers (all business logic in IST) ----
function nowUtc() { return new Date(); }
function istParts(d = nowUtc()) {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return { date: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function slotStartUtc(date, slot) {
  // IST wall clock -> UTC instant
  return new Date(Date.parse(`${date}T${slot}:00Z`) - IST_OFFSET_MIN * 60000);
}
function isBookable(date, slot, now = nowUtc()) {
  if (!SLOTS.includes(slot)) return false;
  const today = istParts(now).date;
  if (date < today || date > addDays(today, BOOK_DAYS_AHEAD)) return false;
  return slotStartUtc(date, slot).getTime() - now.getTime() >= MIN_LEAD_MIN * 60000;
}
function isoNow() { return new Date().toISOString(); }
function prettyDate(d) {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// ---- utils ----
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);

function randId(len, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789") {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
function clean(v, max = 300) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function normPhone(p) {
  const d = String(p ?? "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}
function safeEqual(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function amount(env) { return parseInt(env.PRICE_INR || "1899", 10); }

// Create tables automatically on first use (same as migrations/0001_bookings.sql).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, token TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL,
    name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, pincode TEXT NOT NULL, city TEXT, state TEXT, cycle TEXT, notes TEXT,
    amount INTEGER NOT NULL, status TEXT NOT NULL, utr TEXT, source TEXT, created_at TEXT NOT NULL, expires_at TEXT,
    paid_at TEXT, updated_at TEXT NOT NULL)`,
  `DROP INDEX IF EXISTS one_booking_per_slot`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_paid_booking_per_slot ON bookings(date, slot)
    WHERE status IN ('payment_submitted', 'confirmed', 'collected', 'blocked')`,
  `CREATE INDEX IF NOT EXISTS bookings_by_date ON bookings(date, slot)`,
  `CREATE INDEX IF NOT EXISTS bookings_by_status ON bookings(status)`,
  `CREATE TABLE IF NOT EXISTS payment_proofs (booking_id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)`,
];
let schemaReady = null;
const UPGRADES = ["ALTER TABLE bookings ADD COLUMN city TEXT", "ALTER TABLE bookings ADD COLUMN state TEXT"];
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
      for (const q of UPGRADES) {
        try { await env.DB.prepare(q).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
      }
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function expireHolds(env) {
  await env.DB.prepare("UPDATE bookings SET status='expired', updated_at=?1 WHERE status='pending' AND expires_at < ?1")
    .bind(isoNow()).run();
}

// ---- PIN code → city / state (India Post data via api.postalpincode.in, cached 30 days) ----
async function pincodeLookup(pin, ctx) {
  const cache = caches.default;
  const key = new Request(`https://pincode.cache/${pin}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  let out = { pincode: pin, found: false };
  try {
    const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { cf: { cacheTtl: 86400 } });
    const j = await r.json();
    const offices = (j && j[0] && j[0].PostOffice) || [];
    if (offices.length) {
      const o = offices[0];
      out = { pincode: pin, found: true, city: o.District || o.Block || "", state: o.State || "",
        areas: [...new Set(offices.map((x) => x.Name))].slice(0, 25) };
    }
  } catch (e) { console.log("pincode lookup failed", String(e)); }
  const res = json(out, 200, { "cache-control": "public, max-age=2592000" });
  if (out.found && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---- public API ----
async function getSlots(env, url) {
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Invalid date");
  await expireHolds(env);
  const { results } = await env.DB.prepare(
    `SELECT slot FROM bookings WHERE date=?1 AND status IN (${ACTIVE.map(() => "?").join(",")})`
  ).bind(date, ...ACTIVE).all();
  const taken = new Set(results.map((r) => r.slot));
  return json({
    date,
    slots: SLOTS.map((s) => ({ time: s, label: slotLabel(s), available: !taken.has(s) && isBookable(date, s) })),
  });
}

function getConfig(env) {
  const today = istParts().date;
  const dates = [];
  for (let i = 0; i <= BOOK_DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    if (SLOTS.some((s) => isBookable(d, s))) dates.push(d);
  }
  return json({
    amount: amount(env),
    upiId: env.UPI_ID || "",
    upiName: env.UPI_NAME || "Dr. Sarwan Diagnostic Labs",
    upiQr: env.UPI_QR_STRING || "",
    mapsKey: env.GOOGLE_MAPS_KEY || "",
    holdMinutes: HOLD_MIN,
    dates,
  });
}

async function createBooking(env, req) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  if (b.website) return json({ ok: true }); // honeypot: silently ignore bots
  const name = clean(b.name, 80), address = clean(b.address, 300), pincode = clean(b.pincode, 6);
  const city = clean(b.city, 60), state = clean(b.state, 40);
  const phone = normPhone(b.phone), date = clean(b.date, 10), slot = clean(b.slot, 5);
  if (name.length < 2) return bad("Please enter the patient's name.");
  if (!phone) return bad("Please enter a valid 10-digit mobile number.");
  if (address.length < 8) return bad("Please enter the full address for sample collection.");
  if (!/^\d{6}$/.test(pincode)) return bad("Please enter a valid 6-digit pincode.");
  if (city.length < 2) return bad("Please enter your city / town.");
  if (state.length < 2) return bad("Please enter your state.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isBookable(date, slot)) return bad("That slot is no longer available. Please pick another.", 409);

  await expireHolds(env);
  const taken = await env.DB.prepare(
    `SELECT 1 FROM bookings WHERE date=?1 AND slot=?2 AND status IN (${ACTIVE.map((_, i) => "?" + (i + 3)).join(",")}) LIMIT 1`
  ).bind(date, slot, ...ACTIVE).first();
  if (taken) return bad("Sorry, that slot has just been booked. Please pick another.", 409);
  const id = "DSL-" + randId(6), token = randId(24, "abcdefghijklmnopqrstuvwxyz0123456789");
  const now = isoNow(), expires = new Date(Date.now() + HOLD_MIN * 60000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, token, date, slot, name, phone, address, pincode, city, state, cycle, notes, amount, status, source, created_at, expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?15, ?16, ?9, ?10, ?11, 'pending', ?12, ?13, ?14, ?13)`
    ).bind(id, token, date, slot, name, phone, address, pincode, clean(b.cycle, 60), clean(b.notes, 300),
      amount(env), clean(b.source, 300), now, expires, city, state).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("Sorry, someone just booked that slot. Please pick another.", 409);
    throw e;
  }
  return json({ id, token, date, dateLabel: prettyDate(date), slot, slotLabel: slotLabel(slot), amount: amount(env), expiresAt: expires,
    upiId: env.UPI_ID || "", upiName: env.UPI_NAME || "Dr. Sarwan Diagnostic Labs", upiQr: env.UPI_QR_STRING || "" }, 201);
}

const MAX_SHOT_CHARS = 1_400_000; // ~1 MB image after base64; the browser compresses before upload

async function submitPayment(env, req, id, ctx) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  const utr = String(b.utr || "").replace(/\s/g, "");
  if (utr && !/^[A-Za-z0-9]{10,22}$/.test(utr)) return bad("That doesn't look like a UPI transaction ID. You can leave it empty and just upload the screenshot.");
  let shot = null;
  if (b.screenshot) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.screenshot));
    if (!m) return bad("Please upload the screenshot as an image (JPG or PNG).");
    if (m[2].length > MAX_SHOT_CHARS) return bad("That image is too large. Please upload a screenshot instead of a photo.");
    shot = { mime: m[1], data: m[2] };
  }
  if (!shot && !utr) return bad("Please upload your payment screenshot.");
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!row || !safeEqual(row.token, b.token)) return bad("Booking not found.", 404);
  if (row.status === "cancelled") return bad("This booking was cancelled. Please make a new booking.", 409);

  const now = isoNow();
  const saveProof = async () => {
    if (shot) await env.DB.prepare(
      "INSERT INTO payment_proofs (booking_id, mime, data, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(booking_id) DO UPDATE SET mime=excluded.mime, data=excluded.data, created_at=excluded.created_at"
    ).bind(id, shot.mime, shot.data, now).run();
  };
  if (["payment_submitted", "confirmed", "collected"].includes(row.status)) {
    // already submitted: allow adding / replacing the screenshot or UTR
    await saveProof();
    if (utr) await env.DB.prepare("UPDATE bookings SET utr=?1, updated_at=?2 WHERE id=?3").bind(utr, now, id).run();
    return json({ ok: true, status: row.status, id, dateLabel: prettyDate(row.date), slotLabel: slotLabel(row.slot) });
  }
  // Save the payment proof first, so it is never lost even if the slot was taken meanwhile.
  await saveProof();
  if (utr) await env.DB.prepare("UPDATE bookings SET utr=?1, updated_at=?2 WHERE id=?3").bind(utr, now, id).run();
  try {
    const r = await env.DB.prepare(
      "UPDATE bookings SET status='payment_submitted', paid_at=?1, updated_at=?1 WHERE id=?2 AND status IN ('pending','expired')"
    ).bind(now, id).run();
    if (!r.meta.changes) return bad("Could not update this booking.", 409);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return slotTaken(row);
    throw e;
  }
  return json({ ok: true, status: "payment_submitted", id, date: row.date, dateLabel: prettyDate(row.date), slotLabel: slotLabel(row.slot) });
}

function slotTaken(row) {
  return json({
    error: `Sorry, ${slotLabel(row.slot)} on ${prettyDate(row.date)} was just booked by someone else. Your payment is saved. Please pick another slot.`,
    code: "slot_taken", id: row.id, date: row.date,
  }, 409);
}

// Customer has paid but their slot was taken: move the booking to a new free slot.
async function reslot(env, req, id) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  const date = clean(b.date, 10), slot = clean(b.slot, 5);
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!row || !safeEqual(row.token, b.token)) return bad("Booking not found.", 404);
  if (!["pending", "expired"].includes(row.status)) return bad("This booking is already confirmed.", 409);
  const proof = await env.DB.prepare("SELECT 1 FROM payment_proofs WHERE booking_id=?1").bind(id).first();
  if (!proof && !row.utr) return bad("Please upload your payment screenshot first.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isBookable(date, slot)) return bad("That slot is not available. Please pick another.", 409);
  const now = isoNow();
  try {
    const r = await env.DB.prepare(
      "UPDATE bookings SET date=?1, slot=?2, status='payment_submitted', paid_at=?3, updated_at=?3 WHERE id=?4 AND status IN ('pending','expired')"
    ).bind(date, slot, now, id).run();
    if (!r.meta.changes) return bad("Could not update this booking.", 409);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return slotTaken({ ...row, date, slot });
    throw e;
  }
  return json({ ok: true, status: "payment_submitted", id, date, dateLabel: prettyDate(date), slot, slotLabel: slotLabel(slot) });
}

// ---- admin API ----
function isAdmin(env, req) {
  const want = String(env.ADMIN_PASSWORD || "").trim();
  return !!want && safeEqual(String(req.headers.get("x-admin-key") || "").trim(), want);
}

async function adminList(env, url) {
  await expireHolds(env);
  const today = istParts().date;
  const from = url.searchParams.get("from") || today;
  const to = url.searchParams.get("to") || addDays(today, BOOK_DAYS_AHEAD);
  const includeInactive = url.searchParams.get("all") === "1";
  const { results } = await env.DB.prepare(
    `SELECT id, date, slot, name, phone, address, pincode, city, state, cycle, notes, amount, status, utr, source, created_at, paid_at, updated_at,
       EXISTS(SELECT 1 FROM payment_proofs p WHERE p.booking_id = bookings.id) AS has_proof
     FROM bookings WHERE date BETWEEN ?1 AND ?2 ${includeInactive ? "" : "AND status NOT IN ('expired')"}
     ORDER BY date, slot, created_at`
  ).bind(from, to).all();
  return json({ from, to, slots: SLOTS.map((s) => ({ time: s, label: slotLabel(s) })), bookings: results });
}

// Phone / walk-in booking created by the admin. No lead-time limit; still one paid booking per slot.
async function adminCreate(env, req) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  const name = clean(b.name, 80), address = clean(b.address, 300), pincode = clean(b.pincode, 6);
  const city = clean(b.city, 60), state = clean(b.state, 40), date = clean(b.date, 10), slot = clean(b.slot, 5);
  const phone = normPhone(b.phone);
  const status = ["confirmed", "payment_submitted", "pending"].includes(b.status) ? b.status : "confirmed";
  if (name.length < 2) return bad("Enter the patient's name.");
  if (!phone) return bad("Enter a valid 10-digit mobile number.");
  if (address.length < 4) return bad("Enter the collection address.");
  if (!/^\d{6}$/.test(pincode)) return bad("Enter a valid 6-digit pincode.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !SLOTS.includes(slot)) return bad("Pick a date and slot.");
  const id = "DSL-" + randId(6), token = randId(24, "abcdefghijklmnopqrstuvwxyz0123456789"), now = isoNow();
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, token, date, slot, name, phone, address, pincode, city, state, cycle, notes, amount, status, source, created_at, paid_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'admin', ?15, ?16, ?15)`
    ).bind(id, token, date, slot, name, phone, address, pincode, city, state, clean(b.cycle, 60), clean(b.notes, 300),
      amount(env), status, now, status === "pending" ? null : now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("That slot already has a booking.", 409);
    throw e;
  }
  return json({ ok: true, id }, 201);
}

// Move a booking to another slot (reschedule).
async function adminMove(env, req, id) {
  const { date, slot } = await req.json().catch(() => ({}));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !SLOTS.includes(slot)) return bad("Pick a date and slot.");
  try {
    const r = await env.DB.prepare("UPDATE bookings SET date=?1, slot=?2, updated_at=?3 WHERE id=?4 AND status NOT IN ('blocked','cancelled')")
      .bind(date, slot, isoNow(), id).run();
    if (!r.meta.changes) return bad("Booking not found", 404);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("That slot already has a booking.", 409);
    throw e;
  }
  return json({ ok: true });
}

async function adminScreenshot(env, id) {
  const p = await env.DB.prepare("SELECT mime, data FROM payment_proofs WHERE booking_id=?1").bind(id).first();
  if (!p) return bad("No screenshot for this booking", 404);
  const bin = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { "content-type": p.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

async function adminSetStatus(env, req, id) {
  const { status } = await req.json().catch(() => ({}));
  if (!ADMIN_SETTABLE.includes(status)) return bad("Invalid status");
  try {
    const r = await env.DB.prepare("UPDATE bookings SET status=?1, updated_at=?2 WHERE id=?3 AND status != 'blocked'")
      .bind(status, isoNow(), id).run();
    if (!r.meta.changes) return bad("Booking not found", 404);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("That slot is already taken by another booking.", 409);
    throw e;
  }
  return json({ ok: true });
}

async function adminBlock(env, req) {
  const { date, slot, block } = await req.json().catch(() => ({}));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !SLOTS.includes(slot)) return bad("Invalid date or slot");
  const now = isoNow();
  if (block === false) {
    await env.DB.prepare("DELETE FROM bookings WHERE date=?1 AND slot=?2 AND status='blocked'").bind(date, slot).run();
    return json({ ok: true });
  }
  await expireHolds(env);
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, token, date, slot, name, phone, address, pincode, amount, status, created_at, updated_at)
       VALUES (?1, '-', ?2, ?3, 'Blocked', '-', '-', '-', 0, 'blocked', ?4, ?4)`
    ).bind("BLK-" + randId(6), date, slot, now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("That slot already has a booking.", 409);
    throw e;
  }
  return json({ ok: true });
}

async function adminCsv(env, url) {
  const today = istParts().date;
  const from = url.searchParams.get("from") || addDays(today, -30);
  const to = url.searchParams.get("to") || addDays(today, BOOK_DAYS_AHEAD);
  const { results } = await env.DB.prepare(
    "SELECT id,date,slot,status,name,phone,address,pincode,city,state,cycle,notes,amount,utr,CASE WHEN EXISTS(SELECT 1 FROM payment_proofs p WHERE p.booking_id=bookings.id) THEN 'yes' ELSE 'no' END AS screenshot,source,created_at,paid_at FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status!='blocked' ORDER BY date, slot"
  ).bind(from, to).all();
  const cols = ["id", "date", "slot", "status", "name", "phone", "address", "pincode", "city", "state", "cycle", "notes", "amount", "utr", "screenshot", "source", "created_at", "paid_at"];
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="bookings_${from}_to_${to}.csv"`, "cache-control": "no-store" } });
}

// ---- router ----
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) {
        if (!env.DB) return bad("Database not configured", 503);
        await ensureSchema(env);
        if (p === "/api/config" && req.method === "GET") return getConfig(env);
        if (p === "/api/slots" && req.method === "GET") return getSlots(env, url);
        let pm = p.match(/^\/api\/pincode\/(\d{6})$/);
        if (pm && req.method === "GET") return pincodeLookup(pm[1], ctx);
        if (p === "/api/bookings" && req.method === "POST") return createBooking(env, req);
        let m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/paid$/);
        if (m && req.method === "POST") return submitPayment(env, req, m[1], ctx);
        m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/reslot$/);
        if (m && req.method === "POST") return reslot(env, req, m[1]);

        if (p.startsWith("/api/admin/")) {
          if (!String(env.ADMIN_PASSWORD || "").trim()) return bad("Admin password is not set up yet. In Cloudflare add ADMIN_PASSWORD as a Secret.", 503);
          if (!isAdmin(env, req)) return bad("Wrong password", 401);
          if (p === "/api/admin/bookings" && req.method === "GET") return adminList(env, url);
          if (p === "/api/admin/export.csv" && req.method === "GET") return adminCsv(env, url);
          if (p === "/api/admin/block" && req.method === "POST") return adminBlock(env, req);
          if (p === "/api/admin/bookings" && req.method === "POST") return adminCreate(env, req);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/screenshot$/);
          if (m && req.method === "GET") return adminScreenshot(env, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/move$/);
          if (m && req.method === "POST") return adminMove(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/status$/);
          if (m && req.method === "POST") return adminSetStatus(env, req, m[1]);
        }
        return bad("Not found", 404);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.log("error", p, String(e && e.stack || e));
      return bad("Something went wrong. Please call 8368143677 to book.", 500);
    }
  },
};
