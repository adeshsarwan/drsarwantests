// Dr. Sarwan Diagnostic Labs – booking backend
// Cloudflare Worker + D1. Static site is served from ./public via the ASSETS binding.
import "../public/shared/msgs.js"; // WhatsApp message texts, shared with the admin page
const M = globalThis.DSLMsg;

const SLOT_START_MIN = 6 * 60;    // 06:00
const SLOT_END_MIN = 11 * 60;     // last slot ends at 11:00
const SLOT_LEN_MIN = 30;
const BOOK_DAYS_AHEAD = 14;       // how far ahead people can book
const MIN_LEAD_MIN = 180;         // a slot must start at least 3 hours from now
const HOLD_MIN = 120;             // unpaid bookings are marked expired after this (they never hold a slot)
const IST_OFFSET_MIN = 330;       // UTC+05:30

// Statuses that occupy a slot. An unpaid ("pending") booking does NOT hold the slot.
// Workflow: pending → payment_submitted → confirmed → collected (vial no.) → report_ready → completed
//           confirmed → no_show ("reached, patient unavailable": visit fee due before rebooking)
const ACTIVE = ["payment_submitted", "confirmed", "collected", "report_ready", "completed", "no_show", "blocked"];
// Patient bookings that take one of a slot's places (per city). "blocked" closes the whole slot to new bookings.
const HOLDING = ["payment_submitted", "confirmed", "collected", "report_ready", "completed", "no_show"];
const ADMIN_SETTABLE = ["payment_submitted", "confirmed", "collected", "report_ready", "completed", "no_show", "cancelled"];
const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const REPORT_CHUNK = 1_500_000; // base64 chars per row (D1 rows max ~2 MB)

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
async function defaultPackage(env) {
  return await env.DB.prepare("SELECT * FROM packages WHERE active=1 ORDER BY is_default DESC, sort, id LIMIT 1").first();
}
async function packageById(env, id, activeOnly = true) {
  if (!id) return null;
  return await env.DB.prepare(`SELECT * FROM packages WHERE id=?1 ${activeOnly ? "AND active=1" : ""}`).bind(parseInt(id, 10) || 0).first();
}
function slotCapacity(env) { return Math.max(1, parseInt(env.SLOT_CAPACITY || "20", 10) || 20); }
const cityKey = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Is there room in this slot for one more booking in this city?
async function slotRoom(env, date, slot, city, excludeId = "") {
  const { results } = await env.DB.prepare(
    `SELECT id, city, status FROM bookings WHERE date=?1 AND slot=?2 AND status IN (${ACTIVE.map((_, i) => "?" + (i + 3)).join(",")})`
  ).bind(date, slot, ...ACTIVE).all();
  if (results.some((r) => r.status === "blocked")) return { ok: false, blocked: true, msg: `${slotLabel(slot)} on ${prettyDate(date)} is closed for bookings.` };
  const cap = slotCapacity(env), key = cityKey(city);
  const n = results.filter((r) => r.status !== "blocked" && r.id !== excludeId && cityKey(r.city) === key).length;
  return n < cap ? { ok: true, n, cap } : { ok: false, n, cap, msg: `${slotLabel(slot)} on ${prettyDate(date)} is full${city ? " for " + city : ""} (${cap} bookings). Please pick another time.` };
}
function visitFee(env) { return parseInt(env.VISIT_FEE_INR || "300", 10); }

