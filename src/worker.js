// Dr. Sarwan Diagnostic Labs – booking backend
// Cloudflare Worker + D1. Static site is served from ./public via the ASSETS binding.
import "../public/shared/msgs.js"; // WhatsApp message texts, shared with the admin page
import { imConfigured, imApi, imIsTest, imCreateRequest, imGetRequest, imGetPayment, imPaymentOk, imMacOk } from "./instamojo.js";
import { renderHome, homeFromBody, HOME_DEFAULT } from "./home.js";
import { renderPackagePage, pageFromBody, defaultPageFor, slugify, aiGeneratePage, PAGE_SECTIONS, HORMONE_PAGE } from "./pages.js";
const M = globalThis.DSLMsg;

const SLOT_START_MIN = 7 * 60;    // 07:00 – home collection runs 7 AM to 6 PM
const SLOT_END_MIN = 18 * 60;     // last slot ends at 18:00
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
// TEMPORARY test price for the public booking form only: variable TEST_PRICE = "<slug>=<rupees>" (e.g. "female-pcos=10").
// The page itself still shows the real price; admin bookings and other packages are unaffected. Remove the variable to end it.
function testPrice(env, pkg) {
  const m = /^\s*([a-z0-9-]+)\s*=\s*(\d+)\s*$/.exec(String(env.TEST_PRICE || ""));
  return pkg && m && pkg.slug === m[1] ? { ...pkg, price: parseInt(m[2], 10) } : pkg;
}
async function packageById(env, id, activeOnly = true) {
  if (!id) return null;
  return await env.DB.prepare(`SELECT * FROM packages WHERE id=?1 ${activeOnly ? "AND active=1" : ""}`).bind(parseInt(id, 10) || 0).first();
}
// No limit on bookings per slot (0 = unlimited). Set the SLOT_CAPACITY variable to bring a per-city limit back.
function slotCapacity(env) { const n = parseInt(env.SLOT_CAPACITY || "0", 10); return n > 0 ? n : 0; }
const cityKey = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Is there room in this slot for one more booking in this city?
async function slotRoom(env, date, slot, city, excludeId = "") {
  const { results } = await env.DB.prepare(
    `SELECT id, city, status FROM bookings WHERE date=?1 AND slot=?2 AND status IN (${ACTIVE.map((_, i) => "?" + (i + 3)).join(",")})`
  ).bind(date, slot, ...ACTIVE).all();
  if (results.some((r) => r.status === "blocked")) return { ok: false, blocked: true, msg: `${slotLabel(slot)} on ${prettyDate(date)} is closed for bookings.` };
  const cap = slotCapacity(env), key = cityKey(city);
  if (!cap) return { ok: true, n: 0, cap: 0 };
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
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, at TEXT NOT NULL, who TEXT, role TEXT, what TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS activity_booking ON activity(booking_id, id)`,
  `CREATE TABLE IF NOT EXISTS wa_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT UNIQUE, phone TEXT NOT NULL, type TEXT, body TEXT, at TEXT NOT NULL)`,
  // reports a centre sends on WhatsApp in one go (checked by the AI, confirmed by the centre, then approved by our team)
  `CREATE TABLE IF NOT EXISTS report_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, centre_id INTEGER, phone TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, last_file_at TEXT NOT NULL, closed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS report_batches_status ON report_batches(status, last_file_at)`,
  // what the AI check has learned from approved reports: where each centre's vial no. is printed (label → times found)
  `CREATE TABLE IF NOT EXISTS report_hints (centre_id INTEGER NOT NULL, label TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (centre_id, label))`,
  // online payments (Instamojo): one row per payment attempt. status: created → success | failed | abandoned (never finished)
  `CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, gateway TEXT NOT NULL, request_id TEXT UNIQUE,
    payment_id TEXT, amount INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, method TEXT, back TEXT, checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS payments_by_booking ON payments(booking_id)`,
  `CREATE INDEX IF NOT EXISTS payments_by_status ON payments(status, created_at)`,
  // lab tests (the single tests inside packages) and which package has which test. price / margin are placeholders for later.
  `CREATE TABLE IF NOT EXISTS lab_tests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT, also_called TEXT, category TEXT, sample TEXT,
    purpose TEXT, price INTEGER, margin INTEGER, active INTEGER NOT NULL DEFAULT 1, ai_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lab_tests_name ON lab_tests(lower(name))`,
  `CREATE TABLE IF NOT EXISTS package_tests (package_id INTEGER NOT NULL, test_id INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (package_id, test_id))`,
  `CREATE INDEX IF NOT EXISTS package_tests_test ON package_tests(test_id)`,
  // receipts: one per paid booking, numbered DSL/<financial year>/<n> (e.g. DSL/2026-27/0001)
  `CREATE TABLE IF NOT EXISTS receipts (booking_id TEXT PRIMARY KEY, no TEXT NOT NULL UNIQUE, fy TEXT NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  // phone numbers: calls / website / marketing = 83681 43677, WhatsApp chats = 98180 28755. Texts saved in the database had
  // briefly been switched to 98180 28755 everywhere – put the call number back, keeping WhatsApp links (wa.me/919818028755)
  `UPDATE msg_templates SET body=replace(replace(body,'9818028755','8368143677'),'98180 28755','83681 43677') WHERE body LIKE '%9818028755%' OR body LIKE '%98180 28755%'`,
  `UPDATE menu_items SET title=replace(title,'9818028755','8368143677'), description=replace(description,'9818028755','8368143677') WHERE title LIKE '%9818028755%' OR description LIKE '%9818028755%'`,
  `UPDATE packages SET page=replace(replace(replace(page,'wa.me/919818028755','@@WA@@'),'9818028755','8368143677'),'@@WA@@','wa.me/919818028755') WHERE page LIKE '%9818028755%'`,
  `UPDATE settings SET v=replace(replace(replace(v,'wa.me/919818028755','@@WA@@'),'9818028755','8368143677'),'@@WA@@','wa.me/919818028755') WHERE k='home_page' AND v LIKE '%9818028755%'`,
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
  // website page per package: slug (/package/<slug>), page = JSON of the sections, page_live = 1 when published
  for (const [c, t] of [["slug", "TEXT"], ["page", "TEXT"], ["page_live", "INTEGER NOT NULL DEFAULT 0"], ["page_at", "TEXT"]])
    if (!(cols.results || []).some((x) => x.name === c)) {
      try { await env.DB.prepare(`ALTER TABLE packages ADD COLUMN ${c} ${t}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
    }
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS packages_slug ON packages(slug) WHERE slug IS NOT NULL").run();
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
// Every package gets a web address (/package/<slug>); the website test starts with the old home-page content, published.
async function seedPages(env) {
  const { results } = await env.DB.prepare("SELECT id, name, slug, page, is_default FROM packages WHERE slug IS NULL OR (is_default=1 AND page IS NULL)").all();
  for (const r of results) {
    let slug = r.slug;
    if (!slug) {
      slug = slugify(r.name) || "test-" + r.id;
      if (await env.DB.prepare("SELECT 1 FROM packages WHERE slug=?1 AND id!=?2").bind(slug, r.id).first()) slug += "-" + r.id;
    }
    if (r.is_default && !r.page) {
      await env.DB.prepare("UPDATE packages SET slug=?1, page=?2, page_live=1, page_at=?3 WHERE id=?4").bind(slug, JSON.stringify(HORMONE_PAGE), isoNow(), r.id).run();
    } else await env.DB.prepare("UPDATE packages SET slug=?1 WHERE id=?2").bind(slug, r.id).run();
  }
}
let schemaDone = false; // per isolate; a promise can't be shared between requests in Workers
// report_files columns for the centre → AI check → operator approval flow.
// review: NULL (uploaded by our team – no approval needed) | draft (centre still confirming on WhatsApp) | pending (waiting for an operator)
//         | held (interim – operator waits for the final report) | approved | rejected | withdrawn (the centre took it back)
const REPORT_REVIEW_COLS = ["review", "batch_id", "centre_id", "src", "src_phone", "hint_booking", "ai_status", "ai_at", "ai_json",
  "match_status", "match_json", "centre_ok", "reviewed_by", "reviewed_at", "review_note"];
// reports that count (can be sent, make a booking "report ready"): our team's uploads and approved ones
const LIVE_REP = "(review IS NULL OR review='approved')";
const NEW_COLS = { city: "TEXT", state: "TEXT", vial_no: "TEXT", collected_at: "TEXT", report_name: "TEXT", report_size: "INTEGER",
  report_token: "TEXT", report_at: "TEXT", completed_at: "TEXT", fee_due: "INTEGER", fee_paid_at: "TEXT", missed_slot: "TEXT", package_id: "INTEGER", package_name: "TEXT",
  centre_id: "INTEGER", patient_id: "INTEGER", consent_at: "TEXT", centre_status: "TEXT", centre_status_at: "TEXT", collector_info: "TEXT",
  resched_req: "TEXT", resched_at: "TEXT", resched_date: "TEXT", resched_slot: "TEXT",
  vial_reported: "TEXT", vial_reported_at: "TEXT", pay_method: "TEXT" };
function ensureSchema(env) {
  // Each request runs the (idempotent) setup itself until one finishes. Sharing one promise across requests
  // breaks in Workers: if the request that started it ends first, everyone else waiting gets
  // "This promise was created by a request that has since ended" and the isolate stays broken.
  if (schemaDone) return Promise.resolve();
  return (async () => {
    // Fast path: the full setup below is ~50 database round trips (≈8 s on a cold start). It only needs to run
    // once per code version, so a stamp of the setup code is kept in settings; when it matches, skip it all.
    const stamp = await setupStamp();
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='setup_v'").first().catch(() => null);
    if (r && r.v === stamp) { schemaDone = true; return; }
    await runSetup(env);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('setup_v', ?1)").bind(stamp).run();
    schemaDone = true;
  })();
}
// Changes whenever the tables, columns or any seeding / one-time migration code changes, so new setup still runs after a deploy.
let stampCache = "";
async function setupStamp() {
  if (!stampCache) stampCache = (await sha256([SCHEMA.join("\n"), JSON.stringify(NEW_COLS), JSON.stringify(REPORT_REVIEW_COLS), JSON.stringify(MENU_DEFAULTS), JSON.stringify(MENU_ADDED_V2),
    ...[runSetup, seedPackages, seedPages, migrateTestsAndReports, seedAccounts, closeOldBookings, reopenVialCheck, seedWa, backfillFailed].map((f) => f.toString())].join("\n"))).slice(0, 20);
  return stampCache;
}
async function runSetup(env) {
  {
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
        ["msg_templates", "cur_name"], ["msg_templates", "nx_name"], ["msg_templates", "nx_id"], ["msg_templates", "nx_status"], ["msg_templates", "nx_body"], ["msg_templates", "nx_reason"],
        ["wa_inbox", "status"], ["wa_inbox", "media_id"], ["wa_inbox", "media_type"], ["wa_inbox", "media_name"], ["wa_contacts", "last_act"],
        ...REPORT_REVIEW_COLS.map((c) => ["report_files", c])]) {
        try { await env.DB.prepare(`ALTER TABLE ${tbl} ADD COLUMN ${col} TEXT`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
      }
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS report_files_review ON report_files(review)").run();
      if (!have.size) for (const [c, t] of Object.entries(NEW_COLS)) {
        try { await env.DB.prepare(`ALTER TABLE bookings ADD COLUMN ${c} ${t}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
      }
      await seedPackages(env);
      await seedPages(env);
      await migrateTestsAndReports(env);
      await seedAccounts(env);
      await seedWa(env);
      await backfillFailed(env).catch((e) => console.log("backfill", String(e)));
  }
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
    slots: SLOTS.map((s) => ({ time: s, label: slotLabel(s), available: !closed.has(s) && (!cap || (used[s] || 0) < cap) && isBookable(date, s) })),
  });
}

async function getConfig(env, url) {
  const want = url && url.searchParams.get("package");
  const pkg = testPrice(env, (want && (await packageById(env, want))) || (await defaultPackage(env)));
  const today = istParts().date;
  const dates = [];
  for (let i = 0; i <= BOOK_DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    if (SLOTS.some((s) => isBookable(d, s))) dates.push(d);
  }
  return json({
    amount: pkg ? pkg.price : amount(env),
    test: pkg ? { id: pkg.id, name: pkg.name, tests: pkg.tests || "", prep: pkg.prep || "" } : null,
    gateway: imConfigured(env) ? "instamojo" : "upi",
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
  const pkg = testPrice(env, (await packageById(env, b.package_id)) || (await defaultPackage(env)));
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

// The payment page behind the WhatsApp payment link (?pay=ID&t=TOKEN): what to pay and how.
async function payInfo(env, url, id) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!row || !safeEqual(row.token, url.searchParams.get("t") || "")) return bad("This payment link isn't valid. Please call 8368143677.", 404);
  if (!["pending", "expired", "payment_submitted"].includes(row.status)) return bad(row.status === "cancelled" ? "This booking was cancelled. Please call 8368143677." : "This booking is already paid ✅", 409);
  const t = await env.DB.prepare("SELECT name FROM booking_tests WHERE booking_id=?1 ORDER BY id").bind(id).all();
  return json({ id, token: row.token, date: row.date, dateLabel: prettyDate(row.date), slot: row.slot, slotLabel: slotLabel(row.slot), amount: row.amount,
    testName: t.results.map((x) => x.name).join(", "), status: row.status, name: row.name, phone: row.phone, address: row.address, city: row.city, state: row.state, pincode: row.pincode,
    upiId: env.UPI_ID || "", upiName: env.UPI_NAME || "Dr. Sarwan Diagnostic Labs", upiQr: env.UPI_QR_STRING || "" });
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

// ---- online payment (Instamojo) ----
// 1. The booking form creates the booking (status "pending" – it doesn't hold anything yet).
// 2. /checkout opens an Instamojo payment page for it; the patient pays there.
// 3. Instamojo sends the patient back (?pay_return=…&payment_id=…) and calls our webhook. Either way we ask Instamojo's API
//    whether the payment really succeeded, and only then does the booking become "payment_submitted" (Paid) – the same
//    state a verified UPI screenshot used to give, so it shows up in Bookings and follows the normal steps.
// Payments that fail or are never finished stay in the payments table → Admin → Payments.
const PAY_ABANDON_MIN = 30; // an Instamojo page not paid after this long counts as "not completed"
const okBack = (b) => (/^\/((test|package)\/[a-z0-9-]{1,80}\/?)?$/.test(String(b || "")) ? String(b) : "/");

async function checkout(env, req, url, id) {
  if (!imConfigured(env)) return bad("Online payment isn't set up yet. Please call 8368143677.", 503);
  const b = await req.json().catch(() => ({}));
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!row || !safeEqual(row.token, b.token)) return bad("Booking not found.", 404);
  if (!["pending", "expired"].includes(row.status)) return bad(row.status === "cancelled" ? "This booking was cancelled. Please make a new booking." : "This booking is already paid ✅", 409);
  const back = okBack(b.back);
  // a payment for this booking may have gone through a moment ago (e.g. paid in another tab): settle that first
  const open = await env.DB.prepare("SELECT * FROM payments WHERE booking_id=?1 AND status='created' ORDER BY id DESC").bind(id).all();
  for (const o of open.results) { const r = await settleRequest(env, o, "checkout"); if (r.ok) return json({ ok: true, paid: true }); }
  const t = await env.DB.prepare("SELECT name FROM booking_tests WHERE booking_id=?1 ORDER BY id").bind(id).all();
  const now = isoNow();
  let pr;
  try {
    pr = await imCreateRequest(env, {
      amount: row.amount, purpose: `${row.id} ${t.results.map((x) => x.name).join(", ") || "Home test"}`, name: row.name, phone: row.phone,
      redirectUrl: `${url.origin}${back}?pay_return=${encodeURIComponent(id)}&t=${encodeURIComponent(row.token)}`,
      webhookUrl: `${url.origin}/api/pay/instamojo`,
    });
  } catch (e) {
    console.log("instamojo create", String(e));
    await env.DB.prepare("INSERT INTO payments (booking_id, gateway, amount, status, reason, back, created_at, updated_at) VALUES (?1, 'instamojo', ?2, 'failed', ?3, ?4, ?5, ?5)")
      .bind(id, row.amount, ("Couldn't open the payment page: " + String(e.message || e)).slice(0, 300), back, now).run();
    return bad("We couldn't open the payment page. Please try again, or call 8368143677.", 502);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO payments (booking_id, gateway, request_id, amount, status, back, created_at, updated_at) VALUES (?1, 'instamojo', ?2, ?3, 'created', ?4, ?5, ?5)").bind(id, pr.id, row.amount, back, now),
    // a fresh 2-hour window while the patient pays; still not holding anything until the payment is confirmed
    env.DB.prepare("UPDATE bookings SET status='pending', pay_method='instamojo', expires_at=?1, updated_at=?2 WHERE id=?3").bind(new Date(Date.now() + HOLD_MIN * 60000).toISOString(), now, id),
  ]);
  return json({ ok: true, url: pr.url });
}

// Patient is back from Instamojo: check with Instamojo and tell the page how it went.
async function verifyPay(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!row || !safeEqual(row.token, b.token)) return bad("Booking not found.", 404);
  const reqId = clean(b.payment_request_id, 60), payId = clean(b.payment_id, 60);
  let pay = reqId ? await env.DB.prepare("SELECT * FROM payments WHERE request_id=?1 AND booking_id=?2").bind(reqId, id).first() : null;
  if (!pay) pay = await env.DB.prepare("SELECT * FROM payments WHERE booking_id=?1 AND gateway='instamojo' ORDER BY id DESC LIMIT 1").bind(id).first();
  let r = { ok: false, reason: "We couldn't find your payment." };
  if (pay && pay.status === "success") r = { ok: true };
  else if (pay) r = await settleRequest(env, pay, "return", payId);
  const cur = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  const paid = r.ok || HOLDING.includes(cur.status);
  const t = await env.DB.prepare("SELECT name FROM booking_tests WHERE booking_id=?1 ORDER BY id").bind(id).all();
  const waOn = paid && waAuto(env, await getSettings(env));
  return json({ ok: true, paid, waAuto: waOn, receipt: paid ? `/receipt/${id}?t=${cur.token}` : "", pending: !paid && !!r.pending, reason: paid ? "" : r.reason || "", id, token: cur.token, amount: cur.amount, status: cur.status,
    date: cur.date, dateLabel: prettyDate(cur.date), slot: cur.slot, slotLabel: slotLabel(cur.slot), testName: t.results.map((x) => x.name).join(", "),
    name: cur.name, phone: cur.phone, paymentId: paid ? cur.utr || payId : "" });
}

// Instamojo webhook (form post). We never trust its fields – they only tell us which payment to look up.
async function imWebhook(env, req) {
  const fields = Object.fromEntries((await req.formData().catch(() => new FormData())).entries());
  const mac = await imMacOk(env, fields);
  if (mac === false) { console.log("instamojo webhook: bad mac"); return new Response("bad mac", { status: 400 }); }
  const reqId = clean(fields.payment_request_id, 60), payId = clean(fields.payment_id, 60);
  const pay = reqId && (await env.DB.prepare("SELECT * FROM payments WHERE request_id=?1").bind(reqId).first());
  if (pay && pay.status !== "success") await settleRequest(env, pay, "webhook", payId).catch((e) => console.log("webhook settle", String(e)));
  return new Response("ok");
}

// Find out from Instamojo what happened to a payment request and record it. Safe to call many times.
async function settleRequest(env, pay, via, payId = "") {
  if (!imConfigured(env) || !pay.request_id) return { ok: false, reason: "Online payment isn't set up" };
  const now = isoNow();
  try {
    if (!payId) {
      const rq = await imGetRequest(env, pay.request_id);
      const list = rq.payments || [];
      payId = list[list.length - 1] || "";
      if (!payId) {
        const old = Date.now() - Date.parse(pay.created_at) > PAY_ABANDON_MIN * 60000;
        if (old && pay.status === "created") await env.DB.prepare("UPDATE payments SET status='abandoned', reason=?1, checked_at=?2, updated_at=?2 WHERE id=?3 AND status='created'")
          .bind("Payment page opened but not paid", now, pay.id).run();
        else await env.DB.prepare("UPDATE payments SET checked_at=?1 WHERE id=?2").bind(now, pay.id).run();
        return { ok: false, pending: !old, reason: old ? "The payment wasn't completed." : "Payment not received yet." };
      }
    }
    const p = await imGetPayment(env, payId, pay.request_id);
    const v = imPaymentOk(p, pay.request_id, pay.amount);
    if (!v.ok) {
      await env.DB.prepare("UPDATE payments SET status='failed', payment_id=?1, reason=?2, method=?3, checked_at=?4, updated_at=?4 WHERE id=?5 AND status!='success'")
        .bind(payId, String(v.reason).slice(0, 300), clean(p && p.instrument_type, 40) || null, now, pay.id).run();
      return { ok: false, reason: v.reason };
    }
    await env.DB.prepare("UPDATE payments SET status='success', payment_id=?1, reason=NULL, method=?2, checked_at=?3, updated_at=?3 WHERE id=?4").bind(payId, clean(v.method, 40) || null, now, pay.id).run();
    // Instamojo has confirmed the money, so there's nothing for the team to check: the booking is confirmed straight away
    const r = await env.DB.prepare("UPDATE bookings SET status='confirmed', paid_at=?1, utr=?2, pay_method='instamojo', updated_at=?1 WHERE id=?3 AND status IN ('pending','expired')")
      .bind(now, payId, pay.booking_id).run();
    if (r.meta.changes) {
      await logAct(env, pay.booking_id, "Instamojo", "system", `Paid online ₹${v.amount} (payment ${payId}${v.method ? ", " + v.method : ""}) – via ${via}. Booking confirmed automatically.`);
      await ensureReceipt(env, await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(pay.booking_id).first()).catch((e) => console.log("receipt", String(e)));
      // the operator chooses the collection centre (Operations → Step 1 "Assign centre"); the team gets an alert
      // automatic WhatsApp: confirmation to the patient now; the job goes to the centre once it's chosen
      await waEvent(env, "paid_online", pay.booking_id).catch((e) => console.log("paid_online wa", String(e)));
    }
    return { ok: true };
  } catch (e) {
    console.log("instamojo settle", pay.id, String(e));
    await env.DB.prepare("UPDATE payments SET checked_at=?1 WHERE id=?2").bind(now, pay.id).run();
    return { ok: false, pending: true, reason: "We couldn't check your payment just now." };
  }
}

// cron: look up payment pages nobody came back from (closed the tab, network dropped)
async function paymentSweep(env) {
  if (!imConfigured(env)) return;
  const cut = new Date(Date.now() - 10 * 60000).toISOString(), recheck = new Date(Date.now() - 10 * 60000).toISOString();
  const { results } = await env.DB.prepare(`SELECT * FROM payments WHERE status='created' AND created_at < ?1 AND (checked_at IS NULL OR checked_at < ?2) ORDER BY id LIMIT 5`).bind(cut, recheck).all();
  for (const p of results) await settleRequest(env, p, "sweep");
}

// Admin → Payments: failed / not completed / paid online
async function adminPayments(env, url) {
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await env.DB.prepare(`SELECT p.*, b.name, b.phone, b.date, b.slot, b.city, b.status AS booking_status, b.package_name, b.created_at AS booked_at, b.token
    FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id WHERE p.created_at >= ?1 ORDER BY p.id DESC LIMIT 500`).bind(since).all();
  return json({ payments: results.map((r) => ({ ...r, slotLabel: r.slot ? slotLabel(r.slot) : "", paid_later: r.status !== "success" && HOLDING.includes(r.booking_status) })),
    gateway: { on: imConfigured(env), api: imApi(env), test: imIsTest(env), salt: !!env.INSTAMOJO_SALT, webhook: `${url.origin}/api/pay/instamojo` } });
}
async function adminPaymentCheck(env, id) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=?1").bind(id).first();
  if (!pay) return bad("Payment not found", 404);
  if (pay.status === "success") return json({ ok: true, status: "success" });
  if (!pay.request_id) return bad("This attempt never reached Instamojo – nothing to check.");
  const r = await settleRequest(env, { ...pay, status: pay.status === "abandoned" ? "created" : pay.status }, "admin check", pay.payment_id || "");
  const now = await env.DB.prepare("SELECT status, reason FROM payments WHERE id=?1").bind(id).first();
  return json({ ok: true, paid: r.ok, status: now.status, reason: r.reason || now.reason || "" });
}


