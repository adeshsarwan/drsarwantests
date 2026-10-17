// Dr. Sarwan Diagnostic Labs – booking backend
// Cloudflare Worker + D1. Static site is served from ./public via the ASSETS binding.

const SLOT_START_MIN = 6 * 60;    // 06:00
const SLOT_END_MIN = 11 * 60;     // last slot ends at 11:00
const SLOT_LEN_MIN = 30;
const BOOK_DAYS_AHEAD = 14;       // how far ahead people can book
const MIN_LEAD_MIN = 180;         // a slot must start at least 3 hours from now
const HOLD_MIN = 15;              // minutes a slot is held while the customer pays
const IST_OFFSET_MIN = 330;       // UTC+05:30

const ACTIVE = ["pending", "payment_submitted", "confirmed", "collected", "blocked"];
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
    name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, pincode TEXT NOT NULL, cycle TEXT, notes TEXT,
    amount INTEGER NOT NULL, status TEXT NOT NULL, utr TEXT, source TEXT, created_at TEXT NOT NULL, expires_at TEXT,
    paid_at TEXT, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot ON bookings(date, slot)
    WHERE status IN ('pending', 'payment_submitted', 'confirmed', 'collected', 'blocked')`,
  `CREATE INDEX IF NOT EXISTS bookings_by_date ON bookings(date, slot)`,
  `CREATE INDEX IF NOT EXISTS bookings_by_status ON bookings(status)`,
];
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function expireHolds(env) {
  await env.DB.prepare("UPDATE bookings SET status='expired', updated_at=?1 WHERE status='pending' AND expires_at < ?1")
    .bind(isoNow()).run();
}

// ---- WhatsApp alert to the lab ----
export function adminMessage(b) {
  return [
    "🩸 *New home test booking – payment submitted*",
    `Ref: ${b.id}`,
    `Slot: ${prettyDate(b.date)} · ${slotLabel(b.slot)}`,
    `Name: ${b.name}`,
    `Mobile: +91 ${b.phone}`,
    `Address: ${b.address}, ${b.pincode}`,
    b.cycle ? `Cycle: ${b.cycle}` : null,
    `Amount: Rs. ${b.amount}`,
    `UPI UTR: ${b.utr}`,
    "",
    "Please verify the payment in your UPI app, then mark it Confirmed in the admin page.",
  ].filter((x) => x !== null).join("\n");
}

async function notifyAdmin(env, text) {
  const to = String(env.WA_ADMIN_PHONE || "").replace(/\D/g, "");
  const tasks = [];
  if (to && env.WA_CLOUD_TOKEN && env.WA_CLOUD_PHONE_ID) {
    // Meta WhatsApp Cloud API. Free-form text only delivers inside a 24h customer-service window;
    // for reliable delivery set WA_CLOUD_TEMPLATE to an approved template with one {{1}} body parameter.
    const body = env.WA_CLOUD_TEMPLATE
      ? { messaging_product: "whatsapp", to, type: "template",
          template: { name: env.WA_CLOUD_TEMPLATE, language: { code: env.WA_CLOUD_TEMPLATE_LANG || "en" },
            components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\n+/g, " | ").slice(0, 1000) }] }] } }
      : { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
    tasks.push(fetch(`https://graph.facebook.com/v21.0/${env.WA_CLOUD_PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.WA_CLOUD_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  } else if (to && env.CALLMEBOT_APIKEY) {
    // CallMeBot: free alerts to your own WhatsApp number (see README for the one-time activation).
    const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent("+" + to)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.CALLMEBOT_APIKEY)}`;
    tasks.push(fetch(u));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.log("whatsapp notify failed", String(r.reason));
    else if (!r.value.ok) console.log("whatsapp notify http", r.value.status, (await r.value.text()).slice(0, 300));
  }
  return tasks.length > 0;
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
    holdMinutes: HOLD_MIN,
    dates,
  });
}

async function createBooking(env, req) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  if (b.website) return json({ ok: true }); // honeypot: silently ignore bots
  const name = clean(b.name, 80), address = clean(b.address, 300), pincode = clean(b.pincode, 6);
  const phone = normPhone(b.phone), date = clean(b.date, 10), slot = clean(b.slot, 5);
  if (name.length < 2) return bad("Please enter the patient's name.");
  if (!phone) return bad("Please enter a valid 10-digit mobile number.");
  if (address.length < 8) return bad("Please enter the full address for sample collection.");
  if (!/^\d{6}$/.test(pincode)) return bad("Please enter a valid 6-digit pincode.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isBookable(date, slot)) return bad("That slot is no longer available. Please pick another.", 409);

  await expireHolds(env);
  const id = "DSL-" + randId(6), token = randId(24, "abcdefghijklmnopqrstuvwxyz0123456789");
  const now = isoNow(), expires = new Date(Date.now() + HOLD_MIN * 60000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, token, date, slot, name, phone, address, pincode, cycle, notes, amount, status, source, created_at, expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?14, ?13)`
    ).bind(id, token, date, slot, name, phone, address, pincode, clean(b.cycle, 60), clean(b.notes, 300),
      amount(env), clean(b.source, 300), now, expires).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("Sorry, someone just booked that slot. Please pick another.", 409);
    throw e;
  }
  return json({ id, token, date, dateLabel: prettyDate(date), slot, slotLabel: slotLabel(slot), amount: amount(env), expiresAt: expires,
    upiId: env.UPI_ID || "", upiName: env.UPI_NAME || "Dr. Sarwan Diagnostic Labs", upiQr: env.UPI_QR_STRING || "" }, 201);
}