// Create tables automatically on first use (same as migrations/0001_bookings.sql).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, token TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL,
    name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, pincode TEXT NOT NULL, city TEXT, state TEXT, cycle TEXT, notes TEXT,
    amount INTEGER NOT NULL, status TEXT NOT NULL, utr TEXT, source TEXT, created_at TEXT NOT NULL, expires_at TEXT,
    paid_at TEXT, updated_at TEXT NOT NULL)`,
  `DROP INDEX IF EXISTS one_booking_per_slot`,
  `DROP INDEX IF EXISTS one_paid_booking_per_slot`,
  `DROP INDEX IF EXISTS slot_holder_v3`, // was "one booking per slot"; now up to SLOT_CAPACITY per slot per city, checked in code
  `CREATE INDEX IF NOT EXISTS bookings_by_date ON bookings(date, slot)`,
  `CREATE INDEX IF NOT EXISTS bookings_by_status ON bookings(status)`,
  `CREATE TABLE IF NOT EXISTS payment_proofs (booking_id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_chunks (booking_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (booking_id, idx))`,
  `CREATE TABLE IF NOT EXISTS msg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS msg_log_by_booking ON msg_log(booking_id)`,
  `CREATE TABLE IF NOT EXISTS booking_tests (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, package_id INTEGER, name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0, margin INTEGER)`,
  `CREATE INDEX IF NOT EXISTS booking_tests_by_booking ON booking_tests(booking_id)`,
  `CREATE TABLE IF NOT EXISTS report_files (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, sent_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS report_files_by_booking ON report_files(booking_id)`,
  `CREATE TABLE IF NOT EXISTS report_parts (report_id INTEGER NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (report_id, idx))`,
  `CREATE TABLE IF NOT EXISTS packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tests TEXT, mrp INTEGER, price INTEGER NOT NULL,
    margin INTEGER, target TEXT, prep TEXT, active INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // collection centres and the WhatsApp numbers allowed to work for each centre
  `CREATE TABLE IF NOT EXISTS centres (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT, city TEXT, pincode TEXT,
    contact_name TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS centre_numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, centre_id INTEGER NOT NULL, phone TEXT NOT NULL, name TEXT,
    sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS centre_numbers_phone ON centre_numbers(phone)`,
  // logins: role 'centre' (username + password, belongs to a centre) or 'patient' (created automatically from bookings; logs in with phone + date of birth)
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, username TEXT, pass_hash TEXT,
    centre_id INTEGER, dob TEXT, active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username) WHERE username IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS users_by_phone ON users(role, phone)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, role TEXT NOT NULL, phone TEXT, dob TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_fails (k TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS login_fails_k ON login_fails(k, at)`,
  // ---- WhatsApp ----
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
  // message texts edited in the admin (defaults live in public/shared/msgs.js) + their WhatsApp template status
  `CREATE TABLE IF NOT EXISTS msg_templates (key TEXT PRIMARY KEY, body TEXT, wa_id TEXT, wa_status TEXT, wa_reason TEXT, wa_body TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`,
  // every message the system tried to send through the API (status follows WhatsApp's delivery reports)
  `CREATE TABLE IF NOT EXISTS wa_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT, kind TEXT NOT NULL, to_phone TEXT, to_role TEXT,
    status TEXT NOT NULL, wa_id TEXT, error TEXT, log_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS wa_outbox_wa ON wa_outbox(wa_id)`,
  `CREATE INDEX IF NOT EXISTS wa_outbox_status ON wa_outbox(status, created_at)`,
  // people who wrote to us: open 24-hour chat window + where they are in a menu
  `CREATE TABLE IF NOT EXISTS wa_contacts (phone TEXT PRIMARY KEY, name TEXT, last_in_at TEXT, state TEXT, state_data TEXT, state_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS wa_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT UNIQUE, phone TEXT NOT NULL, type TEXT, body TEXT, at TEXT NOT NULL)`,
];

// Tests / packages from DRSARWAN_TESTS_PACKAGES.xlsx — loaded once into an empty database.
// [name, mrp, display price, margin, tests included]
const SEED_PACKAGES = [
  ["FEMALE FERTILITY", 2330, 1899, 640, "FSH, LH, PRL, AMH, T3, T4, TSH"],
  ["FEMALE PCOS", 1899, 1899, 656, "FSH, LH, Prolactin, Progesterone, Estrogen"],
  ["HEALTH FOR ALL", 1999, 1999, 1142, "85 tests: Vit D3, B12, Thyroid, Urine, Diabetes, CBC, ESR, Lipid, Kidney, Liver"],
  ["NIPT (NON-INVASIVE PRENATAL TEST)", 20000, 8500, 4200, "All chromosomes"],
  ["FATTY LIVER", null, 790, 600, "Liver Function Test"],
  ["MALE CANCER SCREEN", null, 1385, 1300, "CA 19.9, CEA, PSA"],
  ["COMPLETE HEALTH CHECK UP", 2999, 2999, 1043, ""],
  ["DIABETES CHECK", 1799, 1799, 920, ""],
  ["HYPERTENSION", 3999, 3799, 2693, "99 tests: Cortisol, hs-CRP, Lipoprotein(a), Apo B, Apo A1, Apo B/A1 ratio, RBS, CBC, LFT, Electrolytes, Kidney, Lipid, Aldosterone / Direct Renin ratio"],
  ["HEALTH BASIC", 1299, 999, 391, "Lipid, Thyroid, Urine, Renal, Liver"],
  ["CARDIAC PACKAGE", 1935, 1699, 770, "FBS, PPBS, KFT, Urine, Lipid"],
  ["PREGNANCY ANTENATAL BASIC", null, 1499, 664, "CBC, Blood Group, HIV, HCV, HBsAg, VDRL"],
  ["VIRAL MARKERS", null, 1099, 548, ""],
  ["DOUBLE MARKER", null, 1800, 909, ""],
  ["TRIPLE MARKER TESTS (14-22 WEEKS)", null, 1800, 966, ""],
  ["PREGNANCY ADVANCED", null, 2434, 1287, "CBC, Blood Group, HIV, HCV, HBsAg, VDRL, HPLC"],
  ["ALLERGY DRUG PANEL", null, 5999, 4292, ""],
];
// "Before the test" text sent in the WhatsApp confirmation; editable per test in the admin Tests tab.
const CALL = "• Our phlebotomist will call you before arriving";
const BIOTIN = "• Taking biotin (hair, skin or nail vitamins)? Skip it for 2 days before – it can give false thyroid and hormone results";
const FAST = "• Fast for 10–12 hours overnight – only plain water (no tea, coffee, juice or gum)";
const NO_FAST = "• No fasting needed – eat and drink as usual";
const NO_ALCOHOL = "• No alcohol for 24 hours before";
const URINE = "• Collect your first urine of the morning in the container we give you (or keep a clean container ready)";
const MEDS_AFTER = "• Keep taking your regular medicines, but take diabetes medicine/insulin and thyroid tablets only after the sample";
const PREG_DOCS = "• Keep ready: doctor's prescription, latest ultrasound report, your date of birth, current weight and first day of your last period (LMP)";
const DEFAULT_PREP = [FAST, CALL].join("\n");
const PREP = {
  "FEMALE FERTILITY": ["• Best done on day 2–5 of your period (day 1 = first day of bleeding). If your periods are irregular, any day is fine – just tell us",
    "• Morning sample, ideally before 10 AM. Rest quietly for 15 minutes before – stress can raise prolactin",
    NO_FAST, BIOTIN, "• Tell us if you take hormone tablets or birth-control pills", CALL],
  "FEMALE PCOS": ["• Best done on day 2–5 of your period (day 1 = first day of bleeding). If your periods are irregular, any day is fine – just tell us",
    "• If your doctor wants progesterone checked around day 21 (about a week before your next period), tell us and we'll plan the date",
    "• Morning sample, ideally before 10 AM. Rest quietly for 15 minutes before",
    NO_FAST, BIOTIN, CALL],
  "HEALTH FOR ALL": [FAST, NO_ALCOHOL, URINE, MEDS_AFTER, BIOTIN, CALL],
  "NIPT (NON-INVASIVE PRENATAL TEST)": ["• Can be done from 10 weeks of pregnancy", NO_FAST, PREG_DOCS + ", and a photo ID",
    "• We'll help you fill the consent form at collection", CALL],
  "FATTY LIVER": ["• Fast for 8–10 hours overnight – only plain water", NO_ALCOHOL, "• Avoid a heavy, oily dinner the night before", "• Keep taking your regular medicines", CALL],
  "MALE CANCER SCREEN": [NO_FAST, "• No ejaculation (sex or masturbation) for 48 hours before – it can raise PSA",
    "• No cycling, horse riding or heavy exercise for 48 hours before",
    "• Had a prostate examination, catheter or biopsy recently, or a urine infection in the last 6 weeks? Tell us – we may need to change the date",
    "• Tell us if you take medicines for the prostate or hair loss (e.g. finasteride, dutasteride) – they lower PSA", CALL],
  "COMPLETE HEALTH CHECK UP": [FAST, NO_ALCOHOL, URINE, MEDS_AFTER, BIOTIN, CALL],
  "DIABETES CHECK": ["• Fast for 8–12 hours overnight – only plain water", "• Take diabetes tablets/insulin only after the fasting sample",
    "• If your test includes a post-meal (PP) sugar: eat your usual breakfast right after the first sample and note the time – the second sample is taken exactly 2 hours after you start eating",
    "• Avoid heavy exercise on the morning of the test", CALL],
  "HYPERTENSION": [FAST, "• Book an early-morning slot. Be up and about for at least 2 hours before the sample, then sit quietly for 10 minutes",
    "• Eat your usual amount of salt in the days before – don't cut down just for the test. Avoid liquorice (mulethi)",
    "• Some blood-pressure medicines affect the aldosterone/renin test. Ask your doctor before the test – don't stop any medicine on your own",
    NO_ALCOHOL, URINE, CALL],
  "HEALTH BASIC": [FAST, NO_ALCOHOL, URINE, MEDS_AFTER, BIOTIN, CALL],
  "CARDIAC PACKAGE": [FAST, NO_ALCOHOL, URINE,
    "• After the fasting sample, eat your usual breakfast and note the time – the post-meal (PP) sugar sample is taken exactly 2 hours after you start eating",
    "• Take diabetes medicine/insulin only after the fasting sample; keep taking other regular medicines", CALL],
  "PREGNANCY ANTENATAL BASIC": [NO_FAST, "• Keep your doctor's prescription and a photo ID ready", CALL],
  "VIRAL MARKERS": [NO_FAST, "• Keep your doctor's prescription ready, if you have one", CALL],
  "DOUBLE MARKER": ["• Done between 11 and 13 weeks (+6 days) of pregnancy, ideally on or soon after your NT scan", NO_FAST,
    "• Keep ready: NT scan report (with CRL and NT values), doctor's prescription, your date of birth, current weight and LMP",
    "• Tell us if this is an IVF pregnancy, twins, or if you have diabetes – it changes the risk calculation", CALL],
  "TRIPLE MARKER TESTS (14-22 WEEKS)": ["• Best done between 15 and 20 weeks of pregnancy", NO_FAST, PREG_DOCS,
    "• Tell us if this is an IVF pregnancy, twins, or if you have diabetes – it changes the risk calculation", CALL],
  "PREGNANCY ADVANCED": [NO_FAST, "• Keep your doctor's prescription and a photo ID ready", CALL],
  "ALLERGY DRUG PANEL": [NO_FAST, "• Keep taking your medicines. If you take antihistamines or steroids, tell us – your doctor may ask you to pause them",
    "• Keep a list of the medicines you think you react to", CALL],
};
const prepFor = (name) => (PREP[String(name || "").trim().toUpperCase()] || [FAST, CALL]).join("\n");
const DEFAULT_PREP_V1 = "• Fast for 10–12 hours overnight (water is fine)\n• Our phlebotomist will call you before arriving"; // first version, same for all tests
// One-time moves: single test per booking → booking_tests rows; single report per booking → report_files.
async function migrateTestsAndReports(env) {
  await env.DB.prepare(`INSERT INTO booking_tests (booking_id, package_id, name, price, margin)
    SELECT b.id, b.package_id, COALESCE(b.package_name, p.name), COALESCE(p.price, b.amount), p.margin
    FROM bookings b LEFT JOIN packages p ON p.id = b.package_id
    WHERE b.status != 'blocked' AND (b.package_id IS NOT NULL OR b.package_name IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM booking_tests t WHERE t.booking_id = b.id)`).run();
  const { results: old } = await env.DB.prepare(`SELECT id, report_name, report_size, report_token, report_at, completed_at, status FROM bookings
    WHERE report_token IS NOT NULL AND NOT EXISTS (SELECT 1 FROM report_files f WHERE f.token = bookings.report_token)`).all();
  for (const r of old) {
    await env.DB.prepare("INSERT INTO report_files (booking_id, name, size, token, created_at, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(r.id, r.report_name || "report.pdf", r.report_size || 0, r.report_token, r.report_at || isoNow(), r.status === "completed" ? r.completed_at || isoNow() : null).run();
    const f = await env.DB.prepare("SELECT id FROM report_files WHERE token=?1").bind(r.report_token).first();
    await env.DB.prepare("INSERT INTO report_parts (report_id, idx, data) SELECT ?1, idx, data FROM report_chunks WHERE booking_id=?2").bind(f.id, r.id).run();
  }
}
async function seedPackages(env) {
  const cols = await env.DB.prepare("PRAGMA table_info(packages)").all();
  if (!(cols.results || []).some((c) => c.name === "prep")) await env.DB.prepare("ALTER TABLE packages ADD COLUMN prep TEXT").run();
  // fill researched instructions where nobody has written their own yet
  const { results: blank } = await env.DB.prepare("SELECT id, name FROM packages WHERE prep IS NULL OR prep = ?1").bind(DEFAULT_PREP_V1).all();
  if (blank.length) await env.DB.batch(blank.map((r) => env.DB.prepare("UPDATE packages SET prep=?1 WHERE id=?2").bind(prepFor(r.name), r.id)));
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages").first();
  if (n && n.n > 0) return;
  const now = isoNow();
  await env.DB.batch(SEED_PACKAGES.map(([name, mrp, price, margin, tests], i) =>
    env.DB.prepare("INSERT INTO packages (name, tests, mrp, price, margin, prep, active, is_default, sort, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?9, 1, ?6, ?7, ?8, ?8)")
      .bind(name, tests, mrp, price, margin, i === 0 ? 1 : 0, (i + 1) * 10, now, prepFor(name))));
  // bookings made before tests existed were all for the fertility panel
  const d = await env.DB.prepare("SELECT id, name FROM packages WHERE is_default=1").first();
  if (d) await env.DB.prepare("UPDATE bookings SET package_id=?1, package_name=?2 WHERE package_id IS NULL AND status!='blocked'").bind(d.id, d.name).run();
}
let schemaReady = null;
const NEW_COLS = { city: "TEXT", state: "TEXT", vial_no: "TEXT", collected_at: "TEXT", report_name: "TEXT", report_size: "INTEGER",
  report_token: "TEXT", report_at: "TEXT", completed_at: "TEXT", fee_due: "INTEGER", fee_paid_at: "TEXT", missed_slot: "TEXT", package_id: "INTEGER", package_name: "TEXT",
  centre_id: "INTEGER", patient_id: "INTEGER", consent_at: "TEXT", centre_status: "TEXT", centre_status_at: "TEXT", collector_info: "TEXT" };
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // add any missing columns first (older databases), then tables / indexes
      const info = await env.DB.prepare("PRAGMA table_info(bookings)").all().catch(() => ({ results: [] }));
      const have = new Set((info.results || []).map((c) => c.name));
      if (have.size) for (const [c, t] of Object.entries(NEW_COLS)) {
        if (!have.has(c)) {
          try { await env.DB.prepare(`ALTER TABLE bookings ADD COLUMN ${c} ${t}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
        }
      }
      await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
      for (const [tbl, col] of [["wa_contacts", "opted_out"], ["wa_contacts", "read_at"], ["wa_contacts", "human_until"], ["wa_inbox", "dir"], ["wa_inbox", "by_who"],
        ["wa_inbox", "status"], ["wa_inbox", "media_id"], ["wa_inbox", "media_type"], ["wa_inbox", "media_name"]]) {
        try { await env.DB.prepare(`ALTER TABLE ${tbl} ADD COLUMN ${col} TEXT`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
      }
      if (!have.size) for (const [c, t] of Object.entries(NEW_COLS)) {
        try { await env.DB.prepare(`ALTER TABLE bookings ADD COLUMN ${c} ${t}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
      }
      await seedPackages(env);
      await migrateTestsAndReports(env);
      await seedAccounts(env);
      await seedWa(env);
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
    `SELECT slot, city, status FROM bookings WHERE date=?1 AND status IN (${ACTIVE.map(() => "?").join(",")})`
  ).bind(date, ...ACTIVE).all();
  const city = cityKey(url.searchParams.get("city")), cap = slotCapacity(env);
  const closed = new Set(results.filter((r) => r.status === "blocked").map((r) => r.slot));
  const used = {};
  if (city) results.filter((r) => r.status !== "blocked" && cityKey(r.city) === city).forEach((r) => (used[r.slot] = (used[r.slot] || 0) + 1));
  return json({
    date,
    slots: SLOTS.map((s) => ({ time: s, label: slotLabel(s), available: !closed.has(s) && (used[s] || 0) < cap && isBookable(date, s) })),
  });
}

async function getConfig(env) {
  const pkg = await defaultPackage(env);
  const today = istParts().date;
  const dates = [];
  for (let i = 0; i <= BOOK_DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    if (SLOTS.some((s) => isBookable(d, s))) dates.push(d);
  }
  return json({
    amount: pkg ? pkg.price : amount(env),
    test: pkg ? { id: pkg.id, name: pkg.name, tests: pkg.tests || "" } : null,
    upiId: env.UPI_ID || "",
    upiName: env.UPI_NAME || "Dr. Sarwan Diagnostic Labs",
    upiQr: env.UPI_QR_STRING || "",
    mapsKey: env.GOOGLE_MAPS_KEY || "",
    holdMinutes: HOLD_MIN,
    slotCapacity: slotCapacity(env),
    visitFee: visitFee(env),
    centerPhone: String(env.CENTER_WHATSAPP || "8368143677").replace(/\D/g, "").slice(-10),
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
  // date of birth: used by the patient to open their reports (phone + DOB). Older cached pages may not send it.
  const dob = b.dob ? cleanDob(b.dob) : null;
  if (b.dob && !dob) return bad("Please enter a valid date of birth.");

  await expireHolds(env);
  const room = await slotRoom(env, date, slot, city);
  if (!room.ok) return bad("Sorry, " + room.msg, 409);
  const pkg = (await packageById(env, b.package_id)) || (await defaultPackage(env));
  const price = pkg ? pkg.price : amount(env);
  const id = "DSL-" + randId(6), token = randId(24, "abcdefghijklmnopqrstuvwxyz0123456789");
  const now = isoNow(), expires = new Date(Date.now() + HOLD_MIN * 60000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, token, date, slot, name, phone, address, pincode, city, state, cycle, notes, amount, status, source, created_at, expires_at, updated_at, package_id, package_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?15, ?16, ?9, ?10, ?11, 'pending', ?12, ?13, ?14, ?13, ?17, ?18)`
    ).bind(id, token, date, slot, name, phone, address, pincode, clean(b.cycle, 60), clean(b.notes, 300),
      price, clean(b.source, 300), now, expires, city, state, pkg ? pkg.id : null, pkg ? pkg.name : null).run();
    if (pkg) await env.DB.prepare("INSERT INTO booking_tests (booking_id, package_id, name, price, margin) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, pkg.id, pkg.name, pkg.price, pkg.margin).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("Sorry, someone just booked that slot. Please pick another.", 409);
    throw e;
  }
  await linkPatient(env, id, name, phone, dob, b.consent === true ? now : null);
  return json({ id, token, date, dateLabel: prettyDate(date), slot, slotLabel: slotLabel(slot), amount: price, testName: pkg ? pkg.name : "", expiresAt: expires,
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
  if (["payment_submitted", "confirmed", "collected", "report_ready", "completed", "no_show"].includes(row.status)) {
    // already submitted: allow adding / replacing the screenshot or UTR
    await saveProof();
    if (utr) await env.DB.prepare("UPDATE bookings SET utr=?1, updated_at=?2 WHERE id=?3").bind(utr, now, id).run();
    return json({ ok: true, status: row.status, id, dateLabel: prettyDate(row.date), slotLabel: slotLabel(row.slot) });
  }
  // Save the payment proof first, so it is never lost even if the slot was taken meanwhile.
  await saveProof();
  if (utr) await env.DB.prepare("UPDATE bookings SET utr=?1, updated_at=?2 WHERE id=?3").bind(utr, now, id).run();
  const room = await slotRoom(env, row.date, row.slot, row.city, id);
  if (!room.ok) return slotTaken(row);
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
    error: `Sorry, ${slotLabel(row.slot)} on ${prettyDate(row.date)} just got fully booked. Your payment is saved. Please pick another slot.`,
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
  const room = await slotRoom(env, date, slot, row.city, id);
  if (!room.ok) return slotTaken({ ...row, date, slot });
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
       package_id, package_name, vial_no, collected_at, report_name, report_size, report_token, report_at, completed_at, fee_due, fee_paid_at, missed_slot,
       centre_id, patient_id, consent_at, centre_status, collector_info, (SELECT dob FROM users u WHERE u.id = bookings.patient_id) AS dob,
       EXISTS(SELECT 1 FROM payment_proofs p WHERE p.booking_id = bookings.id) AS has_proof,
       (SELECT group_concat(kind || '@' || at, ',') FROM msg_log l WHERE l.booking_id = bookings.id) AS msgs
     FROM bookings WHERE date BETWEEN ?1 AND ?2 ${includeInactive ? "" : "AND status NOT IN ('expired')"}
     ORDER BY date, slot, created_at`
  ).bind(from, to).all();
  const [{ results: tests }, { results: files }] = await Promise.all([
    env.DB.prepare("SELECT t.booking_id, t.package_id, t.name, t.price, t.margin FROM booking_tests t JOIN bookings b ON b.id = t.booking_id WHERE b.date BETWEEN ?1 AND ?2 ORDER BY t.id").bind(from, to).all(),
    env.DB.prepare("SELECT f.id, f.booking_id, f.name, f.size, f.token, f.created_at, f.sent_at FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE b.date BETWEEN ?1 AND ?2 ORDER BY f.id").bind(from, to).all(),
  ]);
  const by = (rows) => rows.reduce((m, r) => ((m[r.booking_id] = m[r.booking_id] || []).push(r), m), {});
  const T = by(tests), F = by(files);
  for (const b of results) { b.tests = T[b.id] || []; b.reports = F[b.id] || []; }
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
  const dob = b.dob ? cleanDob(b.dob) : null;
  if (b.dob && !dob) return bad("Enter a valid date of birth.");
  const pkgs = await pickPackages(env, b);
  if (pkgs.err) return bad(pkgs.err);
  const pkg = pkgs[0];
  const total = pkgs.reduce((a, p) => a + p.price, 0);
  const amt = b.amount === undefined || b.amount === "" || b.amount === null ? total : parseInt(b.amount, 10);
  if (!Number.isFinite(amt) || amt < 0 || amt > 1000000) return bad("Enter a valid amount.");
  const room = await slotRoom(env, date, slot, city);
  if (!room.ok && (room.blocked || HOLDING.includes(status))) return bad(room.msg, 409);
  const id = "DSL-" + randId(6), token = randId(24, "abcdefghijklmnopqrstuvwxyz0123456789"), now = isoNow();
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, token, date, slot, name, phone, address, pincode, city, state, cycle, notes, amount, status, source, created_at, paid_at, updated_at, package_id, package_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'admin', ?15, ?16, ?15, ?17, ?18)`
    ).bind(id, token, date, slot, name, phone, address, pincode, city, state, clean(b.cycle, 60), clean(b.notes, 300),
      amt, status, now, status === "pending" ? null : now, pkg.id, pkgs.map((p) => p.name).join(" + ")).run();
    await env.DB.batch(pkgs.map((p) => env.DB.prepare("INSERT INTO booking_tests (booking_id, package_id, name, price, margin) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, p.id, p.name, p.price, p.margin)));
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("That slot already has a booking.", 409);
    throw e;
  }
  await linkPatient(env, id, name, phone, dob, null);
  if (status === "confirmed") { await autoAssign(env, id); later(req, waEvent(env, "confirmed", id)); }
  return json({ ok: true, id }, 201);
}

// Tests chosen in the admin form: package_ids [..] (or a single package_id); default test if none given.
async function pickPackages(env, b) {
  let ids = Array.isArray(b.package_ids) ? b.package_ids : b.package_id ? [b.package_id] : [];
  ids = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 30);
  if (!ids.length) { const d = await defaultPackage(env); return d ? [d] : { err: "Pick at least one test." }; }
  const { results } = await env.DB.prepare(`SELECT * FROM packages WHERE id IN (${ids.map((_, i) => "?" + (i + 1)).join(",")})`).bind(...ids).all();
  if (results.length !== ids.length) return { err: "One of the tests no longer exists. Refresh and try again." };
  return ids.map((id) => results.find((r) => r.id === id));
}
// Change the tests (and amount) of an existing booking.
async function adminSetTests(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const row = await env.DB.prepare("SELECT id FROM bookings WHERE id=?1 AND status != 'blocked'").bind(id).first();
  if (!row) return bad("Booking not found", 404);
  const pkgs = await pickPackages(env, b);
  if (pkgs.err) return bad(pkgs.err);
  const total = pkgs.reduce((a, p) => a + p.price, 0);
  const amt = b.amount === undefined || b.amount === "" || b.amount === null ? total : parseInt(b.amount, 10);
  if (!Number.isFinite(amt) || amt < 0 || amt > 1000000) return bad("Enter a valid amount.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM booking_tests WHERE booking_id=?1").bind(id),
    ...pkgs.map((p) => env.DB.prepare("INSERT INTO booking_tests (booking_id, package_id, name, price, margin) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, p.id, p.name, p.price, p.margin)),
    env.DB.prepare("UPDATE bookings SET package_id=?1, package_name=?2, amount=?3, updated_at=?4 WHERE id=?5").bind(pkgs[0].id, pkgs.map((p) => p.name).join(" + "), amt, isoNow(), id),
  ]);
  return json({ ok: true });
}

// Move a booking to another slot (reschedule).
async function adminMove(env, req, id) {
  const { date, slot, feePaid } = await req.json().catch(() => ({}));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !SLOTS.includes(slot)) return bad("Pick a date and slot.");
  const row = await env.DB.prepare("SELECT status, city FROM bookings WHERE id=?1").bind(id).first();
  if (!row || ["blocked", "cancelled"].includes(row.status)) return bad("Booking not found", 404);
  const room = await slotRoom(env, date, slot, row.city, id);
  if (!room.ok) return bad(room.msg, 409);
  if (["collected", "report_ready", "completed"].includes(row.status)) return bad("The sample is already collected, so this booking can't be moved.", 409);
  const now = isoNow();
  try {
    let r;
    if (row.status === "no_show") {
      if (feePaid !== true) return bad(`Tick "visit fee received" first. The patient missed the last visit.`, 400);
      r = await env.DB.prepare("UPDATE bookings SET date=?1, slot=?2, status='confirmed', fee_paid_at=?3, updated_at=?3 WHERE id=?4 AND status='no_show'")
        .bind(date, slot, now, id).run();
    } else {
      r = await env.DB.prepare("UPDATE bookings SET date=?1, slot=?2, updated_at=?3 WHERE id=?4 AND status NOT IN ('blocked','cancelled')")
        .bind(date, slot, now, id).run();
    }
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
  const body = await req.json().catch(() => ({}));
  const status = body.status;
  if (!ADMIN_SETTABLE.includes(status)) return bad("Invalid status");
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1 AND status != 'blocked'").bind(id).first();
  if (!row) return bad("Booking not found", 404);
  const now = isoNow();
  const set = { status, updated_at: now };
  if (status === "collected") {
    const vial = clean(body.vial_no, 40).toUpperCase();
    // vial no. can be added later (no_vial) – the admin shows a "vial no. missing" warning until it is
    if (!vial && !body.no_vial) return bad("Enter the vial number written on the sample.");
    if (vial && !body.force) {
      const dup = await env.DB.prepare("SELECT id, name FROM bookings WHERE vial_no=?1 AND id!=?2 LIMIT 1").bind(vial, id).first();
      if (dup) return json({ error: `Vial ${vial} is already used for ${dup.name} (${dup.id}). Check the number.`, code: "dup_vial" }, 409);
    }
    set.vial_no = vial || row.vial_no || null;
    set.collected_at = row.collected_at || now;
  }
  if (status === "report_ready" && !(await env.DB.prepare("SELECT 1 FROM report_files WHERE booking_id=?1 LIMIT 1").bind(id).first())) return bad("Upload the report PDF first.");
  if (HOLDING.includes(status) && !HOLDING.includes(row.status)) {
    const room = await slotRoom(env, row.date, row.slot, row.city, id);
    if (!room.ok) return bad(room.msg + " Reschedule it instead.", 409);
  }
  if (status === "completed") set.completed_at = now;
  if (status === "no_show") {
    set.fee_due = visitFee(env);
    set.fee_paid_at = null;
    set.missed_slot = `${row.date} ${row.slot}`;
  }
  const cols = Object.keys(set);
  try {
    const r = await env.DB.prepare(`UPDATE bookings SET ${cols.map((c, i) => `${c}=?${i + 1}`).join(", ")} WHERE id=?${cols.length + 1}`)
      .bind(...cols.map((c) => set[c]), id).run();
    if (!r.meta.changes) return bad("Booking not found", 404);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad("That slot is already taken by another booking.", 409);
    throw e;
  }
  if (status === "confirmed" && row.status !== "confirmed") {
    await autoAssign(env, id); // payment approved → the default centre gets it (if no centre was chosen yet)
    later(req, waEvent(env, "confirmed", id));
  }
  if (status === "collected" && row.status === "confirmed") later(req, waEvent(env, "collected", id));
  return json({ ok: true });
}

// ---- reports (PDF stored in D1 as base64 chunks) ----
function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function adminUploadReport(env, req, id) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1 AND status != 'blocked'").bind(id).first();
  if (!row) return bad("Booking not found", 404);
  if (!["collected", "report_ready", "completed"].includes(row.status)) return bad("Mark the sample as collected (with vial no.) before uploading reports.", 409);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) return bad("Empty file");
  if (buf.length > MAX_REPORT_BYTES) return bad("Report is larger than 10 MB.");
  if (String.fromCharCode(...buf.subarray(0, 5)) !== "%PDF-") return bad("Please upload the report as a PDF.");
  let name = "report.pdf";
  try { name = clean(decodeURIComponent(req.headers.get("x-filename") || "report.pdf"), 120) || name; } catch {}
  const fid = await storeReport(env, id, buf, name);
  later(req, waEvent(env, "report", id));
  return json({ ok: true, id: fid.id, token: fid.token });
}
// save a report PDF (bytes already checked) – used by the admin, the centre portal and the centre's WhatsApp upload
async function storeReport(env, id, buf, name) {
  const now = isoNow(), token = randId(32, "abcdefghijklmnopqrstuvwxyz0123456789");
  await env.DB.prepare("INSERT INTO report_files (booking_id, name, size, token, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, name, buf.length, token, now).run();
  const f = await env.DB.prepare("SELECT id FROM report_files WHERE token=?1").bind(token).first();
  const b64 = toB64(buf), stmts = [];
  for (let i = 0, n = 0; i < b64.length; i += REPORT_CHUNK, n++)
    stmts.push(env.DB.prepare("INSERT INTO report_parts (report_id, idx, data) VALUES (?1, ?2, ?3)").bind(f.id, n, b64.slice(i, i + REPORT_CHUNK)));
  stmts.push(env.DB.prepare("UPDATE bookings SET status='report_ready', report_at=?1, completed_at=NULL, updated_at=?1 WHERE id=?2").bind(now, id));
  await env.DB.batch(stmts);
  return { id: f.id, token };
}
async function fileResponse(env, f, patient) {
  const { results } = await env.DB.prepare("SELECT data FROM report_parts WHERE report_id=?1 ORDER BY idx").bind(f.id).all();
  if (!results.length) return bad("Report not found", 404);
  const bin = Uint8Array.from(atob(results.map((r) => r.data).join("")), (c) => c.charCodeAt(0));
  const base = String(f.name || "report").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 60);
  const fname = `${String(patient || "").replace(/[^A-Za-z0-9]+/g, "_")}_${base}.pdf`.replace(/^_+/, "");
  return new Response(bin, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${fname}"`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } });
}
async function adminReportFile(env, rid) {
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE f.id=?1").bind(rid).first();
  return f ? fileResponse(env, f, f.patient) : bad("Report not found", 404);
}
async function adminReport(env, id) { // first report of a booking (older admin pages)
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE f.booking_id=?1 ORDER BY f.id LIMIT 1").bind(id).first();
  return f ? fileResponse(env, f, f.patient) : bad("Report not found", 404);
}
async function adminDeleteReport(env, rid) {
  const f = await env.DB.prepare("SELECT * FROM report_files WHERE id=?1").bind(rid).first();
  if (!f) return bad("Report not found", 404);
  await env.DB.batch([env.DB.prepare("DELETE FROM report_parts WHERE report_id=?1").bind(rid), env.DB.prepare("DELETE FROM report_files WHERE id=?1").bind(rid)]);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END) AS unsent FROM report_files WHERE booking_id=?1").bind(f.booking_id).first();
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id=?1").bind(f.booking_id).first();
  if (row && ["report_ready", "completed"].includes(row.status)) {
    const st = !left.n ? "collected" : left.unsent ? "report_ready" : row.status;
    if (st !== row.status) await env.DB.prepare("UPDATE bookings SET status=?1, completed_at=NULL, updated_at=?2 WHERE id=?3").bind(st, isoNow(), f.booking_id).run();
  }
  return json({ ok: true });
}
async function publicReport(env, token) {
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE f.token=?1 AND b.status NOT IN ('cancelled','blocked')").bind(token).first();
  if (!f) return new Response("This report link is not valid. Please WhatsApp us on 8368143677.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return fileResponse(env, f, f.patient);
}

async function adminVial(env, req, id) {
  const body = await req.json().catch(() => ({}));
  const vial = clean(body.vial_no, 40).toUpperCase();
  if (!vial) return bad("Enter the vial number.");
  if (!body.force) {
    const dup = await env.DB.prepare("SELECT id, name FROM bookings WHERE vial_no=?1 AND id!=?2 LIMIT 1").bind(vial, id).first();
    if (dup) return json({ error: `Vial ${vial} is already used for ${dup.name} (${dup.id}). Check the number.`, code: "dup_vial" }, 409);
  }
  const r = await env.DB.prepare("UPDATE bookings SET vial_no=?1, updated_at=?2 WHERE id=?3 AND status IN ('collected','report_ready','completed')").bind(vial, isoNow(), id).run();
  if (!r.meta.changes) return bad("Mark the sample as collected first.", 409);
  return json({ ok: true });
}

// Admin opened WhatsApp with a message. Sending the report completes the job.
const MSG_KINDS = ["pay", "confirm", "center", "collector", "reminder", "slots", "missed", "collected", "report", "prep", "chat"];
const DONE_KINDS = ["confirm", "center", "centre_ok", "collector", "reminder", "collected"]; // message steps that can be ticked as done by hand
async function adminSent(env, req, id) {
  const body = await req.json().catch(() => ({}));
  const kind = body.kind;
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id=?1").bind(id).first();
  if (!row) return bad("Booking not found", 404);
  const now = isoNow();
  if (kind === "report-undo") { // the reports weren't actually sent
    const ids = (Array.isArray(body.reportIds) ? body.reportIds : []).map(Number).filter(Boolean);
    const stmts = ids.map((rid) => env.DB.prepare("UPDATE report_files SET sent_at=NULL WHERE id=?1 AND booking_id=?2").bind(rid, id));
    if (row.status === "completed") stmts.push(env.DB.prepare("UPDATE bookings SET status='report_ready', completed_at=NULL, updated_at=?1 WHERE id=?2").bind(now, id));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }
  // a step done outside the system (e.g. message sent on WhatsApp directly) and ticked by hand – and its undo
  if (kind === "undo-done") {
    if (!DONE_KINDS.includes(body.target)) return bad("Invalid step");
    await env.DB.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind=?2").bind(id, "done:" + body.target).run();
    return json({ ok: true });
  }
  if (String(kind).startsWith("done:")) {
    if (!DONE_KINDS.includes(kind.slice(5))) return bad("Invalid step");
    await env.DB.prepare("INSERT INTO msg_log (booking_id, kind, at) VALUES (?1, ?2, ?3)").bind(id, kind, now).run();
    return json({ ok: true });
  }
  if (!MSG_KINDS.includes(kind)) return bad("Invalid message type");
  const stmts = [env.DB.prepare("INSERT INTO msg_log (booking_id, kind, at) VALUES (?1, ?2, ?3)").bind(id, kind, now)];
  let completed = false, marked = [];
  if (kind === "report") {
    const { results: files } = await env.DB.prepare("SELECT id, sent_at FROM report_files WHERE booking_id=?1").bind(id).all();
    const want = Array.isArray(body.reportIds) ? body.reportIds.map(Number) : files.filter((f) => !f.sent_at).map((f) => f.id);
    marked = files.filter((f) => want.includes(f.id)).map((f) => f.id);
    marked.forEach((rid) => stmts.push(env.DB.prepare("UPDATE report_files SET sent_at=?1 WHERE id=?2").bind(now, rid)));
    const allSent = files.length > 0 && files.every((f) => f.sent_at || marked.includes(f.id));
    if (allSent && row.status === "report_ready") {
      stmts.push(env.DB.prepare("UPDATE bookings SET status='completed', completed_at=?1, updated_at=?1 WHERE id=?2").bind(now, id));
      completed = true;
    }
  }
  await env.DB.batch(stmts);
  return json({ ok: true, completed, marked });
}

// ---- tests / packages ----
async function publicPackages(env) {
  const { results } = await env.DB.prepare("SELECT id, name, tests, mrp, price, prep, is_default FROM packages WHERE active=1 ORDER BY sort, id").all();
  return json({ packages: results });
}
async function adminPackages(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id AND b.status NOT IN ('cancelled','expired','blocked')) AS bookings
     FROM packages p ORDER BY p.sort, p.id`).all();
  return json({ packages: results });
}
function readPackage(b) {
  const name = clean(b.name, 120);
  const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Math.round(Number(String(v).replace(/[^\d.]/g, ""))));
  const price = num(b.price), mrp = num(b.mrp), margin = num(b.margin);
  if (name.length < 2) return { err: "Enter the test / package name." };
  if (price === null || !Number.isFinite(price) || price <= 0) return { err: "Enter the price shown to patients." };
  for (const v of [mrp, margin]) if (v !== null && (!Number.isFinite(v) || v < 0)) return { err: "MRP and margin must be numbers." };
  const prep = b.prep === undefined ? null : String(b.prep).replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
  return { name, tests: clean(b.tests, 1000), price, mrp, margin, target: clean(b.target, 120), prep,
    active: b.active === false || b.active === 0 || b.active === "0" ? 0 : 1, is_default: b.is_default ? 1 : 0 };
}
async function adminSavePackage(env, req, id) {
  const p = readPackage(await req.json().catch(() => ({})));
  if (p.err) return bad(p.err);
  if (p.is_default && !p.active) return bad("The website test can't be hidden. Make another test the website test first.");
  const now = isoNow();
  const dup = await env.DB.prepare("SELECT id FROM packages WHERE lower(name)=lower(?1) AND id != ?2").bind(p.name, id || 0).first();
  if (dup) return bad("A test with this name already exists.", 409);
  const stmts = [];
  if (p.is_default) stmts.push(env.DB.prepare("UPDATE packages SET is_default=0 WHERE id != ?1").bind(id || 0));
  if (id) {
    const cur = await env.DB.prepare("SELECT * FROM packages WHERE id=?1").bind(id).first();
    if (!cur) return bad("Test not found", 404);
    if (cur.is_default && !p.is_default) return bad("Pick another test as the website test instead of unticking this one.");
    stmts.push(env.DB.prepare("UPDATE packages SET name=?1, tests=?2, mrp=?3, price=?4, margin=?5, target=?6, active=?7, is_default=?8, updated_at=?9, prep=COALESCE(?11, prep) WHERE id=?10")
      .bind(p.name, p.tests, p.mrp, p.price, p.margin, p.target, p.active, p.is_default, now, id, p.prep));
    await env.DB.batch(stmts);
    return json({ ok: true, id });
  }
  const mx = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM packages").first();
  stmts.push(env.DB.prepare("INSERT INTO packages (name, tests, mrp, price, margin, target, active, is_default, sort, created_at, updated_at, prep) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)")
    .bind(p.name, p.tests, p.mrp, p.price, p.margin, p.target, p.active, p.is_default, (mx ? mx.m : 0) + 10, now, p.prep));
  await env.DB.batch(stmts);
  const row = await env.DB.prepare("SELECT id FROM packages WHERE name=?1").bind(p.name).first();
  return json({ ok: true, id: row && row.id }, 201);
}
async function adminDeletePackage(env, id) {
  const cur = await env.DB.prepare("SELECT * FROM packages WHERE id=?1").bind(id).first();
  if (!cur) return bad("Test not found", 404);
  if (cur.is_default) return bad("This is the website test. Make another test the website test first.", 409);
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE package_id=?1").bind(id).first();
  if (used && used.n) return bad(`${used.n} booking(s) use this test, so it can't be deleted. Hide it instead.`, 409);
  await env.DB.prepare("DELETE FROM packages WHERE id=?1").bind(id).run();
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
  const already = await env.DB.prepare("SELECT 1 FROM bookings WHERE date=?1 AND slot=?2 AND status='blocked'").bind(date, slot).first();
  if (already) return bad("That slot is already blocked.", 409);
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
    "SELECT id,date,slot,status,package_name AS test,(SELECT SUM(margin) FROM booking_tests t WHERE t.booking_id=bookings.id) - ((SELECT SUM(price) FROM booking_tests t WHERE t.booking_id=bookings.id) - amount) AS margin,(SELECT COUNT(*) FROM report_files f WHERE f.booking_id=bookings.id) AS reports,(SELECT COUNT(*) FROM report_files f WHERE f.booking_id=bookings.id AND f.sent_at IS NOT NULL) AS reports_sent,amount AS amount_charged,name,phone,address,pincode,city,state,cycle,notes,amount,utr,vial_no,collected_at,report_at,completed_at,fee_due,fee_paid_at,CASE WHEN EXISTS(SELECT 1 FROM payment_proofs p WHERE p.booking_id=bookings.id) THEN 'yes' ELSE 'no' END AS screenshot,source,created_at,paid_at FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status!='blocked' ORDER BY date, slot"
  ).bind(from, to).all();
  const cols = ["id", "date", "slot", "status", "test", "margin", "reports", "reports_sent", "name", "phone", "address", "pincode", "city", "state", "cycle", "notes", "amount", "utr", "vial_no", "collected_at", "report_at", "completed_at", "fee_due", "fee_paid_at", "screenshot", "source", "created_at", "paid_at"];
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="bookings_${from}_to_${to}.csv"`, "cache-control": "no-store" } });
}

// =====================================================================
// ---- collection centres, users, logins (centre portal + patient portal) ----
// =====================================================================
const PAID_STATES = ["confirmed", "collected", "report_ready", "completed", "no_show"]; // what a centre gets to see
const CENTRE_SESSION_DAYS = 30, PATIENT_SESSION_HOURS = 12;

function cleanDob(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d) || d.toISOString().slice(0, 10) !== s) return null;
  if (s < "1900-01-01" || s > istParts().date) return null;
  return s;
}

// One-time setup: a temporary centre with the current centre number, given all existing paid bookings;
// and a patient user for every (phone, name) already in the bookings. New bookings link themselves (linkPatient).
async function seedAccounts(env) {
  const now = isoNow();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM centres").first();
  if (!n || !n.n) {
    const phone = normPhone(env.CENTER_WHATSAPP || "8368143677") || "8368143677";
    await env.DB.prepare("INSERT INTO centres (name, address, notes, active, is_default, created_at, updated_at) VALUES (?1, '', ?2, 1, 1, ?3, ?3)")
      .bind("Main collection centre (temporary)", "Created automatically from the old centre number. Rename it and add the real details.", now).run();
    const c = await env.DB.prepare("SELECT id FROM centres ORDER BY id LIMIT 1").first();
    await env.DB.prepare("INSERT OR IGNORE INTO centre_numbers (centre_id, phone, name, sort, created_at) VALUES (?1, ?2, 'Main number', 0, ?3)").bind(c.id, phone, now).run();
    await env.DB.prepare(`UPDATE bookings SET centre_id=?1 WHERE centre_id IS NULL AND status IN (${PAID_STATES.map((_, i) => "?" + (i + 2)).join(",")})`)
      .bind(c.id, ...PAID_STATES).run();
  }
  await env.DB.prepare(`INSERT INTO users (role, name, phone, active, created_at, updated_at)
    SELECT 'patient', MAX(b.name), b.phone, 1, MIN(b.created_at), ?1 FROM bookings b
    WHERE b.patient_id IS NULL AND b.status != 'blocked' AND length(b.phone) = 10
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role='patient' AND u.phone=b.phone AND lower(u.name)=lower(b.name))
    GROUP BY b.phone, lower(b.name)`).bind(now).run();
  await env.DB.prepare(`UPDATE bookings SET patient_id = (SELECT u.id FROM users u WHERE u.role='patient' AND u.phone=bookings.phone AND lower(u.name)=lower(bookings.name) ORDER BY u.id LIMIT 1)
    WHERE patient_id IS NULL AND status != 'blocked'`).run();
}

// Find or create the patient user for this booking (same phone + same name = same patient; family members share a phone).
async function linkPatient(env, bookingId, name, phone, dob, consentAt) {
  const now = isoNow();
  let u = await env.DB.prepare("SELECT id, dob FROM users WHERE role='patient' AND phone=?1 AND lower(name)=lower(?2) ORDER BY id LIMIT 1").bind(phone, name).first();
  if (!u) {
    await env.DB.prepare("INSERT INTO users (role, name, phone, dob, active, created_at, updated_at) VALUES ('patient', ?1, ?2, ?3, 1, ?4, ?4)").bind(name, phone, dob, now).run();
    u = await env.DB.prepare("SELECT id, dob FROM users WHERE role='patient' AND phone=?1 AND lower(name)=lower(?2) ORDER BY id DESC LIMIT 1").bind(phone, name).first();
  } else if (dob && u.dob !== dob) {
    await env.DB.prepare("UPDATE users SET dob=?1, updated_at=?2 WHERE id=?3").bind(dob, now, u.id).run();
  }
  await env.DB.prepare("UPDATE bookings SET patient_id=?1, consent_at=COALESCE(consent_at, ?2) WHERE id=?3").bind(u.id, consentAt, bookingId).run();
}

// ---- passwords (PBKDF2-SHA256) and session tokens (only a SHA-256 of the token is stored) ----
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(String(s).match(/../g).map((h) => parseInt(h, 16)));
const PBKDF2_ITER = 100000; // the most Workers allow
async function pbkdf2(pw, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(pw, salt, PBKDF2_ITER)}`;
}
async function verifyPassword(pw, stored) {
  const [alg, iter, salt, want] = String(stored || "").split("$");
  if (alg !== "pbkdf2" || !salt || !want) return false;
  return safeEqual(await pbkdf2(pw, unhex(salt), parseInt(iter, 10)), want);
}
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// ---- brute-force protection: 8 failed tries per account (or 30 per IP) in 15 minutes ----
async function loginBlocked(env, keys) {
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  await env.DB.prepare("DELETE FROM login_fails WHERE at < ?1").bind(since).run();
  for (const [k, max] of keys) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE k=?1 AND at >= ?2").bind(k, since).first();
    if (r && r.n >= max) return true;
  }
  return false;
}
async function loginFailed(env, keys) {
  const now = isoNow();
  await env.DB.batch(keys.map(([k]) => env.DB.prepare("INSERT INTO login_fails (k, at) VALUES (?1, ?2)").bind(k, now)));
}
const ipOf = (req) => req.headers.get("cf-connecting-ip") || "local";

async function newSession(env, user, ms, extra = {}) {
  const token = randId(40, "abcdefghijklmnopqrstuvwxyz0123456789"), now = isoNow();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, role, phone, dob, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(await sha256(token), user.id, user.role, extra.phone || null, extra.dob || null, now, new Date(Date.now() + ms).toISOString()).run();
  await env.DB.prepare("UPDATE users SET last_login_at=?1 WHERE id=?2").bind(now, user.id).run();
  return token;
}
async function getSession(env, req, role) {
  const token = String(req.headers.get("x-session") || "").trim();
  if (!/^[a-z0-9]{40}$/.test(token)) return null;
  const s = await env.DB.prepare(`SELECT s.token_hash, s.phone AS s_phone, s.dob AS s_dob, u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash=?1 AND s.expires_at > ?2 AND s.role=?3 AND u.active=1`).bind(await sha256(token), isoNow(), role).first();
  return s || null;
}
async function logoutSession(env, req) {
  const token = String(req.headers.get("x-session") || "").trim();
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?1").bind(await sha256(token)).run();
  return json({ ok: true });
}

// ---- admin: collection centres ----
async function centresWithNumbers(env) {
  const [{ results: cs }, { results: nums }, { results: counts }] = await Promise.all([
    env.DB.prepare("SELECT * FROM centres ORDER BY active DESC, is_default DESC, name").all(),
    env.DB.prepare("SELECT id, centre_id, phone, name FROM centre_numbers ORDER BY centre_id, sort, id").all(),
    env.DB.prepare(`SELECT c.id,
        (SELECT COUNT(*) FROM bookings b WHERE b.centre_id=c.id AND b.status IN ('confirmed','collected','report_ready')) AS open_jobs,
        (SELECT COUNT(*) FROM bookings b WHERE b.centre_id=c.id) AS all_jobs,
        (SELECT COUNT(*) FROM users u WHERE u.centre_id=c.id AND u.role='centre') AS users
      FROM centres c`).all(),
  ]);
  return cs.map((c) => ({ ...c, numbers: nums.filter((n) => n.centre_id === c.id), ...(counts.find((x) => x.id === c.id) || {}) }));
}
async function adminCentres(env) { return json({ centres: await centresWithNumbers(env) }); }

function readCentre(b) {
  const name = clean(b.name, 120);
  if (name.length < 2) return { err: "Enter the centre's name." };
  const pin = clean(b.pincode, 6);
  if (pin && !/^\d{6}$/.test(pin)) return { err: "Pincode must be 6 digits." };
  const numbers = [], seen = new Set();
  for (const n of Array.isArray(b.numbers) ? b.numbers : []) {
    const raw = clean(n && n.phone, 20);
    if (!raw) continue;
    const phone = normPhone(raw);
    if (!phone) return { err: `${raw} is not a valid 10-digit mobile number.` };
    if (seen.has(phone)) return { err: `${phone} is listed twice.` };
    seen.add(phone);
    numbers.push({ phone, name: clean(n.name, 60) });
  }
  return { name, address: clean(b.address, 300), city: clean(b.city, 60), pincode: pin, contact_name: clean(b.contact_name, 80),
    notes: clean(b.notes, 500), active: b.active === false || b.active === 0 || b.active === "0" ? 0 : 1,
    is_default: b.is_default === true || b.is_default === 1 || b.is_default === "1" || b.is_default === "on" ? 1 : 0, numbers };
}
async function adminSaveCentre(env, req, id) {
  const c = readCentre(await req.json().catch(() => ({})));
  if (c.err) return bad(c.err);
  if (c.is_default && !c.active) return bad("A switched-off centre can't be the default. Tick “Active” or untick “Default”.");
  if (c.numbers.length) {
    const { results: taken } = await env.DB.prepare(`SELECT n.phone, c.name FROM centre_numbers n JOIN centres c ON c.id = n.centre_id
      WHERE n.phone IN (${c.numbers.map((_, i) => "?" + (i + 2)).join(",")}) AND n.centre_id != ?1`).bind(id || 0, ...c.numbers.map((n) => n.phone)).all();
    if (taken.length) return bad(`${taken[0].phone} is already registered under ${taken[0].name}.`, 409);
  }
  const now = isoNow();
  if (id) {
    const cur = await env.DB.prepare("SELECT id FROM centres WHERE id=?1").bind(id).first();
    if (!cur) return bad("Centre not found", 404);
    await env.DB.prepare("UPDATE centres SET name=?1, address=?2, city=?3, pincode=?4, contact_name=?5, notes=?6, active=?7, is_default=?8, updated_at=?9 WHERE id=?10")
      .bind(c.name, c.address, c.city, c.pincode, c.contact_name, c.notes, c.active, c.is_default, now, id).run();
  } else {
    const r = await env.DB.prepare("INSERT INTO centres (name, address, city, pincode, contact_name, notes, active, is_default, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)")
      .bind(c.name, c.address, c.city, c.pincode, c.contact_name, c.notes, c.active, c.is_default, now).run();
    id = r.meta.last_row_id;
  }
  if (c.is_default) await env.DB.prepare("UPDATE centres SET is_default=0 WHERE id != ?1").bind(id).run(); // only one default
  await env.DB.batch([
    env.DB.prepare("DELETE FROM centre_numbers WHERE centre_id=?1").bind(id),
    ...c.numbers.map((n, i) => env.DB.prepare("INSERT INTO centre_numbers (centre_id, phone, name, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, n.phone, n.name, i, now)),
  ]);
  return json({ ok: true, id });
}
async function adminDeleteCentre(env, id) {
  const c = (await centresWithNumbers(env)).find((x) => x.id === id);
  if (!c) return bad("Centre not found", 404);
  if (c.all_jobs) return bad(`${c.all_jobs} booking(s) were handled by this centre, so it can't be deleted. Untick "Active" to hide it instead.`, 409);
  if (c.users) return bad("Delete or move this centre's logins (Users tab) first.", 409);
  await env.DB.batch([env.DB.prepare("DELETE FROM centre_numbers WHERE centre_id=?1").bind(id), env.DB.prepare("DELETE FROM centres WHERE id=?1").bind(id)]);
  return json({ ok: true });
}
// Operator picks which centre does this booking (null = not assigned yet).
async function adminAssignCentre(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const cid = b.centre_id === null || b.centre_id === "" ? null : parseInt(b.centre_id, 10);
  if (cid !== null) {
    const c = await env.DB.prepare("SELECT id, active FROM centres WHERE id=?1").bind(cid || 0).first();
    if (!c) return bad("Centre not found", 404);
    if (!c.active) return bad("That centre is switched off. Turn it on in the Centres tab first.", 409);
  }
  const cur = await env.DB.prepare("SELECT centre_id FROM bookings WHERE id=?1 AND status != 'blocked'").bind(id).first();
  if (!cur) return bad("Booking not found", 404);
  await assignCentre(env, id, cid);
  if (cid && cid !== cur.centre_id) later(req, waEvent(env, "assigned", id));
  return json({ ok: true });
}
// a paid booking without a centre goes to the default centre (Centres tab → "Default"), if there is an active one
async function autoAssign(env, id) {
  const b = await env.DB.prepare("SELECT centre_id FROM bookings WHERE id=?1").bind(id).first();
  if (!b || b.centre_id) return;
  const c = await env.DB.prepare("SELECT id FROM centres WHERE is_default=1 AND active=1 ORDER BY id LIMIT 1").first();
  if (c) await assignCentre(env, id, c.id);
}
async function assignCentre(env, id, cid) {
  // a new centre starts fresh: not yet accepted, no collector, booking details not yet sent to it
  await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET centre_id=?1, centre_status=NULL, centre_status_at=NULL, collector_info=NULL, updated_at=?2 WHERE id=?3").bind(cid, isoNow(), id),
    env.DB.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('center','done:center','done:centre_ok','collector','done:collector')").bind(id),
  ]);
}

// ---- admin: users ----
async function adminUsers(env, url) {
  const role = url.searchParams.get("role") === "patient" ? "patient" : "centre";
  const q = clean(url.searchParams.get("q"), 60).toLowerCase();
  if (role === "centre") {
    const { results } = await env.DB.prepare(`SELECT u.id, u.role, u.name, u.phone, u.username, u.centre_id, u.active, u.last_login_at, u.created_at, c.name AS centre_name
      FROM users u LEFT JOIN centres c ON c.id = u.centre_id WHERE u.role='centre' ORDER BY u.active DESC, c.name, u.name`).all();
    return json({ users: results });
  }
  const like = "%" + q.replace(/[%_]/g, "") + "%";
  const { results } = await env.DB.prepare(`SELECT u.id, u.role, u.name, u.phone, u.dob, u.active, u.last_login_at, u.created_at,
      COUNT(b.id) AS bookings, MAX(b.date) AS last_date,
      (SELECT COUNT(*) FROM report_files f JOIN bookings x ON x.id = f.booking_id WHERE x.patient_id = u.id AND f.sent_at IS NOT NULL) AS reports
    FROM users u LEFT JOIN bookings b ON b.patient_id = u.id AND b.status NOT IN ('blocked','expired')
    WHERE u.role='patient' AND (?1 = '%%' OR lower(u.name) LIKE ?1 OR u.phone LIKE ?1)
    GROUP BY u.id ORDER BY MAX(COALESCE(b.created_at, u.created_at)) DESC LIMIT 1000`).bind(like).all();
  return json({ users: results });
}
async function adminSaveUser(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const now = isoNow();
  const cur = id ? await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(id).first() : null;
  if (id && !cur) return bad("User not found", 404);
  const role = cur ? cur.role : "centre"; // patients are only created from bookings
  const name = clean(b.name, 80);
  if (name.length < 2) return bad("Enter the name.");
  const active = b.active === false || b.active === 0 || b.active === "0" ? 0 : 1;
  const phone = b.phone ? normPhone(b.phone) : null;
  if (b.phone && !phone) return bad("Enter a valid 10-digit mobile number.");
  if (role === "patient") {
    const dob = b.dob ? cleanDob(b.dob) : null;
    if (b.dob && !dob) return bad("Enter a valid date of birth.");
    await env.DB.prepare("UPDATE users SET name=?1, dob=?2, active=?3, updated_at=?4 WHERE id=?5").bind(name, dob, active, now, id).run();
    return json({ ok: true, id });
  }
  const username = clean(b.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return bad("Username: 3–40 letters, numbers, dot, dash or underscore (no spaces).");
  const centreId = parseInt(b.centre_id, 10);
  if (!(await env.DB.prepare("SELECT 1 FROM centres WHERE id=?1").bind(centreId || 0).first())) return bad("Pick the user's collection centre.");
  const pw = String(b.password || "");
  if (!cur && pw.length < 8) return bad("Set a password of at least 8 characters.");
  if (pw && pw.length < 8) return bad("The new password must be at least 8 characters.");
  const dup = await env.DB.prepare("SELECT id FROM users WHERE username=?1 AND id != ?2").bind(username, id || 0).first();
  if (dup) return bad("That username is already taken.", 409);
  const hash = pw ? await hashPassword(pw) : null;
  if (cur) {
    await env.DB.prepare("UPDATE users SET name=?1, phone=?2, username=?3, centre_id=?4, active=?5, pass_hash=COALESCE(?6, pass_hash), updated_at=?7 WHERE id=?8")
      .bind(name, phone, username, centreId, active, hash, now, id).run();
    if (hash || !active) await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id).run(); // sign them out everywhere
    return json({ ok: true, id });
  }
  const r = await env.DB.prepare("INSERT INTO users (role, name, phone, username, pass_hash, centre_id, active, created_at, updated_at) VALUES ('centre', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
    .bind(name, phone, username, hash, centreId, active, now).run();
  return json({ ok: true, id: r.meta.last_row_id }, 201);
}
async function adminDeleteUser(env, id) {
  const u = await env.DB.prepare("SELECT role FROM users WHERE id=?1").bind(id).first();
  if (!u) return bad("User not found", 404);
  if (u.role === "patient") return bad("Patients come from bookings and can't be deleted. Untick “Active” to block their portal login.", 409);
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id), env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id)]);
  return json({ ok: true });
}

