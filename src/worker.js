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
  report_token: "TEXT", report_at: "TEXT", completed_at: "TEXT", fee_due: "INTEGER", fee_paid_at: "TEXT", missed_slot: "TEXT", package_id: "INTEGER", package_name: "TEXT" };
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
      if (!have.size) for (const [c, t] of Object.entries(NEW_COLS)) {
        try { await env.DB.prepare(`ALTER TABLE bookings ADD COLUMN ${c} ${t}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
      }
      await seedPackages(env);
      await migrateTestsAndReports(env);
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
    if (!vial) return bad("Enter the vial number written on the sample.");
    if (!body.force) {
      const dup = await env.DB.prepare("SELECT id, name FROM bookings WHERE vial_no=?1 AND id!=?2 LIMIT 1").bind(vial, id).first();
      if (dup) return json({ error: `Vial ${vial} is already used for ${dup.name} (${dup.id}). Check the number.`, code: "dup_vial" }, 409);
    }
    set.vial_no = vial;
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
  const now = isoNow(), token = randId(32, "abcdefghijklmnopqrstuvwxyz0123456789");
  await env.DB.prepare("INSERT INTO report_files (booking_id, name, size, token, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, name, buf.length, token, now).run();
  const f = await env.DB.prepare("SELECT id FROM report_files WHERE token=?1").bind(token).first();
  const b64 = toB64(buf), stmts = [];
  for (let i = 0, n = 0; i < b64.length; i += REPORT_CHUNK, n++)
    stmts.push(env.DB.prepare("INSERT INTO report_parts (report_id, idx, data) VALUES (?1, ?2, ?3)").bind(f.id, n, b64.slice(i, i + REPORT_CHUNK)));
  stmts.push(env.DB.prepare("UPDATE bookings SET status='report_ready', report_at=?1, completed_at=NULL, updated_at=?1 WHERE id=?2").bind(now, id));
  await env.DB.batch(stmts);
  return json({ ok: true, id: f.id, token });
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
const MSG_KINDS = ["pay", "confirm", "center", "reminder", "slots", "missed", "collected", "report", "chat"];
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