async function submitPayment(env, req, id, ctx) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  const utr = String(b.utr || "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9]{10,22}$/.test(utr)) return bad("Please enter the 12-digit UPI transaction ID (UTR) from your payment app.");
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!row || !safeEqual(row.token, b.token)) return bad("Booking not found.", 404);
  if (["payment_submitted", "confirmed", "collected"].includes(row.status)) return json({ ok: true, status: row.status, already: true });
  if (row.status === "cancelled") return bad("This booking was cancelled. Please make a new booking.", 409);

  const now = isoNow();
  try {
    // Accept late payment as long as nobody else has taken the slot in the meantime.
    const r = await env.DB.prepare(
      "UPDATE bookings SET status='payment_submitted', utr=?1, paid_at=?2, updated_at=?2 WHERE id=?3 AND status IN ('pending','expired')"
    ).bind(utr, now, id).run();
    if (!r.meta.changes) return bad("Could not update this booking.", 409);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("Your payment hold expired and the slot was taken. Please call 8368143677 with your UTR and we'll rebook you.", 409);
    throw e;
  }
  const booking = { ...row, utr, status: "payment_submitted" };
  const p = notifyAdmin(env, adminMessage(booking));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  return json({ ok: true, status: "payment_submitted", id, date: row.date, dateLabel: prettyDate(row.date), slotLabel: slotLabel(row.slot) });
}

// ---- admin API ----
function isAdmin(env, req) {
  return !!env.ADMIN_PASSWORD && safeEqual(req.headers.get("x-admin-key"), env.ADMIN_PASSWORD);
}

async function adminList(env, url) {
  await expireHolds(env);
  const today = istParts().date;
  const from = url.searchParams.get("from") || today;
  const to = url.searchParams.get("to") || addDays(today, BOOK_DAYS_AHEAD);
  const includeInactive = url.searchParams.get("all") === "1";
  const { results } = await env.DB.prepare(
    `SELECT id, date, slot, name, phone, address, pincode, cycle, notes, amount, status, utr, source, created_at, paid_at, updated_at
     FROM bookings WHERE date BETWEEN ?1 AND ?2 ${includeInactive ? "" : "AND status NOT IN ('expired')"}
     ORDER BY date, slot, created_at`
  ).bind(from, to).all();
  return json({ from, to, slots: SLOTS.map((s) => ({ time: s, label: slotLabel(s) })), bookings: results });
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
    "SELECT id,date,slot,status,name,phone,address,pincode,cycle,notes,amount,utr,source,created_at,paid_at FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status!='blocked' ORDER BY date, slot"
  ).bind(from, to).all();
  const cols = ["id", "date", "slot", "status", "name", "phone", "address", "pincode", "cycle", "notes", "amount", "utr", "source", "created_at", "paid_at"];
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="bookings_${from}_to_${to}.csv"`, "cache-control": "no-store" } });
}

async function adminTestWhatsApp(env) {
  const sent = await notifyAdmin(env, "✅ Test alert from drsarwantests.com booking system.");
  return sent ? json({ ok: true }) : bad("WhatsApp is not configured yet (set WA_ADMIN_PHONE and CALLMEBOT_APIKEY).", 400);
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
        if (p === "/api/bookings" && req.method === "POST") return createBooking(env, req);
        let m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/paid$/);
        if (m && req.method === "POST") return submitPayment(env, req, m[1], ctx);

        if (p.startsWith("/api/admin/")) {
          if (!isAdmin(env, req)) return bad("Unauthorized", 401);
          if (p === "/api/admin/bookings" && req.method === "GET") return adminList(env, url);
          if (p === "/api/admin/export.csv" && req.method === "GET") return adminCsv(env, url);
          if (p === "/api/admin/block" && req.method === "POST") return adminBlock(env, req);
          if (p === "/api/admin/test-whatsapp" && req.method === "POST") return adminTestWhatsApp(env);
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