// ---- centre portal ----
async function centreLogin(env, req) {
  const b = await req.json().catch(() => ({}));
  const username = clean(b.username, 40).toLowerCase(), pw = String(b.password || "");
  const keys = [["c:" + username, 8], ["ip:" + ipOf(req), 30]];
  if (await loginBlocked(env, keys)) return bad("Too many wrong tries. Please wait 15 minutes.", 429);
  const u = await env.DB.prepare("SELECT * FROM users WHERE role='centre' AND username=?1 AND active=1").bind(username).first();
  if (!u || !(await verifyPassword(pw, u.pass_hash))) { await loginFailed(env, keys); return bad("Wrong username or password.", 401); }
  const c = await env.DB.prepare("SELECT id, name, active FROM centres WHERE id=?1").bind(u.centre_id).first();
  if (!c || !c.active) return bad("Your centre is not active. Please contact Dr. Sarwan Diagnostic Labs.", 403);
  const token = await newSession(env, u, CENTRE_SESSION_DAYS * 86400000);
  return json({ token, user: { name: u.name, username: u.username }, centre: { id: c.id, name: c.name } });
}
async function centreBookingRow(env, user, id) {
  return await env.DB.prepare(`SELECT * FROM bookings WHERE id=?1 AND centre_id=?2 AND status IN (${PAID_STATES.map((_, i) => "?" + (i + 3)).join(",")})`)
    .bind(id, user.centre_id, ...PAID_STATES).first();
}
async function centreBookings(env, user, url) {
  const today = istParts().date;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : addDays(today, -30);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") || "") ? url.searchParams.get("to") : addDays(today, BOOK_DAYS_AHEAD);
  const c = await env.DB.prepare("SELECT id, name FROM centres WHERE id=?1").bind(user.centre_id).first();
  const { results } = await env.DB.prepare(`SELECT id, date, slot, name, phone, address, pincode, city, state, cycle, notes, status, vial_no, collected_at, package_name, centre_status, collector_info
    FROM bookings WHERE centre_id=?1 AND date BETWEEN ?2 AND ?3 AND status IN (${PAID_STATES.map((_, i) => "?" + (i + 4)).join(",")}) ORDER BY date, slot`)
    .bind(user.centre_id, from, to, ...PAID_STATES).all();
  const ids = results.map((r) => r.id);
  let tests = [], files = [];
  if (ids.length) {
    const ph = ids.map((_, i) => "?" + (i + 1)).join(",");
    [{ results: tests }, { results: files }] = await Promise.all([
      env.DB.prepare(`SELECT booking_id, name FROM booking_tests WHERE booking_id IN (${ph}) ORDER BY id`).bind(...ids).all(),
      env.DB.prepare(`SELECT id, booking_id, name, size, created_at FROM report_files WHERE booking_id IN (${ph}) ORDER BY id`).bind(...ids).all(),
    ]);
  }
  for (const r of results) {
    r.slot_label = slotLabel(r.slot);
    r.tests = tests.filter((t) => t.booking_id === r.id).map((t) => t.name);
    r.reports = files.filter((f) => f.booking_id === r.id).map(({ booking_id, ...f }) => f);
  }
  return json({ centre: c, user: { name: user.name, username: user.username }, from, to, bookings: results });
}
async function centreCollected(env, user, req, id) {
  const row = await centreBookingRow(env, user, id);
  if (!row) return bad("Booking not found", 404);
  const b = await req.json().catch(() => ({}));
  const r = await markCollected(env, row, b.vial_no);
  if (r.err) return bad(r.err, 409);
  if (r.collected) later(req, waEvent(env, "collected", id));
  return json({ ok: true });
}
// centre (portal or WhatsApp) gives the vial no.: confirmed → collected, or a correction of the vial no.
async function markCollected(env, row, vialIn) {
  const vial = clean(vialIn, 40).toUpperCase().replace(/\s+/g, "");
  if (!vial) return { err: "Enter the vial number written on the sample." };
  const dup = await env.DB.prepare("SELECT id FROM bookings WHERE vial_no=?1 AND id!=?2 LIMIT 1").bind(vial, row.id).first();
  if (dup) return { err: `Vial ${vial} is already used for another booking. Check the number.` };
  const now = isoNow();
  if (row.status === "confirmed") {
    await env.DB.prepare("UPDATE bookings SET status='collected', vial_no=?1, collected_at=COALESCE(collected_at, ?2), updated_at=?2 WHERE id=?3 AND status='confirmed'").bind(vial, now, row.id).run();
    return { ok: true, collected: true, vial };
  }
  if (["collected", "report_ready", "completed"].includes(row.status)) {
    await env.DB.prepare("UPDATE bookings SET vial_no=?1, updated_at=?2 WHERE id=?3").bind(vial, now, row.id).run();
    return { ok: true, vial };
  }
  return { err: "This booking can't be marked collected." };
}
// centre takes the job (with the collector's name / mobile / time for the patient) or gives it back
async function centreAccept(env, user, req, id, what) {
  const row = await centreBookingRow(env, user, id);
  if (!row || row.status !== "confirmed") return bad("This booking can't be changed any more.", 409);
  const now = isoNow();
  if (what === "decline") {
    await env.DB.batch([
      env.DB.prepare("UPDATE bookings SET centre_id=NULL, centre_status='declined', centre_status_at=?1, collector_info=NULL, updated_at=?1 WHERE id=?2").bind(now, id),
      env.DB.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('center','done:center','done:centre_ok')").bind(id),
    ]);
    const c = await env.DB.prepare("SELECT name FROM centres WHERE id=?1").bind(user.centre_id).first();
    later(req, waEvent(env, "declined", id, { centre: c && c.name }));
    return json({ ok: true });
  }
  const b = await req.json().catch(() => ({}));
  const info = clean(b.collector, 200);
  if (info.length < 5) return bad("Enter the collector's name, mobile and arrival time.");
  await env.DB.prepare("UPDATE bookings SET centre_status='accepted', centre_status_at=COALESCE(centre_status_at, ?1), collector_info=?2, updated_at=?1 WHERE id=?3").bind(now, info, id).run();
  later(req, waEvent(env, "accepted", id));
  return json({ ok: true });
}
async function centreUpload(env, user, req, id) {
  if (!(await centreBookingRow(env, user, id))) return bad("Booking not found", 404);
  const r = await adminUploadReport(env, req, id); // same rules and same workflow step as the admin upload
  if (!r.ok) return r;
  const j = await r.json();
  return json({ ok: true, id: j.id }); // the centre doesn't get the patient's download link
}
async function centreReportFile(env, user, rid) {
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE f.id=?1 AND b.centre_id=?2").bind(rid, user.centre_id).first();
  return f ? fileResponse(env, f, f.patient) : bad("Report not found", 404);
}