// ---- receipts (our own, for every paid booking) ----
// Number DSL/<FY>/<n>, the Indian financial year (April–March) of the payment. Made the first time it's needed.
const RECEIPT_STATES = ["payment_submitted", "confirmed", "collected", "report_ready", "completed", "no_show"];
function finYear(iso) {
  const { date } = istParts(new Date(iso || Date.now()));
  const y = +date.slice(0, 4), m = +date.slice(5, 7);
  const a = m >= 4 ? y : y - 1;
  return `${a}-${String((a + 1) % 100).padStart(2, "0")}`;
}
async function ensureReceipt(env, b) {
  if (!b || !RECEIPT_STATES.includes(b.status)) return null;
  const have = await env.DB.prepare("SELECT * FROM receipts WHERE booking_id=?1").bind(b.id).first();
  if (have) return have;
  const fy = finYear(b.paid_at || b.created_at);
  for (let i = 0; i < 5; i++) {
    const mx = await env.DB.prepare("SELECT MAX(seq) AS m FROM receipts WHERE fy=?1").bind(fy).first();
    const seq = ((mx && mx.m) || 0) + 1, no = `DSL/${fy}/${String(seq).padStart(4, "0")}`;
    try {
      await env.DB.prepare("INSERT INTO receipts (booking_id, no, fy, seq, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(b.id, no, fy, seq, isoNow()).run();
      return { booking_id: b.id, no, fy, seq };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
      const again = await env.DB.prepare("SELECT * FROM receipts WHERE booking_id=?1").bind(b.id).first();
      if (again) return again; // made at the same moment by another request
    }
  }
  throw new Error("Couldn't number the receipt");
}
const rEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// GET /receipt/<booking id>?t=<booking token> – printable receipt (the patient has the token; the admin page links it too)
async function receiptPage(env, id, t) {
  const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!b || !safeEqual(b.token, t || "")) return html("<p style='font-family:sans-serif'>This receipt link isn't valid. Please WhatsApp us on 9818028755.</p>", 404);
  const r = await ensureReceipt(env, b);
  if (!r) return html("<p style='font-family:sans-serif'>There's no receipt yet – this booking hasn't been paid.</p>", 404);
  const { results: tests } = await env.DB.prepare("SELECT name, price FROM booking_tests WHERE booking_id=?1 ORDER BY id").bind(id).all();
  const pay = b.pay_method === "instamojo"
    ? await env.DB.prepare("SELECT payment_id, method FROM payments WHERE booking_id=?1 AND status='success' ORDER BY id DESC LIMIT 1").bind(id).first() : null;
  const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
  const lines = tests.length ? tests : [{ name: b.package_name || "Home sample collection test", price: b.amount }];
  const listed = lines.reduce((a, x) => a + (Number(x.price) || 0), 0);
  const adj = Number(b.amount) - listed; // discount / test price (e.g. a temporary price) – the amount paid is what counts
  const paidOn = istParts(new Date(b.paid_at || b.created_at));
  const method = b.pay_method === "instamojo" ? `Online (Instamojo${pay && pay.method ? " · " + pay.method : ""})` : b.utr ? "UPI" : "Paid to Dr. Sarwan Diagnostic Labs";
  const ref = (pay && pay.payment_id) || b.utr || "";
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${rEsc(r.no)} – Dr. Sarwan Diagnostic Labs</title><meta name="robots" content="noindex">
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#13213a;background:#eef2f6;margin:0;padding:24px}
.r{max-width:720px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #1f6977;padding-bottom:16px}
.top img{height:54px}.org{font-size:13px;line-height:1.5;color:#3b4a68;text-align:right}
h1{font-size:22px;margin:22px 0 4px}.paid{display:inline-block;background:#dff3ea;color:#17694a;font-weight:800;border-radius:999px;padding:4px 12px;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:15px}
.kv th{text-align:left;color:#5b6884;font-weight:600;width:38%;padding:6px 0;vertical-align:top}.kv td{padding:6px 0}
.items th,.items td{padding:10px 8px;border-bottom:1px solid #e3e8ef;text-align:left}.items .n{text-align:right;white-space:nowrap}
.items tfoot td{font-weight:800;font-size:17px;border-bottom:0}
.foot{margin-top:24px;font-size:12.5px;color:#5b6884;line-height:1.6}
.btn{display:inline-block;margin:18px auto 0;background:#1f6977;color:#fff;border:0;border-radius:999px;padding:10px 22px;font-weight:700;font-size:15px;cursor:pointer}
@media print{body{background:#fff;padding:0}.r{box-shadow:none;padding:0}.np{display:none}}
</style></head><body><div class="r">
<div class="top"><img src="/assets/logo.png" alt="Dr. Sarwan Diagnostic Labs"><div class="org"><b>Dr. Sarwan Diagnostic Labs</b><br>Shop 37–38, Vardhaman Crown Mall, Dwarka Sector 19<br>New Delhi 110078<br>Call 83681 43677 · WhatsApp 98180 28755 · drsarwantests.com<br>NABL &amp; CGHS approved</div></div>
<h1>Payment receipt</h1><span class="paid">PAID ✓</span>
<table class="kv">
${row("Receipt no.", `<b>${rEsc(r.no)}</b>`)}
${row("Date", `${rEsc(prettyDate(paidOn.date))}`)}
${row("Booking ref", rEsc(b.id))}
${row("Patient", `${rEsc(b.name)}<br>+91 ${rEsc(b.phone)}`)}
${row("Home collection", `${rEsc(prettyDate(b.date))}, ${rEsc(slotLabel(b.slot))}${b.address ? `<br>${rEsc(b.address)}${b.city ? ", " + rEsc(b.city) : ""}${b.pincode ? " – " + rEsc(b.pincode) : ""}` : ""}`)}
${row("Paid by", rEsc(method))}
${ref ? row(b.pay_method === "instamojo" ? "Payment ID" : "Transaction ref", rEsc(ref)) : ""}
</table>
<table class="items"><thead><tr><th>Description</th><th class="n">Amount</th></tr></thead><tbody>
${lines.map((x) => `<tr><td>${rEsc(x.name)}<br><span style="color:#5b6884;font-size:13px">Home sample collection · e-report</span></td><td class="n">${inr(x.price)}</td></tr>`).join("")}
${adj ? `<tr><td>${adj < 0 ? "Discount" : "Adjustment"}</td><td class="n">${adj < 0 ? "− " + inr(-adj) : inr(adj)}</td></tr>` : ""}
</tbody><tfoot><tr><td>Total paid</td><td class="n">${inr(b.amount)}</td></tr></tfoot></table>
<p class="foot">This is a computer-generated receipt and needs no signature.<br>Reschedule any time before the visit; refunds follow our policy at drsarwantests.com/refund.</p>
<div class="np" style="text-align:center"><button class="btn" onclick="print()">Print / save as PDF</button></div>
</div></body></html>`);
}


// Admin only: remove a booking for good (test or fake data) – with its tests, payments, receipt, messages, reports and
// history. Its patient login goes too if the patient has no other booking. Real bookings should be cancelled instead.
async function adminDeleteBooking(env, req, id) {
  const st = STAFF.get(req);
  if (st && st.role !== "admin") return bad("Only an admin can delete a booking.", 403);
  const b = await env.DB.prepare("SELECT id, patient_id FROM bookings WHERE id=?1").bind(id).first();
  if (!b) return bad("Booking not found", 404);
  const files = await env.DB.prepare("SELECT id FROM report_files WHERE booking_id=?1").bind(id).all();
  await env.DB.batch([
    ...files.results.map((f) => env.DB.prepare("DELETE FROM report_parts WHERE report_id=?1").bind(f.id)),
    ...["report_files", "report_chunks", "booking_tests", "payment_proofs", "msg_log", "wa_outbox", "activity", "payments", "receipts"]
      .map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE booking_id=?1`).bind(id)),
    env.DB.prepare("DELETE FROM bookings WHERE id=?1").bind(id),
  ]);
  if (b.patient_id && !(await env.DB.prepare("SELECT 1 FROM bookings WHERE patient_id=?1 LIMIT 1").bind(b.patient_id).first()))
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(b.patient_id),
      env.DB.prepare("DELETE FROM users WHERE id=?1 AND role='patient'").bind(b.patient_id),
    ]);
  console.log("booking deleted", id, st ? st.name : "admin");
  return json({ ok: true });
}
// ---- admin API ----
function isAdmin(env, req) {
  const want = String(env.ADMIN_PASSWORD || "").trim();
  return !!want && safeEqual(String(req.headers.get("x-admin-key") || "").trim(), want);
}

async function adminList(env, url, staff) {
  await expireHolds(env);
  const today = istParts().date;
  const from = url.searchParams.get("from") || today;
  const to = url.searchParams.get("to") || addDays(today, BOOK_DAYS_AHEAD);
  const includeInactive = url.searchParams.get("all") === "1";
  const { results } = await env.DB.prepare(
    `SELECT id, date, slot, name, phone, address, pincode, city, state, cycle, notes, amount, status, utr, token, source, created_at, paid_at, updated_at, pay_method,
       package_id, package_name, vial_no, collected_at, report_name, report_size, report_token, report_at, completed_at, fee_due, fee_paid_at, missed_slot,
       centre_id, patient_id, consent_at, centre_status, centre_status_at, collector_info, resched_req, resched_at, resched_date, resched_slot, vial_reported, vial_reported_at, (SELECT dob FROM users u WHERE u.id = bookings.patient_id) AS dob,
       EXISTS(SELECT 1 FROM payment_proofs p WHERE p.booking_id = bookings.id) AS has_proof,
       (SELECT group_concat(kind || '@' || at, ',') FROM msg_log l WHERE l.booking_id = bookings.id) AS msgs,
       (SELECT group_concat(kind || ':' || id, ',') FROM wa_outbox o WHERE o.booking_id = bookings.id AND o.status = 'failed') AS failed,
       (SELECT COUNT(*) FROM report_files f WHERE f.booking_id = bookings.id AND f.review IN ('pending','held')) AS rev_n
     FROM bookings WHERE date BETWEEN ?1 AND ?2 ${includeInactive ? "" : "AND status NOT IN ('expired')"}
       AND NOT (status IN ('pending','expired') AND COALESCE(pay_method,'')='instamojo' AND COALESCE(source,'')!='admin')
     ORDER BY date, slot, created_at`
  ).bind(from, to).all();
  const [{ results: tests }, { results: files }] = await Promise.all([
    env.DB.prepare("SELECT t.booking_id, t.package_id, t.name, t.price, t.margin FROM booking_tests t JOIN bookings b ON b.id = t.booking_id WHERE b.date BETWEEN ?1 AND ?2 ORDER BY t.id").bind(from, to).all(),
    env.DB.prepare("SELECT f.id, f.booking_id, f.name, f.size, f.token, f.created_at, f.sent_at FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE b.date BETWEEN ?1 AND ?2 AND (f.review IS NULL OR f.review='approved') ORDER BY f.id").bind(from, to).all(),
  ]);
  const by = (rows) => rows.reduce((m, r) => ((m[r.booking_id] = m[r.booking_id] || []).push(r), m), {});
  const T = by(tests), F = by(files);
  const op = staff && staff.role === "operator";
  for (const b of results) { b.tests = (T[b.id] || []).map((t) => (op ? { ...t, margin: null } : t)); b.reports = F[b.id] || []; }
  return json({ from, to, slots: SLOTS.map((s) => ({ time: s, label: slotLabel(s) })), bookings: results });
}

// Phone / walk-in booking created by the admin. No lead-time limit; still one paid booking per slot.
async function adminCreate(env, req) {
  let b;
  try { b = await req.json(); } catch { return bad("Invalid request"); }
  const name = clean(b.name, 80), address = clean(b.address, 300), pincode = clean(b.pincode, 6);
  const city = clean(b.city, 60), state = clean(b.state, 40), date = clean(b.date, 10), slot = clean(b.slot, 5);
  const phone = normPhone(b.phone);
  const staff = STAFF.get(req), op = staff && staff.role !== "admin";
  // paid & confirmed, paid but to verify, or not paid yet (then the patient gets the payment link / a reminder on WhatsApp)
  // operators only take bookings that are already paid
  const status = op ? "confirmed" : ["confirmed", "payment_submitted", "pending"].includes(b.status) ? b.status : "confirmed";
  const utr = String(b.utr || "").replace(/\s/g, "");
  if (utr && !/^[A-Za-z0-9]{6,22}$/.test(utr)) return bad("That transaction ID doesn't look right (6–22 letters or digits). You can leave it empty.");
  const centreId = b.centre_id ? parseInt(b.centre_id, 10) : null;
  if (centreId) {
    const c = await env.DB.prepare("SELECT id, active FROM centres WHERE id=?1").bind(centreId).first();
    if (!c || !c.active) return bad("Pick an active collection centre.");
  } else if (op) return bad("Choose the collection centre.");
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
  if (utr) await env.DB.prepare("UPDATE bookings SET utr=?1 WHERE id=?2").bind(utr, id).run();
  let msg = null;
  if (status === "confirmed") {
    if (centreId) await assignCentre(env, id, centreId); else await autoAssign(env, id);
    later(req, centreJob(env, req, id, "confirmed"));
  } else {
    if (centreId) await assignCentre(env, id, centreId);
    // not paid yet → payment link; paid but not verified → payment reminder (sent now, so the form can say what happened)
    const kind = status === "pending" ? "paylink" : "pay";
    msg = { kind, ...(await sendKind(env, req, id, kind)) };
  }
  return json({ ok: true, id, msg }, 201);
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
  const row = await env.DB.prepare("SELECT status, city, vial_reported FROM bookings WHERE id=?1").bind(id).first();
  if (!row || ["blocked", "cancelled"].includes(row.status)) return bad("Booking not found", 404);
  if (row.vial_reported) return bad("The sample is already collected, so this booking can't be moved.", 409);
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
  const paid = ["payment_submitted", "confirmed", "no_show"].includes(row.status);
  await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET resched_req=NULL, resched_at=NULL, resched_date=NULL, resched_slot=NULL" + (paid ? ", centre_status=NULL, collector_info=NULL" : "") + " WHERE id=?1").bind(id),
    env.DB.prepare(`DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('reminder','done:reminder'${paid ? ",'center','done:center','done:centre_ok','collector','done:collector'" : ""})`).bind(id),
  ]);
  if (paid) later(req, waEvent(env, "moved", id));
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
    if (AFTER_COLLECT_STATES.includes(row.status) && STAFF.get(req) && STAFF.get(req).role !== "admin") return bad("The vial is already confirmed – only an admin can change it.", 403);
    const vial = clean(body.vial_no, 40).toUpperCase();
    // vial no. can be added later (no_vial) – the admin shows a "vial no. missing" warning until it is
    const st = STAFF.get(req);
    if (!vial && (!body.no_vial || (st && st.role !== "admin"))) return bad("Enter the vial number written on the sample.");
    if (vial && !body.force) {
      const dup = await env.DB.prepare("SELECT id, name FROM bookings WHERE vial_no=?1 AND id!=?2 LIMIT 1").bind(vial, id).first();
      if (dup) return json({ error: `Vial ${vial} is already used for ${dup.name} (${dup.id}). Check the number.`, code: "dup_vial" }, 409);
    }
    set.vial_no = vial || row.vial_no || null;
    set.collected_at = row.collected_at || now;
    set.vial_reported = null; set.vial_reported_at = null;
  }
  // finishing a booking whose sample was never confirmed at the lab needs the vial no. too
  if (["report_ready", "completed"].includes(status) && !["collected", "report_ready", "completed"].includes(row.status) && !row.vial_no) {
    const v = clean(body.vial_no, 40).toUpperCase(), st2 = STAFF.get(req);
    if (!v && !(body.no_vial && st2 && st2.role === "admin")) return bad("Confirm the vial at the lab first – the vial number is missing.", 409);
    if (v) { set.vial_no = v; set.collected_at = row.collected_at || now; }
  }
  if (status === "report_ready" && !(await env.DB.prepare(`SELECT 1 FROM report_files WHERE booking_id=?1 AND ${LIVE_REP} LIMIT 1`).bind(id).first())) return bad("Upload the report PDF first (reports from a centre count once they're approved).");
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
// rv: reports from a collection centre ({ review: 'draft' | 'pending', batch_id, centre_id, src, src_phone, hint_booking }) wait for
// the AI check and an operator's approval – they don't change the booking until they're approved.
async function storeReport(env, id, buf, name, rv = null) {
  const now = isoNow(), token = randId(32, "abcdefghijklmnopqrstuvwxyz0123456789");
  await env.DB.prepare(`INSERT INTO report_files (booking_id, name, size, token, created_at, review, batch_id, centre_id, src, src_phone, hint_booking)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`).bind(id || "", name, buf.length, token, now, rv ? rv.review : null,
    rv && rv.batch_id != null ? String(rv.batch_id) : null, rv && rv.centre_id != null ? String(rv.centre_id) : null, rv ? rv.src || null : null,
    rv ? rv.src_phone || null : null, rv ? rv.hint_booking || null : null).run();
  const f = await env.DB.prepare("SELECT id FROM report_files WHERE token=?1").bind(token).first();
  const b64 = toB64(buf), stmts = [];
  for (let i = 0, n = 0; i < b64.length; i += REPORT_CHUNK, n++)
    stmts.push(env.DB.prepare("INSERT INTO report_parts (report_id, idx, data) VALUES (?1, ?2, ?3)").bind(f.id, n, b64.slice(i, i + REPORT_CHUNK)));
  if (!rv) stmts.push(env.DB.prepare("UPDATE bookings SET status='report_ready', report_at=?1, completed_at=NULL, updated_at=?1 WHERE id=?2").bind(now, id));
  await env.DB.batch(stmts);
  return { id: f.id, token };
}
async function deleteReportRows(env, ids) {
  if (!ids.length) return;
  await env.DB.batch(ids.flatMap((rid) => [env.DB.prepare("DELETE FROM report_parts WHERE report_id=?1").bind(rid), env.DB.prepare("DELETE FROM report_files WHERE id=?1").bind(rid)]));
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
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f LEFT JOIN bookings b ON b.id = f.booking_id WHERE f.id=?1").bind(rid).first();
  return f ? fileResponse(env, f, f.patient || "") : bad("Report not found", 404);
}
async function adminReport(env, id) { // first report of a booking (older admin pages)
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE f.booking_id=?1 ORDER BY f.id LIMIT 1").bind(id).first();
  return f ? fileResponse(env, f, f.patient) : bad("Report not found", 404);
}
async function adminDeleteReport(env, rid) {
  const f = await env.DB.prepare("SELECT * FROM report_files WHERE id=?1").bind(rid).first();
  if (!f) return bad("Report not found", 404);
  await env.DB.batch([env.DB.prepare("DELETE FROM report_parts WHERE report_id=?1").bind(rid), env.DB.prepare("DELETE FROM report_files WHERE id=?1").bind(rid)]);
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END) AS unsent FROM report_files WHERE booking_id=?1 AND ${LIVE_REP}`).bind(f.booking_id).first();
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id=?1").bind(f.booking_id).first();
  if (row && ["report_ready", "completed"].includes(row.status)) {
    const st = !left.n ? "collected" : left.unsent ? "report_ready" : row.status;
    if (st !== row.status) await env.DB.prepare("UPDATE bookings SET status=?1, completed_at=NULL, updated_at=?2 WHERE id=?3").bind(st, isoNow(), f.booking_id).run();
  }
  return json({ ok: true });
}
async function publicReport(env, token) {
  const f = await env.DB.prepare("SELECT f.*, b.name AS patient FROM report_files f JOIN bookings b ON b.id = f.booking_id WHERE f.token=?1 AND b.status NOT IN ('cancelled','blocked')").bind(token).first();
  if (!f) return new Response("This report link is not valid. Please WhatsApp us on 9818028755.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
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
  const r = await env.DB.prepare("UPDATE bookings SET vial_no=?1, vial_reported=NULL, vial_reported_at=NULL, updated_at=?2 WHERE id=?3 AND status IN ('collected','report_ready','completed')").bind(vial, isoNow(), id).run();
  if (!r.meta.changes) return bad("Mark the sample as collected first.", 409);
  return json({ ok: true });
}

// Admin opened WhatsApp with a message. Sending the report completes the job.
const MSG_KINDS = ["paylink", "pay", "confirm", "center", "collector", "reminder", "slots", "missed", "collected", "report", "prep", "moved", "centre_cancel", "chat"];
const DONE_KINDS = ["confirm", "center", "centre_ok", "collector", "reminder", "collected"]; // message steps that can be ticked as done by hand
// A message sent by hand from someone's own WhatsApp (manual mode / "Send by hand") – also shown in Admin → Inbox.
async function logHand(env, bookingId, kind, toPhone) {
  try {
    const b = await bookingFull(env, bookingId);
    if (!b) return;
    const m = msgFor(env, await templates(env), b, kind);
    const to = toPhone || (m.t.to === "patient" ? b.phone : m.t.to === "centre" ? b.centre_phone : null);
    if (!to) return;
    await env.DB.prepare("INSERT INTO wa_inbox (wa_id, phone, type, body, at, dir, by_who, status) VALUES (?1, ?2, 'text', ?3, ?4, 'out', 'hand', 'hand')")
      .bind(`hand-${crypto.randomUUID()}`, to, m.text.slice(0, 4000), isoNow()).run();
  } catch (e) { console.log("hand log failed", String(e)); }
}
async function adminSent(env, req, id) {
  const body = await req.json().catch(() => ({}));
  const kind = body.kind;
  const staff = STAFF.get(req);
  if (staff && staff.role !== "admin" && !(kind === "done:centre_ok" || (kind === "undo-done" && body.target === "centre_ok")))
    return bad("Only an admin can mark messages as sent by hand.", 403);
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
    if (kind === "done:centre_ok") later(req, waEvent(env, "accepted_hand", id));
    return json({ ok: true });
  }
  if (!MSG_KINDS.includes(kind)) return bad("Invalid message type");
  later(req, logHand(env, id, kind));
  const stmts = [env.DB.prepare("INSERT INTO msg_log (booking_id, kind, at) VALUES (?1, ?2, ?3)").bind(id, kind, now)];
  let completed = false, marked = [];
  if (kind === "report") {
    const { results: files } = await env.DB.prepare(`SELECT id, sent_at FROM report_files WHERE booking_id=?1 AND ${LIVE_REP}`).bind(id).all();
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
async function adminPackages(env, staff) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id AND b.status NOT IN ('cancelled','expired','blocked')) AS bookings
     FROM packages p ORDER BY p.sort, p.id`).all();
  const { results: links } = await env.DB.prepare("SELECT pt.package_id, t.id, t.name FROM package_tests pt JOIN lab_tests t ON t.id = pt.test_id ORDER BY pt.package_id, pt.sort").all();
  for (const r of results) { r.has_page = !!r.page; delete r.page; if (staff && staff.role === "operator") r.margin = null; r.linked = links.filter((l) => l.package_id === r.id).map((l) => ({ id: l.id, name: l.name })); }
  return json({ packages: results });
}

