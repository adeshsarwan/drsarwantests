// Smart reports: one plain-language report per booking, built from ALL of the booking's lab report PDFs.
// Claude READS the PDFs (every value, unit and printed normal range) and writes the plain-words text: the summary,
// an answer to each question the package page promises to answer, and a line for each "It can" claim.
// Everything that decides a colour or a tick is worked out HERE from the numbers – normal / high / low,
// "something to discuss" / "normal", the counts – so it can't drift from what the lab printed.
// Built automatically (cron) when reports arrive; the operator chooses to send it (or only the lab PDFs) when approving.

export const SMART_VERSION = 1;

const GROUPS = ["Hormones & fertility", "Thyroid", "Blood sugar", "Blood count", "Liver", "Kidney", "Heart & cholesterol",
  "Vitamins & minerals", "Iron", "Infection & immunity", "Pregnancy", "Urine", "Other"];

export const SMART_SCHEMA = {
  type: "object",
  properties: {
    patient: { type: "object", properties: {
      name: { type: "string" }, age: { type: "string", description: "as printed, e.g. 24 years" }, gender: { type: "string" },
      collected: { type: "string", description: "date and time the sample was collected, as printed" },
      reported: { type: "string", description: "latest report date and time printed" },
      barcode: { type: "string" }, lab: { type: "string", description: "lab name printed on the report" },
    } },
    results: { type: "array", description: "EVERY test result in the PDFs, one row per value (max 120)", items: { type: "object", properties: {
      name: { type: "string", description: "short, clear test name, e.g. 'Haemoglobin', 'TSH', 'Absolute lymphocytes'" },
      plain: { type: "string", description: "what it measures in 3–8 plain words, e.g. 'Carries oxygen in red cells'" },
      group: { type: "string", enum: GROUPS },
      value: { type: ["number", "null"], description: "the result as a number exactly as printed; null if not a number" },
      value_text: { type: "string", description: "the result as printed when it isn't a number (e.g. 'Negative', 'Pending'); else empty" },
      unit: { type: "string" },
      low: { type: ["number", "null"], description: "lower limit of the printed normal range; null if none (e.g. '<1.00')" },
      high: { type: ["number", "null"], description: "upper limit of the printed normal range; null if none (e.g. '>60')" },
      range_text: { type: "string", description: "only when the range isn't a simple low–high (phases, trimesters, 'refer below'): a short summary" },
      note: { type: "string", description: "optional one-line note a patient needs to read this value (e.g. range depends on cycle day); else empty" },
    }, required: ["name", "group", "value", "unit", "low", "high"] } },
    summary: { type: "object", properties: {
      intro: { type: "string", description: "2 sentences: how the report looks overall, and that this explains the tests but isn't a diagnosis" },
      points: { type: "array", description: "the 1–4 things that stand out (only values outside the range, most important first). Several out-of-range values of one panel (e.g. blood count) = ONE point.", items: { type: "object", properties: {
        title: { type: "string", description: "e.g. 'Prolactin is high: 107 ng/mL (normal 3.1 – 23)'" },
        text: { type: "string", description: "2–3 plain sentences: what the test is, common reasons it can be outside the range (from the lab's own notes where printed), what the doctor may do next" },
        tests: { type: "array", items: { type: "string" }, description: "exact `name`s from results" },
      }, required: ["title", "text", "tests"] } },
      normal: { type: "string", description: "one sentence listing the important tests that are normal (with a value or two)" },
    }, required: ["intro", "points", "normal"] },
    questions: { type: "array", description: "one answer per question given in the brief, same order, question copied exactly", items: { type: "object", properties: {
      q: { type: "string" }, answer: { type: "string", description: "2–3 plain sentences answering from THESE results only; say plainly if a needed test isn't in the report" },
      tests: { type: "array", items: { type: "string" }, description: "exact `name`s from results used for this answer" },
      missing: { type: "array", items: { type: "string" }, description: "tests this question needs that are NOT in the report" },
    }, required: ["q", "answer", "tests"] } },
    claims: { type: "array", description: "one line per 'It can' claim given in the brief, same order, claim copied exactly", items: { type: "object", properties: {
      claim: { type: "string" }, text: { type: "string", description: "1 sentence: what these results show for this claim" },
      tests: { type: "array", items: { type: "string" } }, missing: { type: "array", items: { type: "string" } },
    }, required: ["claim", "text", "tests"] } },
    lab_notes: { type: "array", items: { type: "string" }, description: "remarks the lab printed that matter to the patient (e.g. possible haemoglobin variant), in plain words; max 4" },
    doctor_questions: { type: "array", items: { type: "string" }, description: "2–4 short questions the patient could ask their doctor about the results outside the range" },
    not_in_report: { type: "array", items: { type: "string" }, description: "tests of the booked package(s) that are NOT in any of the PDFs" },
  },
  required: ["patient", "results", "summary", "questions", "claims", "not_in_report"],
};