// ---- patient portal (phone + date of birth) ----
const PATIENT_STATUS = {
  pending: "Waiting for payment", payment_submitted: "Payment being checked", confirmed: "Booked – collection scheduled",
  collected: "Sample collected – report in progress", report_ready: "Report in progress", completed: "Report ready",
  no_show: "Missed visit – please contact us", cancelled: "Cancelled", expired: "Not paid (expired)",
};
async function patientLogin(env, req) {
  const b = await req.json().catch(() => ({}));
  const phone = normPhone(b.phone), dob = cleanDob(b.dob);
  if (!phone) return bad("Enter your 10-digit mobile number.");
  if (!dob) return bad("Enter your date of birth.");
  const keys = [["p:" + phone, 8], ["ip:" + ipOf(req), 30]];
  if (await loginBlocked(env, keys)) return bad("Too many wrong tries. Please wait 15 minutes or WhatsApp us on 8368143677.", 429);
  const u = await env.DB.prepare("SELECT * FROM users WHERE role='patient' AND phone=?1 AND dob=?2 AND active=1 ORDER BY id LIMIT 1").bind(phone, dob).first();
  if (!u) { await loginFailed(env, keys); return bad("We couldn't find reports for this mobile number and date of birth. Check both, or WhatsApp us on 8368143677.", 401); }
  const token = await newSession(env, u, PATIENT_SESSION_HOURS * 3600000, { phone, dob });
  return json({ token, name: u.name });
}
// every patient user with this phone + DOB (a patient can appear under slightly different names)
const PATIENT_IDS = "SELECT id FROM users WHERE role='patient' AND active=1 AND phone=?1 AND dob=?2";
async function patientBookings(env, s) {
  const { results } = await env.DB.prepare(`SELECT id, date, slot, name, status, package_name, vial_no FROM bookings
    WHERE patient_id IN (${PATIENT_IDS}) AND status NOT IN ('blocked','expired') ORDER BY date DESC, slot DESC LIMIT 100`).bind(s.s_phone, s.s_dob).all();
  const ids = results.map((r) => r.id);
  let tests = [], files = [];
  if (ids.length) {
    const ph = ids.map((_, i) => "?" + (i + 1)).join(",");
    [{ results: tests }, { results: files }] = await Promise.all([
      env.DB.prepare(`SELECT booking_id, name FROM booking_tests WHERE booking_id IN (${ph}) ORDER BY id`).bind(...ids).all(),
      // a report shows here once the lab has released (sent) it – the same moment the WhatsApp step is done
      env.DB.prepare(`SELECT id, booking_id, name, size, sent_at FROM report_files WHERE booking_id IN (${ph}) AND sent_at IS NOT NULL ORDER BY id`).bind(...ids).all(),
    ]);
  }
  for (const r of results) {
    r.slot_label = slotLabel(r.slot);
    r.status_label = PATIENT_STATUS[r.status] || r.status;
    r.tests = tests.filter((t) => t.booking_id === r.id).map((t) => t.name);
    r.reports = files.filter((f) => f.booking_id === r.id).map(({ booking_id, ...f }) => f);
  }
  return json({ name: s.name, bookings: results });
}
async function patientReportFile(env, s, rid) {
  const f = await env.DB.prepare(`SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id
    WHERE f.id=?3 AND f.sent_at IS NOT NULL AND b.status NOT IN ('cancelled','blocked') AND b.patient_id IN (${PATIENT_IDS})`).bind(s.s_phone, s.s_dob, rid).first();
  return f ? fileResponse(env, f, f.patient) : bad("Report not found", 404);
}

// =====================================================================
// ---- WhatsApp Cloud API: settings, sending (automatic, with manual backup), webhook, bot menus ----
// =====================================================================
// Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
//   WA_TOKEN        – permanent System User access token (whatsapp_business_messaging + whatsapp_business_management)
//   WA_APP_SECRET   – the Meta app's App Secret (checks that webhook calls really come from Meta)
//   WA_VERIFY_TOKEN – any text; the same text goes in Meta → WhatsApp → Configuration → Webhook "Verify token"
// Everything else (phone number ID, mode, team numbers…) is set in Admin → WhatsApp.
const WA_DEFAULTS = { wa_mode: "manual", wa_phone_id: "", wa_waba_id: "1451717317036973", wa_version: "v25.0",
  team_numbers: "", auto_reports: "0", wa_down_until: "", wa_down_reason: "" };
const WA_SETTABLE = ["wa_mode", "wa_phone_id", "wa_waba_id", "wa_version", "team_numbers", "auto_reports"];