// ---- website: "/" = our story + package cards; /package/<slug> = a package page (Admin → Packages → "Edit page") ----
async function sitePage(env, req, url, slug) {
  const pkg = await env.DB.prepare("SELECT * FROM packages WHERE slug=?1 AND active=1 AND page_live=1 AND page IS NOT NULL").bind(slug).first();
  if (!pkg) return null;
  let page; try { page = JSON.parse(pkg.page); } catch { return null; }
  return renderPackagePage(env, req, pkg, page, { canonical: `https://drsarwantests.com/package/${pkg.slug}`, formPrice: testPrice(env, pkg).price });
}
async function homeContent(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='home_page'").first();
  try { return r && r.v ? JSON.parse(r.v) : HOME_DEFAULT; } catch { return HOME_DEFAULT; }
}
const livePackages = (env) => env.DB.prepare("SELECT name, slug, price, mrp, tests, page FROM packages WHERE active=1 AND page_live=1 AND page IS NOT NULL AND slug IS NOT NULL ORDER BY is_default DESC, sort, id").all().then((r) => r.results);
async function homePage(env, home, preview) {
  return new Response(renderHome(home, await livePackages(env), { preview }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": preview ? "no-store" : "public, max-age=60" } });
}
async function sitemap(env) {
  const pk = await livePackages(env);
  const urls = ["/", ...pk.map((p) => `/package/${p.slug}`), "/contact", "/privacy", "/service", "/refund", "/delivery"];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>https://drsarwantests.com${u}</loc></url>`).join("\n")}\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
async function adminHome(env) { return json({ page: homeFromBody(await homeContent(env)), packages: (await livePackages(env)).map((p) => ({ name: p.name, slug: p.slug })) }); }
async function adminSaveHome(env, req) {
  const b = await req.json().catch(() => ({}));
  const page = homeFromBody(b.page);
  if (!page.hero.title) return bad("Write the main heading first.");
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('home_page', ?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(page)).run();
  return json({ ok: true });
}
async function adminPage(env, id) {
  const pkg = await env.DB.prepare("SELECT * FROM packages WHERE id=?1").bind(id).first();
  if (!pkg) return bad("Package not found", 404);
  let page = null; try { page = pkg.page ? JSON.parse(pkg.page) : null; } catch {}
  const { page: _, ...info } = pkg;
  return json({ package: info, page: pageFromBody(page || defaultPageFor(pkg)), saved: !!page, slug: pkg.slug || slugify(pkg.name), live: !!pkg.page_live,
    url: `/package/${pkg.slug || slugify(pkg.name)}`, ai: !!aiKey(env) });
}
async function adminSavePage(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const pkg = await env.DB.prepare("SELECT * FROM packages WHERE id=?1").bind(id).first();
  if (!pkg) return bad("Package not found", 404);
  const slug = slugify(b.slug || pkg.slug || pkg.name);
  if (slug.length < 3) return bad("The web address needs at least 3 letters or numbers.");
  if (await env.DB.prepare("SELECT 1 FROM packages WHERE slug=?1 AND id!=?2").bind(slug, id).first()) return bad(`/package/${slug} is already used by another package.`);
  const page = pageFromBody(b.page);
  const live = b.live ? 1 : 0;
  if (live && !pkg.active) return bad("This package is hidden – make it Active before publishing its page.");
  if (live && !page.hero.headline) return bad("Write the main question (hero headline) before publishing.");
  await env.DB.prepare("UPDATE packages SET slug=?1, page=?2, page_live=?3, page_at=?4 WHERE id=?5").bind(slug, JSON.stringify(page), live, isoNow(), id).run();
  return json({ ok: true, slug, live: !!live, url: `/package/${slug}` });
}
async function adminPreviewPage(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const pkg = await env.DB.prepare("SELECT * FROM packages WHERE id=?1").bind(id).first();
  if (!pkg) return bad("Package not found", 404);
  const res = await renderPackagePage(env, req, pkg, b.page || {}, { preview: true, canonical: `https://drsarwantests.com/package/${pkg.slug || slugify(pkg.name)}` });
  return new Response(await res.text(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
async function adminAiPage(env, req, id) {
  if (!aiKey(env)) return bad("Add the ANTHROPIC_API_KEY secret in Cloudflare first.");
  const b = await req.json().catch(() => ({}));
  const pkg = await env.DB.prepare("SELECT * FROM packages WHERE id=?1").bind(id).first();
  if (!pkg) return bad("Package not found", 404);
  const section = String(b.section || "");
  if (section !== "all" && !PAGE_SECTIONS.includes(section)) return bad("Unknown section");
  const S = await getSettings(env);
  try {
    const out = await aiGeneratePage({ url: env.ANTHROPIC_URL || "https://api.anthropic.com", key: aiKey(env), model: S.ai_model || AI_MODEL_DEFAULT },
      pkg, section, clean(b.instructions, 1000), b.page && typeof b.page === "object" ? b.page : null);
    return json({ ok: true, content: out });
  } catch (e) {
    console.log("ai page", String(e));
    return bad("The AI couldn't write this section: " + String(e.message || e).slice(0, 200), 502);
  }
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
  await env.DB.batch([env.DB.prepare("DELETE FROM package_tests WHERE package_id=?1").bind(id), env.DB.prepare("DELETE FROM packages WHERE id=?1").bind(id)]);
  return json({ ok: true });
}


// ---- lab tests: the single tests inside packages (Admin → Tests) ----
// Each test has a plain-language "what it's for" (written by Claude, editable). Packages link to tests (package_tests).
// The package's own "tests" text stays the short summary patients see; "Use linked tests" in the package form rewrites it.
const TEST_CATS = ["Hormones", "Fertility", "Thyroid", "Diabetes", "Liver", "Kidney", "Heart & lipids", "Vitamins & minerals", "Blood count",
  "Infection", "Cancer markers", "Pregnancy", "Allergy", "Urine", "Electrolytes", "Inflammation", "Toxic elements", "Other"];
const normTest = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function readLabTest(b) {
  const name = clean(b.name, 120);
  if (name.length < 2) return { err: "Enter the test name." };
  const n = (v) => (v === "" || v === null || v === undefined ? null : Number.isFinite(+v) && +v >= 0 && +v <= 10000000 ? Math.round(+v) : NaN);
  const price = n(b.price), margin = n(b.margin);
  if (Number.isNaN(price) || Number.isNaN(margin)) return { err: "Price and margin must be numbers." };
  return { name, code: clean(b.code, 40) || null, also_called: clean(b.also_called, 200) || null, category: clean(b.category, 40) || null,
    sample: clean(b.sample, 60) || null, purpose: clean(b.purpose, 1200) || null, price, margin, active: b.active === false || b.active === 0 ? 0 : 1 };
}
async function adminLabTests(env) {
  const [{ results: tests }, { results: links }, { results: pkgs }] = await Promise.all([
    env.DB.prepare("SELECT * FROM lab_tests ORDER BY lower(name)").all(),
    env.DB.prepare("SELECT package_id, test_id, sort FROM package_tests ORDER BY package_id, sort, test_id").all(),
    env.DB.prepare("SELECT id, name, tests, active FROM packages ORDER BY sort, id").all(),
  ]);
  return json({ tests, links, packages: pkgs, cats: TEST_CATS, ai: !!aiKey(env) });
}
async function adminSaveLabTest(env, req, id) {
  const b = await req.json().catch(() => ({}));
  const t = readLabTest(b);
  if (t.err) return bad(t.err);
  const dup = await env.DB.prepare("SELECT id FROM lab_tests WHERE lower(name)=lower(?1) AND id != ?2").bind(t.name, id || 0).first();
  if (dup) return bad("A test with this name already exists.", 409);
  const now = isoNow();
  if (id) {
    const r = await env.DB.prepare(`UPDATE lab_tests SET name=?1, code=?2, also_called=?3, category=?4, sample=?5, purpose=?6, price=?7, margin=?8, active=?9, updated_at=?10 WHERE id=?11`)
      .bind(t.name, t.code, t.also_called, t.category, t.sample, t.purpose, t.price, t.margin, t.active, now, id).run();
    if (!r.meta.changes) return bad("Test not found", 404);
  } else {
    await env.DB.prepare(`INSERT INTO lab_tests (name, code, also_called, category, sample, purpose, price, margin, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
      .bind(t.name, t.code, t.also_called, t.category, t.sample, t.purpose, t.price, t.margin, t.active, now).run();
    id = (await env.DB.prepare("SELECT id FROM lab_tests WHERE lower(name)=lower(?1)").bind(t.name).first()).id;
  }
  // optional: which packages include this test (from the test form)
  if (Array.isArray(b.package_ids)) {
    const want = [...new Set(b.package_ids.map(Number).filter((x) => x > 0))];
    const { results: have } = await env.DB.prepare("SELECT package_id FROM package_tests WHERE test_id=?1").bind(id).all();
    const stmts = [];
    for (const h of have) if (!want.includes(h.package_id)) stmts.push(env.DB.prepare("DELETE FROM package_tests WHERE package_id=?1 AND test_id=?2").bind(h.package_id, id));
    for (const pid of want) if (!have.some((h) => h.package_id === pid))
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO package_tests (package_id, test_id, sort) SELECT ?1, ?2, COALESCE(MAX(sort), 0) + 1 FROM package_tests WHERE package_id=?1").bind(pid, id));
    if (stmts.length) await env.DB.batch(stmts);
  }
  return json({ ok: true, id });
}
async function adminDeleteLabTest(env, id) {
  await env.DB.batch([env.DB.prepare("DELETE FROM package_tests WHERE test_id=?1").bind(id), env.DB.prepare("DELETE FROM lab_tests WHERE id=?1").bind(id)]);
  return json({ ok: true });
}
// The tests of one package, in order (add / remove / reorder from the Packages hover form). summary=true also rewrites the
// package's "Tests included" text from the linked names.
async function adminSetPackageTests(env, req, pid) {
  const b = await req.json().catch(() => ({}));
  const pkg = await env.DB.prepare("SELECT id FROM packages WHERE id=?1").bind(pid).first();
  if (!pkg) return bad("Package not found", 404);
  const ids = [...new Set((Array.isArray(b.test_ids) ? b.test_ids : []).map(Number).filter((x) => x > 0))].slice(0, 400);
  const stmts = [env.DB.prepare("DELETE FROM package_tests WHERE package_id=?1").bind(pid),
    ...ids.map((tid, i) => env.DB.prepare("INSERT INTO package_tests (package_id, test_id, sort) SELECT ?1, id, ?3 FROM lab_tests WHERE id=?2").bind(pid, tid, i + 1))];
  await env.DB.batch(stmts);
  if (b.summary) {
    const { results } = await env.DB.prepare("SELECT t.name FROM package_tests pt JOIN lab_tests t ON t.id = pt.test_id WHERE pt.package_id=?1 ORDER BY pt.sort").bind(pid).all();
    await env.DB.prepare("UPDATE packages SET tests=?1, updated_at=?2 WHERE id=?3").bind(results.map((x) => x.name).join(", ").slice(0, 4000), isoNow(), pid).run();
  }
  return json({ ok: true });
}

// ---- AI: split a package's test list into single tests, explain each, and link them ----
const LABTEST_SCHEMA = {
  type: "object",
  properties: {
    tests: {
      type: "array",
      description: "Every single test in the package, in the order given.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Clear standard name, e.g. 'Thyroid Stimulating Hormone (TSH)'. If the same test is in the existing list, use that exact name." },
          code: { type: "string", description: "Short code if there is a common one (TSH, AMH, HbA1c, LFT). Empty if none." },
          also_called: { type: "string", description: "Other names or how it was written in the package, comma separated. Empty if none." },
          category: { type: "string", enum: TEST_CATS },
          sample: { type: "string", description: "Sample needed: Blood, Urine, Blood (fasting), Stool…" },
          purpose: { type: "string", description: "1–2 short sentences in plain English: what the test measures and why a doctor orders it. No diagnosis, no scare words." },
        },
        required: ["name", "category", "sample", "purpose"],
      },
    },
  },
  required: ["tests"],
};
async function aiSplitPackage(env, S, pkg, known) {
  const prompt = `You are helping an Indian diagnostic lab (Dr. Sarwan Diagnostic Labs, NABL & CGHS approved) keep a catalogue of single lab tests.

Package: ${pkg.name}
What the package says it includes (written by the team, may be messy, may list groups like "Liver (12 Tests)"):
"""${String(pkg.tests || "").slice(0, 6000)}"""

Tests already in our catalogue (reuse these EXACT names when it is the same test):
${known.length ? known.map((t) => `- ${t.name}${t.code ? " [" + t.code + "]" : ""}`).join("\n") : "(none yet)"}

Return every single test in this package through the lab_tests tool:
- Split groups into the individual tests that are named. A group with no names listed (e.g. "Urine routine") is one test, e.g. "Urine Routine Examination".
- A profile that is normally ordered as one (e.g. "Thyroid profile") may be listed as its parts (T3, T4, TSH) when the parts are named; otherwise as the profile.
- Fix spelling and casing; keep Indian lab naming.
- If the text says only something like "85 tests" without naming them, list only what is named.
- "purpose" is for our team and patients: plain words, 1–2 sentences, no medical advice.`;
  const r = await fetch(`${env.ANTHROPIC_URL || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": aiKey(env), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: S.ai_model || AI_MODEL_DEFAULT, max_tokens: 16000,
      tools: [{ name: "lab_tests", description: "The single tests in the package.", input_schema: LABTEST_SCHEMA }],
      tool_choice: { type: "tool", name: "lab_tests" }, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.type === "error") throw new Error((j.error && j.error.message) || `AI request failed (${r.status})`);
  const use = (j.content || []).find((c) => c.type === "tool_use" && c.name === "lab_tests");
  if (!use || !use.input || !Array.isArray(use.input.tests)) throw new Error("The AI didn't return the tests. Please try again.");
  return use.input.tests;
}
async function adminAiPackageTests(env, pid) {
  if (!aiKey(env)) return bad("Add the ANTHROPIC_API_KEY secret in Cloudflare first.");
  const pkg = await env.DB.prepare("SELECT id, name, tests FROM packages WHERE id=?1").bind(pid).first();
  if (!pkg) return bad("Package not found", 404);
  if (!String(pkg.tests || "").trim()) return json({ ok: true, added: 0, linked: 0, note: "This package has no tests written yet." });
  const S = await getSettings(env);
  const { results: known } = await env.DB.prepare("SELECT id, name, code, also_called FROM lab_tests").all();
  let list;
  try { list = await aiSplitPackage(env, S, pkg, known); } catch (e) { return bad(String(e.message || e), 502); }
  const byName = new Map(known.map((t) => [normTest(t.name), t]));
  const byCode = new Map(known.filter((t) => t.code).map((t) => [normTest(t.code), t]));
  const ids = [], now = isoNow();
  let added = 0;
  for (const x of list) {
    const t = readLabTest({ ...x, category: TEST_CATS.includes(x.category) ? x.category : "Other" });
    if (t.err) continue;
    let hit = byName.get(normTest(t.name)) || (t.code && byCode.get(normTest(t.code)));
    if (!hit) {
      await env.DB.prepare(`INSERT OR IGNORE INTO lab_tests (name, code, also_called, category, sample, purpose, active, ai_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7, ?7)`)
        .bind(t.name, t.code, t.also_called, t.category, t.sample, t.purpose, now).run();
      hit = await env.DB.prepare("SELECT id, name, code FROM lab_tests WHERE lower(name)=lower(?1)").bind(t.name).first();
      if (!hit) continue;
      added++; byName.set(normTest(hit.name), hit); if (hit.code) byCode.set(normTest(hit.code), hit);
    } else {
      // fill in what's missing on an existing test (never overwrite what the team wrote)
      await env.DB.prepare(`UPDATE lab_tests SET code=COALESCE(code, ?1), category=COALESCE(category, ?2), sample=COALESCE(sample, ?3), purpose=COALESCE(purpose, ?4), updated_at=?5 WHERE id=?6`)
        .bind(t.code, t.category, t.sample, t.purpose, now, hit.id).run();
    }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  await env.DB.batch([env.DB.prepare("DELETE FROM package_tests WHERE package_id=?1").bind(pid),
    ...ids.map((tid, i) => env.DB.prepare("INSERT INTO package_tests (package_id, test_id, sort) VALUES (?1, ?2, ?3)").bind(pid, tid, i + 1))]);
  return json({ ok: true, added, linked: ids.length });
}
// "What it's for" for one test, written again by the AI
async function adminAiLabTest(env, id) {
  if (!aiKey(env)) return bad("Add the ANTHROPIC_API_KEY secret in Cloudflare first.");
  const t = await env.DB.prepare("SELECT * FROM lab_tests WHERE id=?1").bind(id).first();
  if (!t) return bad("Test not found", 404);
  const S = await getSettings(env);
  let list;
  try { list = await aiSplitPackage(env, S, { name: "single test", tests: t.name + (t.code ? ` (${t.code})` : "") }, []); } catch (e) { return bad(String(e.message || e), 502); }
  const x = list[0] || {};
  await env.DB.prepare("UPDATE lab_tests SET purpose=?1, category=COALESCE(category, ?2), sample=COALESCE(sample, ?3), code=COALESCE(code, ?4), ai_at=?5, updated_at=?5 WHERE id=?6")
    .bind(clean(x.purpose, 1200) || t.purpose, TEST_CATS.includes(x.category) ? x.category : null, clean(x.sample, 60) || null, clean(x.code, 40) || null, isoNow(), id).run();
  return json({ ok: true, purpose: clean(x.purpose, 1200) });
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
    "SELECT id,date,slot,status,package_name AS test,(SELECT SUM(margin) FROM booking_tests t WHERE t.booking_id=bookings.id) - ((SELECT SUM(price) FROM booking_tests t WHERE t.booking_id=bookings.id) - amount) AS margin,(SELECT COUNT(*) FROM report_files f WHERE f.booking_id=bookings.id AND (f.review IS NULL OR f.review='approved')) AS reports,(SELECT COUNT(*) FROM report_files f WHERE f.booking_id=bookings.id AND f.sent_at IS NOT NULL) AS reports_sent,amount AS amount_charged,name,phone,address,pincode,city,state,cycle,notes,amount,utr,vial_no,collected_at,report_at,completed_at,fee_due,fee_paid_at,CASE WHEN EXISTS(SELECT 1 FROM payment_proofs p WHERE p.booking_id=bookings.id) THEN 'yes' ELSE 'no' END AS screenshot,source,created_at,paid_at FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status!='blocked' ORDER BY date, slot"
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
const AFTER_COLLECT_STATES = ["collected", "report_ready", "completed"];
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
// One-time clean-up (14 Nov 2026): visits before the new workflow went live were all done outside the system
// (sample collected, report given), so they are closed as completed. Runs once; a settings flag remembers it.
async function closeOldBookings(env) {
  const flag = "mig_close_old_20261114";
  if (await env.DB.prepare("SELECT 1 FROM settings WHERE k=?1").bind(flag).first()) return;
  const now = isoNow();
  const where = "date < '2026-11-14' AND status IN ('payment_submitted','confirmed','collected','report_ready')";
  await env.DB.batch([
    env.DB.prepare(`UPDATE wa_outbox SET status='dismissed', updated_at=?1 WHERE status='failed' AND booking_id IN (SELECT id FROM bookings WHERE ${where})`).bind(now),
    env.DB.prepare(`UPDATE bookings SET status='completed', completed_at=COALESCE(completed_at, ?1), paid_at=COALESCE(paid_at, ?1),
      collected_at=COALESCE(collected_at, ?1), centre_status=COALESCE(centre_status, 'accepted'), centre_status_at=COALESCE(centre_status_at, ?1),
      resched_req=NULL, resched_at=NULL, resched_date=NULL, resched_slot=NULL, updated_at=?1 WHERE ${where}`).bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES (?1, ?2)").bind(flag, now),
  ]);
}
// One-time (15 Nov 2026): DSL-DVBY8Y was moved to "collected" straight from the centre's vial no. – put it back
// so the operator checks and confirms the vial (the centre's number is kept as the reported one).
async function reopenVialCheck(env) {
  const flag = "mig_reopen_vial_20261115";
  if (await env.DB.prepare("SELECT 1 FROM settings WHERE k=?1").bind(flag).first()) return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET status='confirmed', vial_reported=vial_no, vial_reported_at=collected_at, vial_no=NULL, collected_at=NULL, updated_at=?1
      WHERE id='DSL-DVBY8Y' AND status='collected' AND NOT EXISTS (SELECT 1 FROM report_files f WHERE f.booking_id='DSL-DVBY8Y')`).bind(isoNow()),
    env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES (?1, ?2)").bind(flag, isoNow()),
  ]);
}
async function seedAccounts(env) {
  const now = isoNow();
  await closeOldBookings(env);
  await reopenVialCheck(env);
  // the first admin login: username "admin" with the existing admin password
  const pw = String(env.ADMIN_PASSWORD || "").trim();
  if (pw && !(await env.DB.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").first())) {
    await env.DB.prepare("INSERT OR IGNORE INTO users (role, name, username, pass_hash, active, created_at, updated_at) VALUES ('admin', 'Admin', 'admin', ?1, 1, ?2, ?2)")
      .bind(await hashPassword(pw), now).run();
  }
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
    WHERE s.token_hash=?1 AND s.expires_at > ?2 AND s.role IN (SELECT value FROM json_each(?3)) AND u.active=1`).bind(await sha256(token), isoNow(), JSON.stringify([].concat(role))).first();
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
  const cur = await env.DB.prepare("SELECT centre_id, status, vial_reported FROM bookings WHERE id=?1 AND status != 'blocked'").bind(id).first();
  if (!cur) return bad("Booking not found", 404);
  if (cur.centre_id && (cur.vial_reported || ["collected", "report_ready", "completed"].includes(cur.status)))
    return bad("The sample is already collected, so the collection centre can't be changed.", 409);
  await assignCentre(env, id, cid);
  // payment is never checked by hand any more: a paid booking still marked "payment submitted" is confirmed by choosing its centre
  if (cid && cur.status === "payment_submitted") {
    await env.DB.prepare("UPDATE bookings SET status='confirmed', paid_at=COALESCE(paid_at, ?1), updated_at=?1 WHERE id=?2").bind(isoNow(), id).run();
    await logAct(env, id, (STAFF.get(req) || {}).name || "Admin", (STAFF.get(req) || {}).role || "admin", "Centre chosen – booking confirmed");
    later(req, centreJob(env, req, id, "paid_online")); // patient's confirmation (once) + job to the centre
  } else if (cid && cid !== cur.centre_id) later(req, centreJob(env, req, id, "assigned"));
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
  const role = url.searchParams.get("role") === "patient" ? "patient" : "staff";
  const q = clean(url.searchParams.get("q"), 60).toLowerCase();
  if (role === "staff") {
    const { results } = await env.DB.prepare(`SELECT u.id, u.role, u.name, u.phone, u.username, u.centre_id, u.active, u.last_login_at, u.created_at, c.name AS centre_name
      FROM users u LEFT JOIN centres c ON c.id = u.centre_id WHERE u.role IN ('admin','operator','centre')
      ORDER BY u.active DESC, CASE u.role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, c.name, u.name`).all();
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
  // patients are only created from bookings; staff roles can be changed
  const role = cur && cur.role === "patient" ? "patient" : ["admin", "operator", "centre"].includes(b.role) ? b.role : cur ? cur.role : "centre";
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
  const centreId = role === "centre" ? parseInt(b.centre_id, 10) : null;
  if (role === "centre" && !(await env.DB.prepare("SELECT 1 FROM centres WHERE id=?1").bind(centreId || 0).first())) return bad("Pick the user's collection centre.");
  if (cur && cur.role === "admin" && (role !== "admin" || !active)) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id != ?1").bind(id).first();
    if (!n.n) return bad("This is the only admin – make someone else an admin first.", 409);
  }
  const pw = String(b.password || "");
  if (!cur && pw.length < 8) return bad("Set a password of at least 8 characters.");
  if (pw && pw.length < 8) return bad("The new password must be at least 8 characters.");
  const dup = await env.DB.prepare("SELECT id FROM users WHERE username=?1 AND id != ?2").bind(username, id || 0).first();
  if (dup) return bad("That username is already taken.", 409);
  const hash = pw ? await hashPassword(pw) : null;
  if (cur) {
    await env.DB.prepare("UPDATE users SET role=?9, name=?1, phone=?2, username=?3, centre_id=?4, active=?5, pass_hash=COALESCE(?6, pass_hash), updated_at=?7 WHERE id=?8")
      .bind(name, phone, username, centreId, active, hash, now, id, role).run();
    if (hash || !active || role !== cur.role) await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id).run(); // sign them out everywhere
    return json({ ok: true, id });
  }
  const r = await env.DB.prepare("INSERT INTO users (role, name, phone, username, pass_hash, centre_id, active, created_at, updated_at) VALUES (?8, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
    .bind(name, phone, username, hash, centreId, active, now, role).run();
  return json({ ok: true, id: r.meta.last_row_id }, 201);
}
async function adminDeleteUser(env, id) {
  const u = await env.DB.prepare("SELECT role FROM users WHERE id=?1").bind(id).first();
  if (!u) return bad("User not found", 404);
  if (u.role === "patient") return bad("Patients come from bookings and can't be deleted. Untick “Active” to block their portal login.", 409);
  if (u.role === "admin") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id != ?1").bind(id).first();
    if (!n.n) return bad("This is the only admin and can't be deleted.", 409);
  }
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id), env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id)]);
  return json({ ok: true });
}

// ---- centre portal ----
// New booking: everything we know about a mobile number (people on it, their addresses, last packages).
async function adminLookup(env, url) {
  // ?q=digits: patients whose number contains them, one row per person + address they used (latest first)
  const q = String(url.searchParams.get("q") || "").replace(/\D/g, "").slice(-10);
  if (url.searchParams.has("q")) {
    if (q.length < 3) return json({ matches: [] });
    const { results } = await env.DB.prepare(
      `SELECT b.phone, b.patient_id, COALESCE(u.name, b.name) AS name, u.dob, b.address, b.pincode, b.city, b.state, b.package_name AS last_package, b.date AS last_date, MAX(b.created_at) AS last_at
       FROM bookings b LEFT JOIN users u ON u.id = b.patient_id
       WHERE b.phone LIKE ?1 AND b.status != 'blocked' AND b.name != ''
       GROUP BY b.phone, COALESCE(CAST(b.patient_id AS TEXT), lower(b.name)), lower(trim(b.address)), b.pincode
       ORDER BY (b.phone LIKE ?2) DESC, last_at DESC LIMIT 8`).bind(`%${q}%`, `${q}%`).all();
    return json({ matches: results.map(({ last_at, patient_id, ...m }) => m) });
  }
  const phone = normPhone(url.searchParams.get("phone") || "");
  if (!phone) return bad("Enter a valid 10-digit mobile number.");
  const [{ results: people }, { results: rows }] = await Promise.all([
    env.DB.prepare("SELECT id, name, dob FROM users WHERE role='patient' AND phone=?1 AND active=1 ORDER BY id").bind(phone).all(),
    env.DB.prepare(`SELECT id, name, date, address, pincode, city, state, package_name, status, patient_id FROM bookings
      WHERE phone=?1 AND status NOT IN ('blocked') ORDER BY created_at DESC LIMIT 30`).bind(phone).all(),
  ]);
  const seen = new Set(), addresses = [];
  for (const r of rows) {
    const k = (r.address + "|" + r.pincode).toLowerCase().replace(/\s+/g, " ");
    if (!r.address || seen.has(k)) continue;
    seen.add(k); addresses.push({ address: r.address, pincode: r.pincode, city: r.city, state: r.state, last: r.date });
  }
  const out = people.map((p) => {
    const mine = rows.filter((r) => r.patient_id === p.id);
    return { id: p.id, name: p.name, dob: p.dob, bookings: mine.length, last_date: mine[0] ? mine[0].date : null, last_package: mine[0] ? mine[0].package_name : null };
  });
  return json({ phone, people: out, addresses: addresses.slice(0, 6), bookings: rows.length });
}

// ---- staff (admin / operator) sign-in ----
const STAFF_SESSION_DAYS = 7;
const STAFF_ROLES = ["admin", "operator"];
async function staffLogin(env, req) {
  const b = await req.json().catch(() => ({}));
  const username = clean(b.username, 40).toLowerCase(), pw = String(b.password || "");
  const keys = [["s:" + username, 8], ["ip:" + ipOf(req), 30]];
  if (await loginBlocked(env, keys)) return bad("Too many wrong tries. Please wait 15 minutes.", 429);
  const u = await env.DB.prepare("SELECT * FROM users WHERE role IN ('admin','operator') AND username=?1 AND active=1").bind(username).first();
  if (!u || !(await verifyPassword(pw, u.pass_hash))) { await loginFailed(env, keys); return bad("Wrong username or password.", 401); }
  const token = await newSession(env, u, STAFF_SESSION_DAYS * 86400000);
  return json({ token, user: { name: u.name, username: u.username, role: u.role } });
}
// who is calling an /api/admin/ endpoint: a signed-in admin/operator, or the old admin password (counts as admin)
async function staffOf(env, req) {
  if (isAdmin(env, req)) return { id: 0, role: "admin", name: "Admin", username: "admin" };
  const u = await getSession(env, req, STAFF_ROLES);
  return u ? { id: u.id, role: u.role, name: u.name, username: u.username } : null;
}
// what an operator may do in /api/admin/ (everything else is admin-only)
const OPERATOR_OK = [
  ["GET", /^\/api\/admin\/(bookings|packages|centres|me)$/],
  ["POST", /^\/api\/admin\/bookings$/],
  ["GET", /^\/api\/admin\/lookup$/],
  ["GET", /^\/api\/admin\/bookings\/DSL-[A-Z0-9]{6}\/(screenshot|reports?|activity)$/],
  ["POST", /^\/api\/admin\/bookings\/DSL-[A-Z0-9]{6}\/(move|reports?|tests|sent|status|centre|send|resched|cancel-centre)$/], // vial changes: admin only
  ["GET", /^\/api\/admin\/reports\/\d{1,9}$/],
  ["GET", /^\/api\/admin\/review$/],
  ["POST", /^\/api\/admin\/review\/\d{1,9}$/],
  ["DELETE", /^\/api\/admin\/reports\/\d{1,9}$/],
];
const operatorMay = (method, p) => OPERATOR_OK.some(([m, re]) => m === method && re.test(p));

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
  const { results } = await env.DB.prepare(`SELECT id, date, slot, name, phone, address, pincode, city, state, cycle, notes, status, vial_no, vial_reported, collected_at, package_name, centre_status, collector_info
    FROM bookings WHERE centre_id=?1 AND date BETWEEN ?2 AND ?3 AND status IN (${PAID_STATES.map((_, i) => "?" + (i + 4)).join(",")}) ORDER BY date, slot`)
    .bind(user.centre_id, from, to, ...PAID_STATES).all();
  const ids = results.map((r) => r.id);
  let tests = [], files = [];
  if (ids.length) {
    const ph = ids.map((_, i) => "?" + (i + 1)).join(",");
    [{ results: tests }, { results: files }] = await Promise.all([
      env.DB.prepare(`SELECT booking_id, name FROM booking_tests WHERE booking_id IN (${ph}) ORDER BY id`).bind(...ids).all(),
      env.DB.prepare(`SELECT id, booking_id, name, size, created_at, review, review_note FROM report_files WHERE booking_id IN (${ph}) AND COALESCE(review, '') NOT IN ('draft','withdrawn') ORDER BY id`).bind(...ids).all(),
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
  const r = await reportVial(env, row, b.vial_no);
  if (r.err) return bad(r.err, 409);
  if (r.reported) later(req, waEvent(env, "vial_reported", id));
  return json({ ok: true, reported: !!r.reported });
}
// centre (portal or WhatsApp) gives the vial no.: confirmed → collected, or a correction of the vial no.
// The centre (portal or WhatsApp) only REPORTS the vial no. Nothing moves and the patient isn't told until
// someone in our team checks it and confirms the vial at the lab (Operations → Step 3).
async function reportVial(env, row, vialIn) {
  const vial = clean(vialIn, 40).toUpperCase().replace(/\s+/g, "");
  if (!vial) return { err: "Enter the vial number written on the sample." };
  if (!["confirmed", "collected", "report_ready", "completed"].includes(row.status)) return { err: "This booking can't take a vial no." };
  const dup = await env.DB.prepare("SELECT id FROM bookings WHERE vial_no=?1 AND id!=?2 LIMIT 1").bind(vial, row.id).first();
  if (dup) return { err: `Vial ${vial} is already used for another booking. Check the number.` };
  if (vial === row.vial_no) return { ok: true, vial, same: true };
  const now = isoNow();
  await env.DB.prepare("UPDATE bookings SET vial_reported=?1, vial_reported_at=?2, updated_at=?2 WHERE id=?3").bind(vial, now, row.id).run();
  return { ok: true, vial, reported: true };
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
// A report from the centre portal goes through the same AI check and operator approval as one sent on WhatsApp.
async function centreUpload(env, user, req, id) {
  const row = await centreBookingRow(env, user, id);
  if (!row) return bad("Booking not found", 404);
  if (!["confirmed", "collected", "report_ready", "completed"].includes(row.status)) return bad("This booking can't take a report.", 409);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) return bad("Empty file");
  if (buf.length > MAX_REPORT_BYTES) return bad("Report is larger than 10 MB.");
  if (String.fromCharCode(...buf.subarray(0, 5)) !== "%PDF-") return bad("Please upload the report as a PDF.");
  let name = "report.pdf";
  try { name = clean(decodeURIComponent(req.headers.get("x-filename") || "report.pdf"), 120) || name; } catch {}
  const f = await storeReport(env, id, buf, name, { review: "pending", centre_id: user.centre_id, src: "portal", src_phone: user.phone || null, hint_booking: id });
  later(req, waEvent(env, "review", id));
  return json({ ok: true, id: f.id, review: "pending" }); // the centre doesn't get the patient's download link
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
  if (await loginBlocked(env, keys)) return bad("Too many wrong tries. Please wait 15 minutes or WhatsApp us on 9818028755.", 429);
  const u = await env.DB.prepare("SELECT * FROM users WHERE role='patient' AND phone=?1 AND dob=?2 AND active=1 ORDER BY id LIMIT 1").bind(phone, dob).first();
  if (!u) { await loginFailed(env, keys); return bad("We couldn't find reports for this mobile number and date of birth. Check both, or WhatsApp us on 9818028755.", 401); }
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
// ---- AI report check: read every page of a report PDF, match it to the right patient ----
// =====================================================================
// The AI only READS the report (names, ages, IDs, dates, tests on every page). Matching to a patient is done here in code,
// so the rules are the same every time and the reasons can be shown to the centre and the operator.
// Claude (Anthropic API) reads the PDF. Secret: ANTHROPIC_API_KEY (or CLAUDE_API_KEY) in Cloudflare → Worker → Settings → Variables and Secrets.
// Model: Admin → WhatsApp → "AI model". Without a key, reports still flow; they are marked "AI check off" and matched by hand.
const AI_MODEL_DEFAULT = "claude-sonnet-5-5";
const aiKey = (env) => env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || "";
const REPORT_PENDING_STATES = ["confirmed", "collected", "report_ready", "completed"]; // bookings a report can belong to
const REPORT_LOOKBACK_DAYS = 60;
const AI_STALE_MIN = 4; // a check still "checking" after this long was cut off → try again

const AI_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["readable", "lab_name", "report_status", "pending_tests", "pages_total", "people", "identifiers", "collected_on", "reported_on", "tests"],
  properties: {
    readable: { type: "boolean", description: "false only if this is not a medical report (lab, pathology, radiology/imaging such as X-ray, ultrasound, CT, MRI, ECG) or the pages can't be read" },
    lab_name: { type: "string" },
    report_status: { type: "string", enum: ["final", "interim", "unknown"] },
    pending_tests: { type: "integer", description: "tests marked pending / processing / not ready; 0 if none" },
    pages_total: { type: "integer" },
    people: {
      type: "array", description: "every different patient named on the pages, with the pages each appears on",
      items: { type: "object", additionalProperties: false, required: ["name", "age_years", "gender", "pages"],
        properties: { name: { type: "string" }, age_years: { type: ["number", "null"] }, gender: { type: "string", enum: ["female", "male", "other", "unknown"] },
          pages: { type: "array", items: { type: "integer" } } } },
    },
    identifiers: {
      type: "array", description: "every barcode, sample no., lab no., visit/patient ID or reference printed (max 30)",
      items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } },
    },
    collected_on: { type: "string", description: "sample collection date YYYY-MM-DD, or empty" },
    reported_on: { type: "string", description: "report date YYYY-MM-DD, or empty" },
    tests: { type: "array", items: { type: "string" }, description: "test and panel names in the report (max 60)" },
  },
};
const AI_PROMPT = `You are checking a medical report PDF (lab / pathology, or radiology / imaging such as X-ray, ultrasound, CT, MRI, ECG) before it is sent to a patient. Read EVERY page, including headers and footers.
Extract exactly what is printed – never guess or correct spellings.
- people: each different patient name printed on the pages, with age, gender and the page numbers (1-based) it appears on.
  Treat the same name written with or without spaces, titles (Mr/Mrs/Ms) or dots as ONE person. If a page shows a different patient, list that person separately.
- identifiers: every barcode, sample number, lab number, accession, visit or patient ID and its label as printed (e.g. "BarcodeNO", "Sample Type | Barcode").
- report_status: "interim" if the report says interim/partial/provisional or some tests are still pending/processing, "final" if it says final, else "unknown".
- tests: names of the tests or panels reported.
Always answer by calling the lab_report tool exactly once (no other text).`;

async function reportB64(env, rid) {
  const { results } = await env.DB.prepare("SELECT data FROM report_parts WHERE report_id=?1 ORDER BY idx").bind(rid).all();
  return results.map((r) => r.data).join("");
}
async function aiReadReport(env, S, rid, filename) {
  const b64 = await reportB64(env, rid);
  const r = await fetch(`${env.ANTHROPIC_URL || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": aiKey(env), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: S.ai_model || AI_MODEL_DEFAULT,
      max_tokens: 4000,
      tools: [{ name: "lab_report", description: "What is printed in the lab report: patients per page, IDs, dates, status and tests.", input_schema: AI_SCHEMA }],
      tool_choice: { type: "auto" }, // some models don't allow forcing a tool; the prompt asks for it and plain JSON is accepted too
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 }, title: String(filename || "report.pdf").slice(0, 200) },
        { type: "text", text: AI_PROMPT },
      ] }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.type === "error") throw new Error((j.error && j.error.message) || `AI check failed (${r.status})`);
  const use = (j.content || []).find((c) => c.type === "tool_use" && c.name === "lab_report");
  if (use && use.input) return use.input;
  const txt = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = /\{[\s\S]*\}/.exec(txt);
  if (m) { try { const o = JSON.parse(m[0]); if (o && Array.isArray(o.people)) return o; } catch {} }
  throw new Error("The AI didn't return the report details");
}

// ---- matching helpers ----
const NAME_TITLES = new Set(["MR", "MRS", "MS", "MISS", "MASTER", "BABY", "DR", "SMT", "SHRI", "SRI", "KUM", "KUMARI", "MX", "BO", "MSTR", "SH"]);
const nameTokens = (s) => String(s || "").toUpperCase().replace(/\(.*?\)/g, " ").split(/[^A-Z]+/).filter((t) => t && !NAME_TITLES.has(t));
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// how well the name on the report fits the booking: exact | close | partial | none
function nameFit(onReport, booked) {
  const a = nameTokens(onReport), b = nameTokens(booked);
  if (!a.length || !b.length) return "none";
  const ja = a.join(""), jb = b.join("");
  if (ja === jb || [...a].sort().join("") === [...b].sort().join("")) return "exact"; // "RIYASHARMA" = "Riya Sharma", "Sarwan Adesh" = "Adesh Sarwan"
  const d = lev(ja, jb) / Math.max(ja.length, jb.length);
  if (d <= 0.15) return "close"; // small spelling differences
  // "Priya S" vs "Priya Sharma", or only the first name booked
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const tokOk = (x, y) => x === y || (x.length === 1 && y[0] === x) || (y.length === 1 && x[0] === y) || lev(x, y) <= (Math.min(x.length, y.length) >= 5 ? 1 : 0);
  if (s.every((t) => l.some((u) => tokOk(t, u))) && tokOk(s[0], l[0])) return "partial";
  if (Math.min(ja.length, jb.length) >= 5 && (ja.includes(jb) || jb.includes(ja))) return "partial";
  return "none";
}
const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// is the vial no. the centre typed printed anywhere in the report? (no fixed format: "529620" is found inside "GA529620")
function vialFound(vial, ids) {
  const v = normId(vial);
  if (v.length < 4) return null;
  for (const x of ids) {
    const val = normId(x.value);
    if (val && val.length >= 4 && (val === v || val.includes(v) || (v.includes(val) && val.length >= 6))) return x;
  }
  return null;
}
function ageAt(dob, onDate) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const d = onDate && /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : istParts().date;
  let a = Number(d.slice(0, 4)) - Number(dob.slice(0, 4));
  if (d.slice(5) < dob.slice(5)) a--;
  return a >= 0 && a < 130 ? a : null;
}
const dayDiff = (a, b) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000;
const SHORT_TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "SMT", "SHRI", "SRI", "MASTER", "BABY"]);
const shortName = (n) => { const t = String(n || "").replace(/\b(mr|mrs|ms|dr|smt)\.(?=\S)/gi, "$1. ").trim().split(/\s+/).filter((w) => !SHORT_TITLES.has(w.toUpperCase().replace(/\./g, ""))); return t.length > 1 ? `${t[0]} ${t[t.length - 1][0].toUpperCase()}` : t[0] || "Patient"; };

// the different people named in the report (the same person spelled with/without spaces counts once)
function reportPeople(ai) {
  const out = [];
  for (const p of (ai && ai.people) || []) {
    if (!nameTokens(p.name).length) continue;
    const same = out.find((q) => ["exact", "close"].includes(nameFit(q.name, p.name)));
    if (same) { same.pages = [...new Set([...same.pages, ...(p.pages || [])])]; if (same.age_years == null) same.age_years = p.age_years; }
    else out.push({ name: p.name, age_years: p.age_years, gender: p.gender, pages: [...(p.pages || [])] });
  }
  return out;
}

// Score the report against every booking it could belong to → { status: ok | check | nomatch | mixed | unreadable | off, best, reasons… }
async function matchReport(env, f, ai, aiError) {
  const hint = f.hint_booking || (f.booking_id && f.src === "portal" ? f.booking_id : null);
  const base = { best: null, second: null, reasons: [], says: null, pages: ai ? ai.pages_total || null : null,
    interim: !!(ai && (ai.report_status === "interim" || ai.pending_tests > 0)), pending_tests: ai ? ai.pending_tests || 0 : 0, lab: ai ? ai.lab_name || "" : "" };
  if (!ai) return { ...base, status: "off", best: hint, reasons: [aiError ? `AI check failed (${String(aiError).slice(0, 120)}) – check it by hand` : "AI check is off – check it by hand"] };
  if (!ai.readable) return { ...base, status: "unreadable", best: hint, reasons: ["The AI couldn't read this PDF – open it and check by hand"] };
  const people = reportPeople(ai);
  const p = people[0] || null;
  base.says = p ? { name: p.name, age: p.age_years, gender: p.gender } : null;
  base.people = people.map((x) => ({ name: x.name, age: x.age_years, pages: x.pages.slice(0, 50) }));
  if (people.length > 1) return { ...base, status: "mixed", best: hint, reasons: [`Mixed report – different patients on different pages: ${people.map((x) => `${x.name} (pages ${x.pages.slice(0, 6).join(", ")}${x.pages.length > 6 ? "…" : ""})`).join(" · ")}`] };
  if (!p) return { ...base, status: "unreadable", best: hint, reasons: ["No patient name found in the report"] };

  // candidates: this centre's bookings that can take a report (any centre for reports our team uploads)
  const since = addDays(istParts().date, -REPORT_LOOKBACK_DAYS);
  const ph = REPORT_PENDING_STATES.map((_, i) => "?" + (i + 3)).join(",");
  const { results: cands } = await env.DB.prepare(`SELECT b.id, b.name, b.date, b.status, b.vial_no, b.vial_reported, b.collected_at, b.vial_reported_at,
      (SELECT dob FROM users u WHERE u.id = b.patient_id) AS dob, (SELECT group_concat(t.name || ' ' || COALESCE(p.tests, ''), ' ') FROM booking_tests t LEFT JOIN packages p ON p.id = t.package_id WHERE t.booking_id = b.id) AS tests
    FROM bookings b WHERE b.centre_id = ?1 AND b.date >= ?2 AND b.status IN (${ph}) ORDER BY b.date DESC LIMIT 300`).bind(Number(f.centre_id) || 0, since, ...REPORT_PENDING_STATES).all();
  if (hint && !cands.some((c) => c.id === hint)) {
    const h = await env.DB.prepare(`SELECT b.id, b.name, b.date, b.status, b.vial_no, b.vial_reported, b.collected_at, b.vial_reported_at, (SELECT dob FROM users u WHERE u.id = b.patient_id) AS dob, '' AS tests FROM bookings b WHERE b.id=?1`).bind(hint).first();
    if (h) cands.push(h);
  }
  const ids = ai.identifiers || [];
  const repDate = /^\d{4}-\d{2}-\d{2}$/.test(ai.collected_on || "") ? ai.collected_on : /^\d{4}-\d{2}-\d{2}$/.test(ai.reported_on || "") ? ai.reported_on : null;
  const repTests = (ai.tests || []).join(" ").toUpperCase();
  const scored = cands.map((c) => {
    const fit = nameFit(p.name, c.name);
    let score = { exact: 60, close: 48, partial: 35, none: 0 }[fit];
    const why = [], warn = [];
    if (fit === "exact") why.push("name matches"); else if (fit === "close") why.push("name matches (small spelling difference)");
    else if (fit === "partial") warn.push(`name only partly matches (report: ${p.name}, booking: ${c.name})`);
    const vials = [c.vial_reported, c.vial_no].filter(Boolean);
    const vf = vials.map((v) => vialFound(v, ids)).find(Boolean) || null;
    if (vf) { score += 50; why.push(`vial no. found (${vf.label || "ID"} ${vf.value})`); }
    const age = ageAt(c.dob, repDate);
    let ageOk = null;
    if (age != null && p.age_years != null) {
      ageOk = Math.abs(age - p.age_years) <= 1;
      if (ageOk) { score += 10; why.push(`age ${p.age_years}${age !== Math.round(p.age_years) ? ` (booking ${age})` : ""}`); }
      else { score -= 25; warn.push(`age differs: report ${p.age_years}, booking ${age}`); }
    }
    const coll = (c.collected_at || c.vial_reported_at || "").slice(0, 10) || c.date;
    if (repDate && coll) {
      const dd = dayDiff(repDate, coll);
      if (dd <= 2) { score += 5; why.push(ai.collected_on ? "collected the same day" : "report date fits"); }
      else if (dd > 7) { score -= 10; warn.push(`report date ${repDate} is far from the visit (${coll})`); }
    }
    // tests: how many words of the booked tests show up in the report (supporting only)
    const words = [...new Set(String(c.tests || "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && !["AND", "THE", "PROFILE", "PANEL", "TEST", "TESTS", "PACKAGE", "TOTAL", "SERUM", "BLOOD", "FULL", "BODY", "WITH"].includes(w)))];
    let testsNote = null;
    if (words.length >= 3 && repTests) {
      const hit = words.filter((w) => repTests.includes(w)).length / words.length;
      if (hit >= 0.5) { score += 5; testsNote = "tests fit the booking"; why.push(testsNote); }
      else if (hit < 0.2) { score -= 5; warn.push("few of the booked tests are in this report – partial or wrong report?"); }
    }
    if (hint && c.id === hint) score += 5;
    return { c, fit, score, why, warn, vf, ageOk };
  }).sort((x, y) => y.score - x.score);
  const top = scored[0], two = scored[1];
  base.cands = scored.slice(0, 3).map((x) => ({ id: x.c.id, score: x.score }));
  if (!top || top.score < 30) {
    const uniq = [...new Map(ids.map((x) => [normId(x.value), String(x.value).replace(/[*_]/g, "").trim()])).values()].filter(Boolean);
    const any = uniq.length ? ` IDs printed: ${uniq.slice(0, 3).join(", ")}.` : "";
    return { ...base, status: "nomatch", best: hint, reasons: [`No patient waiting at this centre matches ${p.name}${p.age_years != null ? ` (${p.age_years}y)` : ""}.${any}`] };
  }
  const reasons = [...top.why, ...top.warn];
  let status = "ok";
  if (!["exact", "close"].includes(top.fit)) status = "check";
  if (top.fit === "none") reasons.unshift(`the vial no. matches but the name doesn't (report: ${p.name}, booking: ${top.c.name})`);
  if (top.ageOk === false) status = "check";
  if (two && two.score >= top.score - 15 && two.score >= 30) { status = "check"; reasons.push(`could also be ${two.c.name} (${two.c.id})`); }
  if (hint && hint !== top.c.id) { status = "check"; reasons.push(`the centre said this is for booking ${hint}, but it fits ${top.c.name} (${top.c.id}) better`); }
  if (people[0].pages.length && ai.pages_total && people[0].pages.length >= ai.pages_total) reasons.push(`same name on all ${ai.pages_total} pages`);
  if (!top.vf) {
    const h = await env.DB.prepare("SELECT SUM(CASE WHEN label != '__miss__' THEN hits ELSE 0 END) AS hit, SUM(CASE WHEN label = '__miss__' THEN hits ELSE 0 END) AS miss FROM report_hints WHERE centre_id=?1").bind(Number(f.centre_id) || 0).first();
    if (h && h.miss >= 3 && !h.hit) reasons.push("vial no. isn't printed on this centre's reports (normal for them)");
    else if ([top.c.vial_reported, top.c.vial_no].some(Boolean)) reasons.push("vial no. not found in the report");
  }
  if (base.interim) reasons.push(`INTERIM report${base.pending_tests ? ` – ${base.pending_tests} test${base.pending_tests === 1 ? "" : "s"} still processing` : ""}`);
  return { ...base, status, best: top.c.id, second: two && two.score >= 30 ? two.c.id : null, vial_label: top.vf ? top.vf.label || "" : null, reasons };
}

// Read + match one report (claimed so two runs never check the same file). Called every minute by the cron.
async function checkReport(env, S, rid) {
  const now = isoNow(), stale = new Date(Date.now() - AI_STALE_MIN * 60000).toISOString();
  const claim = await env.DB.prepare("UPDATE report_files SET ai_status='checking', ai_at=?1 WHERE id=?2 AND (ai_status IS NULL OR (ai_status='checking' AND ai_at < ?3))").bind(now, rid, stale).run();
  if (!claim.meta.changes) return;
  const f = await env.DB.prepare("SELECT * FROM report_files WHERE id=?1").bind(rid).first();
  let ai = null, err = null;
  if (aiKey(env)) {
    try { ai = await aiReadReport(env, S, rid, f.name); } catch (e) { err = e && e.message ? e.message : String(e); console.log("AI report check failed", rid, err); }
  }
  const m = await matchReport(env, f, ai, err);
  // a report from the centre portal stays on the booking the centre chose; the operator sees the AI's opinion
  const bookingId = f.src === "portal" ? f.booking_id : f.booking_id || "";
  await env.DB.prepare("UPDATE report_files SET ai_status=?1, ai_at=?2, ai_json=?3, match_status=?4, match_json=?5, booking_id=?6 WHERE id=?7")
    .bind(ai ? "done" : aiKey(env) ? "error" : "off", isoNow(), ai ? JSON.stringify(ai).slice(0, 60000) : err, m.status, JSON.stringify(m), bookingId, rid).run();
}

// Every minute: check new reports, then show each finished batch to its centre (1 minute after the last PDF, or after DONE).
async function reportJobs(env) {
  const S = await getSettings(env);
  const stale = new Date(Date.now() - AI_STALE_MIN * 60000).toISOString();
  const { results: todo } = await env.DB.prepare(`SELECT id FROM report_files WHERE review IN ('draft','pending','held')
    AND (ai_status IS NULL OR (ai_status='checking' AND ai_at < ?1)) ORDER BY id LIMIT 4`).bind(stale).all();
  await Promise.all(todo.map((f) => checkReport(env, S, f.id).catch((e) => console.log("report check", f.id, String(e && e.stack || e)))));
  const quiet = new Date(Date.now() - 60000).toISOString();
  const { results: ready } = await env.DB.prepare(`SELECT * FROM report_batches b WHERE b.status IN ('open','closing') AND (b.status='closing' OR b.last_file_at < ?1)
    AND NOT EXISTS (SELECT 1 FROM report_files f WHERE f.batch_id = CAST(b.id AS TEXT) AND f.review='draft' AND (f.ai_status IS NULL OR f.ai_status='checking')) LIMIT 10`).bind(quiet).all();
  // reports a centre never confirmed (it left the list for a day): removed, the centre is told nothing was sent
  const { results: oldB } = await env.DB.prepare("SELECT id FROM report_batches WHERE status IN ('open','closing','confirm') AND last_file_at < ?1 LIMIT 20").bind(new Date(Date.now() - 24 * 3600000).toISOString()).all();
  for (const b of oldB) {
    const { results: fs } = await env.DB.prepare("SELECT id FROM report_files WHERE batch_id=?1 AND review='draft'").bind(String(b.id)).all();
    await deleteReportRows(env, fs.map((f) => f.id));
    await env.DB.prepare("UPDATE report_batches SET status='expired', closed_at=?1 WHERE id=?2").bind(isoNow(), b.id).run();
  }
  for (const b of ready) {
    try {
      const contact = await env.DB.prepare("SELECT * FROM wa_contacts WHERE phone=?1").bind(b.phone).first();
      const who = await waWho(env, S, b.phone);
      if (who.role !== "centre") { await env.DB.prepare("UPDATE report_batches SET status='cancelled', closed_at=?1 WHERE id=?2").bind(isoNow(), b.id).run(); continue; }
      await new Bot(env, S, b.phone, who, contact).showBatch(b.id);
    } catch (e) { console.log("batch", b.id, String(e && e.stack || e)); }
  }
}

// Admin → WhatsApp → "Test AI check": Claude reads the newest report on the site. Nothing is saved or changed.
async function adminAiTest(env) {
  if (!aiKey(env)) return bad("Add the ANTHROPIC_API_KEY secret in Cloudflare first.");
  const f = await env.DB.prepare("SELECT f.id, f.name, b.name AS patient, b.vial_no FROM report_files f LEFT JOIN bookings b ON b.id = f.booking_id ORDER BY f.id DESC LIMIT 1").first();
  if (!f) return bad("There's no report on the site yet to test with.");
  const S = await getSettings(env), t0 = Date.now();
  try {
    const ai = await aiReadReport(env, S, f.id, f.name);
    const people = reportPeople(ai);
    return json({ ok: true, model: S.ai_model || AI_MODEL_DEFAULT, seconds: Math.round((Date.now() - t0) / 100) / 10, file: f.name, booking_name: f.patient, booking_vial: f.vial_no,
      read: { people: people.map((p) => ({ name: p.name, age: p.age_years, gender: p.gender, pages: p.pages.length })), ids: (ai.identifiers || []).slice(0, 6), status: ai.report_status,
        pending_tests: ai.pending_tests, pages: ai.pages_total, lab: ai.lab_name, collected_on: ai.collected_on, tests: (ai.tests || []).length,
        name_fit: people[0] && f.patient ? nameFit(people[0].name, f.patient) : null, vial_found: f.vial_no ? !!vialFound(f.vial_no, ai.identifiers || []) : null } });
  } catch (e) { return json({ ok: false, model: S.ai_model || AI_MODEL_DEFAULT, error: String(e && e.message || e) }); }
}

// ---- operator approval queue (Operations → Reports to approve) ----
async function adminReview(env) {
  const { results: files } = await env.DB.prepare(`SELECT f.id, f.booking_id, f.name, f.size, f.created_at, f.review, f.src, f.src_phone, f.centre_ok, f.ai_status,
      f.match_status, f.match_json, f.reviewed_at, f.review_note, f.centre_id, c.name AS centre,
      b.name AS patient, b.date, b.slot, b.status, b.vial_no, b.vial_reported, b.phone, (SELECT dob FROM users u WHERE u.id = b.patient_id) AS dob,
      (SELECT name FROM centre_numbers n WHERE n.phone = f.src_phone LIMIT 1) AS sender
    FROM report_files f LEFT JOIN bookings b ON b.id = f.booking_id LEFT JOIN centres c ON c.id = CAST(f.centre_id AS INTEGER)
    WHERE f.review IN ('pending','held') ORDER BY f.id LIMIT 200`).all();
  for (const f of files) {
    try { f.match = JSON.parse(f.match_json || "null"); } catch { f.match = null; }
    delete f.match_json;
    f.age = ageAt(f.dob, null);
    delete f.dob;
  }
  // bookings a report can be moved to
  const { results: targets } = await env.DB.prepare(`SELECT id, name, date, status, centre_id, vial_no FROM bookings WHERE status IN ('confirmed','collected','report_ready','completed')
    AND date >= ?1 ORDER BY date DESC, slot DESC LIMIT 300`).bind(addDays(istParts().date, -REPORT_LOOKBACK_DAYS)).all();
  return json({ files, targets });
}
async function adminReviewAct(env, req, rid) {
  const b = await req.json().catch(() => ({}));
  const st = STAFF.get(req) || { name: "Admin", role: "admin" };
  const f = await env.DB.prepare("SELECT * FROM report_files WHERE id=?1").bind(rid).first();
  if (!f || !["pending", "held"].includes(f.review)) return bad("This report isn't waiting for approval any more.", 409);
  const now = isoNow(), note = clean(b.note, 300);
  let m = null; try { m = JSON.parse(f.match_json || "null"); } catch {}
  const who = `${st.name}${st.role ? ` (${st.role})` : ""}`;
  if (b.action === "reassign") {
    const t = await env.DB.prepare("SELECT id, name, status FROM bookings WHERE id=?1 AND status IN ('confirmed','collected','report_ready','completed')").bind(clean(b.booking_id, 20)).first();
    if (!t) return bad("Choose the booking this report belongs to.");
    await env.DB.prepare("UPDATE report_files SET booking_id=?1, match_json=?2 WHERE id=?3").bind(t.id, JSON.stringify({ ...(m || {}), reassigned: { from: f.booking_id || null, by: st.name, at: now } }), rid).run();
    await logAct(env, t.id, st.name, st.role, `Report “${f.name}” moved to this booking for approval${f.booking_id ? ` (was ${f.booking_id})` : ""}`);
    if (f.booking_id) await logAct(env, f.booking_id, st.name, st.role, `Report “${f.name}” moved to booking ${t.id}`);
    return json({ ok: true });
  }
  if (b.action === "hold") {
    await env.DB.prepare("UPDATE report_files SET review='held', reviewed_by=?1, reviewed_at=?2, review_note=?3 WHERE id=?4").bind(who, now, note || "Waiting for the final report", rid).run();
    if (f.booking_id) await logAct(env, f.booking_id, st.name, st.role, `Interim report “${f.name}” kept back – waiting for the final report`);
    return json({ ok: true });
  }
  if (b.action === "reject") {
    if (note.length < 3) return bad("Write why it's rejected – the centre gets this message.");
    await env.DB.prepare("UPDATE report_files SET review='rejected', reviewed_by=?1, reviewed_at=?2, review_note=?3 WHERE id=?4").bind(who, now, note, rid).run();
    if (f.booking_id) await logAct(env, f.booking_id, st.name, st.role, `Report “${f.name}” rejected: ${note}`);
    let told = false;
    const S = await getSettings(env);
    if (f.src_phone && waReady(env, S) && !waDown(S)) {
      const bk = f.booking_id ? await env.DB.prepare("SELECT id, name FROM bookings WHERE id=?1").bind(f.booking_id).first() : null;
      try {
        await waText(env, S, f.src_phone, `❌ Report *${f.name}*${bk ? ` for ${shortName(bk.name)} (${bk.id})` : ""} was not accepted by our team:\n${note}\n\nPlease send the right report here (📎 → Document).`, { by: "team" });
        told = true;
      } catch (e) { console.log("reject message", String(e)); }
    }
    return json({ ok: true, told });
  }
  if (b.action !== "approve") return bad("Invalid action");
  if (!f.booking_id) return bad("Choose the patient first (Reassign).", 409);
  const bk = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(f.booking_id).first();
  if (!bk || !["collected", "report_ready", "completed"].includes(bk.status)) return bad("Confirm the vial at the lab first (Step 3), then approve the report.", 409);
  const risky = !m || m.status !== "ok" || f.centre_ok === "unknown" || (m.best && m.best !== f.booking_id);
  if (risky && note.length < 3) return bad("This report isn't a clean match – write a short reason for approving it.", 400);
  await env.DB.prepare("UPDATE report_files SET review='approved', reviewed_by=?1, reviewed_at=?2, review_note=?3 WHERE id=?4").bind(who, now, note || null, rid).run();
  if (bk.status === "collected" || bk.status === "completed")
    await env.DB.prepare("UPDATE bookings SET status='report_ready', report_at=?1, completed_at=NULL, updated_at=?1 WHERE id=?2").bind(now, bk.id).run();
  await logAct(env, bk.id, st.name, st.role, `Report “${f.name}” approved${note ? ` · ${note}` : ""}`);
  await learnHint(env, f, m, bk);
  // approved = checked → it goes to the patient now (same as pressing Send in Reports)
  const r = b.send === false ? { held: true } : await sendKind(env, req, bk.id, "report", { reportIds: [rid] });
  let text;
  if (r.manual) { const full = await bookingFull(env, bk.id); text = msgFor(env, await templates(env), full, "report", { files: full.files.filter((x) => x.id === rid) }).text; }
  return json({ ok: true, send: r, text, phone: bk.phone, booking_id: bk.id });
}
// remember where this centre's vial numbers are printed (or that they aren't)
async function learnHint(env, f, m, bk) {
  const cid = Number(f.centre_id) || 0;
  if (!cid || !m || m.status === "off" || !(bk.vial_no || bk.vial_reported)) return;
  const label = m.vial_label ? String(m.vial_label).slice(0, 60) || "ID" : "__miss__";
  await env.DB.prepare("INSERT INTO report_hints (centre_id, label, hits) VALUES (?1, ?2, 1) ON CONFLICT(centre_id, label) DO UPDATE SET hits = hits + 1").bind(cid, label).run();
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
  team_numbers: "", auto_reports: "0", wa_down_until: "", wa_down_reason: "", ai_model: "" };
const WA_SETTABLE = ["wa_mode", "wa_phone_id", "wa_waba_id", "wa_version", "team_numbers", "auto_reports", "ai_model"];

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
    return { ...t, base_name: t.wa_name, wa_name: o.cur_name || t.wa_name, default_body: t.body, body: o.body || t.body, custom: !!o.body, wa_id: o.wa_id || null, wa_status: o.wa_status || null, wa_reason: o.wa_reason || null, wa_body: o.wa_body || null,
      nx_name: o.nx_name || null, nx_id: o.nx_id || null, nx_status: o.nx_status || null, nx_body: o.nx_body || null, nx_reason: o.nx_reason || null };
  });
}
async function bookingFull(env, id) {
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE id=?1").bind(id).first();
  if (!b) return null;
  const [{ results: tests }, { results: files }] = await Promise.all([
    env.DB.prepare("SELECT t.name, p.tests AS includes, p.prep FROM booking_tests t LEFT JOIN packages p ON p.id = t.package_id WHERE t.booking_id=?1 ORDER BY t.id").bind(id).all(),
    env.DB.prepare(`SELECT id, name, size, sent_at FROM report_files WHERE booking_id=?1 AND ${LIVE_REP} ORDER BY id`).bind(id).all(),
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
    const r = await env.DB.prepare("INSERT INTO wa_outbox (booking_id, kind, to_phone, to_role, status, error, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'failed', ?5, ?6, ?6)")
      .bind(b.id, kind, phone || null, m.t.to, String(error).slice(0, 500), now).run();
    await logFailed(env, r.meta.last_row_id, phone, m.text, error);
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
  // the patient's booking confirmation goes out once the collection centre has accepted the visit
  if (ev === "confirmed") {
    if (b.centre_id) await once("center"); else await deliver(env, b, "team_paid", { S, T });
  } else if (ev === "paid_online") {
    await once("confirm"); // paid online: the patient hears from us right away
    if (b.centre_id) await once("center"); else await deliver(env, b, "team_paid", { S, T });
  } else if (ev === "assigned") await once("center");
  else if (ev === "accepted") { await once("confirm"); await deliver(env, b, "collector", { S, T }); }
  else if (ev === "accepted_hand") await once("confirm");
  else if (ev === "declined") await team(`${extra.centre || "The centre"} can't do this collection – please choose another centre`);
  else if (ev === "collected") await once("collected");
  else if (ev === "review") await team(`${extra.n > 1 ? extra.n + " reports" : "A report"} from ${extra.centre || "the centre"} ${extra.n > 1 ? "are" : "is"} waiting for your approval – Operations → Reports to approve`);
  else if (ev === "vial_reported") await team(`The centre sent vial no. ${b.vial_reported} – check it and confirm the vial at the lab on the dashboard`);
  else if (ev === "report") {
    if (S.auto_reports === "1") await deliver(env, b, "report", { S, T });
    else await team("Report uploaded – check it and send it to the patient");
  } else if (ev === "moved") { // new date/time set by our team: patient told, centre gets the job again to accept the new time
    await deliver(env, b, "moved", { S, T });
    if (b.centre_id) await deliver(env, b, "center", { S, T });
  } else if (ev === "resched_req") await team(`Reschedule request: ${b.resched_req || "the patient wants another time"} – please handle it on the dashboard`); else if (ev === "payment") await team("Payment screenshot received on WhatsApp – please verify");
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
  centre: { c_new: "New jobs to accept", c_today: "Today's visits", c_vial: "Sample collected", c_upload: "Upload reports", c_jobs: "All open jobs", c_edit: "Fix a mistake" },
  team: { o_assign: "Choose centres", o_today: "Today's summary", o_failed: "Messages to send by hand" },
};
const MENU_DEFAULTS = [
  ["patient", "my_bookings", "My bookings", "Date, time and tests"], ["patient", "status", "Track my test", "Where your sample and report are"],
  ["patient", "prep", "How to prepare", "Fasting and other instructions"], ["patient", "resched", "Change date / time", "Pick a new slot"],
  ["patient", "pay", "Pay for my test", "UPI details and payment screenshot"], ["patient", "report", "Get my report", "Sent here after a date-of-birth check"],
  ["patient", "book", "Book a new test", "Open our booking page"], ["patient", "talk", "Talk to our team", "We'll call you back"],
  ["centre", "c_new", "New jobs to accept", "Accept or decline new visits"], ["centre", "c_today", "Today's visits", "Patients to visit today"],
  ["centre", "c_vial", "Sample collected", "Vial no. – one or many patients"], ["centre", "c_upload", "Upload reports", "Send report PDFs – one or many"],
  ["centre", "c_jobs", "All open jobs", "Everything not finished yet"], ["centre", "c_edit", "Fix a mistake", "Change a vial no., collector or report"],
  ["team", "o_assign", "Choose centres", "Paid bookings without a centre"], ["team", "o_today", "Today's summary", "Visits, samples and reports"],
  ["team", "o_failed", "Messages to send by hand", "Messages the API couldn't send"],
];
const MENU_ADDED_V2 = ["c_edit"]; // menu options added after the first version: given once to existing menus
async function seedWa(env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM menu_items").first();
  if (n && n.n) {
    if (await env.DB.prepare("SELECT 1 FROM settings WHERE k='menu_v2'").first()) return;
    for (const [role, action, title, description] of MENU_DEFAULTS.filter((x) => MENU_ADDED_V2.includes(x[1]))) {
      if (await env.DB.prepare("SELECT 1 FROM menu_items WHERE role=?1 AND action=?2").bind(role, action).first()) continue;
      const mx = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM menu_items WHERE role=?1").bind(role).first();
      await env.DB.prepare("INSERT INTO menu_items (role, action, title, description, sort, active) VALUES (?1, ?2, ?3, ?4, ?5, 1)").bind(role, action, title, description, (mx ? mx.m : 0) + 1).run();
    }
    await setSettings(env, { menu_v2: "1" });
    return;
  }
  await env.DB.batch(MENU_DEFAULTS.map(([role, action, title, description], i) =>
    env.DB.prepare("INSERT INTO menu_items (role, action, title, description, sort, active) VALUES (?1, ?2, ?3, ?4, ?5, 1)").bind(role, action, title, description, i)));
}

// ---- webhook ----
async function waWebhookVerify(env, url) {
  if (url.searchParams.get("hub.mode") === "subscribe" && env.WA_VERIFY_TOKEN && safeEqual(url.searchParams.get("hub.verify_token") || "", env.WA_VERIFY_TOKEN))
    return new Response(url.searchParams.get("hub.challenge") || "", { status: 200, headers: { "content-type": "text/plain" } });
  return new Response("Forbidden", { status: 403 });
}
// the last call from Meta (shown by Admin → WhatsApp → Diagnose), so a webhook that never arrives or is refused can be spotted
async function hookSeen(env, result, raw) {
  let what = "";
  try { const b = JSON.parse(raw); const c = (((b.entry || [])[0] || {}).changes || [])[0] || {}; what = `${c.field || ""}${c.value && c.value.messages ? " · message" : c.value && c.value.statuses ? " · status" : ""}`; } catch {}
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('wa_hook_last', ?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify({ at: isoNow(), result, what })).run().catch(() => {});
}
async function waWebhook(env, req) {
  if (!env.WA_APP_SECRET) return new Response("WhatsApp is not set up", { status: 503 });
  const raw = await req.text();
  const sig = String(req.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WA_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  if (!sig || !safeEqual(sig, want)) { await hookSeen(env, sig ? "refused – signature doesn't match WA_APP_SECRET" : "refused – no signature", raw); return new Response("Bad signature", { status: 401 }); }
  await hookSeen(env, "ok", raw);
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
      // a new version of a text: approved → it takes over; otherwise just note its status
      const nx = await env.DB.prepare("SELECT key FROM msg_templates WHERE nx_id=?1").bind(String(v.message_template_id)).first().catch(() => null);
      if (nx) {
        if (String(v.event).toUpperCase() === "APPROVED") await promoteTemplate(env, nx.key);
        else await env.DB.prepare("UPDATE msg_templates SET nx_status=?1, nx_reason=?2 WHERE key=?3").bind(String(v.event).toUpperCase(), reason, nx.key).run().catch(() => {});
      }
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

// "2", "1,3", "1 3", "1-3", "ALL" → [1, 3] (1-based); null if it isn't a list of numbers; { err } if a number is out of range
function parsePicks(text, n) {
  const t = String(text || "").trim();
  if (/^all$/i.test(t)) return Array.from({ length: n }, (_, i) => i + 1);
  const parts = t.split(/\s*(?:,|;|&|\band\b|\s)\s*/i).map((x) => x.replace(/\.$/, "")).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const part of parts) {
    const m = /^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    let x = +m[1], y = m[2] ? +m[2] : x;
    if (x > y) [x, y] = [y, x];
    for (let i = x; i <= y; i++) out.push(i);
  }
  if (out.some((x) => x < 1 || x > n)) return { err: true };
  return [...new Set(out)];
}

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
    if (text.startsWith("f:")) return role === "centre" ? this.flowTap(st, text) : this.menu(false);
    if (role === "centre") {
      // a swipe-reply to one of our job messages tells us which patient the centre means
      if (msg.context && msg.context.id) {
        const o = await this.db.prepare("SELECT booking_id FROM wa_outbox WHERE wa_id=?1 AND booking_id IS NOT NULL AND booking_id != '' LIMIT 1").bind(msg.context.id).first();
        if (o && (await this.job(o.booking_id))) this.ctxBooking = o.booking_id;
      }
      if (/^undo$/i.test(text)) return this.undo();
      if (st && /^(f_|r_)/.test(st) && /^(0|cancel)$/i.test(text)) {
        let d = null; try { d = JSON.parse(this.c.state_data || "null"); } catch {}
        return this.flowCancel(st, d);
      }
      if (this.ctxBooking && text && !text.startsWith("a:") && !(st && /^(f_|r_)/.test(st)) && msg.type !== "document" && !/^(menu|hi|hello|hey|0)$/i.test(text)) {
        await this.state(null);
        const [b] = await this.withDob([this.ctxBooking]);
        await this.say(`About *${this.label(b)}* 👇`);
        return this.centreAction("c_job", this.ctxBooking);
      }
    }
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
    if (a === "book") return this.say(`Book a home blood test here: ${SITE}/#book\nOur phlebotomist comes to your home between 7 AM and 6 PM.`);
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
      if (["payment_submitted", "confirmed"].includes(b.status)) {
        // paid visits are moved by our team (the collection centre has to agree to the new time)
        await env.DB.prepare("UPDATE bookings SET resched_req=?1, resched_at=?2, resched_date=?3, resched_slot=?4, updated_at=?2 WHERE id=?5")
          .bind(`Asked for ${M.fmtDate(d)}, ${M.slotLabel(slot)}`, isoNow(), d, slot, b.id).run();
        await logAct(env, b.id, `Patient (WhatsApp +91 ${this.phone})`, "patient", `Reschedule request: ${M.fmtDate(d)}, ${M.slotLabel(slot)}`);
        await this.say(`Thank you 🙏 We've asked for *${M.fmtDate(d)}, ${M.slotLabel(slot)}*.\n\nOur team will confirm the new time with the collector and message you here shortly. Until then your visit stays on *${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}*.`);
        await waEvent(env, "resched_req", b.id);
        return;
      }
      try {
        await env.DB.batch([
          env.DB.prepare("UPDATE bookings SET date=?1, slot=?2, status=CASE WHEN status='expired' THEN 'pending' ELSE status END, updated_at=?3 WHERE id=?4").bind(d, slot, isoNow(), b.id),
          env.DB.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('reminder','done:reminder')").bind(b.id),
        ]);
      } catch (e) { if (/UNIQUE/i.test(String(e))) return this.say("Someone just took that time. Please pick another."); throw e; }
      await this.say(`Done ✅ Your visit is now on *${M.fmtDate(d)}, ${M.slotLabel(slot)}*.\n\nYour slot is reserved once the payment is received.`);
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
    await logAct(env, b.id, `Patient (WhatsApp +91 ${this.phone})`, "patient", "Payment screenshot sent on WhatsApp");
    await this.say(`Thanks! We've received your payment screenshot for ${b.id} ✅ We'll confirm your booking as soon as we've checked it.`);
    return waEvent(env, "payment", b.id);
  }

  // ---------- collection centres ----------
  // Every centre action works the same way: pick the patient(s) from a numbered list of the ones WAITING for that step
  // (tap one, or type 1,3 / ALL) → give the value(s) → a confirm screen that repeats name, age and booking ID →
  // Confirm / change a value / change a patient / remove a row / cancel → saved, with UNDO for 10 minutes.
  // Numbers only mean something for the list they came with; lists expire after 15 minutes.
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
  // "Priya S · 32y · DSL-7K3Q9P" – enough to tell two Priyas apart without sending the full name around
  label(b) { const a = ageAt(b.dob, null); return `${shortName(b.name)}${a != null ? ` · ${a}y` : ""} · ${b.id}`; }
  async withDob(ids) {
    if (!ids.length) return [];
    const { results } = await this.db.prepare(`SELECT b.*, (SELECT dob FROM users u WHERE u.id = b.patient_id) AS dob FROM bookings b WHERE b.centre_id=?1 AND b.id IN (${ids.map((_, i) => "?" + (i + 2)).join(",")})`)
      .bind(this.who.centre_id, ...ids).all();
    return ids.map((id) => results.find((r) => r.id === id)).filter(Boolean);
  }
  // the bookings waiting for one step at this centre
  async pending(a) {
    const today = istParts().date;
    const W = {
      visit: ["b.status='confirmed' AND b.centre_status IS NULL", []],
      vial: ["b.status='confirmed' AND b.vial_reported IS NULL AND b.date <= ?2", [addDays(today, 1)]],
      rep: ["b.status IN ('confirmed','collected','report_ready','completed') AND b.date >= ?2", [addDays(today, -REPORT_LOOKBACK_DAYS)]],
      edit: ["b.status IN ('confirmed','collected','report_ready') AND b.updated_at >= ?2", [new Date(Date.now() - 3 * 86400000).toISOString()]],
    }[a];
    const order = a === "rep" ? `(SELECT COUNT(*) FROM report_files f WHERE f.booking_id = b.id AND ${LIVE_REP.replace(/review/g, "f.review")}) ASC, b.date DESC, b.slot`
      : a === "edit" ? "b.updated_at DESC" : "b.date, b.slot";
    const { results } = await this.db.prepare(`SELECT b.*, (SELECT dob FROM users u WHERE u.id = b.patient_id) AS dob FROM bookings b
      WHERE b.centre_id=?1 AND ${W[0]} ORDER BY ${order} LIMIT 40`).bind(this.who.centre_id, ...W[1]).all();
    return results;
  }
  // flow state lives in wa_contacts.state / state_data (JSON); k = a token for the screen, so buttons from an older message are refused
  async save(st, d) { d.k = randId(4); this.d = d; await this.state(st, JSON.stringify(d)); return d; }
  async options(body, opts) { // a tap list + the same options by number
    await this.list(`${body}\n\nTap below or reply with the number${opts.some((o) => o.c === "x") ? " (0 = cancel)" : ""}.`, "Choose",
      opts.map((o, i) => ({ id: `f:opt:${o.c}:${this.d.k}`, title: `${i + 1}. ${o.t}`, description: o.d || "" })));
  }
  async whoDid(id) {
    const a = await this.db.prepare("SELECT who, at FROM activity WHERE booking_id=?1 ORDER BY id DESC LIMIT 1").bind(id).first();
    if (!a) return "";
    const t = new Date(a.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
    return ` by ${String(a.who || "someone").split(" (")[0]} at ${t}`;
  }
  get actor() { return `${this.who.name || this.who.centre || "Centre"} (WhatsApp +91 ${this.phone})`; }

  async startPick(a, ret = {}) {
    let rows = await this.pending(a);
    if (ret.exclude) rows = rows.filter((b) => !ret.exclude.includes(b.id));
    const none = { visit: "No new jobs to accept right now ✅", vial: "No samples are waiting for a vial no. ✅", rep: "No patients at your centre can take a report right now.",
      edit: "Nothing from the last 3 days to fix." }[a];
    if (!rows.length) {
      await this.say(none);
      if (ret.b) return this.showBatch(ret.b);
      if (ret.rows) return this.showConf({ a, rows: ret.rows, edit: ret.edit });
      await this.state(null);
      return this.menu(false);
    }
    const swap = ret.r != null || ret.f != null;
    if (rows.length === 1 && !swap && (a === "visit" || a === "vial")) {
      await this.say(`Only one patient is waiting: *${this.label(rows[0])}*`);
      return this.startValues(a, [rows[0].id]);
    }
    const multi = !swap && (a === "visit" || a === "vial");
    const ask = { visit: "Which visit do you want to accept?", vial: "Whose sample did you collect?", rep: `Which patient is *${ret.fname || "this report"}* for?`, edit: "Which patient do you want to fix?" }[a];
    const how = multi ? "Tap one, or type the numbers for several – like *1,3* or *ALL*." : "Tap one, or reply with its number.";
    const d = await this.save("f_pick", { a, ids: rows.map((b) => b.id), at: isoNow(), multi, ...ret });
    const line = (b, i) => `${i + 1}. ${this.label(b)}\n    ${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}`;
    if (rows.length <= 10 && !multi) {
      return this.list(`${ask}\n${how}`, "Choose patient", rows.map((b, i) => ({ id: `f:sel:${b.id}:${d.k}`, title: `${i + 1}. ${shortName(b.name)}`.slice(0, 24),
        description: `${ageAt(b.dob, null) != null ? ageAt(b.dob, null) + "y · " : ""}${M.fmtDate(b.date)} ${b.slot} · ${b.id}` })));
    }
    if (rows.length <= 10) { // several can be picked: show the numbered list as text too, so "1,3" is easy to type
      await this.say(`${ask}\n\n${rows.map(line).join("\n")}`);
      return this.list(how, "Choose patient", rows.map((b, i) => ({ id: `f:sel:${b.id}:${d.k}`, title: `${i + 1}. ${shortName(b.name)}`.slice(0, 24),
        description: `${ageAt(b.dob, null) != null ? ageAt(b.dob, null) + "y · " : ""}${M.fmtDate(b.date)} ${b.slot} · ${b.id}` })));
    }
    return this.say(`${ask}\n\n${rows.map(line).join("\n")}\n\n${how.replace("Tap one, or type", "Type")}\n(0 = cancel)`);
  }
  async picked(d, ids) {
    const now = new Set((await this.pending(d.a)).map((b) => b.id));
    const gone = ids.filter((id) => !now.has(id)), keep = ids.filter((id) => now.has(id));
    if (gone.length && d.a !== "rep") {
      const names = await this.withDob(gone), lines = [];
      for (const b of names) lines.push(`• ${this.label(b)} – already done${await this.whoDid(b.id)}`);
      if (lines.length) await this.say(`Already done, so left out:\n${lines.join("\n")}`);
    }
    if (!keep.length) return this.startPick(d.a, d.b ? { b: d.b, f: d.f } : d.rows ? { r: d.r, rows: d.rows, edit: d.edit } : {});
    if (d.a === "edit") { await this.state(null); return this.centreAction("c_job", keep[0]); }
    if (d.a === "rep") return this.assignFile(d.b, d.f, keep[0]);
    if (d.r != null) { const rows = d.rows.map((r) => ({ ...r })); rows[d.r].id = keep[0]; return this.showConf({ a: d.a, rows, edit: d.edit }); }
    return this.startValues(d.a, keep);
  }
  async startValues(a, ids, edit = false) {
    const bs = await this.withDob(ids);
    if (!bs.length) return this.startPick(a);
    const L = bs.map((b) => this.label(b));
    const nums = L.map((l, i) => `${i + 1} = ${l}`).join("\n");
    let t;
    if (a === "vial") t = bs.length === 1 ? `Reply with the *vial no.* written on the sample of *${L[0]}*.`
      : `Send the *vial numbers*, one line per patient:\n${nums}\n\nLike this:\n1 V58812\n2 V58830`;
    else t = bs.length === 1 ? `Reply with the *collector's name, mobile and arrival time* for *${L[0]}* – e.g.\nRamesh, 98765 43210, 8:30 AM`
      : `Send the *collector's name, mobile and time*:\n• Same collector for all – one line, e.g.\nRamesh, 98765 43210\n• Different collectors – one line per patient:\n1 Ramesh, 98765 43210, 8:30 AM\n2 Suresh, 98111 22233, 9 AM\n\n${nums}`;
    await this.save("f_vals", { a, rows: bs.map((b) => ({ id: b.id })), edit });
    return this.say(`${t}\n\n(0 = cancel · 9 = back)`);
  }
  // the vial no. as we store it, and whether another open booking already has it
  async vialProblem(v, id) {
    if (!v) return "empty";
    const dup = await this.db.prepare("SELECT id, name FROM bookings WHERE (vial_no=?1 OR vial_reported=?1) AND id != ?2 AND status NOT IN ('cancelled','expired','blocked') LIMIT 1").bind(v, id).first();
    return dup ? `vial ${v} is already used for another patient (${shortName(dup.name)})` : null;
  }
  normVal(a, v) { return a === "vial" ? clean(v, 40).toUpperCase().replace(/\s+/g, "") : clean(v, 200); }
  async valuesAnswer(d, text) {
    const n = d.rows.length, errs = [];
    const rows = d.rows.map((r) => ({ ...r }));
    const got = {};
    if (n === 1) got[0] = text.replace(/^1\s*[.):=\-–]\s*/, "").trim();
    else {
      const lines = text.split(d.a === "vial" ? /[\n;,]+/ : /\n|;/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        const m = /^(\d{1,2})\s*[.):=\-–]?\s+(.+)$/.exec(line) || /^(\d{1,2})\s*[.):=\-–]\s*(.+)$/.exec(line);
        if (m && +m[1] >= 1 && +m[1] <= n) got[+m[1] - 1] = m[2].trim();
        else if (d.a === "visit" && lines.length === 1) for (let i = 0; i < n; i++) got[i] = line; // same collector for everyone
        else errs.push(`“${line.slice(0, 40)}” – start the line with the patient's number, e.g. ${d.a === "vial" ? "1 V58812" : "1 Ramesh, 98765 43210"}`);
      }
    }
    for (const [i, raw] of Object.entries(got)) {
      const v = this.normVal(d.a, raw);
      if (d.a === "visit" && v.length < 5) { errs.push(`Row ${+i + 1}: please give the collector's name and mobile.`); continue; }
      if (d.a === "vial") {
        const p = await this.vialProblem(v, rows[i].id);
        if (p && p !== "empty") { errs.push(`Row ${+i + 1}: ${p}. Check the number.`); continue; }
        if (p === "empty") continue;
        const twin = rows.findIndex((r, j) => j !== +i && r.v === v);
        if (twin >= 0) { errs.push(`Row ${+i + 1}: vial ${v} is also given for row ${twin + 1}.`); continue; }
      }
      rows[i].v = v;
    }
    const miss = rows.map((r, i) => (r.v ? null : i)).filter((i) => i != null);
    if (!miss.length) return this.showConf({ a: d.a, rows, edit: d.edit });
    await this.save("f_vals", { a: d.a, rows, edit: d.edit });
    const bs = await this.withDob(miss.map((i) => rows[i].id));
    const what = d.a === "vial" ? "vial no." : "collector details";
    return this.say(`${errs.length ? errs.join("\n") + "\n\n" : ""}Still need the ${what} for:\n${miss.map((i, j) => `${i + 1} = ${bs[j] ? this.label(bs[j]) : rows[i].id}`).join("\n")}${n > 1 ? `\n\nOne line each, like: ${miss[0] + 1} ${d.a === "vial" ? "V58812" : "Ramesh, 98765 43210"}` : ""}`);
  }
  async showConf(d) {
    const bs = await this.withDob(d.rows.map((r) => r.id));
    const rows = d.rows.filter((r) => bs.some((b) => b.id === r.id));
    if (!rows.length) { await this.state(null); await this.say("Those patients aren't with your centre any more – nothing was saved."); return this.menu(false); }
    const lines = rows.map((r, i) => `${i + 1}. ${this.label(bs.find((b) => b.id === r.id))}\n    → ${d.a === "vial" ? "Vial " : "Collector: "}${r.v}`);
    await this.say(`*Please check${rows.length > 1 ? ` (${rows.length} patients)` : ""}:*\n\n${lines.join("\n")}`);
    const opts = [
      { c: "ok", t: rows.length > 1 ? "✅ Confirm all" : "✅ Confirm", d: d.a === "vial" ? "Send the vial no. to our team" : "Accept – the patient gets the details" },
      { c: "val", t: d.a === "vial" ? "✏️ Change vial no." : "✏️ Change collector" },
      { c: "pat", t: "🔁 Change patient" },
      ...(rows.length > 1 ? [{ c: "del", t: "🗑️ Remove a row" }] : []),
      { c: "x", t: "❌ Cancel" },
    ];
    await this.save("f_conf", { a: d.a, rows, edit: d.edit, o: opts.map((o) => o.c) });
    return this.options("Is this right?", opts);
  }
  async confOpt(d, c) {
    const n = d.rows.length;
    if (c === "ok") return this.applyRows(d);
    if (c === "x") return this.flowCancel("f_conf", d);
    if (c === "val" || c === "pat" || c === "del") {
      if (n === 1 && c !== "del") return this.whichRow({ ...d, m: c }, 0);
      await this.save("f_which", { a: d.a, rows: d.rows, edit: d.edit, m: c });
      return this.say(`Which row? Reply 1–${n}.\n(9 = back)`);
    }
    return this.showConf(d);
  }
  async whichRow(d, r) {
    if (d.m === "del") {
      const rows = d.rows.filter((_, i) => i !== r);
      if (!rows.length) return this.flowCancel("f_conf", d);
      return this.showConf({ a: d.a, rows, edit: d.edit });
    }
    if (d.m === "pat") return this.startPick(d.a, { r, rows: d.rows, edit: d.edit, exclude: d.rows.map((x) => x.id) });
    const [b] = await this.withDob([d.rows[r].id]);
    await this.save("f_rowval", { a: d.a, rows: d.rows, edit: d.edit, r });
    return this.say(`New ${d.a === "vial" ? "vial no." : "collector name, mobile and time"} for *${b ? this.label(b) : d.rows[r].id}*?\n(9 = back)`);
  }
  async rowVal(d, text) {
    const v = this.normVal(d.a, text), rows = d.rows.map((x) => ({ ...x }));
    let p = d.a === "visit" ? (v.length < 5 ? "Please give the collector's name and mobile." : null) : await this.vialProblem(v, rows[d.r].id);
    if (!p && d.a === "vial" && rows.some((x, j) => j !== d.r && x.v === v)) p = `vial ${v} is already given for another row`;
    if (p) return this.say(`${p === "empty" ? "Please send the vial no." : p[0].toUpperCase() + p.slice(1) + "."} Try again (9 = back).`);
    rows[d.r].v = v;
    return this.showConf({ a: d.a, rows, edit: d.edit });
  }
  // Confirm: save each row (skipping ones someone else finished meanwhile) and keep what's needed for UNDO
  async applyRows(d) {
    const env = this.env, done = [], skipped = [], undo = [];
    for (const r of d.rows) {
      const b = await this.job(r.id);
      const [bd] = b ? await this.withDob([b.id]) : [];
      const L = bd ? this.label(bd) : r.id;
      if (!b) { skipped.push(`${L} – not with your centre any more`); continue; }
      if (d.a === "vial") {
        if (!d.edit && b.status === "confirmed" && b.vial_reported && b.vial_reported !== r.v) { skipped.push(`${L} – vial ${b.vial_reported} was already sent${await this.whoDid(b.id)}`); continue; }
        const prev = { vial_reported: b.vial_reported, vial_reported_at: b.vial_reported_at };
        const res = await reportVial(env, b, r.v);
        if (res.err) { skipped.push(`${L} – ${res.err}`); continue; }
        if (res.reported) {
          await logAct(env, b.id, this.actor, "centre", `Vial no. sent by the centre: ${res.vial}`);
          await waEvent(env, "vial_reported", b.id);
          undo.push({ id: b.id, prev, v: res.vial });
        }
        done.push(`${L} → vial ${res.vial}`);
      } else {
        if (b.status !== "confirmed") { skipped.push(`${L} – this visit can't be changed any more`); continue; }
        if (!d.edit && b.centre_status === "accepted" && b.collector_info) { skipped.push(`${L} – already accepted${await this.whoDid(b.id)}`); continue; }
        const prev = { centre_status: b.centre_status, centre_status_at: b.centre_status_at, collector_info: b.collector_info };
        const now = isoNow();
        await this.db.prepare("UPDATE bookings SET centre_status='accepted', centre_status_at=COALESCE(centre_status_at, ?1), collector_info=?2, updated_at=?1 WHERE id=?3").bind(now, r.v, b.id).run();
        await logAct(env, b.id, this.actor, "centre", `${prev.centre_status === "accepted" ? "Collector details changed" : "Centre accepted the job on WhatsApp"} · collector: ${r.v}`);
        if (waAuto(env, this.S)) await waEvent(env, "accepted", b.id);
        undo.push({ id: b.id, prev, v: r.v });
        done.push(`${L} → ${r.v}`);
      }
    }
    await this.state(null);
    if (undo.length) await this.setLastAct({ at: isoNow(), a: d.a, items: undo });
    const tail = d.a === "vial" ? "Our team will check the vial no. and confirm it at the lab." : waAuto(env, this.S) ? "We've sent the collector details to the patient." : "Our team will share the details with the patient.";
    const parts = [];
    if (done.length) parts.push(`Saved ✅ ${done.length > 1 ? done.length + " patients" : ""}\n${done.map((x) => "• " + x).join("\n")}\n\n${tail}`);
    if (skipped.length) parts.push(`Not saved:\n${skipped.map((x) => "• " + x).join("\n")}`);
    if (undo.length) parts.push("Reply *UNDO* within 10 minutes to reverse this. Type *menu* for more.");
    return this.say(parts.join("\n\n") || "Nothing was saved.");
  }
  async setLastAct(o) { await this.db.prepare("UPDATE wa_contacts SET last_act=?1 WHERE phone=?2").bind(o ? JSON.stringify(o) : null, this.phone).run(); this.c.last_act = o ? JSON.stringify(o) : null; }
  async undo() {
    const env = this.env;
    let la = null; try { la = JSON.parse(this.c.last_act || "null"); } catch {}
    if (!la || Date.now() - Date.parse(la.at) > 10 * 60000)
      return this.say("There's nothing to undo – UNDO works for 10 minutes after you save.\nTo fix something older, choose *Fix a mistake* in the menu.");
    await this.state(null);
    const out = [];
    for (const it of la.items) {
      if (la.a === "reports") {
        const f = await this.db.prepare("SELECT f.*, b.name AS patient FROM report_files f LEFT JOIN bookings b ON b.id = f.booking_id WHERE f.id=?1 AND f.src_phone=?2").bind(it, this.phone).first();
        if (!f) continue;
        if (["pending", "held"].includes(f.review)) {
          await this.db.prepare("UPDATE report_files SET review='withdrawn', reviewed_at=?1, review_note='Taken back by the centre (UNDO)' WHERE id=?2").bind(isoNow(), f.id).run();
          if (f.booking_id) await logAct(env, f.booking_id, this.actor, "centre", `Report “${f.name}” taken back by the centre (UNDO)`);
          out.push(`↩️ ${f.name} – taken back`);
        } else if (f.review === "approved") {
          if (f.booking_id) await this.team(f.booking_id, `${this.who.centre} wants to take back report “${f.name}” for ${f.patient || "a patient"}, but it was already approved${f.sent_at ? " and sent" : ""}. Please check.`).catch(() => {});
          out.push(`⚠️ ${f.name} – our team already approved it; we've told them`);
        }
        continue;
      }
      const b = await this.job(it.id);
      if (!b) continue;
      const [bd] = await this.withDob([b.id]);
      if (la.a === "vial") {
        if (b.status === "confirmed" && b.vial_reported === it.v) {
          await this.db.prepare("UPDATE bookings SET vial_reported=?1, vial_reported_at=?2, updated_at=?3 WHERE id=?4").bind(it.prev.vial_reported, it.prev.vial_reported_at, isoNow(), b.id).run();
          await logAct(env, b.id, this.actor, "centre", `Centre took back vial no. ${it.v} (UNDO)`);
          out.push(`↩️ ${this.label(bd)} – vial ${it.v} removed`);
        } else {
          await this.team(b.id, `${this.who.centre} wants to undo vial no. ${it.v} for ${b.name}, but our team already confirmed it at the lab. Please check.`).catch(() => {});
          out.push(`⚠️ ${this.label(bd)} – our team already confirmed this vial; we've told them`);
        }
      } else if (la.a === "visit") {
        if (b.status !== "confirmed") continue;
        await this.db.prepare("UPDATE bookings SET centre_status=?1, centre_status_at=?2, collector_info=?3, updated_at=?4 WHERE id=?5")
          .bind(it.prev.centre_status, it.prev.centre_status_at, it.prev.collector_info, isoNow(), b.id).run();
        await logAct(env, b.id, this.actor, "centre", "Centre took back the acceptance / collector details (UNDO)");
        const told = await this.db.prepare("SELECT 1 FROM msg_log WHERE booking_id=?1 AND kind IN ('collector','confirm') AND at >= ?2 LIMIT 1").bind(b.id, la.at).first();
        if (told) await this.team(b.id, `${this.who.centre} undid ${it.prev.centre_status === "accepted" ? "the new collector details" : "accepting the visit"} for ${b.name}, but the patient was already sent the collector details. Please call the patient.`).catch(() => {});
        out.push(`↩️ ${this.label(bd)}${told ? " – the patient was already told; our team will call them" : ""}`);
      }
    }
    await this.setLastAct(null);
    return this.say(out.length ? `Undone ✅\n${out.join("\n")}` : "Nothing could be undone.");
  }
  async flowCancel(st, d) {
    await this.state(null);
    if (/^r_/.test(st) && d && d.b) {
      await this.cancelBatch(d.b);
      await this.say("Cancelled – none of these reports were sent.");
    } else await this.say("Cancelled – nothing was saved.");
    return this.menu(false);
  }

  // taps on our flow buttons: f:sel:<booking>:<k> (a patient) or f:opt:<code>:<k> (an option)
  async flowTap(st, text) {
    const [, kind, val, k] = text.split(":");
    let d = null; try { d = JSON.parse(this.c.state_data || "null"); } catch {}
    if (!st || !d || !/^(f_|r_)/.test(st)) return this.say("That list isn't active any more.").then(() => this.menu(false));
    if (k && d.k && k !== d.k) return this.say("That button is from an older message – please use the latest one 👇").then(() => this.reshow(st, d));
    this.d = d;
    if (kind === "sel") {
      if (st !== "f_pick" || !d.ids.includes(val)) return this.reshow(st, d);
      return this.picked(d, [val]);
    }
    return this.flowOpt(st, d, val);
  }
  async reshow(st, d) {
    if (st === "f_pick") return this.startPick(d.a, d.b ? { b: d.b, f: d.f, fname: d.fname } : d.rows ? { r: d.r, rows: d.rows, edit: d.edit, exclude: d.exclude } : {});
    if (st === "f_conf" || st === "f_which" || st === "f_rowval") return this.showConf(d);
    if (st === "f_vals") return this.startValues(d.a, d.rows.map((r) => r.id), d.edit);
    if (/^r_/.test(st) && d.b) return this.showBatch(d.b);
    await this.state(null);
    return this.menu(false);
  }
  async flowOpt(st, d, c) {
    if (st === "f_conf") return this.confOpt(d, c);
    if (st === "r_conf") return this.batchOpt(d, c);
    if (st === "r_row") return this.rowOpt(d, c);
    return this.reshow(st, d);
  }
  // typed answers while in a flow
  async flowAnswer(st, d, text) {
    this.d = d;
    const t = text.trim(), num = /^\d{1,2}$/.test(t) ? Number(t) : null;
    if (t === "9" && st !== "f_pick") { // back one step
      if (st === "f_vals") return this.startPick(d.a);
      if (/^f_/.test(st)) return this.showConf(d);
      if (/^r_/.test(st)) return this.showBatch(d.b);
    }
    if (st === "f_pick") {
      if (Date.now() - Date.parse(d.at) > 15 * 60000) { await this.say("That list has expired – here's the updated one 👇"); return this.reshow(st, d); }
      const p = parsePicks(t, d.ids.length);
      if (!p) return this.say(`Please reply with the number${d.multi ? "s" : ""} from the list${d.multi ? " – like 2, or 1,3, or ALL" : ""}. (0 = cancel)`);
      if (p.err) return this.say(`The list only goes from 1 to ${d.ids.length}. Try again.`);
      if (!d.multi && p.length > 1) return this.say("Please choose just one number here.");
      return this.picked(d, p.map((i) => d.ids[i - 1]));
    }
    if (st === "f_vals") return this.valuesAnswer(d, text);
    if (st === "f_rowval") return this.rowVal(d, text);
    if (st === "f_conf" || st === "r_conf" || st === "r_row") {
      if (num != null && num >= 1 && num <= d.o.length) return this.flowOpt(st, d, d.o[num - 1]);
      return this.say(`Please reply with a number from 1 to ${d.o.length}${st === "r_row" ? "" : " (0 = cancel)"}.`);
    }
    if (st === "f_which" || st === "r_which") {
      const n = st === "f_which" ? d.rows.length : (await this.batchFiles(d.b)).length;
      if (num == null || num < 1 || num > n) return this.say(`Please reply with a row number from 1 to ${n} (9 = back).`);
      if (st === "f_which") return this.whichRow(d, num - 1);
      const f = (await this.batchFiles(d.b))[num - 1];
      if (d.m === "del") { await deleteReportRows(this.env, [f.id]); return this.showBatch(d.b); }
      return this.rowMenu(d.b, f.id);
    }
    if (st === "r_batch") {
      if (/^done$/i.test(t)) {
        const n = (await this.batchFiles(d.b)).length;
        await this.db.prepare("UPDATE report_batches SET status='closing' WHERE id=?1 AND status='open'").bind(d.b).run();
        return this.say(`Checking ${n} report${n === 1 ? "" : "s"}… ⏳ I'll reply here in a minute or two.`);
      }
      return this.say("Send the next report PDF (📎 → Document), or type *DONE* when you've sent them all. (0 = cancel)");
    }
    return this.reshow(st, d);
  }

  async centreAction(a, id) {
    const env = this.env, today = istParts().date;
    const listOr = async (rows, action, title, none) => (rows.length ? this.list(title, "Choose", this.jobRows(rows, action)) : this.say(none).then(() => this.menu(false)));
    if (a === "c_new") return this.startPick("visit");
    if (a === "c_vial") return this.startPick("vial");
    if (a === "c_edit") return this.startPick("edit");
    if (a === "c_today") return listOr(await this.jobs("date=?2 AND status IN ('confirmed','collected')", [today]), "c_job", "Today's visits:", "No visits today.");
    if (a === "c_jobs") return listOr(await this.jobs("status IN ('confirmed','collected','report_ready') AND date >= ?2", [addDays(today, -30)]), "c_job", "Open jobs:", "No open jobs ✅");
    if (a === "c_upload") {
      const open = await this.openBatch();
      if (open && open.status === "confirm") return this.showBatch(open.id);
      await this.state("upload", "");
      return this.say("Send the report PDFs here now – one or many (📎 → Document).\nI'll match each report to the right patient and show you the list to confirm.");
    }
    const b = await this.job(id);
    if (!b) return this.say("That booking isn't with your centre any more.").then(() => this.menu(false));
    if (a === "c_job") {
      const full = await bookingFull(env, b.id);
      const rows = [];
      if (b.status === "confirmed") {
        if (b.centre_status !== "accepted") rows.push({ id: `a:c_accept:${b.id}`, title: "Accept", description: "We'll do this visit" }, { id: `a:c_decline:${b.id}`, title: "Can't do", description: "Give it to another centre" });
        rows.push({ id: `a:c_coll:${b.id}`, title: "Collector details", description: "Name, mobile and time for the patient" }, { id: `a:c_vialq:${b.id}`, title: b.vial_reported ? "Change vial no." : "Sample collected", description: b.vial_reported || "Enter the vial no." });
      } else rows.push({ id: `a:c_up:${b.id}`, title: "Upload report", description: "Send the report PDF" }, { id: `a:c_vialq:${b.id}`, title: "Change vial no.", description: b.vial_no || b.vial_reported || "" });
      const wd = await this.db.prepare("SELECT COUNT(*) AS n FROM report_files WHERE booking_id=?1 AND review IN ('pending','held') AND src_phone IS NOT NULL").bind(b.id).first();
      if (wd && wd.n) rows.push({ id: `a:c_wd:${b.id}`, title: "Take back report", description: `${wd.n} report${wd.n === 1 ? "" : "s"} waiting for our approval` });
      rows.push({ id: "a:menu", title: "Back to menu" });
      return this.list(msgFor(env, await templates(env), full, "center").text.slice(0, 1000), "What next?", rows);
    }
    if (a === "c_accept") return this.startValues("visit", [b.id]);
    if (a === "c_coll") return this.startValues("visit", [b.id], b.centre_status === "accepted");
    if (a === "c_vialq") return this.startValues("vial", [b.id], !!(b.vial_reported || b.vial_no));
    if (a === "c_decline") {
      await logAct(env, b.id, this.actor, "centre", "Centre declined the job on WhatsApp");
      await this.db.prepare("UPDATE bookings SET centre_id=NULL, centre_status='declined', centre_status_at=?1, collector_info=NULL, updated_at=?1 WHERE id=?2").bind(isoNow(), b.id).run();
      await this.db.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('center','done:center','done:centre_ok')").bind(b.id).run();
      await this.say("Noted 👍 We'll give this visit to another centre.");
      return waEvent(env, "declined", b.id, { centre: this.who.centre });
    }
    if (a === "c_up") { await this.state("upload", b.id); return this.say(`Send the report PDF${b.name ? " of *" + shortName(b.name) + "*" : ""} here now (📎 → Document). You can send more than one.`); }
    if (a === "c_wd") {
      const { results } = await this.db.prepare("SELECT id, name FROM report_files WHERE booking_id=?1 AND review IN ('pending','held') AND src_phone IS NOT NULL").bind(b.id).all();
      for (const f of results) await this.db.prepare("UPDATE report_files SET review='withdrawn', reviewed_at=?1, review_note='Taken back by the centre' WHERE id=?2").bind(isoNow(), f.id).run();
      if (results.length) await logAct(env, b.id, this.actor, "centre", `Centre took back ${results.length} report${results.length === 1 ? "" : "s"} waiting for approval`);
      return this.say(results.length ? `Taken back ✅ ${results.map((f) => f.name).join(", ")}\nSend the right report PDF here when you have it.` : "No reports to take back.");
    }
    return this.menu(false);
  }
  async centreAnswer(st, data, text) {
    const env = this.env;
    if (/^(f_|r_)/.test(st)) {
      let d = null; try { d = JSON.parse(data || "null"); } catch {}
      if (!d) { await this.state(null); return this.menu(true); }
      return this.flowAnswer(st, d, text);
    }
    if (st === "upload") return this.say("Please send the report as a *PDF document* (📎 → Document).");
    // older single-step states (from before the confirm screens)
    const b = await this.job(data);
    if (!b) { await this.state(null); return this.menu(true); }
    if (st === "collector") return this.valuesAnswer({ a: "visit", rows: [{ id: b.id }] }, text);
    if (st === "vial") return this.valuesAnswer({ a: "vial", rows: [{ id: b.id }] }, text);
    return this.menu(true);
  }

  // ---------- reports from a centre: one or many PDFs → AI check → the centre confirms → operator approves ----------
  async openBatch() {
    return await this.db.prepare("SELECT * FROM report_batches WHERE phone=?1 AND status IN ('open','closing','confirm') AND created_at > ?2 ORDER BY id DESC LIMIT 1")
      .bind(this.phone, new Date(Date.now() - 24 * 3600000).toISOString()).first();
  }
  async batchFiles(bid) {
    const { results } = await this.db.prepare("SELECT * FROM report_files WHERE batch_id=?1 AND review='draft' ORDER BY id").bind(String(bid)).all();
    return results;
  }
  async cancelBatch(bid) {
    const files = await this.batchFiles(bid);
    await deleteReportRows(this.env, files.map((f) => f.id));
    await this.db.prepare("UPDATE report_batches SET status='cancelled', closed_at=?1 WHERE id=?2").bind(isoNow(), bid).run();
  }
  async centreMedia(msg, st) {
    const env = this.env;
    if (msg.type !== "document") return this.say("Please send the report as a *PDF document* (📎 → Document), not a photo.");
    let d = null; try { d = JSON.parse(this.c.state_data || "null"); } catch {}
    // the patient the centre already named: "Upload report" for one patient, a DSL ref in the caption / file name, or a swipe-reply to the job
    let hint = st === "upload" ? this.c.state_data || null : st === "r_batch" && d ? d.h || null : null;
    const ref = /DSL-[A-Z0-9]{6}/i.exec(`${msg.document.caption || ""} ${msg.document.filename || ""}`);
    if (ref) hint = ref[0].toUpperCase();
    if (!hint && this.ctxBooking) hint = this.ctxBooking;
    if (hint && !(await this.job(hint))) hint = null;
    const f = await waMedia(env, this.S, msg.document.id);
    if (f.bytes.length > MAX_REPORT_BYTES) return this.say("That file is larger than 10 MB. Please send a smaller PDF.");
    if (String.fromCharCode(...f.bytes.subarray(0, 5)) !== "%PDF-") return this.say("That isn't a PDF. Please send the report as a PDF document.");
    const now = isoNow();
    let batch = await this.openBatch();
    const wasShown = batch && batch.status === "confirm";
    if (!batch) {
      await this.db.prepare("INSERT INTO report_batches (centre_id, phone, status, created_at, last_file_at) VALUES (?1, ?2, 'open', ?3, ?3)").bind(this.who.centre_id, this.phone, now).run();
      batch = await this.db.prepare("SELECT * FROM report_batches WHERE phone=?1 ORDER BY id DESC LIMIT 1").bind(this.phone).first();
    }
    const name = clean(msg.document.filename || `${hint || "report"}.pdf`, 120);
    await storeReport(env, hint || "", f.bytes, name, { review: "draft", batch_id: batch.id, centre_id: this.who.centre_id, src: "wa", src_phone: this.phone, hint_booking: hint });
    await this.db.prepare("UPDATE report_batches SET last_file_at=?1, status='open' WHERE id=?2").bind(now, batch.id).run();
    const n = (await this.batchFiles(batch.id)).length;
    await this.save("r_batch", { b: batch.id, h: st === "upload" ? this.c.state_data || null : d && st === "r_batch" ? d.h || null : null });
    if (wasShown) return this.say(`📄 Added *${name}* – I'll show you the updated list in a minute.`);
    if (n === 1) return this.say(`📄 Got it – *${name}*.\nSend all your reports now, one or many. I'll check the names and show you the list about a minute after the last one (or type *DONE*).`);
    return this.say(`📄 ${n} reports received.`);
  }
  // the confirm screen for a batch: one numbered row per report with ✅ ⚠️ ❌ and why
  async batchRowText(f, i) {
    let m = {}; try { m = JSON.parse(f.match_json || "{}") || {}; } catch {}
    const bid = f.centre_ok === "unknown" ? null : f.centre_ok ? f.booking_id : m.best || f.booking_id || null;
    const [b] = bid ? await this.withDob([bid]) : [];
    const icon = f.centre_ok === "unknown" ? "📤" : f.centre_ok === "yes" ? "✅" : { ok: "✅", check: "⚠️", nomatch: "❌", mixed: "❌", unreadable: "❌", off: "❔" }[m.status] || "❔";
    const head = f.centre_ok === "unknown" ? "Not in your list – our team will match it" : b ? this.label(b) : "No matching patient";
    const says = m.says ? `Report says: ${m.says.name}${m.says.age != null ? `, ${m.says.age}y` : ""}${m.says.gender && m.says.gender !== "unknown" ? `, ${m.says.gender[0].toUpperCase()}` : ""}` : "";
    let sub;
    if (f.centre_ok === "yes") sub = `You confirmed this patient${says ? " · " + says : ""}`;
    else if (f.centre_ok === "picked") sub = `You chose this patient${m.status !== "ok" ? ` · ${says || (m.reasons || [])[0] || ""}` : ""}`;
    else if (f.centre_ok === "unknown") sub = says;
    else if (m.status === "ok") sub = (m.reasons || []).filter((r) => !/^INTERIM/.test(r)).slice(0, 2).join(" · ");
    else sub = [says, ...(m.reasons || []).filter((r) => !/^(name matches|age \d|collected the same|report date fits|tests fit|same name on all)/.test(r)).slice(0, 2)].filter(Boolean).join("\n    ");
    if (m.interim && f.centre_ok !== "unknown") sub = `${sub ? sub + " · " : ""}interim report`;
    return `${i + 1}. ${icon} ${head}\n    📄 ${f.name}${sub ? `\n    ${sub}` : ""}`;
  }
  async showBatch(bid) {
    const batch = await this.db.prepare("SELECT * FROM report_batches WHERE id=?1").bind(bid).first();
    if (!batch || !["open", "closing", "confirm"].includes(batch.status)) { await this.state(null); return; }
    const files = await this.batchFiles(bid);
    if (!files.length) {
      await this.db.prepare("UPDATE report_batches SET status='cancelled', closed_at=?1 WHERE id=?2").bind(isoNow(), bid).run();
      await this.state(null);
      return this.say("No reports left in the list – nothing was sent.");
    }
    if (files.some((f) => !f.ai_status || f.ai_status === "checking")) return this.say("Still checking the reports… ⏳ I'll show you the list in a minute.");
    await this.db.prepare("UPDATE report_batches SET status='confirm' WHERE id=?1").bind(bid).run();
    const rows = [];
    for (const [i, f] of files.entries()) rows.push(await this.batchRowText(f, i));
    const flagged = files.filter((f) => { let m = {}; try { m = JSON.parse(f.match_json || "{}"); } catch {} return !f.centre_ok && m.status !== "ok"; }).length;
    await this.say(`*Please check before sending${files.length > 1 ? ` (${files.length} reports)` : ""}:*\n\n${rows.join("\n\n")}${flagged ? `\n\n⚠️/❌/❔ rows: fix them, or confirm and our team will check them.` : ""}`);
    const opts = [
      { c: "ok", t: "✅ Confirm & send", d: "To our team – they approve each report" },
      { c: "fix", t: "✏️ Fix a row", d: "Pick the patient or confirm it" },
      { c: "del", t: "🗑️ Remove a row" },
      { c: "x", t: "❌ Cancel all", d: "Nothing is sent" },
    ];
    await this.save("r_conf", { b: bid, o: opts.map((o) => o.c) });
    return this.options("Is this right?", opts);
  }
  async batchOpt(d, c) {
    const files = await this.batchFiles(d.b);
    if (c === "ok") return this.confirmBatch(d.b);
    if (c === "x") return this.flowCancel("r_conf", d);
    if (c === "fix" || c === "del") {
      if (files.length === 1) {
        if (c === "del") { await deleteReportRows(this.env, [files[0].id]); return this.showBatch(d.b); }
        return this.rowMenu(d.b, files[0].id);
      }
      await this.save("r_which", { b: d.b, m: c });
      return this.say(`Which row? Reply 1–${files.length}.\n(9 = back)`);
    }
    return this.showBatch(d.b);
  }
  async rowMenu(bid, fid) {
    const files = await this.batchFiles(bid);
    const i = files.findIndex((x) => x.id === fid);
    if (i < 0) return this.showBatch(bid);
    const f = files[i];
    let m = {}; try { m = JSON.parse(f.match_json || "{}") || {}; } catch {}
    const [best] = m.best ? await this.withDob([m.best]) : [];
    await this.say(await this.batchRowText(f, i));
    const opts = [];
    if (best && m.status !== "ok" && f.centre_ok !== "yes") opts.push({ c: "same", t: "✔ Yes, this patient", d: this.label(best).slice(0, 72) });
    opts.push({ c: "pick", t: "🔁 Pick the patient", d: "Choose from your list" }, { c: "team", t: "📤 Not in my list", d: "Our team will match it" },
      { c: "drop", t: "🗑️ Remove report" }, { c: "back", t: "↩️ Back to the list" });
    await this.save("r_row", { b: bid, f: fid, o: opts.map((o) => o.c) });
    return this.options(`Row ${i + 1} – what should I do?`, opts);
  }
  async rowOpt(d, c) {
    const f = await this.db.prepare("SELECT * FROM report_files WHERE id=?1 AND batch_id=?2 AND review='draft'").bind(d.f, String(d.b)).first();
    if (!f || c === "back") return this.showBatch(d.b);
    let m = {}; try { m = JSON.parse(f.match_json || "{}") || {}; } catch {}
    if (c === "same" && m.best) { await this.db.prepare("UPDATE report_files SET centre_ok='yes', booking_id=?1 WHERE id=?2").bind(m.best, f.id).run(); return this.showBatch(d.b); }
    if (c === "team") { await this.db.prepare("UPDATE report_files SET centre_ok='unknown', booking_id='' WHERE id=?1").bind(f.id).run(); return this.showBatch(d.b); }
    if (c === "drop") { await deleteReportRows(this.env, [f.id]); return this.showBatch(d.b); }
    if (c === "pick") return this.startPick("rep", { b: d.b, f: f.id, fname: f.name });
    return this.showBatch(d.b);
  }
  // the centre picked the patient for a report: the AI's reading is matched again against that patient, so the operator sees how well it fits
  async assignFile(bid, fid, bookingId) {
    const f = await this.db.prepare("SELECT * FROM report_files WHERE id=?1 AND batch_id=?2 AND review='draft'").bind(fid, String(bid)).first();
    if (!f) return this.showBatch(bid);
    let ai = null; try { ai = f.ai_status === "done" ? JSON.parse(f.ai_json || "null") : null; } catch {}
    const m = await matchReport(this.env, { ...f, hint_booking: bookingId }, ai, f.ai_status === "error" ? f.ai_json : null);
    if (m.best !== bookingId) m.centre_pick = bookingId;
    await this.db.prepare("UPDATE report_files SET booking_id=?1, hint_booking=?1, centre_ok='picked', match_status=?2, match_json=?3 WHERE id=?4").bind(bookingId, m.status, JSON.stringify(m), fid).run();
    return this.showBatch(bid);
  }
  async confirmBatch(bid) {
    const env = this.env, files = await this.batchFiles(bid), ids = [], now = isoNow();
    let first = null;
    for (const f of files) {
      let m = {}; try { m = JSON.parse(f.match_json || "{}") || {}; } catch {}
      const bookingId = f.centre_ok === "unknown" ? "" : f.centre_ok ? f.booking_id : m.best || f.booking_id || "";
      await this.db.prepare("UPDATE report_files SET review='pending', booking_id=?1 WHERE id=?2 AND review='draft'").bind(bookingId, f.id).run();
      ids.push(f.id);
      if (bookingId) { first = first || bookingId; await logAct(env, bookingId, this.actor, "centre", `Report “${f.name}” sent by the centre on WhatsApp – waiting for approval`); }
    }
    await this.db.prepare("UPDATE report_batches SET status='done', closed_at=?1 WHERE id=?2").bind(now, bid).run();
    await this.state(null);
    await this.setLastAct({ at: now, a: "reports", items: ids });
    if (first) await waEvent(env, "review", first, { n: ids.length, centre: this.who.centre });
    else for (const t of teamNumbers(this.S)) await waText(env, this.S, t, `📄 ${ids.length} report${ids.length === 1 ? "" : "s"} from ${this.who.centre} waiting for approval – ${SITE}/admin/ → Operations`).catch(() => {});
    return this.say(`Sent for approval ✅ ${ids.length} report${ids.length === 1 ? "" : "s"}.\nOur team checks every report before it goes to the patient.\n\nReply *UNDO* within 10 minutes to take ${ids.length === 1 ? "it" : "them"} back.`);
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
    secrets: { WA_TOKEN: !!env.WA_TOKEN, WA_APP_SECRET: !!env.WA_APP_SECRET, WA_VERIFY_TOKEN: !!env.WA_VERIFY_TOKEN, AI_KEY: env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : env.CLAUDE_API_KEY ? "CLAUDE_API_KEY" : "" },
    ai_model_default: AI_MODEL_DEFAULT,
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
      SUM(CASE WHEN COALESCE(i.dir, 'in') = 'in' AND i.at > COALESCE(c.read_at, '') THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN i.status = 'failed' AND i.wa_id LIKE 'fail-%' THEN 1 ELSE 0 END) AS notsent
    FROM wa_inbox i LEFT JOIN wa_contacts c ON c.phone = i.phone GROUP BY i.phone ORDER BY last_id DESC LIMIT 300`).all();
  const last = {};
  for (let i = 0; i < results.length; i += 90) {
    const ids = results.slice(i, i + 90).map((r) => r.last_id);
    const { results: rows } = await env.DB.prepare(`SELECT id, phone, body, at, dir, by_who, status FROM wa_inbox WHERE id IN (${ids.map((_, k) => `?${k + 1}`).join(",")})`).bind(...ids).all();
    for (const r of rows) last[r.phone] = r;
  }
  const people = {};
  for (let i = 0; i < results.length; i += 90) Object.assign(people, await chatPeople(env, S, results.slice(i, i + 90).map((r) => r.phone)));
  return json({ chats: results.map((r) => ({ ...people[r.phone], unread: r.unread || 0, notsent: r.notsent || 0, last: last[r.phone] || null })), ready: waReady(env, S) });
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
  if ("ai_model" in set && set.ai_model && !/^[a-z0-9][a-z0-9.\-_:]{1,60}$/i.test(set.ai_model)) return bad("The AI model name looks like claude-sonnet-5-5.");
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
// Admin → WhatsApp → Diagnose: why don't incoming messages arrive? Asks Meta which app is subscribed to the WhatsApp account,
// where that app sends its webhook and for which fields, and shows the last call we got from Meta.
async function adminWaDiagnose(env, fix) {
  const S = await getSettings(env), out = { problems: [] };
  if (!env.WA_TOKEN) return bad("The WA_TOKEN secret isn't set in Cloudflare yet.");
  if (!S.wa_waba_id) return bad("Enter the WhatsApp account ID first.");
  try {
    if (fix) out.subscribe = await graph(env, S, `${S.wa_waba_id}/subscribed_apps`, { method: "POST" });
    const sub = await graph(env, S, `${S.wa_waba_id}/subscribed_apps`);
    out.apps = (sub.data || []).map((x) => x.whatsapp_business_api_data || x);
    if (!out.apps.length) out.problems.push("No app is subscribed to your WhatsApp account, so Meta sends incoming messages nowhere. Press “Connect app to WhatsApp account”.");
  } catch (e) { out.problems.push(`Couldn't read the subscribed apps: ${e.message}`); }
  const app = (out.apps || [])[0];
  if (app && app.id && env.WA_APP_SECRET) {
    try {
      const r = await fetch(`${env.WA_GRAPH_URL || "https://graph.facebook.com"}/${S.wa_version || "v25.0"}/${app.id}/subscriptions?access_token=${encodeURIComponent(app.id + "|" + env.WA_APP_SECRET)}`);
      const j = await r.json().catch(() => ({}));
      if (j.error) out.problems.push(`Meta refused the app secret check (${j.error.message}). WA_APP_SECRET may not belong to app ${app.name || app.id} – then every incoming message is refused.`);
      else {
        out.webhooks = (j.data || []).map((x) => ({ object: x.object, callback_url: x.callback_url, active: x.active, fields: (x.fields || []).map((f) => f.name || f) }));
        const wa = out.webhooks.find((x) => x.object === "whatsapp_business_account");
        const want = `${SITE}/api/wa/webhook`;
        if (!wa) out.problems.push(`The app has no WhatsApp webhook. In Meta → your app → WhatsApp → Configuration set Callback URL ${want} and the verify token, then subscribe “messages”.`);
        else {
          if (wa.callback_url !== want) out.problems.push(`The webhook goes to ${wa.callback_url}, not ${want}.`);
          if (!wa.fields.includes("messages")) out.problems.push("The webhook isn't subscribed to the “messages” field (Meta → WhatsApp → Configuration → Webhook fields → messages → Subscribe).");
          if (!wa.fields.includes("message_template_status_update")) out.problems.push("Optional: subscribe “message_template_status_update” too, so template approvals arrive instantly.");
          if (wa.active === false) out.problems.push("The webhook is switched off (not active).");
        }
      }
    } catch (e) { out.problems.push(`Couldn't check the webhook: ${e.message}`); }
  }
  try { out.last_call = JSON.parse((await env.DB.prepare("SELECT v FROM settings WHERE k='wa_hook_last'").first() || {}).v || "null"); } catch { out.last_call = null; }
  if (!out.problems.length) out.problems.push("Meta's side looks right. If messages still don't arrive: the Meta app must be Live (App Dashboard → top bar: App Mode → Live) – apps in Development mode don't get real messages.");
  return json(out);
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
// The WhatsApp version of a text: body (+ example values) and quick-reply buttons.
function tplComponents(env, t) {
  const { text, params } = M.metaBody(t.body);
  if (text.length > 1024) return { error: `The WhatsApp version is ${text.length} characters; WhatsApp allows 1,024. Shorten the text.` };
  if (/^\s*\{\{/.test(text) || /\}\}\s*$/.test(text)) return { error: "WhatsApp doesn't allow a template to start or end with a {{value}}. Add a few words before / after it." };
  const ex = M.vars({ id: "DSL-AB12CD", name: "Asha Verma", phone: "9811122233", date: addDays(istParts().date, 2), slot: "07:30", address: "Flat 302, Sunrise Apartments, Sector 7",
    city: "New Delhi", state: "Delhi", pincode: "110075", amount: 1899, vial_no: "AB1234", notes: "Gate 2", collector_info: "Ramesh, 98765 43210, 8:30 AM", status: "confirmed" },
  { tests: [{ name: "FEMALE FERTILITY", includes: "FSH, LH, AMH, TSH" }], cfg: { amount: 1899, upiId: env.UPI_ID || "lab@upi", visitFee: 300 }, centre: { name: "Dwarka Sector 7 centre" }, alert: "Report uploaded" });
  const comps = [{ type: "BODY", text, ...(params.length ? { example: { body_text_named_params: params.map((k) => ({ param_name: k, example: M.oneLine(ex[k]).slice(0, 200) })) } } : {}) }];
  if (t.buttons.length) comps.push({ type: "BUTTONS", buttons: t.buttons.map((x) => ({ type: "QUICK_REPLY", text: x.text })) });
  return { comps };
}
// Send a text to WhatsApp for approval as a template (needed to message people who haven't written to us in 24 hours).
// An APPROVED text is never edited in place (Meta often refuses that, and it would stop sending while under review):
// the new wording goes in as a new version (<name>_v2, _v3 …). The approved version keeps being used until the new one
// is approved, then the new one takes over by itself (adminWaSync / the webhook → promoteTemplate).
async function adminWaSubmit(env, key) {
  const S = await getSettings(env);
  if (!env.WA_TOKEN) return bad("Add the WA_TOKEN secret in Cloudflare first.");
  if (!S.wa_waba_id) return bad("Enter the WhatsApp account ID first.");
  const t = (await templates(env)).find((x) => x.key === key);
  if (!t) return bad("Unknown message", 404);
  if (t.meta === false) return bad("This message only goes out inside an open chat, so it doesn't need WhatsApp's approval.");
  const c = tplComponents(env, t);
  if (c.error) return bad(c.error);
  const comps = c.comps;
  if (t.wa_id && ["APPROVED", "PAUSED", "DISABLED"].includes(t.wa_status)) {
    const m = /_v(\d+)$/.exec(t.wa_name);
    let n = Math.max(m ? +m[1] + 1 : 2, (/_v(\d+)$/.exec(t.nx_name || "") || [0, 0])[1] * 1 + 1);
    for (let tries = 0; tries < 4; tries++, n++) {
      const name = `${t.base_name}_v${n}`;
      try {
        const j = await graph(env, S, `${S.wa_waba_id}/message_templates`, { method: "POST", body: { name, language: "en", category: "UTILITY", parameter_format: "NAMED", components: comps } });
        const status = j.status || "PENDING";
        await env.DB.prepare("UPDATE msg_templates SET nx_name=?1, nx_id=?2, nx_status=?3, nx_body=?4, nx_reason=NULL, wa_reason=NULL, updated_at=?5 WHERE key=?6")
          .bind(name, j.id, status, t.body, isoNow(), key).run();
        if (status === "APPROVED") await promoteTemplate(env, key);
        return json({ ok: true, status, version: name });
      } catch (e) {
        if (/already exists|2388024|2388023/i.test(e.message)) continue; // that name is taken (e.g. an older attempt) – next number
        return bad(`WhatsApp said: ${e.message}`, 400);
      }
    }
    return bad("WhatsApp already has templates with the next version names – try again later.");
  }
  try {
    let id = t.wa_id, status = "PENDING";
    if (id) await graph(env, S, id, { method: "POST", body: { components: comps } }); // not approved yet (pending / rejected): edit it
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
// The new version was approved: send with it from now on.
async function promoteTemplate(env, key) {
  const t = (await templates(env)).find((x) => x.key === key);
  if (!t || !t.nx_body || t.nx_body.trim() !== String(t.body).trim()) { // the text changed since – that version is outdated
    await env.DB.prepare("UPDATE msg_templates SET nx_name=NULL, nx_id=NULL, nx_status=NULL, nx_body=NULL, nx_reason=NULL WHERE key=?1").bind(key).run();
    return;
  }
  await env.DB.prepare(`UPDATE msg_templates SET cur_name=nx_name, wa_id=nx_id, wa_status='APPROVED', wa_body=nx_body, wa_reason=NULL,
    nx_name=NULL, nx_id=NULL, nx_status=NULL, nx_body=NULL, nx_reason=NULL, updated_at=?1 WHERE key=?2 AND nx_id IS NOT NULL`).bind(isoNow(), key).run();
}
// Every message text that WhatsApp hasn't approved in its current wording is sent for approval automatically:
// new texts, texts edited in the admin, and texts whose wording changed in the code (e.g. a new phone number).
// Runs from the cron at most every 30 minutes; a text WhatsApp is still reviewing is left alone.
// Meta allows an approved template to be edited once a day (10 times a month) – a refusal is simply retried next time.
async function autoSubmitTemplates(env, force) {
  const S = await getSettings(env);
  if (!env.WA_TOKEN || !S.wa_waba_id) return { skipped: "WhatsApp isn't set up" };
  const last = await env.DB.prepare("SELECT v FROM settings WHERE k='tpl_auto_at'").first();
  if (!force && last && Date.now() - Date.parse(last.v) < 30 * 60000) return { skipped: "ran recently" };
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('tpl_auto_at', ?1)").bind(isoNow()).run();
  await adminWaSync(env).catch(() => {}); // fresh statuses from Meta first
  const out = [];
  for (const t of await templates(env)) {
    if (t.meta === false || ["PENDING", "IN_APPEAL"].includes(t.wa_status)) continue;
    const changed = !t.wa_id || !t.wa_body || t.wa_body.trim() !== String(t.body).trim();
    if (!changed) continue;
    // this wording is already waiting as a new version (or WhatsApp turned it down – don't send the same text again)
    if (t.nx_body && t.nx_body.trim() === String(t.body).trim() && ["PENDING", "IN_APPEAL", "REJECTED"].includes(t.nx_status)) continue;
    const r = await adminWaSubmit(env, t.key);
    const j = await r.json().catch(() => ({}));
    out.push({ key: t.key, ok: r.ok, status: j.status || null, error: r.ok ? null : j.error || String(r.status) });
    if (!r.ok) {
      console.log("template auto-submit", t.key, j.error);
      await env.DB.prepare("UPDATE msg_templates SET wa_reason=?1 WHERE key=?2").bind(String("Auto-submit: " + (j.error || r.status)).slice(0, 300), t.key).run().catch(() => {});
    }
    if (out.length >= 8) break; // the rest next time
  }
  return { submitted: out };
}
async function adminWaSync(env) {
  const S = await getSettings(env);
  if (!env.WA_TOKEN || !S.wa_waba_id) return bad("Set the WA_TOKEN secret and the WhatsApp account ID first.");
  let j;
  try { j = await graph(env, S, `${S.wa_waba_id}/message_templates?fields=id,name,status,language,rejected_reason,components&limit=200`); }
  catch (e) { return bad(`WhatsApp said: ${e.message}`, 502); }
  const { results: rows } = await env.DB.prepare("SELECT key, wa_body FROM msg_templates").all();
  const find = (name) => name && (j.data || []).find((d) => d.name === name && /^en/.test(d.language || ""));
  const why = (m) => (m.rejected_reason && m.rejected_reason !== "NONE" ? m.rejected_reason : null);
  const stmts = [], promote = [];
  for (const t of await templates(env)) {
    if (t.meta === false) continue;
    const nx = find(t.nx_name);
    if (nx) {
      if (t.nx_body && t.nx_body.trim() !== String(t.body).trim()) stmts.push(env.DB.prepare("UPDATE msg_templates SET nx_name=NULL, nx_id=NULL, nx_status=NULL, nx_body=NULL, nx_reason=NULL WHERE key=?1").bind(t.key)); // the text changed again – that version is outdated
      else if (nx.status === "APPROVED") promote.push(t.key);
      else stmts.push(env.DB.prepare("UPDATE msg_templates SET nx_id=?1, nx_status=?2, nx_reason=?3 WHERE key=?4").bind(nx.id, nx.status, why(nx), t.key));
    }
    const m = find(t.wa_name);
    if (!m) continue;
    const have = rows.find((r) => r.key === t.key);
    const metaText = ((m.components || []).find((c) => c.type === "BODY") || {}).text || null;
    stmts.push(env.DB.prepare(`INSERT INTO msg_templates (key, wa_id, wa_status, wa_reason, wa_body, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(key) DO UPDATE SET wa_id=excluded.wa_id, wa_status=excluded.wa_status, wa_reason=COALESCE(excluded.wa_reason, CASE WHEN msg_templates.wa_reason LIKE 'Auto-submit:%' THEN msg_templates.wa_reason END), wa_body=COALESCE(msg_templates.wa_body, excluded.wa_body), updated_at=excluded.updated_at`)
      .bind(t.key, m.id, m.status, why(m), have && have.wa_body ? have.wa_body : metaText, isoNow()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  for (const k of promote) await promoteTemplate(env, k);
  return json({ ok: true, found: stmts.length, promoted: promote.length });
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
    if (o.booking_id && o.to_phone) await logHand(env, o.booking_id, o.kind, o.to_phone);
    if (o.kind === "report" && o.booking_id) await releaseReports(env, await bookingFull(env, o.booking_id));
    await env.DB.prepare("UPDATE wa_inbox SET status='resent' WHERE wa_id=?1").bind(`fail-${id}`).run();
  } else {
    await env.DB.prepare("UPDATE wa_outbox SET status='dismissed', updated_at=?1 WHERE id=?2").bind(now, id).run();
    await env.DB.prepare("UPDATE wa_inbox SET status='dismissed' WHERE wa_id=?1").bind(`fail-${id}`).run();
  }
  return json({ ok: true });
}
// admin pressed a message button: through the API when it's set up, otherwise { manual: true } and the page opens WhatsApp
async function adminSend(env, req, id) {
  const b = await req.json().catch(() => ({}));
  if (!MSG_KINDS.includes(b.kind) || b.kind === "chat") return bad("Invalid message type");
  const sug = Array.isArray(b.sug) ? b.sug.filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && SLOTS.includes(s.slot)).slice(0, 5) : undefined;
  return json(await sendKind(env, req, id, b.kind, { sug, reportIds: b.reportIds }));
}
// Send one message now. → { sent } | { queued } (operator: passed to the admin's Send by hand list) | { manual } (admin sends it by hand)
async function sendKind(env, req, id, kind, opts = {}) {
  const S = await getSettings(env);
  const staff = STAFF.get(req), op = staff && staff.role !== "admin";
  if (!waReady(env, S) || waDown(S) || S.wa_mode !== "auto") {
    if (!op) return { manual: true };
    await queueForAdmin(env, id, kind, !waReady(env, S) ? "The WhatsApp API isn't set up yet." : waDown(S) ? `WhatsApp API paused: ${S.wa_down_reason}` : "Sending is set to Manual.");
    return { queued: true };
  }
  const r = await deliver(env, id, kind, { S, ...opts });
  if (r.manual && op) return { queued: true, error: r.error };
  if (r.manual) { // the page sends it by hand now
    const { results: gone } = await env.DB.prepare("SELECT id FROM wa_outbox WHERE booking_id=?1 AND kind=?2 AND status='failed'").bind(id, kind).all();
    await env.DB.prepare("UPDATE wa_outbox SET status='dismissed' WHERE booking_id=?1 AND kind=?2 AND status='failed'").bind(id, kind).run();
    for (const g of gone) await env.DB.prepare("UPDATE wa_inbox SET status='resent' WHERE wa_id=?1").bind(`fail-${g.id}`).run();
  }
  return r;
}

// A message the API couldn't send, put in the admin's "Send by hand" list.
async function queueForAdmin(env, id, kind, error) {
  const b = await bookingFull(env, id);
  if (!b) return;
  const m = msgFor(env, await templates(env), b, kind);
  const to = m.t.to === "centre" ? b.centre_phone : m.t.to === "patient" ? b.phone : null;
  const now = isoNow();
  const r = await env.DB.prepare("INSERT INTO wa_outbox (booking_id, kind, to_phone, to_role, status, error, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'failed', ?5, ?6, ?6)")
    .bind(id, kind, to || null, m.t.to, String(error).slice(0, 500), now).run();
  await logFailed(env, r.meta.last_row_id, to, m.text, error);
}
// A message that couldn't be sent also shows in that person's chat in Admin → Inbox ("Not sent" + the reason + Send by hand).
// wa_id "fail-<outbox id>" links the chat line to the Send-by-hand list.
const NOT_SENT = "\n⚠ Not sent: ";
async function logFailed(env, oid, phone, text, error, at) {
  if (!oid || !phone) return;
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO wa_inbox (wa_id, phone, type, body, at, dir, by_who, status) VALUES (?1, ?2, 'text', ?3, ?4, 'out', 'auto', 'failed')")
      .bind(`fail-${oid}`, phone, (String(text || "").slice(0, 3500) + NOT_SENT + String(error || "").slice(0, 400)), at || isoNow()).run();
  } catch (e) { console.log("failed-message log", String(e)); }
}
// one-time: messages that failed before this was added get their chat line too
async function backfillFailed(env) {
  if (await env.DB.prepare("SELECT 1 FROM settings WHERE k='inbox_fail_v1'").first()) return;
  await setSettings(env, { inbox_fail_v1: "1" });
  const { results } = await env.DB.prepare("SELECT * FROM wa_outbox WHERE status IN ('failed','dismissed') AND to_phone IS NOT NULL AND created_at >= ?1 ORDER BY id LIMIT 300")
    .bind(new Date(Date.now() - 60 * 86400000).toISOString()).all();
  const T = await templates(env), cache = {};
  for (const o of results) {
    let text = "";
    try { const b = cache[o.booking_id] || (cache[o.booking_id] = await bookingFull(env, o.booking_id)); text = b ? msgFor(env, T, b, o.kind).text : ""; } catch {}
    await logFailed(env, o.id, o.to_phone, text || o.kind, o.error, o.created_at);
    if (o.status === "dismissed") await env.DB.prepare("UPDATE wa_inbox SET status='dismissed' WHERE wa_id=?1").bind(`fail-${o.id}`).run();
  }
}

// The job goes to the collection centre on WhatsApp. If sending isn't automatic and an operator did this,
// the message is put in the admin's "Send by hand" list instead (operators never send by hand).
async function centreJob(env, req, id, ev) {
  const S = await getSettings(env);
  if (waAuto(env, S)) return waEvent(env, ev, id);
  const staff = STAFF.get(req);
  if (staff && staff.role !== "admin") {
    const b = await env.DB.prepare("SELECT centre_id FROM bookings WHERE id=?1").bind(id).first();
    if (b && b.centre_id) await queueForAdmin(env, id, "center", "Sending is set to Manual.");
  }
}

// ---- reschedule requests (from the patient's WhatsApp menu) ----
async function adminResched(env, req, id) {
  const b = await req.json().catch(() => ({}));
  if (b.action !== "dismiss") return bad("Invalid request");
  await env.DB.prepare("UPDATE bookings SET resched_req=NULL, resched_at=NULL, resched_date=NULL, resched_slot=NULL, updated_at=?1 WHERE id=?2").bind(isoNow(), id).run();
  return json({ ok: true });
}
// Take the job away from its collection centre: the centre gets a cancellation message, the booking waits for a new centre.
async function adminCancelCentre(env, req, id) {
  const row = await bookingFull(env, id);
  if (!row || !row.centre_id) return bad("This booking has no collection centre.", 400);
  if (AFTER_COLLECT_STATES.includes(row.status)) return bad("The sample is already collected.", 409);
  const S = await getSettings(env);
  const staff = STAFF.get(req), op = staff && staff.role !== "admin";
  let r = { manual: true, error: "Sending is set to Manual." };
  if (waReady(env, S) && !waDown(S) && S.wa_mode === "auto") r = await deliver(env, row, "centre_cancel", { S });
  else if (op) await queueForAdmin(env, id, "centre_cancel", r.error);
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET centre_id=NULL, centre_status='cancelled', centre_status_at=?1, collector_info=NULL, updated_at=?1 WHERE id=?2").bind(now, id),
    env.DB.prepare("DELETE FROM msg_log WHERE booking_id=?1 AND kind IN ('center','done:center','done:centre_ok','collector','done:collector','reminder','done:reminder')").bind(id),
  ]);
  return json({ ok: true, sent: !!r.sent, queued: !r.sent && op, manual: !r.sent && !op, text: !r.sent && !op ? msgFor(env, await templates(env), row, "centre_cancel").text : undefined, phone: row.centre_phone || null });
}

// ---- activity log: who did what to a booking ----
async function logAct(env, id, who, role, what) {
  if (!id || !what) return;
  await env.DB.prepare("INSERT INTO activity (booking_id, at, who, role, what) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, isoNow(), who || null, role || null, String(what).slice(0, 300)).run();
}
const STATUS_TXT = { pending: "Awaiting payment", payment_submitted: "Paid – to verify", confirmed: "Payment confirmed", collected: "Vial confirmed at lab", report_ready: "Report ready",
  completed: "Completed", no_show: "Patient not available", cancelled: "Cancelled", expired: "Expired" };
async function auditApi(env, req, am, b, res) {
  const st = STAFF.get(req) || {};
  const [, area, idIn, action] = am;
  let id = idIn;
  b = b || {};
  if (!id && area === "admin") { const j = await res.json().catch(() => ({})); id = j.id; }
  if (!id) return;
  const centreName = async (cid) => { const c = cid ? await env.DB.prepare("SELECT name FROM centres WHERE id=?1").bind(cid).first() : null; return c ? c.name : "none"; };
  let what = "";
  if (!action) what = `Booking added (${STATUS_TXT[b.status] || "Payment confirmed"})${b.centre_id ? " · centre: " + (await centreName(b.centre_id)) : ""}`;
  else if (area === "centre") what = action === "collected" ? `Vial no. sent by the centre: ${clean(b.vial_no, 40).toUpperCase()}` : action === "accept" ? `Centre accepted${b.collector ? " · collector: " + clean(b.collector, 120) : ""}` : action === "decline" ? "Centre declined the job" : action === "reports" ? "Report uploaded by the centre" : action;
  else if (action === "status") what = `${STATUS_TXT[b.status] || b.status}${b.vial_no ? " · vial " + clean(b.vial_no, 40).toUpperCase() : b.status === "collected" && b.no_vial ? " · without vial no." : ""}`;
  else if (action === "vial") what = `Vial no. changed to ${clean(b.vial_no, 40).toUpperCase()}`;
  else if (action === "centre") what = `Collection centre: ${await centreName(b.centre_id)}`;
  else if (action === "move") what = `Moved to ${M.fmtDate(b.date)}, ${M.slotLabel(b.slot)}`;
  else if (action === "sent") what = b.kind === "done:centre_ok" ? "Centre acceptance ticked by hand" : b.kind === "undo-done" ? `Undid “${b.target}”` : String(b.kind).startsWith("done:") ? `Ticked “${String(b.kind).slice(5)}” as done` : `Sent “${b.kind}” by hand (own WhatsApp)`;
  else if (action === "send") what = `Sent “${b.kind}” on WhatsApp`;
  else if (action === "tests") what = "Packages changed";
  else if (action === "reports" || action === "report") what = "Report uploaded";
  else if (action === "resched") what = "Reschedule request dismissed";
  else if (action === "cancel-centre") what = "Job cancelled at the centre";
  else what = action;
  await logAct(env, id, st.name || "Admin", st.role || null, what);
}
async function adminActivity(env, id) {
  const { results } = await env.DB.prepare("SELECT at, who, role, what FROM activity WHERE booking_id=?1 ORDER BY id DESC LIMIT 100").bind(id).all();
  return json({ activity: results });
}

// ---- router ----
// run work after the response is sent (e.g. WhatsApp messages after an admin click)
const CTX = new WeakMap();
const STAFF = new WeakMap(); // req → the signed-in admin/operator
function later(req, promise) {
  const p = Promise.resolve(promise).catch((e) => console.log("background job failed", String(e && e.stack || e)));
  const ctx = CTX.get(req);
  if (ctx) ctx.waitUntil(p);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      if (event.cron === "30 13 * * *") await waDaily(env); // 7 PM IST: visit reminders
      await reportJobs(env); // every minute: AI report checks + confirm screens for the centres
      await paymentSweep(env).catch((e) => console.log("payment sweep", String(e))); // online payments nobody came back from
      // every 10 minutes while any message text is waiting for WhatsApp's approval: load its status from Meta
      // (Meta also tells us through the webhook, but only if "message_template_status_update" is subscribed)
      await autoSubmitTemplates(env).catch((e) => console.log("template auto-submit", String(e))); // every 30 min: wording changed → send for approval
      if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() % 10 === 0
        && (await env.DB.prepare("SELECT 1 FROM msg_templates WHERE wa_status IN ('PENDING','IN_APPEAL') OR nx_status IN ('PENDING','IN_APPEAL') LIMIT 1").first())) await adminWaSync(env).catch(() => {});
    })());
  },
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    const am = req.method !== "GET" && path.match(/^\/api\/(admin|centre)\/bookings(?:\/(DSL-[A-Z0-9]{6})(?:\/([a-z-]+))?)?$/);
    const body = am && (req.headers.get("content-type") || "").includes("json") ? await req.clone().json().catch(() => null) : null;
    const res = await this.handle(req, env, ctx);
    if (am && res.ok && env.DB) ctx.waitUntil(auditApi(env, req, am, body, res.clone()).catch((e) => console.log("audit", String(e))));
    return res;
  },
  async handle(req, env, ctx) {
    CTX.set(req, ctx);
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) {
        if (!env.DB) return bad("Database not configured", 503);
        await ensureSchema(env);
        if (p === "/api/config" && req.method === "GET") return getConfig(env, url);
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
        m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/pay$/);
        if (m && req.method === "GET") return payInfo(env, url, m[1]);
        m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/reslot$/);
        if (m && req.method === "POST") return reslot(env, req, m[1]);
        m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/checkout$/);
        if (m && req.method === "POST") return checkout(env, req, url, m[1]);
        m = p.match(/^\/api\/bookings\/(DSL-[A-Z0-9]{6})\/verify$/);
        if (m && req.method === "POST") return verifyPay(env, req, m[1]);
        if (p === "/api/pay/instamojo" && req.method === "POST") return imWebhook(env, req);

        if (p === "/api/staff/login" && req.method === "POST") return staffLogin(env, req);
        if (p === "/api/staff/logout" && req.method === "POST") return logoutSession(env, req);
        if (p.startsWith("/api/admin/")) {
          const staff = await staffOf(env, req);
          if (!staff) return bad("Please sign in again.", 401);
          if (staff.role !== "admin" && !operatorMay(req.method, p)) return bad("Only an admin can do this.", 403);
          STAFF.set(req, staff);
          if (p === "/api/admin/me" && req.method === "GET") return json({ user: staff });
          if (p === "/api/admin/lookup" && req.method === "GET") return adminLookup(env, url);
          if (p === "/api/admin/bookings" && req.method === "GET") return adminList(env, url, staff);
          if (p === "/api/admin/export.csv" && req.method === "GET") return adminCsv(env, url);
          if (p === "/api/admin/block" && req.method === "POST") return adminBlock(env, req);
          if (p === "/api/admin/bookings" && req.method === "POST") return adminCreate(env, req);
          { const dm = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})$/); if (dm && req.method === "DELETE") return adminDeleteBooking(env, req, dm[1]); }
          if (p === "/api/admin/packages" && req.method === "GET") return adminPackages(env, staff);
          if (p.startsWith("/api/admin/labtests") && staff.role !== "admin") return bad("Only an admin can do this.", 403);
          if (p === "/api/admin/labtests" && req.method === "GET") return adminLabTests(env);
          if (p === "/api/admin/labtests" && req.method === "POST") return adminSaveLabTest(env, req, null);
          { const lm = p.match(/^\/api\/admin\/labtests\/(\d{1,9})(\/ai)?$/);
            if (lm && req.method === "POST") return lm[2] ? adminAiLabTest(env, Number(lm[1])) : adminSaveLabTest(env, req, Number(lm[1]));
            if (lm && !lm[2] && req.method === "DELETE") return adminDeleteLabTest(env, Number(lm[1])); }
          { const pm2 = p.match(/^\/api\/admin\/labtests\/package\/(\d{1,9})(\/ai)?$/);
            if (pm2 && req.method === "POST") return pm2[2] ? adminAiPackageTests(env, Number(pm2[1])) : adminSetPackageTests(env, req, Number(pm2[1])); }
          if (p === "/api/admin/packages" && req.method === "POST") return adminSavePackage(env, req, null);
          if (p.startsWith("/api/admin/home") && staff.role !== "admin") return bad("Only an admin can do this.", 403);
          if (p === "/api/admin/home" && req.method === "GET") return adminHome(env);
          if (p === "/api/admin/home" && req.method === "POST") return adminSaveHome(env, req);
          if (p === "/api/admin/home/preview" && req.method === "POST") return homePage(env, (await req.json().catch(() => ({}))).page || {}, true);
          m = p.match(/^\/api\/admin\/packages\/(\d{1,9})\/page(?:\/(preview|ai))?$/);
          if (m && staff.role !== "admin") return bad("Only an admin can do this.", 403);
          if (m && !m[2] && req.method === "GET") return adminPage(env, Number(m[1]));
          if (m && !m[2] && req.method === "POST") return adminSavePage(env, req, Number(m[1]));
          if (m && m[2] === "preview" && req.method === "POST") return adminPreviewPage(env, req, Number(m[1]));
          if (m && m[2] === "ai" && req.method === "POST") return adminAiPage(env, req, Number(m[1]));
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
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/activity$/);
          if (m && req.method === "GET") return adminActivity(env, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/resched$/);
          if (m && req.method === "POST") return adminResched(env, req, m[1]);
          m = p.match(/^\/api\/admin\/bookings\/(DSL-[A-Z0-9]{6})\/cancel-centre$/);
          if (m && req.method === "POST") return adminCancelCentre(env, req, m[1]);
          if (p === "/api/admin/payments" && req.method === "GET") return adminPayments(env, url);
          m = p.match(/^\/api\/admin\/payments\/(\d{1,9})\/check$/);
          if (m && req.method === "POST") return adminPaymentCheck(env, Number(m[1]));
          if (p === "/api/admin/review" && req.method === "GET") return adminReview(env);
          m = p.match(/^\/api\/admin\/review\/(\d{1,9})$/);
          if (m && req.method === "POST") return adminReviewAct(env, req, Number(m[1]));
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
          if (p === "/api/admin/wa/ai-test" && req.method === "POST") return adminAiTest(env);
          if (p === "/api/admin/wa/diagnose" && req.method === "POST") return adminWaDiagnose(env, false);
          if (p === "/api/admin/wa/connect" && req.method === "POST") return adminWaDiagnose(env, true);
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
          STAFF.set(req, { id: user.id, role: "centre", name: user.name + " (centre login)" });
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
      // website: "/" = our story + packages, /package/<slug> = a published package page (old /package/<slug> links move there)
      const old = p.match(/^\/test\/([a-z0-9-]{1,80})\/?$/);
      if (old) return Response.redirect(new URL(`/package/${old[1]}${url.search}`, req.url).toString(), 301);
      const rc = p.match(/^\/receipt\/(DSL-[A-Za-z0-9]{1,20})\/?$/);
      if (rc && req.method === "GET" && env.DB) { await ensureSchema(env); return receiptPage(env, rc[1], url.searchParams.get("t")); }
      const tm = p.match(/^\/package\/([a-z0-9-]{1,80})\/?$/);
      if ((tm || p === "/" || p === "/sitemap.xml") && req.method === "GET" && env.DB) {
        try {
          await ensureSchema(env);
          if (p === "/") return await homePage(env, await homeContent(env), false);
          if (p === "/sitemap.xml") return await sitemap(env);
          const res = await sitePage(env, req, url, tm[1]);
          if (res) return res;
        } catch (e) { console.log("site page", p, String(e && e.stack || e)); }
        if (tm) return Response.redirect(new URL("/#packages", req.url).toString(), 302);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.log("error", p, String(e && e.stack || e));
      // staff screens get the real reason (helps fixing); the public site keeps the friendly text
      if (/^\/api\/(admin|staff|centre)\//.test(p)) return bad("Server error: " + String((e && e.message) || e).slice(0, 200), 500);
      return bad("Something went wrong. Please call 8368143677 to book.", 500);
    }
  },
};