export function smartPrompt(ctx) {
  const pk = ctx.packages.map((p) => [
    `Package: ${p.name}${p.tests ? ` – tests: ${p.tests}` : ""}`,
    p.questions.length ? `Questions this package's web page says it answers:\n${p.questions.map((q, i) => `  Q${i + 1}. ${q.title}${q.answered_by ? ` (answered by: ${q.answered_by})` : ""}`).join("\n")}` : "",
    p.can.length ? `"It can" claims on the web page:\n${p.can.map((c, i) => `  C${i + 1}. ${c}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  return `You are writing a patient's "smart report" for Dr. Sarwan Diagnostic Labs, an NABL-accredited lab in India.
The attached PDF(s) are this patient's lab reports for ONE booking. Read EVERY page.

BOOKING
Patient booked as: ${ctx.name}${ctx.cycle ? `\nCycle / notes given at booking: ${ctx.cycle}` : ""}
${pk || "No package details."}

RULES
1. results: copy every value, unit and normal range EXACTLY as printed. Never guess, round or correct. If a test appears twice (e.g. interim and final), keep the final one.
   If the printed range is one simple range, put it in low/high. If it depends on cycle phase, trimester or menopause, use a single range only when the printed "Ref. interval" column gives one; otherwise low = high = null and summarise the phases in range_text.
   One-sided ranges: "<1.00" → low null, high 1.0; ">60" → low 60, high null.
2. Plain words, short sentences, for an Indian patient with no medical training. British spelling. No jargon without a plain explanation.
3. NEVER diagnose, never name a disease the patient "has", never suggest medicines or doses. Use "can be a sign of", "your doctor may".
   Base reasons for an abnormal value on the lab's own printed notes where present.
4. questions / claims: answer each from THESE results only, in the same order, copying the question / claim text exactly. If a test it needs isn't in the PDFs, say so plainly and list it in missing.
5. Calm and honest: don't alarm, don't reassure beyond the numbers.
Answer by calling the smart_report tool exactly once.`;
}

// ---------------- after the AI: the numbers decide every flag ----------------
const num = (v) => (typeof v === "number" && isFinite(v) ? v : v != null && v !== "" && isFinite(Number(v)) ? Number(v) : null);
const s = (v, n = 400) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const key = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export function statusOf(r) {
  if (r.value == null) return /pend|process|await/i.test(r.value_text || "") ? "pending" : "info";
  if (r.low == null && r.high == null) return "info";
  if (r.high != null && r.value > r.high) return "high";
  if (r.low != null && r.value < r.low) return "low";
  return "ok";
}
// where the dot sits on the bar: the normal band is the middle 30–70 %
export function dotPos(r) {
  if (r.value == null || (r.low == null && r.high == null)) return null;
  const lo = r.low != null ? r.low : 0, hi = r.high != null ? r.high : (r.low != null ? r.low * 2 || 1 : 1);
  const span = hi - lo || Math.abs(hi) || 1;
  return Math.max(4, Math.min(96, Math.round((30 + ((r.value - lo) / span) * 40) * 10) / 10));
}

export function finishSmart(ai, ctx) {
  ai = ai || {};
  const results = (Array.isArray(ai.results) ? ai.results : []).slice(0, 120).map((x) => {
    const r = { name: s(x.name, 80), plain: s(x.plain, 120), group: GROUPS.includes(x.group) ? x.group : "Other",
      value: num(x.value), value_text: s(x.value_text, 60), unit: s(x.unit, 30), low: num(x.low), high: num(x.high),
      range_text: s(x.range_text, 200), note: s(x.note, 220) };
    if (r.low != null && r.high != null && r.low > r.high) [r.low, r.high] = [r.high, r.low];
    r.status = statusOf(r); r.pos = dotPos(r);
    return r;
  }).filter((r) => r.name && (r.value != null || r.value_text));
  const byKey = new Map(results.map((r) => [key(r.name), r]));
  const find = (n) => byKey.get(key(n)) || results.find((r) => key(r.name).includes(key(n)) && key(n).length >= 3) || null;
  const pills = (names) => [...new Set((names || []).map(String))].map(find).filter(Boolean)
    .map((r) => ({ name: r.name, value: r.value != null ? r.value : r.value_text, unit: r.unit, status: r.status }));
  const flagged = (ps) => ps.some((p) => p.status === "high" || p.status === "low");

  const qIn = ctx.packages.flatMap((p) => p.questions.map((q) => q.title));
  const qs = (Array.isArray(ai.questions) ? ai.questions : []).slice(0, 12).map((q, i) => {
    const ps = pills(q.tests), missing = (q.missing || []).map((m) => s(m, 60)).filter(Boolean).slice(0, 6);
    return { q: s(qIn[i] || q.q, 200), answer: s(q.answer, 700), pills: ps, missing,
      verdict: flagged(ps) ? "discuss" : ps.length ? "ok" : "missing" };
  }).filter((q) => q.q && q.answer);
  const cIn = ctx.packages.flatMap((p) => p.can);
  const claims = (Array.isArray(ai.claims) ? ai.claims : []).slice(0, 12).map((c, i) => {
    const ps = pills(c.tests), missing = (c.missing || []).map((m) => s(m, 60)).filter(Boolean);
    return { claim: s(cIn[i] || c.claim, 240), text: s(c.text, 400), status: flagged(ps) ? "discuss" : ps.length && !missing.length ? "ok" : "missing", missing };
  }).filter((c) => c.claim);
  const sm = ai.summary || {};
  const points = (Array.isArray(sm.points) ? sm.points : []).slice(0, 4).map((p) => {
    const ps = pills(p.tests);
    const far = ps.some((x) => { const r = find(x.name); return r && r.value != null && ((r.high != null && r.value > r.high * 1.5) || (r.low != null && r.value < r.low * 0.67)); });
    return { title: s(p.title, 160), text: s(p.text, 600), level: far ? "high" : "mild", tests: ps.map((x) => x.name) };
  }).filter((p) => p.title);

  // groups in a fixed order; values outside the range first inside each group
  const order = { high: 0, low: 0, pending: 1, info: 2, ok: 3 };
  const groups = GROUPS.map((g) => ({ name: g, items: results.filter((r) => r.group === g).sort((a, b) => order[a.status] - order[b.status]) })).filter((g) => g.items.length);
  const counts = { total: results.length, ok: results.filter((r) => r.status === "ok").length, flagged: results.filter((r) => r.status === "high" || r.status === "low").length,
    other: results.filter((r) => r.status === "info" || r.status === "pending").length };
  const p = ai.patient || {};
  return {
    v: SMART_VERSION,
    patient: { name: s(p.name, 80) || ctx.name, booked_name: ctx.name, age: s(p.age, 30), gender: s(p.gender, 20), collected: s(p.collected, 40),
      reported: s(p.reported, 40), barcode: s(p.barcode, 40), lab: s(p.lab, 80) },
    booking: ctx.booking_id, packages: ctx.packages.map((x) => x.name),
    counts, groups,
    summary: { intro: s(sm.intro, 500), points, normal: s(sm.normal, 400) },
    questions: qs, claims,
    cant: ctx.packages.flatMap((x) => x.cant).map((c) => s(c, 240)).filter(Boolean).slice(0, 6),
    lab_notes: (ai.lab_notes || []).map((x) => s(x, 400)).filter(Boolean).slice(0, 4),
    doctor_questions: (ai.doctor_questions || []).map((x) => s(x, 200)).filter(Boolean).slice(0, 4),
    not_in_report: (ai.not_in_report || []).map((x) => s(x, 60)).filter(Boolean).slice(0, 12),
    files: ctx.files.map((f) => ({ id: f.id, name: f.name })),
  };
}