async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM settings").all();
  const S = { ...WA_DEFAULTS };
  for (const r of results) S[r.k] = r.v ?? "";
  return S;
}
async function setSettings(env, obj) {
  const e = Object.entries(obj);
  if (e.length) await env.DB.batch(e.map(([k, v]) => env.DB.prepare("INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, v == null ? "" : String(v))));
}
const teamNumbers = (S) => String(S.team_numbers || "").split(/[,;\s]+/).map((x) => normPhone(x)).filter(Boolean);
const waReady = (env, S) => !!(env.WA_TOKEN && S.wa_phone_id);
const waDown = (S) => !!(S.wa_down_until && S.wa_down_until > isoNow());
const waAuto = (env, S) => S.wa_mode === "auto" && waReady(env, S) && !waDown(S);

class WaError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
async function graph(env, S, path, { method = "GET", body, form } = {}) {
  // WA_GRAPH_URL is only for local testing against a fake API
  const r = await fetch(`${env.WA_GRAPH_URL || "https://graph.facebook.com"}/${S.wa_version || "v25.0"}/${path}`, {
    method, headers: { authorization: `Bearer ${env.WA_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    const msg = (e.error_user_msg || e.message || `WhatsApp API error ${r.status}`) + (e.error_data && e.error_data.details ? ` – ${e.error_data.details}` : "");
    throw new WaError(msg, e.code || r.status);
  }
  return j;
}
// errors that mean the whole API is unusable for us (token, payment method, account) → pause 30 minutes; messages go to "send by hand"
const WA_OUTAGE = [190, 10, 200, 3, 131031, 131042, 131005, 368, 500, 502, 503, 504];
async function noteOutage(env, e) {
  if (!WA_OUTAGE.includes(Number(e && e.code))) return;
  await setSettings(env, { wa_down_until: new Date(Date.now() + 30 * 60000).toISOString(), wa_down_reason: String(e.message).slice(0, 300) });
}
// Every message we send is also written to the chat history (Admin → Inbox).
// meta: { by: "bot" | "auto" | "team", text: what to show in the inbox (for templates) }
async function waSend(env, S, to, payload, meta = {}) {
  const j = await graph(env, S, `${S.wa_phone_id}/messages`, { method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", to: "91" + to, ...payload } });
  const id = j.messages && j.messages[0] ? j.messages[0].id : null;
  try {
    const med = payload.document || payload.image || null;
    await env.DB.prepare("INSERT OR IGNORE INTO wa_inbox (wa_id, phone, type, body, at, dir, by_who, status, media_id, media_type, media_name) VALUES (?1, ?2, ?3, ?4, ?5, 'out', ?6, 'sent', ?7, ?8, ?9)")
      .bind(id || `local-${crypto.randomUUID()}`, to, payload.type, String(meta.text || waSummary(payload)).slice(0, 4000), isoNow(), meta.by || "bot",
        med ? med.id || null : null, med ? (payload.document ? "application/pdf" : "image") : null, med ? med.filename || null : null).run();
  } catch (e) { console.log("chat log failed", String(e)); }
  return id;
}
function waSummary(p) {
  if (p.type === "text") return p.text.body;
  if (p.type === "interactive") {
    const i = p.interactive, opts = i.type === "button" ? i.action.buttons.map((b) => b.reply.title) : i.action.sections.flatMap((x) => x.rows.map((r) => r.title));
    return `${i.body.text}\n[ ${opts.join(" · ")} ]`;
  }
  if (p.type === "document") return p.document.caption || `📄 ${p.document.filename || "Document"}`;
  if (p.type === "image") return p.image.caption || "📷 Photo";
  if (p.type === "template") return `Template: ${p.template.name}`;
  return p.type;
}
const waText = (env, S, to, body, meta) => waSend(env, S, to, { type: "text", text: { body: String(body).slice(0, 4096), preview_url: false } }, meta);
const waButtons = (env, S, to, body, buttons, meta) => waSend(env, S, to, { type: "interactive", interactive: { type: "button", body: { text: String(body).slice(0, 1024) },
  action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } } }, meta);
const waList = (env, S, to, body, button, rows, meta) => waSend(env, S, to, { type: "interactive", interactive: { type: "list", body: { text: String(body).slice(0, 1024) },
  action: { button: button.slice(0, 20), sections: [{ title: "Choose", rows: rows.slice(0, 10).map((r) => ({ id: r.id.slice(0, 200), title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }] } } }, meta);
async function waMedia(env, S, mediaId) {
  const meta = await graph(env, S, mediaId);
  const r = await fetch(meta.url, { headers: { authorization: `Bearer ${env.WA_TOKEN}` } });
  if (!r.ok) throw new WaError("Could not download the file from WhatsApp", r.status);
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: meta.mime_type || r.headers.get("content-type") || "" };
}
async function waSendFile(env, S, to, bytes, mime, filename, caption, meta) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const up = await graph(env, S, `${S.wa_phone_id}/media`, { method: "POST", form });
  const cap = caption ? { caption: String(caption).slice(0, 1024) } : {};
  return mime === "application/pdf"
    ? waSend(env, S, to, { type: "document", document: { id: up.id, filename, ...cap } }, meta)
    : waSend(env, S, to, { type: "image", image: { id: up.id, ...cap } }, meta);
}
const waSendPdf = (env, S, to, bytes, filename, meta) => waSendFile(env, S, to, bytes, "application/pdf", filename, "", meta);
async function reportBytes(env, rid) {
  const { results } = await env.DB.prepare("SELECT data FROM report_parts WHERE report_id=?1 ORDER BY idx").bind(rid).all();
  return Uint8Array.from(atob(results.map((r) => r.data).join("")), (c) => c.charCodeAt(0));
}

// ---- message texts (defaults in public/shared/msgs.js, edits in msg_templates) ----
async function templates(env) {
  const { results } = await env.DB.prepare("SELECT * FROM msg_templates").all();
  return M.TEMPLATES.map((t) => {
    const o = results.find((r) => r.key === t.key) || {};
    return { ...t, default_body: t.body, body: o.body || t.body, custom: !!o.body, wa_id: o.wa_id || null, wa_status: o.wa_status || null, wa_reason: o.wa_reason || null, wa_body: o.wa_body || null };
  });
}
async function bookingFull(env, id) {
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!b) return null;
  const [{ results: tests }, { results: files }] = await Promise.all([
    env.DB.prepare("SELECT t.name, p.tests AS includes, p.prep FROM booking_tests t LEFT JOIN packages p ON p.id = t.package_id WHERE t.booking_id=?1 ORDER BY t.id").bind(id).all(),
    env.DB.prepare("SELECT id, name, size, sent_at FROM report_files WHERE booking_id=?1 ORDER BY id").bind(id).all(),
  ]);
  b.tests = tests; b.files = files;
  b.centre = b.centre_id ? await env.DB.prepare("SELECT id, name FROM centres WHERE id=?1").bind(b.centre_id).first() : null;
  const n = b.centre_id ? await env.DB.prepare("SELECT phone FROM centre_numbers WHERE centre_id=?1 ORDER BY sort, id LIMIT 1").bind(b.centre_id).first() : null;
  b.centre_phone = n ? n.phone : null;
  return b;
}
function msgFor(env, T, b, kind, extra = {}) {
  const t = T.find((x) => x.key === kind);
  if (!t) throw new Error("Unknown message " + kind);
  const v = M.vars(b, { tests: b.tests, cfg: { amount: amount(env), upiId: env.UPI_ID || "", visitFee: visitFee(env) }, centre: b.centre,
    files: extra.files || (b.files || []).filter((f) => !f.sent_at), sug: extra.sug, kind, alert: extra.alert });
  return { t, v, text: M.render(t.body, v) };
}
async function chatOpen(env, phone) {
  const c = await env.DB.prepare("SELECT last_in_at FROM wa_contacts WHERE phone=?1").bind(phone).first();
  return !!(c && c.last_in_at && Date.now() - Date.parse(c.last_in_at) < 23.5 * 3600000);
}
// One message to one number: as a normal message if they wrote to us in the last 24 hours, otherwise as the approved template.
async function sendOne(env, S, b, m, to) {
  const { t, v, text } = m;
  const btns = (t.buttons || []).map((x) => ({ id: `a:${x.id}:${b.id}`, title: x.text }));
  if (await chatOpen(env, to)) {
    if (btns.length && text.length <= 1024) return waButtons(env, S, to, text, btns, { by: "auto" });
    const id = await waText(env, S, to, text, { by: "auto" });
    if (btns.length) await waButtons(env, S, to, "Anything else?", btns, { by: "auto" });
    return id;
  }
  if (t.meta === false) throw new WaError("This message can only go out while the chat is open (the person wrote to us in the last 24 hours).", "window");
  if (t.wa_status !== "APPROVED") throw new WaError(`The WhatsApp template for “${t.label}” isn't approved yet (${t.wa_status ? t.wa_status.toLowerCase() : "not submitted"}) and the chat isn't open.`, "template");
  const { params } = M.metaBody(t.wa_body || t.body); // the variables of the version WhatsApp approved
  const comps = [];
  if (params.length) comps.push({ type: "body", parameters: params.map((k) => ({ type: "text", parameter_name: k, text: M.oneLine(v[k]).slice(0, 900) })) });
  (t.buttons || []).forEach((x, i) => comps.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: `a:${x.id}:${b.id}` }] }));
  return waSend(env, S, to, { type: "template", template: { name: t.wa_name, language: { code: "en" }, components: comps } },
    { by: "auto", text: text + (t.buttons && t.buttons.length ? `\n[ ${t.buttons.map((x) => x.text).join(" · ")} ]` : "") });
}
// Reports count as sent (and show in the patient portal) once the patient has been told they're ready.
async function releaseReports(env, b, reportIds) {
  const now = isoNow();
  const files = b.files || [];
  const want = Array.isArray(reportIds) && reportIds.length ? reportIds.map(Number) : files.filter((f) => !f.sent_at).map((f) => f.id);
  const marked = files.filter((f) => want.includes(f.id) && !f.sent_at).map((f) => f.id);
  const stmts = marked.map((rid) => env.DB.prepare("UPDATE report_files SET sent_at=?1 WHERE id=?2").bind(now, rid));
  if (files.length && files.every((f) => f.sent_at || marked.includes(f.id)) && b.status === "report_ready")
    stmts.push(env.DB.prepare("UPDATE bookings SET status='completed', completed_at=?1, updated_at=?1 WHERE id=?2").bind(now, b.id));
  if (stmts.length) await env.DB.batch(stmts);
  return marked;
}

// Send one of a booking's messages through WhatsApp.
// → { sent: true } or { manual: true, error } – then it waits in Admin → WhatsApp → "Send by hand" (same text, opened in WhatsApp).
async function deliver(env, bookingOrId, kind, opts = {}) {
  const S = opts.S || await getSettings(env);
  const b = typeof bookingOrId === "string" ? await bookingFull(env, bookingOrId) : bookingOrId;
  if (!b) return { manual: true, error: "Booking not found" };
  const T = opts.T || await templates(env);
  const files = kind === "report" && Array.isArray(opts.reportIds) && opts.reportIds.length ? (b.files || []).filter((f) => opts.reportIds.map(Number).includes(f.id)) : undefined;
  const m = msgFor(env, T, b, kind, { ...opts, files });
  const to = opts.to ? [opts.to] : m.t.to === "patient" ? [b.phone] : m.t.to === "centre" ? (b.centre_phone ? [b.centre_phone] : []) : teamNumbers(S);
  const now = isoNow();
  const fail = async (error, phone) => {
    await env.DB.prepare("INSERT INTO wa_outbox (booking_id, kind, to_phone, to_role, status, error, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'failed', ?5, ?6, ?6)")
      .bind(b.id, kind, phone || null, m.t.to, String(error).slice(0, 500), now).run();
    return { manual: true, error: String(error) };
  };
  if (!waReady(env, S)) return { manual: true, error: "The WhatsApp API isn't set up yet." };
  if (!to.length) return fail(m.t.to === "centre" ? (b.centre_id ? "This centre has no WhatsApp number." : "No collection centre chosen yet.") : m.t.to === "team" ? "No team numbers in Admin → WhatsApp." : "No mobile number.");
  if (waDown(S)) return fail(`WhatsApp API paused: ${S.wa_down_reason}`, to[0]);
  let sent = 0, lastErr = null;
  for (const phone of to) {
    try {
      const waId = await sendOne(env, S, b, m, phone);
      let logId = null;
      if (m.t.to !== "team" && !sent) logId = (await env.DB.prepare("INSERT INTO msg_log (booking_id, kind, at) VALUES (?1, ?2, ?3)").bind(b.id, kind, now).run()).meta.last_row_id;
      await env.DB.prepare("INSERT INTO wa_outbox (booking_id, kind, to_phone, to_role, status, wa_id, log_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'sent', ?5, ?6, ?7, ?7)")
        .bind(b.id, kind, phone, m.t.to, waId, logId, now).run();
      sent++;
    } catch (e) { lastErr = e; await noteOutage(env, e); }
  }
  if (sent) {
    const marked = kind === "report" ? await releaseReports(env, b, opts.reportIds) : [];
    return { sent: true, marked };
  }
  return fail(lastErr ? lastErr.message : "Not sent", to[0]);
}

// Things that happen in the workflow → the WhatsApp messages that go with them (only in automatic mode).
async function waEvent(env, ev, id, extra = {}) {
  const S = await getSettings(env);
  if (!waAuto(env, S)) return;
  const b = await bookingFull(env, id);
  if (!b) return;
  const T = await templates(env);
  const done = async (k) => !!(await env.DB.prepare("SELECT 1 FROM msg_log WHERE booking_id=?1 AND kind IN (?2, ?3) LIMIT 1").bind(id, k, "done:" + k).first());
  const once = async (k, o = {}) => { if (!(await done(k))) await deliver(env, b, k, { S, T, ...o }); };
  const team = (alert) => deliver(env, b, "team_alert", { S, T, alert });
  if (ev === "confirmed") {
    await once("confirm");
    if (b.centre_id) await once("center"); else await deliver(env, b, "team_paid", { S, T });
  } else if (ev === "assigned") await once("center");
  else if (ev === "accepted") await deliver(env, b, "collector", { S, T });
  else if (ev === "declined") await team(`${extra.centre || "The centre"} can't do this collection – please choose another centre`);
  else if (ev === "collected") await once("collected");
  else if (ev === "report") {
    if (S.auto_reports === "1") await deliver(env, b, "report", { S, T });
    else await team("Report uploaded – check it and send it to the patient");
  } else if (ev === "rescheduled") {
    if (b.centre_id) await deliver(env, b, "center", { S, T });
    await team(`The patient moved the visit to ${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}`);
  } else if (ev === "payment") await team("Payment screenshot received on WhatsApp – please verify");
}

// Every evening (cron): reminders for tomorrow's visits.
async function waDaily(env) {
  const S = await getSettings(env);
  await env.DB.prepare("DELETE FROM wa_inbox WHERE at < ?1").bind(new Date(Date.now() - 90 * 86400000).toISOString()).run();
  if (!waAuto(env, S)) return;
  const tomorrow = addDays(istParts().date, 1);
  const { results } = await env.DB.prepare(`SELECT id FROM bookings WHERE date=?1 AND status='confirmed'
    AND NOT EXISTS (SELECT 1 FROM msg_log l WHERE l.booking_id = bookings.id AND l.kind IN ('reminder','done:reminder'))
    AND phone NOT IN (SELECT phone FROM wa_contacts WHERE opted_out IS NOT NULL)`).bind(tomorrow).all();
  const T = await templates(env);
  for (const r of results) await deliver(env, r.id, "reminder", { S, T });
}

// ---- menus of the WhatsApp bot (titles editable in Admin → WhatsApp) ----
const MENU_ACTIONS = {
  patient: { my_bookings: "My bookings", status: "Track my test", prep: "How to prepare", resched: "Change date / time", pay: "Pay for my test", report: "Get my report", book: "Book a new test", talk: "Talk to our team" },
  centre: { c_new: "New jobs to accept", c_today: "Today's visits", c_vial: "Sample collected", c_upload: "Upload a report", c_jobs: "All open jobs" },
  team: { o_assign: "Choose centres", o_today: "Today's summary", o_failed: "Messages to send by hand" },
};
const MENU_DEFAULTS = [
  ["patient", "my_bookings", "My bookings", "Date, time and tests"], ["patient", "status", "Track my test", "Where your sample and report are"],
  ["patient", "prep", "How to prepare", "Fasting and other instructions"], ["patient", "resched", "Change date / time", "Pick a new slot"],
  ["patient", "pay", "Pay for my test", "UPI details and payment screenshot"], ["patient", "report", "Get my report", "Sent here after a date-of-birth check"],
  ["patient", "book", "Book a new test", "Open our booking page"], ["patient", "talk", "Talk to our team", "We'll call you back"],
  ["centre", "c_new", "New jobs to accept", "Accept or decline new visits"], ["centre", "c_today", "Today's visits", "Patients to visit today"],
  ["centre", "c_vial", "Sample collected", "Enter the vial no."], ["centre", "c_upload", "Upload a report", "Send the report PDF here"],
  ["centre", "c_jobs", "All open jobs", "Everything not finished yet"],
  ["team", "o_assign", "Choose centres", "Paid bookings without a centre"], ["team", "o_today", "Today's summary", "Visits, samples and reports"],
  ["team", "o_failed", "Messages to send by hand", "Messages the API couldn't send"],
];
async function seedWa(env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM menu_items").first();
  if (n && n.n) return;
  await env.DB.batch(MENU_DEFAULTS.map(([role, action, title, description], i) =>
    env.DB.prepare("INSERT INTO menu_items (role, action, title, description, sort, active) VALUES (?1, ?2, ?3, ?4, ?5, 1)").bind(role, action, title, description, i)));
}

// ---- webhook ----
async function waWebhookVerify(env, url) {
  if (url.searchParams.get("hub.mode") === "subscribe" && env.WA_VERIFY_TOKEN && safeEqual(url.searchParams.get("hub.verify_token") || "", env.WA_VERIFY_TOKEN))
    return new Response(url.searchParams.get("hub.challenge") || "", { status: 200, headers: { "content-type": "text/plain" } });
  return new Response("Forbidden", { status: 403 });
}
async function waWebhook(env, req) {
  if (!env.WA_APP_SECRET) return new Response("WhatsApp is not set up", { status: 503 });
  const raw = await req.text();
  const sig = String(req.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WA_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  if (!sig || !safeEqual(sig, want)) return new Response("Bad signature", { status: 401 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("ok"); }
  later(req, waProcess(env, body)); // answer Meta at once; do the work after
  return new Response("ok");
}
async function waProcess(env, body) {
  const S = await getSettings(env);
  for (const en of body.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {};
    // Meta tells us when a message text (template) is approved, rejected or paused
    if (ch.field === "message_template_status_update" && v.message_template_id && v.event) {
      const reason = v.reason && v.reason !== "NONE" ? String(v.reason).replace(/_/g, " ").toLowerCase() : null;
      await env.DB.prepare("UPDATE msg_templates SET wa_status=?1, wa_reason=?2, updated_at=?3 WHERE wa_id=?4")
        .bind(String(v.event).toUpperCase(), reason, isoNow(), String(v.message_template_id)).run().catch(() => {});
      continue;
    }
    if (S.wa_phone_id && v.metadata && v.metadata.phone_number_id && String(v.metadata.phone_number_id) !== String(S.wa_phone_id)) continue;
    for (const st of v.statuses || []) await waStatus(env, st);
    for (const msg of v.messages || []) {
      const c = (v.contacts || []).find((x) => x.wa_id === msg.from);
      try { await waInbound(env, S, msg, (c && c.profile && c.profile.name) || ""); }
      catch (e) { console.log("WhatsApp message failed", String(e && e.stack || e)); }
    }
  }
}
// delivery reports: sent → delivered → read, or failed (then the step is undone and it goes to "send by hand")
async function waStatus(env, st) {
  const R = { sent: 1, delivered: 2, read: 3, failed: 9 };
  if (R[st.status]) {
    const err = st.status === "failed" ? (st.errors || []).map((e) => e.title || e.message || "Failed").join("; ") : "";
    await env.DB.prepare(`UPDATE wa_inbox SET status=?1, body = CASE WHEN ?3 = '' THEN body ELSE body || ?3 END WHERE wa_id=?2 AND dir='out'
      AND CASE status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 9 ELSE 1 END < ?4`)
      .bind(st.status, st.id, err ? `\n⚠ Not delivered: ${err}` : "", R[st.status]).run().catch(() => {});
  }
  const o = await env.DB.prepare("SELECT * FROM wa_outbox WHERE wa_id=?1").bind(st.id).first();
  if (!o) return;
  const rank = { sent: 1, delivered: 2, read: 3 };
  if (st.status === "failed") {
    const err = (st.errors || []).map((e) => `${e.title || e.message || "Failed"}${e.error_data && e.error_data.details ? " – " + e.error_data.details : ""}`).join("; ") || "WhatsApp couldn't deliver it";
    const stmts = [env.DB.prepare("UPDATE wa_outbox SET status='failed', error=?1, updated_at=?2 WHERE id=?3").bind(err.slice(0, 500), isoNow(), o.id)];
    if (o.log_id) stmts.push(env.DB.prepare("DELETE FROM msg_log WHERE id=?1").bind(o.log_id));
    await env.DB.batch(stmts);
  } else if ((rank[st.status] || 0) > (rank[o.status] || 0)) {
    await env.DB.prepare("UPDATE wa_outbox SET status=?1, updated_at=?2 WHERE id=?3").bind(st.status, isoNow(), o.id).run();
  }
}

// ---- the bot: someone wrote to our number ----
const phone10 = (waId) => String(waId || "").replace(/\D/g, "").slice(-10);
async function waInbound(env, S, msg, name) {
  const phone = phone10(msg.from);
  if (phone.length !== 10) return;
  const now = isoNow();
  const text = msg.type === "text" ? String((msg.text && msg.text.body) || "").trim()
    : msg.type === "interactive" ? String((msg.interactive.button_reply && msg.interactive.button_reply.id) || (msg.interactive.list_reply && msg.interactive.list_reply.id) || "")
    : msg.type === "button" ? String((msg.button && (msg.button.payload || msg.button.text)) || "") : "";
  const med = msg[msg.type] && msg[msg.type].id ? msg[msg.type] : null; // image, document, audio, video, sticker
  const shown = msg.type === "interactive" ? String((msg.interactive.button_reply && msg.interactive.button_reply.title) || (msg.interactive.list_reply && msg.interactive.list_reply.title) || text)
    : msg.type === "button" ? String((msg.button && msg.button.text) || text)
    : med ? String(med.caption || med.filename || ({ image: "📷 Photo", document: "📄 Document", audio: "🎤 Voice message", video: "🎬 Video", sticker: "Sticker" }[msg.type] || msg.type))
    : msg.type === "location" ? `📍 Location ${msg.location.latitude},${msg.location.longitude}`
    : text || `(${msg.type})`;
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO wa_inbox (wa_id, phone, type, body, at, dir, media_id, media_type, media_name) VALUES (?1, ?2, ?3, ?4, ?5, 'in', ?6, ?7, ?8)")
    .bind(msg.id, phone, msg.type, shown.slice(0, 4000), now, med ? med.id : null, med ? med.mime_type || msg.type : null, med ? med.filename || null : null).run();
  if (!ins.meta.changes) return; // WhatsApp sometimes delivers the same message twice
  await env.DB.prepare(`INSERT INTO wa_contacts (phone, name, last_in_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(phone) DO UPDATE SET last_in_at=excluded.last_in_at, name=COALESCE(NULLIF(excluded.name, ''), wa_contacts.name)`).bind(phone, name, now).run();
  if (!waReady(env, S) || waDown(S)) return;
  const contact = await env.DB.prepare("SELECT * FROM wa_contacts WHERE phone=?1").bind(phone).first();
  const who = await waWho(env, S, phone);
  await new Bot(env, S, phone, who, contact).handle(msg, text);
}
async function waWho(env, S, phone) {
  if (teamNumbers(S).includes(phone)) return { role: "team" };
  const cn = await env.DB.prepare("SELECT n.centre_id, n.name, c.name AS centre FROM centre_numbers n JOIN centres c ON c.id = n.centre_id WHERE n.phone=?1 AND c.active=1").bind(phone).first();
  if (cn) return { role: "centre", centre_id: cn.centre_id, centre: cn.centre, name: cn.name };
  return { role: "patient" };
}
const parseDob = (s) => {
  const t = String(s || "").trim();
  let m = /^(\d{1,2})[\s./-](\d{1,2})[\s./-](\d{4})$/.exec(t);
  if (m) return cleanDob(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  return m ? cleanDob(t) : null;
};
const STATUS_LINE = { pending: "Waiting for payment", payment_submitted: "Payment received – being checked", confirmed: "Confirmed – visit scheduled",
  collected: "Sample collected – report in progress", report_ready: "Report in progress", completed: "Report ready", no_show: "Missed visit – please contact us" };
const SITE = "https://drsarwantests.com";

class Bot {
  constructor(env, S, phone, who, contact) { Object.assign(this, { env, S, phone, who, c: contact || {} }); this.db = env.DB; }
  say(t) { return waText(this.env, this.S, this.phone, t); }
  buttons(t, b) { return waButtons(this.env, this.S, this.phone, t, b); }
  list(t, btn, rows) { return waList(this.env, this.S, this.phone, t, btn, rows); }
  async state(s, data) { await this.db.prepare("UPDATE wa_contacts SET state=?1, state_data=?2, state_at=?3 WHERE phone=?4").bind(s, data == null ? null : String(data), s ? isoNow() : null, this.phone).run(); }
  team(id, alert) { return deliver(this.env, id, "team_alert", { S: this.S, alert }); }

  async handle(msg, text) {
    const role = this.who.role;
    const st = this.c.state && this.c.state_at && Date.now() - Date.parse(this.c.state_at) < 60 * 60000 ? this.c.state : null;
    if (text.startsWith("a:")) {
      const [, action, id, extra] = text.split(":");
      await this.state(null);
      return this.action(action, id, extra);
    }
    // someone from our team is chatting with this person in Admin → Inbox: the bot stays quiet unless they ask for the menu
    if (this.c.human_until && Date.parse(this.c.human_until) > Date.now() && !/^(menu|0)$/i.test(text)) return;
    if (msg.type === "document" || msg.type === "image") return this.media(msg, st);
    if (role === "patient" && /^(stop|unsubscribe)$/i.test(text)) {
      await this.state(null);
      await this.db.prepare("UPDATE wa_contacts SET opted_out=?1 WHERE phone=?2").bind(isoNow(), this.phone).run();
      return this.say("You won't get reminders from us any more. We'll still message you about a booking you make and send your reports here.\n\nReply *START* to turn reminders back on.");
    }
    if (role === "patient" && /^start$/i.test(text) && this.c.opted_out) {
      await this.db.prepare("UPDATE wa_contacts SET opted_out=NULL WHERE phone=?1").bind(this.phone).run();
      this.c.opted_out = null;
      await this.say("Reminders are back on ✅");
    }
    if (st && text && !/^(menu|hi|hello|hey|start|0|cancel)$/i.test(text)) return this.answer(st, this.c.state_data, text);
    await this.state(null);
    return this.menu(true);
  }
  async menu(greet) {
    const role = this.who.role;
    const { results } = await this.db.prepare("SELECT action, title, description FROM menu_items WHERE role=?1 AND active=1 ORDER BY sort, id LIMIT 10").bind(role).all();
    const rows = results.filter((r) => MENU_ACTIONS[role][r.action]).map((r) => ({ id: `a:${r.action}`, title: r.title, description: r.description || "" }));
    const hi = role === "centre" ? `Hi${this.who.name ? " " + this.who.name : ""} 👋 ${this.who.centre} – what would you like to do?`
      : role === "team" ? "Hi 👋 Dr. Sarwan Diagnostic Labs team menu."
      : `Hi${this.c.name ? " " + String(this.c.name).split(" ")[0] : ""} 👋 Welcome to *Dr. Sarwan Diagnostic Labs*. How can we help?`;
    if (!rows.length) return this.say(hi + "\n\nPlease call us on 8368143677.");
    return this.list(greet ? hi : "What else can we help with?", "Menu", rows);
  }

  // ---------- patients ----------
  async bookings(onlyOpen) {
    const { results } = await this.db.prepare(`SELECT * FROM bookings WHERE phone=?1 AND status NOT IN ('blocked','expired','cancelled')
      ${onlyOpen ? "AND status IN ('pending','payment_submitted','confirmed') AND date >= ?2" : "AND ?2 = ?2"} ORDER BY date DESC, slot DESC LIMIT 10`).bind(this.phone, addDays(istParts().date, onlyOpen ? 0 : -3650)).all();
    return results;
  }
  async pick(rows, action, prompt) { // more than one booking → let them choose
    if (rows.length === 1) return rows[0];
    await this.list(prompt, "Choose", rows.map((b) => ({ id: `a:${action}:${b.id}`, title: `${M.fmtDate(b.date)}`, description: `${M.slotLabel(b.slot)} · ${b.package_name || b.id}` })));
    return null;
  }
  async ownBooking(id) {
    const b = id ? await this.db.prepare("SELECT * FROM bookings WHERE id=?1 AND phone=?2 AND status != 'blocked'").bind(id, this.phone).first() : null;
    return b;
  }
  async action(a, id, extra) {
    const role = this.who.role;
    if (a === "menu") return this.menu(false);
    if (role === "centre" && a.startsWith("c_")) return this.centreAction(a, id, extra);
    if (role === "team" && a.startsWith("o_")) return this.teamAction(a, id, extra);
    if (a.startsWith("c_") || a.startsWith("o_")) return this.menu(false);
    return this.patientAction(a, id, extra);
  }
  async patientAction(a, id, extra) {
    const env = this.env;
    if (a === "my_bookings" || a === "status") {
      const rows = (await this.bookings(false)).slice(0, 5);
      if (!rows.length) return this.buttons(`We couldn't find a booking for this number.\nBook a home blood test at ${SITE}`, [{ id: "a:book", title: "Book a test" }, { id: "a:talk", title: "Talk to us" }]);
      const lines = [];
      for (const b of rows) {
        const full = await bookingFull(env, b.id);
        lines.push([`*${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}*`, `🧪 ${full.tests.map((t) => t.name).join(", ") || b.package_name || "Blood test"}`,
          `📌 ${STATUS_LINE[b.status] || b.status}`, a === "status" && b.collector_info && b.status === "confirmed" ? `👤 Collector: ${b.collector_info}` : null,
          a === "status" && b.vial_no ? `🧪 Vial no.: ${b.vial_no}` : null, `Ref ${b.id}`].filter(Boolean).join("\n"));
      }
      await this.say(lines.join("\n\n"));
      return this.menu(false);
    }
    if (a === "prep") {
      let b = id ? await this.ownBooking(id) : null;
      if (!b) { const rows = await this.bookings(true); b = rows.length ? await this.pick(rows, "prep", "Which test?") : null; if (!b && rows.length) return; }
      if (!b) return this.say("You don't have an upcoming test. Before most blood tests: fast for 10–12 hours (water is fine) unless your doctor says otherwise. Our team will tell you exactly what to do when you book.");
      const full = await bookingFull(env, b.id);
      await this.say(msgFor(env, await templates(env), full, "prep").text);
      return;
    }
    if (a === "book") return this.say(`Book a home blood test here: ${SITE}/#book\nOur phlebotomist comes to your home between 6 and 11 AM.`);
    if (a === "talk") {
      const rows = await this.bookings(false);
      await deliver(env, rows[0] ? rows[0].id : "", "team_alert", { S: this.S, alert: `+91 ${this.phone} (${this.c.name || "patient"}) asked to talk to the team` })
        .catch(() => {});
      if (!rows[0]) for (const t of teamNumbers(this.S)) await waText(env, this.S, t, `🔔 +91 ${this.phone} (${this.c.name || "new contact"}) asked to talk to the team on WhatsApp.`).catch(() => {});
      return this.say("Thanks! Someone from our team will call you shortly. You can also call us on 8368143677.");
    }
    if (a === "pay") {
      let b = id ? await this.ownBooking(id) : null;
      if (!b) {
        const { results } = await this.db.prepare(`SELECT * FROM bookings WHERE phone=?1 AND (status IN ('pending','expired') AND date >= ?2 OR (status='no_show' AND fee_due > 0 AND fee_paid_at IS NULL)) ORDER BY created_at DESC LIMIT 5`)
          .bind(this.phone, istParts().date).all();
        if (!results.length) return this.say("There's nothing to pay right now ✅ If you've just booked on our website, pay on the booking page or send the payment screenshot here.");
        b = await this.pick(results, "pay", "Which booking do you want to pay for?");
        if (!b) return;
      }
      const amt = b.status === "no_show" ? b.fee_due : b.amount;
      await this.state("proof", b.id);
      return this.say([`Please pay *${M.money(amt)}* by UPI to:`, `*${env.UPI_ID || "our UPI ID"}*`, `(${env.UPI_NAME || "Dr. Sarwan Diagnostic Labs"})`, "",
        "Then send the payment *screenshot* here. We'll confirm your booking as soon as we've checked it.", "", `Booking ${b.id} · ${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}`].join("\n"));
    }
    if (a === "report") {
      await this.state("dob", id || "");
      return this.say("To keep reports private, please reply with the patient's *date of birth* (DD-MM-YYYY), e.g. 14-05-1990.");
    }
    if (a === "resched") {
      let b = id ? await this.ownBooking(id) : null;
      if (!b) { const rows = await this.bookings(true); if (!rows.length) return this.say("You don't have an upcoming visit to change. Book a new one at " + SITE); b = await this.pick(rows, "resched", "Which visit do you want to move?"); if (!b) return; }
      if (!["pending", "payment_submitted", "confirmed", "expired"].includes(b.status)) return this.say("This visit can't be moved any more. Please call us on 8368143677.");
      const today = istParts().date, rows = [];
      for (let i = 0; i <= BOOK_DAYS_AHEAD && rows.length < 10; i++) {
        const d = addDays(today, i);
        let n = 0;
        for (const s of SLOTS) if (isBookable(d, s) && (await slotRoom(env, d, s, b.city, b.id)).ok) n++;
        if (n) rows.push({ id: `a:rs_d:${b.id}:${d.replace(/-/g, "")}`, title: M.fmtDate(d), description: `${n} time${n === 1 ? "" : "s"} free` });
      }
      if (!rows.length) return this.say("Sorry, there are no free times in the next two weeks. Please call us on 8368143677.");
      return this.list(`Your visit is on *${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}*. Pick a new day:`, "Choose day", rows);
    }
    if (a === "rs_d" || a === "rs_s") {
      const b = await this.ownBooking(id);
      if (!b || !["pending", "payment_submitted", "confirmed", "expired"].includes(b.status)) return this.say("This visit can't be moved any more. Please call us on 8368143677.");
      const d = String(extra || "").replace(/^(\d{4})(\d{2})(\d{2}).*$/, "$1-$2-$3");
      if (a === "rs_d") {
        const rows = [];
        for (const s of SLOTS) if (isBookable(d, s) && (await slotRoom(env, d, s, b.city, b.id)).ok) rows.push({ id: `a:rs_s:${b.id}:${d.replace(/-/g, "")}${s.replace(":", "")}`, title: M.slotLabel(s) });
        if (!rows.length) return this.say("That day just filled up. Please pick another day.").then(() => this.patientAction("resched", b.id));
        return this.list(`Pick a time on *${M.fmtDate(d)}*:`, "Choose time", rows.slice(0, 10));
      }
      const t = String(extra || "").slice(8);
      const slot = `${t.slice(0, 2)}:${t.slice(2, 4)}`;
      if (!SLOTS.includes(slot) || !isBookable(d, slot)) return this.say("That time isn't available any more. Please pick another.");
      const room = await slotRoom(env, d, slot, b.city, b.id);
      if (!room.ok) return this.say(room.msg);
      try {
        await env.DB.batch([
          env.DB.prepare("UPDATE bookings SET date=?1, slot=?2, status=CASE WHEN status='expired' THEN 'pending' ELSE status END, updated_at=?3 WHERE id=?4").bind(d, slot, isoNow(), b.id),
          env.DB.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('reminder','done:reminder')").bind(b.id),
        ]);
      } catch (e) { if (/UNIQUE/i.test(String(e))) return this.say("Someone just took that time. Please pick another."); throw e; }
      await this.say(`Done ✅ Your visit is now on *${M.fmtDate(d)}, ${M.slotLabel(slot)}*.${b.status === "pending" || b.status === "expired" ? "\n\nYour slot is reserved once the payment is received." : ""}`);
      if (["payment_submitted", "confirmed"].includes(b.status)) await waEvent(env, "rescheduled", b.id);
      return;
    }
    return this.menu(false);
  }
  async answer(st, data, text) {
    const env = this.env;
    if (this.who.role === "centre") return this.centreAnswer(st, data, text);
    if (st === "dob") {
      const dob = parseDob(text);
      const tries = (parseInt(String(data || "").split("|")[1] || "0", 10) || 0) + 1;
      const bid = String(data || "").split("|")[0];
      const users = dob ? (await this.db.prepare("SELECT id FROM users WHERE role='patient' AND active=1 AND phone=?1 AND dob=?2").bind(this.phone, dob).all()).results : [];
      if (!users.length) {
        if (tries >= 3) { await this.state(null); return this.say("That date of birth doesn't match our records. For your safety we've stopped here – please call us on 8368143677."); }
        await this.state("dob", `${bid}|${tries}`);
        return this.say(dob ? "That date of birth doesn't match our records for this number. Please check and try again (DD-MM-YYYY)." : "Please send the date of birth like this: 14-05-1990");
      }
      await this.state(null);
      const ids = users.map((u) => u.id);
      const { results: files } = await this.db.prepare(`SELECT f.id, f.name, b.id AS booking_id, b.date FROM report_files f JOIN bookings b ON b.id = f.booking_id
        WHERE f.sent_at IS NOT NULL AND b.status NOT IN ('cancelled','blocked') AND b.patient_id IN (${ids.map((_, i) => "?" + (i + 1)).join(",")})
        ${bid ? `AND b.id = ?${ids.length + 1}` : ""} ORDER BY b.date DESC, f.id LIMIT 6`).bind(...ids, ...(bid ? [bid] : [])).all();
      if (!files.length) return this.say("Your report isn't ready yet. We'll send it here as soon as it is 🙏");
      await this.say(`Here ${files.length === 1 ? "is your report" : "are your reports"} 📄`);
      for (const f of files) await waSendPdf(env, this.S, this.phone, await reportBytes(env, f.id), `${f.name.replace(/\.pdf$/i, "")}.pdf`);
      return this.say(`Please share ${files.length === 1 ? "it" : "them"} with your doctor. You can also open your reports at ${SITE}/reports/`);
    }
    return this.menu(true);
  }
  async media(msg, st) {
    const env = this.env;
    if (this.who.role === "centre") return this.centreMedia(msg, st);
    if (this.who.role === "team") return this.say("Thanks – files can be added from the admin page.");
    // a patient sending a picture: the payment screenshot
    let b = st === "proof" ? await this.ownBooking(this.c.state_data) : null;
    if (!b) {
      b = await this.db.prepare(`SELECT * FROM bookings WHERE phone=?1 AND (status IN ('pending','expired') AND date >= ?2 OR status='payment_submitted' OR (status='no_show' AND fee_due > 0 AND fee_paid_at IS NULL))
        ORDER BY created_at DESC LIMIT 1`).bind(this.phone, istParts().date).first();
    }
    if (!b || msg.type !== "image") return this.say("Thanks, we've received it. Our team will take a look 🙏").then(() => this.team(b ? b.id : "", `+91 ${this.phone} sent a ${msg.type} on WhatsApp`).catch(() => {}));
    const f = await waMedia(env, this.S, msg.image.id);
    if (!/^image\/(jpeg|png|webp)/.test(f.mime)) return this.say("Please send the payment screenshot as a photo (JPG or PNG).");
    const data = toB64(f.bytes);
    if (data.length > MAX_SHOT_CHARS) return this.say("That picture is too large. Please send a screenshot instead.");
    const now = isoNow();
    await this.db.prepare("INSERT INTO payment_proofs (booking_id, mime, data, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(booking_id) DO UPDATE SET mime=excluded.mime, data=excluded.data, created_at=excluded.created_at")
      .bind(b.id, f.mime.split(";")[0], data, now).run();
    if (["pending", "expired"].includes(b.status)) {
      const room = await slotRoom(env, b.date, b.slot, b.city, b.id);
      if (!room.ok || !isBookable(b.date, b.slot)) {
        await this.state(null);
        await this.say("Thanks, we've got your payment screenshot ✅ But your time slot isn't free any more – please pick a new time:");
        return this.patientAction("resched", b.id);
      }
      await this.db.prepare("UPDATE bookings SET status='payment_submitted', paid_at=?1, updated_at=?1 WHERE id=?2 AND status IN ('pending','expired')").bind(now, b.id).run();
    }
    await this.state(null);
    await this.say(`Thanks! We've received your payment screenshot for ${b.id} ✅ We'll confirm your booking as soon as we've checked it.`);
    return waEvent(env, "payment", b.id);
  }

  // ---------- collection centres ----------
  async jobs(where, binds = []) {
    const { results } = await this.db.prepare(`SELECT * FROM bookings WHERE centre_id=?1 AND ${where} ORDER BY date, slot LIMIT 10`).bind(this.who.centre_id, ...binds).all();
    return results;
  }
  async job(id) {
    return id ? await this.db.prepare(`SELECT * FROM bookings WHERE id=?1 AND centre_id=?2 AND status IN (${PAID_STATES.map((_, i) => "?" + (i + 3)).join(",")})`)
      .bind(id, this.who.centre_id, ...PAID_STATES).first() : null;
  }
  jobRows(rows, action) {
    return rows.map((b) => ({ id: `a:${action}:${b.id}`, title: `${M.fmtDate(b.date)} ${b.slot}`, description: `${b.name} · ${b.city || b.pincode}` }));
  }
  async centreAction(a, id) {
    const env = this.env, today = istParts().date;
    const listOr = async (rows, action, title, none) => (rows.length ? this.list(title, "Choose", this.jobRows(rows, action)) : this.say(none).then(() => this.menu(false)));
    if (a === "c_new") return listOr(await this.jobs("status='confirmed' AND centre_status IS NULL"), "c_job", "New jobs – choose one to accept or decline:", "No new jobs right now ✅");
    if (a === "c_today") return listOr(await this.jobs("date=?2 AND status IN ('confirmed','collected')", [today]), "c_job", "Today's visits:", "No visits today.");
    if (a === "c_jobs") return listOr(await this.jobs("status IN ('confirmed','collected','report_ready') AND date >= ?2", [addDays(today, -30)]), "c_job", "Open jobs:", "No open jobs ✅");
    if (a === "c_vial") return listOr(await this.jobs("status='confirmed' AND date <= ?2", [addDays(today, 1)]), "c_vialq", "Which patient's sample did you collect?", "No samples waiting to be collected.");
    if (a === "c_upload") return listOr(await this.jobs("status IN ('collected','report_ready')"), "c_up", "Which patient's report do you want to upload?", "No reports waiting.");
    const b = await this.job(id);
    if (!b) return this.say("That booking isn't with your centre any more.").then(() => this.menu(false));
    if (a === "c_job") {
      const full = await bookingFull(env, b.id);
      const rows = [];
      if (b.status === "confirmed") {
        if (b.centre_status !== "accepted") rows.push({ id: `a:c_accept:${b.id}`, title: "Accept", description: "We'll do this visit" }, { id: `a:c_decline:${b.id}`, title: "Can't do", description: "Give it to another centre" });
        rows.push({ id: `a:c_coll:${b.id}`, title: "Collector details", description: "Name, mobile and time for the patient" }, { id: `a:c_vialq:${b.id}`, title: "Sample collected", description: "Enter the vial no." });
      } else rows.push({ id: `a:c_up:${b.id}`, title: "Upload report", description: "Send the report PDF" }, { id: `a:c_vialq:${b.id}`, title: "Edit vial no.", description: b.vial_no || "" });
      rows.push({ id: "a:menu", title: "Back to menu" });
      return this.list(msgFor(env, await templates(env), full, "center").text.slice(0, 1000), "What next?", rows);
    }
    if (a === "c_accept") {
      await this.db.prepare("UPDATE bookings SET centre_status='accepted', centre_status_at=?1, updated_at=?1 WHERE id=?2").bind(isoNow(), b.id).run();
      await this.state("collector", b.id);
      return this.say(`Thank you ✅ Please reply with the *collector's name, mobile and arrival time* for ${b.name} – e.g.\nRamesh, 98765 43210, 8:30 AM\n\nWe'll send it to the patient.`);
    }
    if (a === "c_decline") {
      await this.db.prepare("UPDATE bookings SET centre_id=NULL, centre_status='declined', centre_status_at=?1, collector_info=NULL, updated_at=?1 WHERE id=?2").bind(isoNow(), b.id).run();
      await this.db.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('center','done:center','done:centre_ok')").bind(b.id).run();
      await this.say("Noted 👍 We'll give this visit to another centre.");
      return waEvent(env, "declined", b.id, { centre: this.who.centre });
    }
    if (a === "c_coll") { await this.state("collector", b.id); return this.say(`Reply with the *collector's name, mobile and arrival time* for ${b.name} – e.g.\nRamesh, 98765 43210, 8:30 AM`); }
    if (a === "c_vialq") { await this.state("vial", b.id); return this.say(`Reply with the *vial no.* written on ${b.name}'s sample.`); }
    if (a === "c_up") { await this.state("upload", b.id); return this.say(`Send ${b.name}'s report *PDF* here now (as a document). You can send more than one.`); }
    return this.menu(false);
  }
  async centreAnswer(st, id, text) {
    const env = this.env;
    const b = await this.job(id);
    if (!b) { await this.state(null); return this.menu(true); }
    if (st === "collector") {
      const info = clean(text, 200);
      if (info.length < 5) return this.say("Please send the collector's name, mobile and time, e.g. Ramesh, 98765 43210, 8:30 AM");
      await this.db.prepare("UPDATE bookings SET collector_info=?1, centre_status='accepted', centre_status_at=COALESCE(centre_status_at, ?2), updated_at=?2 WHERE id=?3").bind(info, isoNow(), b.id).run();
      await this.state(null);
      const S = this.S;
      if (waAuto(env, S)) { await waEvent(env, "accepted", b.id); await this.say("Saved ✅ We've sent the collector details to the patient."); }
      else await this.say("Saved ✅ Our team will share the details with the patient.");
      return this.menu(false);
    }
    if (st === "vial") {
      const r = await markCollected(env, b, text);
      if (r.err) return this.say(r.err + " Send the vial no. again.");
      await this.state(null);
      if (r.collected) await waEvent(env, "collected", b.id);
      await this.say(`Saved ✅ ${b.name} – vial *${r.vial}*${r.collected ? " – sample collected." : "."}`);
      return this.menu(false);
    }
    if (st === "upload") return this.say("Please send the report as a *PDF document* (📎 → Document).");
    return this.menu(true);
  }
  async centreMedia(msg, st) {
    const env = this.env;
    let id = st === "upload" ? this.c.state_data : null;
    const caption = (msg.document && msg.document.caption) || (msg.image && msg.image.caption) || "";
    const ref = /DSL-[A-Z0-9]{6}/i.exec(caption + " " + ((msg.document && msg.document.filename) || ""));
    if (ref) id = ref[0].toUpperCase();
    const b = await this.job(id);
    if (!b) return this.say("Which patient is this report for? Choose *Upload a report* in the menu first, then send the PDF.").then(() => this.centreAction("c_upload"));
    if (msg.type !== "document") return this.say("Please send the report as a *PDF document* (📎 → Document), not a photo.");
    if (!["collected", "report_ready", "completed"].includes(b.status)) return this.say(`First mark ${b.name}'s sample as collected (with the vial no.), then send the report.`);
    const f = await waMedia(env, this.S, msg.document.id);
    if (f.bytes.length > MAX_REPORT_BYTES) return this.say("That file is larger than 10 MB. Please send a smaller PDF.");
    if (String.fromCharCode(...f.bytes.subarray(0, 5)) !== "%PDF-") return this.say("That isn't a PDF. Please send the report as a PDF document.");
    await storeReport(env, b.id, f.bytes, clean(msg.document.filename || `${b.vial_no || b.id}.pdf`, 120));
    await waEvent(env, "report", b.id);
    return this.say(`Report saved for ${b.name} ✅ Send another PDF if there's more, or type *menu*.`);
  }

  // ---------- our team ----------
  async teamAction(a, id, extra) {
    const env = this.env, today = istParts().date;
    if (a === "o_assign") {
      if (!id) {
        const { results } = await this.db.prepare("SELECT * FROM bookings WHERE status IN ('confirmed') AND centre_id IS NULL AND date >= ?1 ORDER BY date, slot LIMIT 10").bind(addDays(today, -1)).all();
        if (!results.length) return this.say("Every paid booking has a centre ✅").then(() => this.menu(false));
        return this.list("Paid bookings without a centre:", "Choose", results.map((b) => ({ id: `a:o_assign:${b.id}`, title: `${M.fmtDate(b.date)} ${b.slot}`, description: `${b.name} · ${b.city || b.pincode}` })));
      }
      const b = await this.db.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
      if (!b) return this.say("Booking not found.");
      const { results: cs } = await this.db.prepare("SELECT id, name, city FROM centres WHERE active=1 ORDER BY name LIMIT 10").all();
      if (!cs.length) return this.say("No active centres. Add one in the admin page → Centres.");
      return this.list(`${b.id} · ${b.name}\n${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}\n📍 ${[b.address, b.city, b.pincode].filter(Boolean).join(", ")}\n\nWhich centre?`, "Choose centre",
        cs.map((c) => ({ id: `a:o_set:${b.id}:${c.id}`, title: c.name, description: c.city || "" })));
    }
    if (a === "o_set") {
      const b = await this.db.prepare("SELECT id, name FROM bookings WHERE id=?1 AND status != 'blocked'").bind(id).first();
      const c = await this.db.prepare("SELECT id, name FROM centres WHERE id=?1 AND active=1").bind(parseInt(extra, 10) || 0).first();
      if (!b || !c) return this.say("Couldn't do that – the booking or centre wasn't found.");
      await assignCentre(env, b.id, c.id);
      await waEvent(env, "assigned", b.id);
      await this.say(`✅ ${b.name} (${b.id}) → ${c.name}.${waAuto(env, this.S) ? " The booking details were sent to the centre." : ""}`);
      return this.teamAction("o_assign");
    }
    if (a === "o_today") {
      const { results } = await this.db.prepare("SELECT status, COUNT(*) AS n FROM bookings WHERE date=?1 AND status NOT IN ('blocked','expired','cancelled') GROUP BY status").bind(today).all();
      const un = await this.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed' AND centre_id IS NULL AND date >= ?1").bind(today).first();
      const verify = await this.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='payment_submitted'").first();
      const send = await this.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='report_ready'").first();
      const fails = await this.db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE status='failed' AND to_role != 'team' AND created_at >= ?1").bind(new Date(Date.now() - 7 * 86400000).toISOString()).first();
      return this.say([`📊 *Today (${M.fmtDate(today)})*`, ...results.map((r) => `• ${STATUS_LINE[r.status] || r.status}: ${r.n}`), "",
        `💳 Payments to verify: ${verify.n}`, `🏥 Paid, no centre yet: ${un.n}`, `📄 Reports to send: ${send.n}`, `✋ Messages to send by hand: ${fails.n}`, "", `${SITE}/admin/`].join("\n"));
    }
    if (a === "o_failed") {
      const r = await this.db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE status='failed' AND to_role != 'team' AND created_at >= ?1").bind(new Date(Date.now() - 7 * 86400000).toISOString()).first();
      return this.say(r.n ? `✋ ${r.n} message${r.n === 1 ? "" : "s"} couldn't be sent automatically. Open ${SITE}/admin/ → WhatsApp → *Send by hand*.` : "Nothing to send by hand ✅");
    }
    return this.menu(false);
  }
}

// ---- admin: WhatsApp settings, texts, menus, messages to send by hand ----
async function adminWa(env, url) {
  const S = await getSettings(env);
  const [T, { results: menus }, { results: failed }] = await Promise.all([
    templates(env),
    env.DB.prepare("SELECT * FROM menu_items ORDER BY role, sort, id").all(),
    env.DB.prepare(`SELECT o.*, b.name AS patient FROM wa_outbox o LEFT JOIN bookings b ON b.id = o.booking_id
      WHERE o.status='failed' AND o.to_role != 'team' AND o.created_at >= ?1 ORDER BY o.id DESC LIMIT 50`).bind(new Date(Date.now() - 14 * 86400000).toISOString()).all(),
  ]);
  const { results: recent } = await env.DB.prepare(`SELECT o.id, o.booking_id, o.kind, o.to_phone, o.to_role, o.status, o.error, o.created_at, b.name AS patient
    FROM wa_outbox o LEFT JOIN bookings b ON b.id = o.booking_id ORDER BY o.id DESC LIMIT 30`).all();
  // the exact text to send by hand for each failed message
  const cache = {};
  for (const f of failed) {
    try {
      const b = cache[f.booking_id] || (cache[f.booking_id] = await bookingFull(env, f.booking_id));
      f.text = b ? msgFor(env, T, b, f.kind).text : "";
      f.to_phone = f.to_phone || (b ? (f.to_role === "centre" ? b.centre_phone : b.phone) : "");
    } catch { f.text = ""; }
  }
  return json({
    settings: Object.fromEntries(Object.entries(S).filter(([k]) => k in WA_DEFAULTS)),
    secrets: { WA_TOKEN: !!env.WA_TOKEN, WA_APP_SECRET: !!env.WA_APP_SECRET, WA_VERIFY_TOKEN: !!env.WA_VERIFY_TOKEN },
    ready: waReady(env, S), auto: waAuto(env, S), down: waDown(S),
    webhook: `${url.origin}/api/wa/webhook`, templates: T, vars: M.VARS, menus, actions: MENU_ACTIONS, failed, recent,
  });
}
// ---- Admin → Inbox: every WhatsApp conversation, and replies from the team ----
async function chatPeople(env, S, phones) {
  const out = {};
  if (!phones.length) return out;
  const team = teamNumbers(S);
  const q = phones.map((_, i) => `?${i + 1}`).join(",");
  const [{ results: cs }, { results: cn }, { results: bk }] = await Promise.all([
    env.DB.prepare(`SELECT phone, name, last_in_at, read_at, human_until, opted_out FROM wa_contacts WHERE phone IN (${q})`).bind(...phones).all(),
    env.DB.prepare(`SELECT n.phone, n.name, c.name AS centre FROM centre_numbers n JOIN centres c ON c.id = n.centre_id WHERE n.phone IN (${q})`).bind(...phones).all(),
    env.DB.prepare(`SELECT phone, name, id, date, status FROM bookings WHERE phone IN (${q}) AND status NOT IN ('blocked') ORDER BY created_at DESC`).bind(...phones).all(),
  ]);
  for (const ph of phones) {
    const c = cs.find((x) => x.phone === ph) || {}, n = cn.find((x) => x.phone === ph), b = bk.find((x) => x.phone === ph);
    const role = team.includes(ph) ? "team" : n ? "centre" : "patient";
    out[ph] = {
      phone: ph, role, wa_name: c.name || "", name: role === "centre" ? `${n.centre}${n.name ? " · " + n.name : ""}` : role === "team" ? `Team${c.name ? " · " + c.name : ""}` : (b && b.name) || c.name || "",
      last_in_at: c.last_in_at || null, read_at: c.read_at || null, open: !!(c.last_in_at && Date.now() - Date.parse(c.last_in_at) < 23.5 * 3600000),
      human_until: c.human_until && Date.parse(c.human_until) > Date.now() ? c.human_until : null, opted_out: !!c.opted_out,
      bookings: bk.filter((x) => x.phone === ph).slice(0, 5).map((x) => ({ id: x.id, date: x.date, status: x.status })),
    };
  }
  return out;
}
async function adminChats(env) {
  const S = await getSettings(env);
  const { results } = await env.DB.prepare(`SELECT i.phone, MAX(i.id) AS last_id,
      SUM(CASE WHEN COALESCE(i.dir, 'in') = 'in' AND i.at > COALESCE(c.read_at, '') THEN 1 ELSE 0 END) AS unread
    FROM wa_inbox i LEFT JOIN wa_contacts c ON c.phone = i.phone GROUP BY i.phone ORDER BY last_id DESC LIMIT 300`).all();
  const last = {};
  for (let i = 0; i < results.length; i += 90) {
    const ids = results.slice(i, i + 90).map((r) => r.last_id);
    const { results: rows } = await env.DB.prepare(`SELECT id, phone, body, at, dir, by_who, status FROM wa_inbox WHERE id IN (${ids.map((_, k) => `?${k + 1}`).join(",")})`).bind(...ids).all();
    for (const r of rows) last[r.phone] = r;
  }
  const people = {};
  for (let i = 0; i < results.length; i += 90) Object.assign(people, await chatPeople(env, S, results.slice(i, i + 90).map((r) => r.phone)));
  return json({ chats: results.map((r) => ({ ...people[r.phone], unread: r.unread || 0, last: last[r.phone] || null })), ready: waReady(env, S) });
}
async function adminChat(env, phone) {
  const S = await getSettings(env);
  const { results } = await env.DB.prepare("SELECT id, wa_id, type, body, at, dir, by_who, status, media_id, media_type, media_name FROM wa_inbox WHERE phone=?1 ORDER BY id DESC LIMIT 300").bind(phone).all();
  await env.DB.prepare(`INSERT INTO wa_contacts (phone, read_at) VALUES (?1, ?2) ON CONFLICT(phone) DO UPDATE SET read_at=excluded.read_at`).bind(phone, isoNow()).run();
  const who = (await chatPeople(env, S, [phone]))[phone];
  return json({ who, messages: results.reverse().map((m) => ({ ...m, dir: m.dir || "in" })), ready: waReady(env, S) });
}
const CHAT_FILE_MAX = 10 * 1024 * 1024;
async function adminChatSend(env, req, phone) {
  const S = await getSettings(env);
  if (!waReady(env, S)) return bad("The WhatsApp API isn't set up yet (Admin → WhatsApp).");
  if (!(await chatOpen(env, phone)))
    return bad("WhatsApp only allows a free message within 24 hours of this person's last message. Use a booking's message buttons (they go out as approved templates), or wait for them to write to us.", 409);
  let text = "", file = null;
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const fd = await req.formData();
    text = String(fd.get("text") || "").trim();
    const f = fd.get("file");
    if (f && typeof f === "object" && f.size) {
      if (f.size > CHAT_FILE_MAX) return bad("Files can be up to 10 MB.");
      const mime = f.type === "application/pdf" ? "application/pdf" : /^image\/(jpeg|png)$/.test(f.type) ? f.type : null;
      if (!mime) return bad("You can send a PDF or a JPG/PNG photo.");
      file = { bytes: new Uint8Array(await f.arrayBuffer()), mime, name: clean(f.name || (mime === "application/pdf" ? "document.pdf" : "photo.jpg"), 120) };
    }
  } else {
    const b = await req.json().catch(() => ({}));
    text = String(b.text || "").trim();
  }
  if (!text && !file) return bad("Type a message first.");
  if (text.length > 4000) return bad("That message is too long (4000 characters max).");
  try {
    if (file) await waSendFile(env, S, phone, file.bytes, file.mime, file.name, file.mime === "application/pdf" ? "" : text, { by: "team", ...(file.mime === "application/pdf" ? {} : text ? { text } : {}) });
    if (text && (!file || file.mime === "application/pdf")) await waText(env, S, phone, text, { by: "team" });
  } catch (e) { return bad(`WhatsApp said: ${e.message}`, 502); }
  // the bot stays quiet in this chat for an hour, so it doesn't interrupt the conversation
  const until = new Date(Date.now() + 60 * 60000).toISOString();
  await env.DB.prepare("UPDATE wa_contacts SET human_until=?1, state=NULL, read_at=?2 WHERE phone=?3").bind(until, isoNow(), phone).run();
  return json({ ok: true, human_until: until });
}
async function adminChatBot(env, req, phone) {
  const b = await req.json().catch(() => ({}));
  const until = b.pause ? new Date(Date.now() + 60 * 60000).toISOString() : null;
  await env.DB.prepare(`INSERT INTO wa_contacts (phone, human_until) VALUES (?1, ?2) ON CONFLICT(phone) DO UPDATE SET human_until=excluded.human_until`).bind(phone, until).run();
  return json({ ok: true, human_until: until });
}
async function adminChatMedia(env, id) {
  const row = await env.DB.prepare("SELECT media_id, media_type, media_name FROM wa_inbox WHERE id=?1").bind(id).first();
  if (!row || !row.media_id) return bad("No file", 404);
  const S = await getSettings(env);
  try {
    const f = await waMedia(env, S, row.media_id);
    const name = (row.media_name || `whatsapp-${id}`).replace(/[^\w.\- ]/g, "_");
    return new Response(f.bytes, { headers: { "content-type": f.mime || "application/octet-stream", "content-disposition": `inline; filename="${name}"`, "cache-control": "private, max-age=3600" } });
  } catch (e) { return bad("WhatsApp no longer has this file (files are kept for about 30 days).", 410); }
}
async function adminWaSettings(env, req) {
  const b = await req.json().catch(() => ({}));
  const set = {};
  for (const k of WA_SETTABLE) if (k in b) set[k] = clean(b[k], 300);
  if ("wa_mode" in set && !["manual", "auto"].includes(set.wa_mode)) return bad("Choose manual or automatic.");
  if ("wa_phone_id" in set && set.wa_phone_id && !/^\d{6,25}$/.test(set.wa_phone_id)) return bad("The phone number ID is a long number (WhatsApp → API Setup).");
  if ("wa_waba_id" in set && set.wa_waba_id && !/^\d{6,25}$/.test(set.wa_waba_id)) return bad("The WhatsApp account ID is a long number.");
  if ("wa_version" in set && !/^v\d{2}\.\d$/.test(set.wa_version)) return bad("API version looks like v25.0");
  if ("team_numbers" in set) {
    const raw = set.team_numbers.split(/[,;\s]+/).filter(Boolean);
    const bad1 = raw.find((x) => !normPhone(x));
    if (bad1) return bad(`${bad1} isn't a valid 10-digit mobile number.`);
    set.team_numbers = raw.map((x) => normPhone(x)).join(", ");
  }
  if ("auto_reports" in set) set.auto_reports = b.auto_reports === true || b.auto_reports === "1" ? "1" : "0";
  if (b.resume) Object.assign(set, { wa_down_until: "", wa_down_reason: "" });
  await setSettings(env, set);
  return json({ ok: true });
}
async function adminWaTest(env) {
  const S = await getSettings(env);
  if (!env.WA_TOKEN) return bad("The WA_TOKEN secret isn't set in Cloudflare yet.");
  if (!S.wa_phone_id) return bad("Enter the phone number ID first.");
  try {
    const p = await graph(env, S, `${S.wa_phone_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status,messaging_limit_tier`);
    await setSettings(env, { wa_down_until: "", wa_down_reason: "" });
    return json({ ok: true, phone: p });
  } catch (e) { return bad(`WhatsApp said: ${e.message}`, 502); }
}
async function adminWaSaveTemplate(env, req, key, reset) {
  if (!M.TEMPLATES.some((t) => t.key === key)) return bad("Unknown message", 404);
  const body = reset ? null : String((await req.json().catch(() => ({}))).body || "").replace(/\r/g, "").trim();
  if (!reset && (body.length < 5 || body.length > 4000)) return bad("The text must be 5 to 4,000 characters.");
  const unknown = !reset && Array.from(body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g), (m) => m[1]).find((k) => !M.VARS.some(([n]) => n === k));
  if (unknown) return bad(`{{${unknown}}} isn't one of the values that can be filled in.`);
  await env.DB.prepare("INSERT INTO msg_templates (key, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at").bind(key, body, isoNow()).run();
  return json({ ok: true });
}
// Send a text to WhatsApp for approval as a template (needed to message people who haven't written to us in 24 hours).
async function adminWaSubmit(env, key) {
  const S = await getSettings(env);
  if (!env.WA_TOKEN) return bad("Add the WA_TOKEN secret in Cloudflare first.");
  if (!S.wa_waba_id) return bad("Enter the WhatsApp account ID first.");
  const t = (await templates(env)).find((x) => x.key === key);
  if (!t) return bad("Unknown message", 404);
  if (t.meta === false) return bad("This message only goes out inside an open chat, so it doesn't need WhatsApp's approval.");
  const { text, params } = M.metaBody(t.body);
  if (text.length > 1024) return bad(`The WhatsApp version is ${text.length} characters; WhatsApp allows 1,024. Shorten the text.`);
  if (/^\s*\{\{/.test(text) || /\}\}\s*$/.test(text)) return bad("WhatsApp doesn't allow a template to start or end with a {{value}}. Add a few words before / after it.");
  const ex = M.vars({ id: "DSL-AB12CD", name: "Asha Verma", phone: "9811122233", date: addDays(istParts().date, 2), slot: "07:30", address: "Flat 302, Sunrise Apartments, Sector 7",
    city: "New Delhi", state: "Delhi", pincode: "110075", amount: 1899, vial_no: "AB1234", notes: "Gate 2", collector_info: "Ramesh, 98765 43210, 8:30 AM", status: "confirmed" },
  { tests: [{ name: "FEMALE FERTILITY", includes: "FSH, LH, AMH, TSH" }], cfg: { amount: 1899, upiId: env.UPI_ID || "lab@upi", visitFee: 300 }, centre: { name: "Dwarka Sector 7 centre" }, alert: "Report uploaded" });
  const comps = [{ type: "BODY", text, ...(params.length ? { example: { body_text_named_params: params.map((k) => ({ param_name: k, example: M.oneLine(ex[k]).slice(0, 200) })) } } : {}) }];
  if (t.buttons.length) comps.push({ type: "BUTTONS", buttons: t.buttons.map((x) => ({ type: "QUICK_REPLY", text: x.text })) });
  try {
    let id = t.wa_id, status = "PENDING";
    if (id) await graph(env, S, id, { method: "POST", body: { components: comps } }); // edit the existing template
    else {
      const j = await graph(env, S, `${S.wa_waba_id}/message_templates`, { method: "POST", body: { name: t.wa_name, language: "en", category: "UTILITY", parameter_format: "NAMED", components: comps } });
      id = j.id; status = j.status || "PENDING";
    }
    await env.DB.prepare(`INSERT INTO msg_templates (key, wa_id, wa_status, wa_reason, wa_body, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5)
      ON CONFLICT(key) DO UPDATE SET wa_id=excluded.wa_id, wa_status=excluded.wa_status, wa_reason=NULL, wa_body=excluded.wa_body, updated_at=excluded.updated_at`).bind(key, id, status, t.body, isoNow()).run();
    return json({ ok: true, status });
  } catch (e) {
    if (/already exists|2388024|2388023/i.test(e.message)) { await adminWaSync(env); return bad("WhatsApp already has a template with this name – its status has been loaded. Press Submit again to update it."); }
    return bad(`WhatsApp said: ${e.message}`, 400);
  }
}
async function adminWaSync(env) {
  const S = await getSettings(env);
  if (!env.WA_TOKEN || !S.wa_waba_id) return bad("Set the WA_TOKEN secret and the WhatsApp account ID first.");
  let j;
  try { j = await graph(env, S, `${S.wa_waba_id}/message_templates?fields=id,name,status,language,rejected_reason,components&limit=200`); }
  catch (e) { return bad(`WhatsApp said: ${e.message}`, 502); }
  const { results: rows } = await env.DB.prepare("SELECT key, wa_body FROM msg_templates").all();
  const stmts = [];
  for (const t of M.TEMPLATES) {
    if (t.meta === false) continue;
    const m = (j.data || []).find((d) => d.name === t.wa_name && /^en/.test(d.language || ""));
    if (!m) continue;
    const have = rows.find((r) => r.key === t.key);
    const metaText = ((m.components || []).find((c) => c.type === "BODY") || {}).text || null;
    stmts.push(env.DB.prepare(`INSERT INTO msg_templates (key, wa_id, wa_status, wa_reason, wa_body, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(key) DO UPDATE SET wa_id=excluded.wa_id, wa_status=excluded.wa_status, wa_reason=excluded.wa_reason, wa_body=COALESCE(msg_templates.wa_body, excluded.wa_body), updated_at=excluded.updated_at`)
      .bind(t.key, m.id, m.status, m.rejected_reason && m.rejected_reason !== "NONE" ? m.rejected_reason : null, have && have.wa_body ? have.wa_body : metaText, isoNow()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, found: stmts.length });
}
async function adminWaMenu(env, req) {
  const b = await req.json().catch(() => ({}));
  const role = b.role;
  if (!MENU_ACTIONS[role]) return bad("Unknown menu");
  const items = (Array.isArray(b.items) ? b.items : []).filter((x) => MENU_ACTIONS[role][x.action]);
  if (items.filter((x) => x.active !== false).length > 10) return bad("WhatsApp menus can show at most 10 options. Switch some off.");
  for (const x of items) {
    if (!clean(x.title, 24)) return bad("Every option needs a title.");
    if (String(x.title).length > 24) return bad(`“${x.title}” is too long – titles can be 24 characters.`);
    if (String(x.description || "").length > 72) return bad(`The description of “${x.title}” is too long – 72 characters max.`);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM menu_items WHERE role=?1").bind(role),
    ...items.map((x, i) => env.DB.prepare("INSERT INTO menu_items (role, action, title, description, sort, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(role, x.action, clean(x.title, 24), clean(x.description, 72), i, x.active === false ? 0 : 1)),
  ]);
  return json({ ok: true });
}
// a message the API couldn't send: sent by hand now (counts as done) or not needed any more
async function adminWaOutbox(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const o = await env.DB.prepare("SELECT * FROM wa_outbox WHERE id=?1").bind(id).first();
  if (!o) return bad("Not found", 404);
  const now = isoNow();
  if (b.action === "done") {
    const stmts = [env.DB.prepare("UPDATE wa_outbox SET status='manual', updated_at=?1 WHERE id=?2").bind(now, id)];
    if (o.booking_id && o.to_role !== "team" && MSG_KINDS.includes(o.kind)) stmts.push(env.DB.prepare("INSERT INTO msg_log (booking_id, kind, at) VALUES (?1, ?2, ?3)").bind(o.booking_id, o.kind, now));
    await env.DB.batch(stmts);
    if (o.kind === "report" && o.booking_id) await releaseReports(env, await bookingFull(env, o.booking_id));
  } else await env.DB.prepare("UPDATE wa_outbox SET status='dismissed', updated_at=?1 WHERE id=?2").bind(now, id).run();
  return json({ ok: true });
}
// admin pressed a message button: through the API when it's set up, otherwise { manual: true } and the page opens WhatsApp
async function adminSend(env, req, id) {
  const b = await req.json().catch(() => ({}));
  if (!MSG_KINDS.includes(b.kind) || b.kind === "chat") return bad("Invalid message type");
  const S = await getSettings(env);
  if (!waReady(env, S) || waDown(S) || S.wa_mode !== "auto") return json({ manual: true });
  const sug = Array.isArray(b.sug) ? b.sug.filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && SLOTS.includes(s.slot)).slice(0, 5) : undefined;
  const r = await deliver(env, id, b.kind, { S, sug, reportIds: b.reportIds });
  if (r.manual) await env.DB.prepare("UPDATE wa_outbox SET status='dismissed' WHERE booking_id=?1 AND kind=?2 AND status='failed'").bind(id, b.kind).run(); // the page sends it by hand now
  return json(r);
}

// ---- router ----
// run work after the response is sent (e.g. WhatsApp messages after an admin click)
const CTX = new WeakMap();
function later(req, promise) {
  const p = Promise.resolve(promise).catch((e) => console.log("background job failed", String(e && e.stack || e)));
  const ctx = CTX.get(req);
  if (ctx) ctx.waitUntil(p);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await ensureSchema(env); await waDaily(env); })());
  },
  async fetch(req, env, ctx) {
    CTX.set(req, ctx);
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) {
        if (!env.DB) return bad("Database not configured", 503);
        await ensureSchema(env);
        if (p === "/api/config" && req.method === "GET") return getConfig(env);
        if (p === "/api/wa/webhook" && req.method === "GET") return waWebhookVerify(env, url);
        if (p === "/api/wa/webhook" && req.method === "POST") return waWebhook(env, req);
        if (p === "/api/packages" && req.method === "GET") return publicPackages(env);
        if (p === "/api/slots" && req.method === "GET") return getSlots(env, url);
        let pm = p.match(/^\/api\/pincode\/(\d{6})$/);
        if (pm && req.method === "GET") return pincodeLookup(pm[1], ctx);
        if (p === "/api/bookings" && req.method === "POST") return createBooking(env, req);
        let rt = p.match(/^\/api\/report\/([a-z0-9]{32})$/);
        if (rt && req.method === "GET") return publicReport(env, rt[1]);
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
          if (p === "/api/admin/packages" && req.method === "GET") return adminPackages(env);
          if (p === "/api/admin/packages" && req.method === "POST") return adminSavePackage(env, req, null);
          m = p.match(/^\/api\/admin\/packages\/(\d{1,9})$/);
          if (m && req.method === "POST") return adminSavePackage(env, req, Number(m[1]));
          if (m && req.method === "DELETE") return adminDeletePackage(env, Number(m[1]));
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/screenshot$/);
          if (m && req.method === "GET") return adminScreenshot(env, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/move$/);
          if (m && req.method === "POST") return adminMove(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/reports?$/);
          if (m && req.method === "POST") return adminUploadReport(env, req, m[1]);
          if (m && req.method === "GET") return adminReport(env, m[1]);
          m = p.match(/^\/api\/admin\/reports\/(\d{1,9})$/);
          if (m && req.method === "GET") return adminReportFile(env, Number(m[1]));
          if (m && req.method === "DELETE") return adminDeleteReport(env, Number(m[1]));
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/tests$/);
          if (m && req.method === "POST") return adminSetTests(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/vial$/);
          if (m && req.method === "POST") return adminVial(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/sent$/);
          if (m && req.method === "POST") return adminSent(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/status$/);
          if (m && req.method === "POST") return adminSetStatus(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/centre$/);
          if (m && req.method === "POST") return adminAssignCentre(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/send$/);
          if (m && req.method === "POST") return adminSend(env, req, m[1]);
          if (p === "/api/admin/wa" && req.method === "GET") return adminWa(env, url);
          if (p === "/api/admin/wa/chats" && req.method === "GET") return adminChats(env);
          m = p.match(/^\/api\/admin\/wa\/chats\/(\d{10})$/);
          if (m && req.method === "GET") return adminChat(env, m[1]);
          if (m && req.method === "POST") return adminChatSend(env, req, m[1]);
          m = p.match(/^\/api\/admin\/wa\/chats\/(\d{10})\/bot$/);
          if (m && req.method === "POST") return adminChatBot(env, req, m[1]);
          m = p.match(/^\/api\/admin\/wa\/media\/(\d{1,12})$/);
          if (m && req.method === "GET") return adminChatMedia(env, Number(m[1]));
          if (p === "/api/admin/wa/settings" && req.method === "POST") return adminWaSettings(env, req);
          if (p === "/api/admin/wa/test" && req.method === "POST") return adminWaTest(env);
          if (p === "/api/admin/wa/sync" && req.method === "POST") return adminWaSync(env);
          if (p === "/api/admin/wa/menu" && req.method === "POST") return adminWaMenu(env, req);
          m = p.match(/^\/api\/admin\/wa\/templates\/([a-z_]{2,30})$/);
          if (m && req.method === "POST") return adminWaSaveTemplate(env, req, m[1], false);
          if (m && req.method === "DELETE") return adminWaSaveTemplate(env, req, m[1], true);
          m = p.match(/^\/api\/admin\/wa\/templates\/([a-z_]{2,30})\/submit$/);
          if (m && req.method === "POST") return adminWaSubmit(env, m[1]);
          m = p.match(/^\/api\/admin\/wa\/outbox\/(\d{1,9})$/);
          if (m && req.method === "POST") return adminWaOutbox(env, req, Number(m[1]));
          if (p === "/api/admin/centres" && req.method === "GET") return adminCentres(env);
          if (p === "/api/admin/centres" && req.method === "POST") return adminSaveCentre(env, req, null);
          m = p.match(/^\/api\/admin\/centres\/(\d{1,9})$/);
          if (m && req.method === "POST") return adminSaveCentre(env, req, Number(m[1]));
          if (m && req.method === "DELETE") return adminDeleteCentre(env, Number(m[1]));
          if (p === "/api/admin/users" && req.method === "GET") return adminUsers(env, url);
          if (p === "/api/admin/users" && req.method === "POST") return adminSaveUser(env, req, null);
          m = p.match(/^\/api\/admin\/users\/(\d{1,9})$/);
          if (m && req.method === "POST") return adminSaveUser(env, req, Number(m[1]));
          if (m && req.method === "DELETE") return adminDeleteUser(env, Number(m[1]));
          return bad("Not found", 404);
        }

        // collection-centre portal (username + password)
        if (p === "/api/centre/login" && req.method === "POST") return centreLogin(env, req);
        if (p.startsWith("/api/centre/")) {
          if (p === "/api/centre/logout" && req.method === "POST") return logoutSession(env, req);
          const user = await getSession(env, req, "centre");
          if (!user) return bad("Please sign in again.", 401);
          if (p === "/api/centre/bookings" && req.method === "GET") return centreBookings(env, user, url);
          m = p.match(/^\/api\/centre\/bookings\/(DSL-[A-Z0-9]{6})\/collected$/);
          if (m && req.method === "POST") return centreCollected(env, user, req, m[1]);
          m = p.match(/^\/api\/centre\/bookings\/(DSL-[A-Z0-9]{6})\/reports$/);
          if (m && req.method === "POST") return centreUpload(env, user, req, m[1]);
          m = p.match(/^\/api\/centre\/bookings\/(DSL-[A-Z0-9]{6})\/(accept|decline)$/);
          if (m && req.method === "POST") return centreAccept(env, user, req, m[1], m[2]);
          m = p.match(/^\/api\/centre\/reports\/(\d{1,9})$/);
          if (m && req.method === "GET") return centreReportFile(env, user, Number(m[1]));
          return bad("Not found", 404);
        }

        // patient portal (mobile number + date of birth)
        if (p === "/api/patient/login" && req.method === "POST") return patientLogin(env, req);
        if (p.startsWith("/api/patient/")) {
          if (p === "/api/patient/logout" && req.method === "POST") return logoutSession(env, req);
          const s = await getSession(env, req, "patient");
          if (!s) return bad("Please sign in again.", 401);
          if (p === "/api/patient/bookings" && req.method === "GET") return patientBookings(env, s);
          m = p.match(/^\/api\/patient\/reports\/(\d{1,9})$/);
          if (m && req.method === "GET") return patientReportFile(env, s, Number(m[1]));
          return bad("Not found", 404);
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
