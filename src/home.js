// Home page ("/"): a trust-first brand page – accreditations, our promises, how a sample travels, the smart report,
// the packages (cards come live from Packages), coverage, honest promises and FAQ.
// Content is JSON in settings key "home_page" (version 2), edited in Admin → Packages → "Edit home page".
// Content saved before version 2 (the old "Our journey" layout) is replaced by HOME_DEFAULT.

export const HOME_VERSION = 2;

export const HOME_DEFAULT = {
  v: HOME_VERSION,
  hero: {
    badge: "NABL accredited · CGHS approved · Since 2015",
    title: "Lab tests at home you can trust, from a lab that's accredited",
    text: "A trained phlebotomist collects your sample at home, any time from 7 AM to 6 PM. It's tested to national (NABL) quality standards, and your report comes to your WhatsApp.",
    cta: "Book a home test",
    chips: ["Home sample collection", "Hygienic, sealed kits", "Reports on WhatsApp", "Secure online payment"],
  },
  creds: {
    title: "Independently assessed, so you don't have to take our word for it",
    items: [
      { name: "NABL", title: "NABL accredited lab", text: "Assessed against national quality standards for medical testing labs · Certificate MC-6975", url: "" },
      { name: "CGHS", title: "CGHS approved centre", text: "Approved to serve Central Government Health Scheme members", url: "" },
      { name: "ISO", title: "ISO 9001:2015 certified lab", text: "Quality-managed processes from booking to report", url: "" },
    ],
  },
  stats: [
    { big: "Since 2015", small: "Serving patients for 10+ years" },
    { big: "PAN India", small: "Home collection in metro & tier-1 cities" },
    { big: "7 AM – 6 PM", small: "Home collection, every day" },
    { big: "On WhatsApp", small: "E-report, plus anytime access in My reports" },
  ],
  pillars: {
    kicker: "Why families choose DSL",
    title: "Eight promises behind every test",
    intro: "A diagnosis starts with a result you can rely on. This is what we do to earn that trust each time.",
    items: [
      { tag: "Accredited", title: "NABL & CGHS approved", text: "Our lab is assessed against national quality standards and approved by CGHS. Ask to see the certificates at any time." },
      { tag: "Accurate", title: "Results you can act on", text: "Samples are tested on quality-controlled analysers. Every report is checked against your name and booking before it's released." },
      { tag: "Hygienic", title: "Sealed, single-use kits", text: "Every needle and vial is new, sealed and opened in front of you. The phlebotomist sanitises their hands and wears fresh gloves for each patient." },
      { tag: "Safety", title: "Trained, verified collectors", text: "You get the collector's name and phone number on WhatsApp before the visit, so you know exactly who is coming to your door." },
      { tag: "Doorstep pickup", title: "Home sample, your slot", text: "Pick a time between 7 AM and 6 PM. No queues, no travel, and no waiting room while you're fasting." },
      { tag: "Wide coverage", title: "Collection across India", text: "Our collection centres serve homes in metro and tier-1 cities nationwide, and every sample is tested to the same standard." },
      { tag: "Fast", title: "Booked in a minute", text: "Pay online and your slot is confirmed straight away. WhatsApp updates follow at every step, and the report arrives the moment it's ready." },
      { tag: "Affordable", title: "Clear prices, no surprises", text: "The price you see is the price you pay, with home collection included. Lab tests are GST-exempt, and each package shows what it can and can't tell you." },
    ],
  },
  steps: {
    kicker: "How it works",
    title: "Your sample's journey, from your door to your report",
    intro: "You're kept informed on WhatsApp at every step, so you always know where your sample is.",
    items: [
      { title: "Book & pay", text: "Choose a package and a slot between 7 AM and 6 PM. Pay securely by UPI, card or net banking – your slot is confirmed at once." },
      { title: "Sample at home", text: "A trained collector, whose name and timing you get on WhatsApp, collects your sample at home with a sealed, single-use kit." },
      { title: "Report on WhatsApp", text: "Tested in our NABL-accredited lab and checked against your booking, your report comes to WhatsApp and stays in My reports." },
    ],
  },
  report: {
    kicker: "Smart report",
    title: "A report you can actually read",
    text: "Each value sits beside its normal range, and anything outside the range is clearly flagged, so you know what to discuss with your doctor.",
    points: [
      { title: "Normal ranges beside every value", text: "See at a glance what's in range and what isn't." },
      { title: "Private by design", text: "Reports open only with your mobile number and date of birth." },
      { title: "All your reports in one place", text: "Download past reports any time from My reports, so you can track changes over time." },
    ],
  },
  packages: { title: "Packages built around real questions", intro: "Every sample is collected at home, and each package page explains what it can and can't show." },
  coverage: {
    kicker: "Wide coverage",
    title: "Home collection in your city",
    text: "Our network of collection centres serves homes across India's metro and tier-1 cities. Book online, and the nearest centre confirms your visit.",
    cities: ["Delhi NCR", "Mumbai", "Bengaluru", "Hyderabad", "Chennai", "Kolkata", "Pune", "Ahmedabad", "Jaipur", "Lucknow", "Chandigarh", "+ more"],
  },
  promises: {
    title: "Straight answers on money, privacy and changes",
    items: [
      { title: "Secure payment", text: "Payments run on a secure payment gateway by UPI, card or net banking. Your slot is confirmed only after a successful payment." },
      { title: "Reschedule your slot", text: "Plans change, so you can move your visit to another slot. Our refund policy explains cancellations." },
      { title: "Your data stays yours", text: "Reports open only with your mobile number and date of birth. We never share your results." },
    ],
  },
  faq: {
    title: "Before you book",
    items: [
      { q: "Is Dr. Sarwan Diagnostic Labs NABL accredited?", a: "Yes. Our lab is NABL accredited and CGHS approved, and we've been serving patients since 2015." },
      { q: "How is my sample kept hygienic and safe?", a: "The collector uses a new, sealed, single-use kit that's opened in front of you. Each vial is labelled with a unique number, so your sample is tracked from your home to the lab." },
      { q: "When will I get my report?", a: "Your report is sent on WhatsApp as soon as it's verified, and it stays in My reports to download any time. The package page shows the usual time for each test." },
      { q: "Do I need to fast?", a: "Some tests need 8–12 hours of fasting. Each package page tells you how to prepare, and we remind you on WhatsApp before your visit." },
      { q: "Which cities do you cover?", a: "We offer home collection across India's metro and tier-1 cities. Call or WhatsApp your PIN code to confirm." },
      { q: "Is there an extra charge for home collection?", a: "No. The package price includes home collection, and lab tests are GST-exempt." },
    ],
  },
  seo: {
    title: "Dr. Sarwan Diagnostic Labs – NABL & CGHS approved home lab tests",
    description: "NABL-accredited, CGHS-approved diagnostic labs since 2015. Home sample collection 7 AM–6 PM across India, secure online payment and e-reports on WhatsApp.",
  },
};

const str = (v, max = 400) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
const strs = (v, n, max) => arr(v, n).map((x) => str(x, max)).filter(Boolean);
const obj = (v) => (v && typeof v === "object" ? v : {});

export function homeFromBody(b) {
  b = obj(b);
  const h = obj(b.hero), c = obj(b.creds), pl = obj(b.pillars), st = obj(b.steps), r = obj(b.report), p = obj(b.packages),
    cv = obj(b.coverage), pr = obj(b.promises), f = obj(b.faq), seo = obj(b.seo);
  const tt = (x, a = 60, bb = 300) => ({ title: str(x && x.title, a), text: str(x && x.text, bb) });
  return {
    v: HOME_VERSION,
    hero: { badge: str(h.badge, 80), title: str(h.title, 160), text: str(h.text, 500), cta: str(h.cta, 40) || "Book a home test", chips: strs(h.chips, 6, 40) },
    creds: { title: str(c.title, 120),
      items: arr(c.items, 4).map((x) => ({ name: str(x && x.name, 8), title: str(x && x.title, 60), text: str(x && x.text, 160), url: str(x && x.url, 300) })).filter((x) => x.title) },
    stats: arr(b.stats, 6).map((x) => ({ big: str(x && x.big, 20), small: str(x && x.small, 60) })).filter((x) => x.big),
    pillars: { kicker: str(pl.kicker, 60), title: str(pl.title, 100), intro: str(pl.intro, 300),
      items: arr(pl.items, 12).map((x) => ({ tag: str(x && x.tag, 30), ...tt(x) })).filter((x) => x.title) },
    steps: { kicker: str(st.kicker, 60), title: str(st.title, 100), intro: str(st.intro, 300), items: arr(st.items, 8).map((x) => tt(x, 40, 200)).filter((x) => x.title) },
    report: { kicker: str(r.kicker, 60), title: str(r.title, 100), text: str(r.text, 400), points: arr(r.points, 5).map((x) => tt(x, 60, 200)).filter((x) => x.title) },
    packages: { title: str(p.title, 100), intro: str(p.intro, 300) },
    coverage: { kicker: str(cv.kicker, 60), title: str(cv.title, 100), text: str(cv.text, 400), cities: strs(cv.cities, 40, 30) },
    promises: { title: str(pr.title, 100), items: arr(pr.items, 4).map((x) => tt(x, 60, 300)).filter((x) => x.title) },
    faq: { title: str(f.title, 100), items: arr(f.items, 12).map((x) => ({ q: str(x && x.q, 160), a: str(x && x.a, 600) })).filter((x) => x.q && x.a) },
    seo: { title: str(seo.title, 120), description: str(seo.description, 300) },
  };
}

// Stored content from before version 2 (old journey layout) falls back to the new default.
const OLD_SIX_STEPS = "Book & pay|Collector assigned|Sample at home|Tested at the lab|Report verified|Report on WhatsApp";
export function homeOrDefault(stored) {
  if (!(stored && stored.v === HOME_VERSION)) return HOME_DEFAULT;
  // the first six-step "How it works" (unchanged by hand) becomes the short three-step version
  const st = stored.steps || {};
  if (Array.isArray(st.items) && st.items.map((x) => x && x.title).join("|") === OLD_SIX_STEPS) return { ...stored, steps: { ...st, items: HOME_DEFAULT.steps.items } };
  return stored;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rs = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const testCount = (t) => { const m = /(\d+)\s*tests?/i.exec(String(t || "")); if (m) return Number(m[1]); const n = String(t || "").split(/[,+;\n]/).filter((x) => x.trim()).length; return n; };
// official marks for the accreditation card and footer, matched by the item's name or title (works with saved content too)
const CRED_LOGOS = [
  [/nabl/i, "/assets/accreditation/nabl.png", "NABL accreditation mark, certificate MC-6975"],
  [/cghs/i, "/assets/accreditation/cghs.png", "CGHS (Central Government Health Scheme) emblem"],
  [/\biso\b|9001/i, "/assets/accreditation/iso.png", "ISO 9001:2015 certification mark"],
];
const credLogo = (x) => { const k = `${x.name || ""} ${x.title || ""}`; const m = CRED_LOGOS.find(([re]) => re.test(k)); return m ? { src: m[1], alt: m[2] } : null; };
const PHONE_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"></path></svg>';
// icons for the promise cards, picked by the card's tag (falls back to a tick)
const ICONS = {
  accredited: '<path d="M12 2l3 3 4-.5-.5 4 3 3-3 3 .5 4-4-.5-3 3-3-3-4 .5.5-4-3-3 3-3-.5-4 4 .5z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  accurate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  hygienic: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 14.5a2.5 2.5 0 002.5 2.5"/>',
  safety: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/>',
  doorstep: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  coverage: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  fast: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  affordable: '<path d="M7 4h10M7 8h10M13 4c3 0 4 2 4 4s-1 4-4 4H7l8 8"/>',
  report: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h6"/>',
  tick: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
};
const iconFor = (tag) => { const t = String(tag || "").toLowerCase();
  const k = Object.keys(ICONS).find((k) => t.includes(k)) || (t.includes("home") || t.includes("pickup") ? "doorstep" : t.includes("cover") || t.includes("india") ? "coverage" : t.includes("price") || t.includes("afford") ? "affordable" : t.includes("report") ? "report" : t.includes("hygien") || t.includes("clean") ? "hygienic" : "tick");
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#1f6977" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`; };

const H2 = 'margin: 6px 0 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 36px; line-height: 1.15';
const KICK = 'font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #c2410c';
const LEAD = 'margin: 10px 0 0; color: #3b4a68; font-size: 17px; line-height: 1.55';
const WRAP = 'max-width: 1180px; margin: 0 auto; padding: 72px 24px';
const head = (k, t, i, id) => `<div style="max-width: 720px">${k ? `<span style="${KICK}">${esc(k)}</span>` : ""}<h2 ${id ? `id="${id}" ` : ""}style="${H2}">${esc(t)}</h2>${i ? `<p style="${LEAD}">${esc(i)}</p>` : ""}</div>`;

// pkgs: [{ name, slug, price, mrp, tests, page, target, card_headline, card_text, card_points }] – only packages with a published page
export function renderHome(home, pkgs, opts = {}) {
  const h = homeFromBody(home);
  const title = h.seo.title || "Dr. Sarwan Diagnostic Labs";
  const desc = h.seo.description || "";
  const cards = pkgs.map((p) => {
    let pg = {}; try { pg = JSON.parse(p.page || "{}"); } catch {}
    const hero = pg.hero || {}, n = testCount(p.tests);
    // card copy from Admin → Packages → Edit → Website card, falling back to the package page's hero
    const line = p.card_text || hero.subtitle || p.tests || "";
    const tag = p.target || (hero.kicker ? String(hero.kicker).split("·")[0].trim() : "Home collection");
    const headline = String(p.card_headline || String(hero.headline || p.name).replace(/\[|\]/g, "")).replace(/^[\s•\-*·]+/, "");
    const points = String(p.card_points || "").split("\n").map((x) => x.replace(/^[\s•\-*·]+/, "").trim()).filter(Boolean).slice(0, 4);
    return `<article class="pk-card" style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 18px; padding: 24px; display: flex; flex-direction: column; gap: 12px">
<span style="align-self: flex-start; font-size: 12.5px; font-weight: 800; color: #1f6977; background: #e6f3f1; border-radius: 999px; padding: 3px 10px">${esc(tag)}</span>
<h3 style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 21px; line-height: 1.2">${esc(headline)}</h3>
<p style="margin: 0; color: #3b4a68; line-height: 1.5; font-size: 15px">${esc(line)}</p>
${points.length ? `<div style="background: #f4f7fa; border-radius: 12px; padding: 12px 14px"><span style="display: block; font-size: 12.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #5a6880; margin-bottom: 6px">This package helps answer</span>
<ul style="list-style: none; margin: 0; padding: 0; display: grid; gap: 6px">${points.map((q) => `<li style="display: flex; gap: 8px; font-size: 14.5px; line-height: 1.4"><span aria-hidden="true" style="color: #16a34a; font-weight: 800">✓</span><span>${esc(q)}</span></li>`).join("")}</ul></div>` : ""}
<div style="display: flex; align-items: baseline; gap: 10px; margin-top: auto; flex-wrap: wrap"><b style="font-family: Archivo, sans-serif; font-size: 26px">${rs(p.price)}</b>${p.mrp && p.mrp > p.price ? `<s style="color: #8492a6; font-size: 15px">${rs(p.mrp)}</s>` : ""}<span style="color: #5a6880; font-size: 14px">${esc(p.name)}${n > 1 ? ` · ${n} tests` : ""}</span></div>
<span style="color: #5a6880; font-size: 13.5px">Home collection included · E-report on WhatsApp</span>
<a href="/package/${esc(p.slug)}" style="min-height: 44px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: #c2410c; color: #ffffff; text-decoration: none; font-weight: 700">See what it shows &amp; book</a>
</article>`;
  }).join("\n");
  const ld = { "@context": "https://schema.org", "@type": "MedicalOrganization", name: "Dr. Sarwan Diagnostic Labs", url: "https://drsarwantests.com/", telephone: "+91-8368143677",
    address: { "@type": "PostalAddress", streetAddress: "Shop 37-38, Vardhaman Crown Mall, Sector 19, Dwarka", addressLocality: "New Delhi", postalCode: "110078", addressCountry: "IN" } };
  const faqLd = h.faq.items.length ? { "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: h.faq.items.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) } : null;
  const ldTag = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
  const reportDemo = [["Haemoglobin", "13.2 g/dL", 52, 0], ["TSH", "6.1 µIU/mL ↑", 86, 1], ["Fasting glucose", "92 mg/dL", 45, 0], ["Vitamin D", "18 ng/mL ↓", 12, 1], ["Vitamin B12", "410 pg/mL", 48, 0]];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://drsarwantests.com/">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://drsarwantests.com/assets/og.jpg">
<meta property="og:url" content="https://drsarwantests.com/">
${opts.preview ? '<meta name="robots" content="noindex">' : ""}
<meta name="theme-color" content="#1f6977">
<link rel="icon" href="/assets/logo.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&amp;family=Figtree:wght@400;500;600;700&amp;display=swap">
<style>
body{margin:0;background:#fff}*,*::before,*::after{box-sizing:border-box}img{max-width:100%}html{scroll-behavior:smooth}section{scroll-margin-top:84px}
a{color:#1f6977}a:hover{color:#164e59}
.g4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
.g6{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;counter-reset:s;list-style:none;margin:0;padding:0}
.g6 li::before{counter-increment:s;content:counter(s);display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#1f6977;color:#fff;font-weight:800;font-size:14px;margin-bottom:12px}
.g2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px;align-items:start}
.g3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.stats>div{padding:22px 20px;border-left:1px solid rgba(255,255,255,.2)}.stats>div:first-child{border-left:0}
details{border-bottom:1px solid #e1e8ee;padding:18px 0}summary{cursor:pointer;font-weight:700;font-size:17px;list-style:none;display:flex;justify-content:space-between;gap:16px}
summary::-webkit-details-marker{display:none}summary::after{content:"+";color:#1f6977;font-size:22px;line-height:1}details[open] summary::after{content:"–"}
.mbar{display:none}
.pk-track{display:flex;gap:18px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding:4px 2px 8px;scrollbar-width:none;outline:none}
.pk-track::-webkit-scrollbar{display:none}
.pk-card{flex:0 0 calc((100% - 36px) / 3);scroll-snap-align:start;min-width:0}
.pk-nav{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:18px}
.pk-btn{width:44px;height:44px;border-radius:50%;border:1.5px solid #1f6977;background:#fff;color:#1f6977;font-size:26px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0 0 3px}
.pk-btn:disabled{opacity:.3;cursor:default}.pk-btn:not(:disabled):hover{background:#1f6977;color:#fff}
.pk-dots{display:flex;gap:6px}.pk-dots i{width:8px;height:8px;border-radius:999px;background:#c9d5dd;transition:all .2s}.pk-dots i.on{width:22px;background:#1f6977}
@media (max-width:980px){.pk-card{flex-basis:calc((100% - 18px) / 2)}}
@media (max-width:640px){.pk-card{flex-basis:86%}}
@media (max-width:980px){.g4{grid-template-columns:repeat(2,minmax(0,1fr))}.g6{grid-template-columns:repeat(3,minmax(0,1fr)) !important}}
@media (max-width:760px){.navlink{display:none !important}.hero-h{font-size:36px !important}.g2,.g3{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}
.stats>div:nth-child(3){border-left:0}.stats>div:nth-child(n+3){border-top:1px solid rgba(255,255,255,.2)}h2{font-size:28px !important}}
@media (max-width:560px){.g4{grid-template-columns:1fr}.g6{grid-template-columns:1fr !important}.navbook{display:none !important}
.mbar{display:grid;grid-template-columns:1fr 1fr;gap:10px;position:fixed;left:0;right:0;bottom:0;z-index:30;background:#fff;border-top:1px solid #e1e8ee;padding:10px}body{padding-bottom:70px}}
</style>
${ldTag(ld)}
${faqLd ? ldTag(faqLd) : ""}
</head>
<body>
<div style="font-family: Figtree, system-ui, sans-serif; color: #1b2a4e; font-size: 16px; line-height: 1.55">

<header style="background: #ffffff; border-bottom: 1px solid #e3edf3; position: sticky; top: 0; z-index: 20">
<div style="max-width: 1180px; margin: 0 auto; padding: 12px 24px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px">
<a href="/"><img src="/assets/logo.png" alt="Dr. Sarwan Diagnostic Labs" style="height: 52px; width: auto; display: block"></a>
<nav aria-label="Main" style="display: flex; flex-wrap: wrap; align-items: center; gap: 22px; font-weight: 600; font-size: 15px">
<a class="navlink" href="#why" style="color: #1b2a4e; text-decoration: none">Why DSL</a>
<a class="navlink" href="#packages" style="color: #1b2a4e; text-decoration: none">Packages</a>
<a href="/reports/" style="color: #1b2a4e; text-decoration: none">My reports</a>
<a class="navlink" href="tel:8368143677" style="color: #1b2a4e; text-decoration: none; display: inline-flex; align-items: center; gap: 6px">${PHONE_SVG}8368143677</a>
<a class="navbook" href="#packages" style="background: #c2410c; color: #ffffff; text-decoration: none; padding: 11px 20px; border-radius: 999px; min-height: 44px; display: inline-flex; align-items: center">Book a home test</a>
</nav>
</div>
</header>

<section style="background: linear-gradient(180deg, #e6f3f1, #ffffff 90%)">
<div style="max-width: 1180px; margin: 0 auto; padding: 64px 24px 48px">
<div class="g2" style="align-items: center">
<div style="display: flex; flex-direction: column; gap: 20px">
${h.hero.badge ? `<span style="${KICK}; color: #1f6977">${esc(h.hero.badge)}</span>` : ""}
<h1 class="hero-h" style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 50px; line-height: 1.07">${esc(h.hero.title)}</h1>
${h.hero.text ? `<p style="margin: 0; font-size: 19px; line-height: 1.55; color: #3b4a68">${esc(h.hero.text)}</p>` : ""}
<div style="display: flex; gap: 12px; flex-wrap: wrap">
<a href="#packages" style="min-height: 48px; display: inline-flex; align-items: center; padding: 0 22px; border-radius: 999px; background: #c2410c; color: #ffffff; text-decoration: none; font-weight: 700">${esc(h.hero.cta)} →</a>
<a href="tel:8368143677" style="min-height: 48px; display: inline-flex; align-items: center; gap: 8px; padding: 0 22px; border-radius: 999px; border: 1.5px solid #1f6977; color: #1f6977; text-decoration: none; font-weight: 700">${PHONE_SVG}Call 8368143677</a>
</div>
${h.hero.chips.length ? `<div style="display: flex; flex-wrap: wrap; gap: 8px">${h.hero.chips.map((c) => `<span style="display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #e1e8ee; border-radius: 999px; padding: 6px 12px; font-size: 14px; font-weight: 600; color: #1f6977"><span aria-hidden="true" style="width: 8px; height: 8px; border-radius: 50%; background: #16a34a"></span>${esc(c)}</span>`).join("")}</div>` : ""}
</div>
${h.creds.items.length ? `<aside aria-label="Accreditations" style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 20px; box-shadow: 0 8px 28px rgba(27,42,78,.08); padding: 26px">
${h.creds.title ? `<p style="margin: 0 0 14px; color: #5a6880; font-weight: 600; font-size: 15px">${esc(h.creds.title)}</p>` : ""}
${h.creds.items.map((x, i) => `<div style="display: flex; gap: 14px; align-items: center; padding: 14px 0; ${i ? "border-top: 1px solid #e1e8ee" : ""}">
${credLogo(x) ? `<span style="flex: none; width: 76px; height: 76px; border-radius: 16px; background: #ffffff; border: 1px solid #e1e8ee; box-shadow: 0 2px 8px rgba(27,42,78,.06); display: grid; place-items: center; padding: 8px; box-sizing: border-box"><img src="${credLogo(x).src}" alt="${esc(credLogo(x).alt)}" width="60" height="60" loading="eager" style="width: 60px; height: 60px; object-fit: contain; display: block"></span>` : `<span aria-hidden="true" style="flex: none; width: 76px; height: 76px; border-radius: 50%; border: 3px solid #1f6977; display: grid; place-items: center; font-family: Archivo, sans-serif; font-weight: 800; font-size: 14px; color: #1f6977; box-sizing: border-box">${esc(x.name || "✓")}</span>`}
<span style="display: flex; flex-direction: column"><b style="font-size: 16px">${esc(x.title)}</b>${x.text ? `<span style="font-size: 14px; color: #5a6880">${esc(x.text)}</span>` : ""}${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" style="font-size: 14px; font-weight: 600">View certificate ↗</a>` : ""}</span>
</div>`).join("\n")}
</aside>` : ""}
</div>
${h.stats.length ? `<div class="stats" role="list" style="margin-top: 48px; background: #1f6977; color: #ffffff; border-radius: 16px; overflow: hidden">
${h.stats.map((s) => `<div role="listitem"><b style="display: block; font-family: Archivo, sans-serif; font-size: 24px">${esc(s.big)}</b><span style="font-size: 14px; opacity: .88">${esc(s.small)}</span></div>`).join("\n")}
</div>` : ""}
</div>
</section>

${h.pillars.items.length ? `<section id="why" aria-labelledby="why-h">
<div style="${WRAP}; display: flex; flex-direction: column; gap: 36px">
${head(h.pillars.kicker, h.pillars.title, h.pillars.intro, "why-h")}
<div class="g4">
${h.pillars.items.map((x) => `<article style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 16px; padding: 22px">
<span style="width: 48px; height: 48px; border-radius: 12px; background: #e6f3f1; display: grid; place-items: center; margin-bottom: 14px">${iconFor(x.tag || x.title)}</span>
${x.tag ? `<span style="${KICK}; font-size: 12px">${esc(x.tag)}</span>` : ""}
<h3 style="margin: 4px 0 8px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 18px; line-height: 1.3">${esc(x.title)}</h3>
<p style="margin: 0; font-size: 15px; color: #3b4a68; line-height: 1.5">${esc(x.text)}</p>
</article>`).join("\n")}
</div>
</div>
</section>` : ""}

${h.steps.items.length ? `<section aria-labelledby="how-h" style="background: #f4f7fa">
<div style="${WRAP}; display: flex; flex-direction: column; gap: 36px">
${head(h.steps.kicker, h.steps.title, h.steps.intro, "how-h")}
<ol class="g6" style="grid-template-columns: repeat(${Math.min(h.steps.items.length, 6)}, minmax(0, 1fr))">
${h.steps.items.map((x) => `<li style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 16px; padding: 20px 16px"><b style="display: block; font-size: 16px; margin-bottom: 6px">${esc(x.title)}</b><span style="font-size: 14px; color: #3b4a68; line-height: 1.5">${esc(x.text)}</span></li>`).join("\n")}
</ol>
</div>
</section>` : ""}

${h.report.title ? `<section aria-labelledby="rep-h">
<div class="g2" style="${WRAP}">
<div>
${head(h.report.kicker, h.report.title, h.report.text, "rep-h")}
${h.report.points.length ? `<ul style="list-style: none; margin: 24px 0 0; padding: 0; display: grid; gap: 12px">
${h.report.points.map((x) => `<li style="display: flex; gap: 12px; background: #ffffff; border: 1px solid #e1e8ee; border-radius: 12px; padding: 14px 16px"><span aria-hidden="true" style="flex: none; width: 24px; height: 24px; border-radius: 50%; background: #16a34a; color: #fff; font-weight: 800; font-size: 13px; display: grid; place-items: center">✓</span><span><b style="display: block">${esc(x.title)}</b><span style="font-size: 14px; color: #5a6880">${esc(x.text)}</span></span></li>`).join("\n")}
</ul>` : ""}
<a href="/reports/" style="margin-top: 22px; min-height: 46px; display: inline-flex; align-items: center; padding: 0 22px; border-radius: 999px; border: 1.5px solid #1f6977; color: #1f6977; text-decoration: none; font-weight: 700">Open My reports</a>
</div>
<div aria-label="Sample report preview" style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 20px; box-shadow: 0 8px 28px rgba(27,42,78,.08); padding: 22px">
<div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e1e8ee; padding-bottom: 12px; margin-bottom: 6px"><b style="color: #1f6977">Sample report preview</b><span style="font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #e7f6ee; color: #15803d">Verified ✓</span></div>
${reportDemo.map(([n, v, pos, out]) => `<div style="display: grid; grid-template-columns: 1.3fr .9fr 1fr; gap: 8px; align-items: center; font-size: 14px; padding: 10px 0; border-bottom: 1px dashed #e1e8ee"><span>${n}</span><b style="color: ${out ? "#c2410c" : "#15803d"}">${v}</b><span style="position: relative; height: 6px; border-radius: 6px; background: #e1e8ee"><i style="position: absolute; top: -3px; left: ${pos}%; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; background: ${out ? "#c2410c" : "#16a34a"}"></i></span></div>`).join("")}
<p style="margin: 12px 0 0; font-size: 12px; color: #5a6880">Illustrative example only, not a real patient's report.</p>
</div>
</div>
</section>` : ""}

<section id="packages" aria-labelledby="pk-h" style="background: #f4f7fa">
<div style="${WRAP}; display: flex; flex-direction: column; gap: 28px">
${head("Health packages", h.packages.title || "Health packages", h.packages.intro, "pk-h")}
${cards ? `<div class="pk-car" data-n="${pkgs.length}">
<div class="pk-track" id="pkTrack" tabindex="0" aria-label="Health packages – scroll for more">\n${cards}\n</div>
<div class="pk-nav"><button type="button" class="pk-btn" data-dir="-1" aria-label="Previous packages">‹</button><div class="pk-dots" aria-hidden="true"></div><button type="button" class="pk-btn" data-dir="1" aria-label="More packages">›</button></div>
</div>`
  : '<p style="margin: 0; color: #3b4a68">Our packages are being updated. Please call <a href="tel:8368143677">8368143677</a> to book.</p>'}
</div>
</section>

${h.coverage.title ? `<section aria-labelledby="cov-h">
<div class="g2" style="${WRAP}; align-items: center">
<div>
${head(h.coverage.kicker, h.coverage.title, h.coverage.text, "cov-h")}
${h.coverage.cities.length ? `<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px">${h.coverage.cities.map((c) => `<span style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 10px; padding: 8px 14px; font-size: 15px; font-weight: 600">${esc(c)}</span>`).join("")}</div>` : ""}
</div>
<div style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 20px; box-shadow: 0 8px 28px rgba(27,42,78,.08); padding: 26px">
<b style="font-family: Archivo, sans-serif; font-size: 20px">Not sure if we cover your area?</b>
<p style="margin: 8px 0 18px; color: #3b4a68">Call or WhatsApp us your PIN code and we'll confirm in minutes.</p>
<div style="display: flex; gap: 12px; flex-wrap: wrap">
<a href="tel:8368143677" style="min-height: 46px; display: inline-flex; align-items: center; padding: 0 20px; border-radius: 999px; background: #c2410c; color: #ffffff; text-decoration: none; font-weight: 700">Call 8368143677</a>
<a href="https://wa.me/919818028755?text=${encodeURIComponent("Hi, do you collect samples at my PIN code?")}" target="_blank" rel="noopener" style="min-height: 46px; display: inline-flex; align-items: center; padding: 0 20px; border-radius: 999px; border: 1.5px solid #1f6977; color: #1f6977; text-decoration: none; font-weight: 700">WhatsApp us</a>
</div>
</div>
</div>
</section>` : ""}

${h.promises.items.length ? `<section aria-labelledby="pr-h" style="background: #f4f7fa">
<div style="${WRAP}; display: flex; flex-direction: column; gap: 32px">
${head("Our promises", h.promises.title, "", "pr-h")}
<div class="g3">
${h.promises.items.map((x) => `<div style="border-left: 4px solid #1f6977; background: #ffffff; padding: 18px 20px; border-radius: 0 12px 12px 0"><b style="display: block; font-size: 16px; margin-bottom: 6px">${esc(x.title)}</b><span style="font-size: 14.5px; color: #3b4a68; line-height: 1.5">${esc(x.text)}</span></div>`).join("\n")}
</div>
<p style="margin: 0; font-size: 14px; color: #5a6880">Read our <a href="/refund">refund policy</a>, <a href="/privacy">privacy policy</a> and <a href="/service">terms of service</a>.</p>
</div>
</section>` : ""}

${h.faq.items.length ? `<section aria-labelledby="faq-h">
<div style="${WRAP}; max-width: 868px">
${head("Questions", h.faq.title || "Questions", "", "faq-h")}
<div style="margin-top: 20px">
${h.faq.items.map((x) => `<details><summary>${esc(x.q)}</summary><p style="margin: 10px 0 0; color: #3b4a68; line-height: 1.55">${esc(x.a)}</p></details>`).join("\n")}
</div>
</div>
</section>` : ""}

<section>
<div style="max-width: 1180px; margin: 0 auto; padding: 0 24px 72px">
<div style="background: #1f6977; color: #ffffff; border-radius: 22px; padding: 40px; display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap">
<div><h2 style="margin: 0 0 6px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 30px">Accredited testing, without leaving home</h2>
<p style="margin: 0; opacity: .9">Book in a minute. A collector comes to you between 7 AM and 6 PM.</p></div>
<div style="display: flex; gap: 12px; flex-wrap: wrap">
<a href="#packages" style="min-height: 48px; display: inline-flex; align-items: center; padding: 0 22px; border-radius: 999px; background: #ffffff; color: #1f6977; text-decoration: none; font-weight: 700">Book a home test →</a>
<a href="tel:8368143677" style="min-height: 48px; display: inline-flex; align-items: center; padding: 0 22px; border-radius: 999px; border: 1.5px solid #ffffff; color: #ffffff; text-decoration: none; font-weight: 700">Call 8368143677</a>
</div>
</div>
</div>
</section>

<footer style="background: #1b2a4e; color: #d6deea">
<div style="max-width: 1180px; margin: 0 auto; padding: 36px 24px; display: flex; flex-direction: column; gap: 12px; font-size: 14px">
<b style="color: #ffffff; font-family: Archivo, sans-serif; font-size: 17px">Dr. Sarwan Diagnostic Labs</b>
${h.creds.items.some(credLogo) ? `<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 4px 0">${h.creds.items.filter(credLogo).map((x) => `<span title="${esc(x.title)}" style="width: 64px; height: 64px; border-radius: 14px; background: #ffffff; display: grid; place-items: center; padding: 7px; box-sizing: border-box"><img src="${credLogo(x).src}" alt="${esc(credLogo(x).alt)}" width="50" height="50" loading="lazy" style="width: 50px; height: 50px; object-fit: contain; display: block"></span>`).join("")}</div>` : ""}
<span>${h.creds.items.map((x) => esc(x.title)).join(" · ")}</span>
<span>Shop 37–38, Vardhaman Crown Mall, Sector 19, Dwarka, New Delhi 110078 · <a href="tel:8368143677" style="color: #d6deea">8368143677</a></span>
<span style="display: flex; gap: 16px; flex-wrap: wrap"><a href="/contact" style="color: #d6deea">Contact us</a><a href="/privacy" style="color: #d6deea">Privacy Policy</a><a href="/service" style="color: #d6deea">Terms of Service</a><a href="/refund" style="color: #d6deea">Refunds</a><a href="/delivery" style="color: #d6deea">Delivery</a><a href="/reports/" style="color: #d6deea">My reports</a></span>
<span style="color: #9fb0c8">© Dr. Sarwan Diagnostic Labs. Results support, not replace, your doctor's advice.</span>
</div>
</footer>

<div class="mbar">
<a href="tel:8368143677" style="min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; border: 1.5px solid #1f6977; color: #1f6977; text-decoration: none; font-weight: 700">Call</a>
<a href="#packages" style="min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: #c2410c; color: #ffffff; text-decoration: none; font-weight: 700">Book test</a>
</div>
</div>
<script>
(function(){var t=document.getElementById("pkTrack");if(!t)return;var car=t.parentNode,dots=car.querySelector(".pk-dots"),bs=car.querySelectorAll(".pk-btn");
function per(){var c=t.querySelector(".pk-card");return c?Math.max(1,Math.round(t.clientWidth/(c.getBoundingClientRect().width+18))):1}
function pages(){return Math.max(1,Math.ceil(t.children.length/per()))}
function step(){var c=t.querySelector(".pk-card");return c?(c.getBoundingClientRect().width+18)*per():t.clientWidth}
function upd(){var n=pages(),i=Math.round(t.scrollLeft/step());if(dots.children.length!==n){dots.innerHTML=new Array(n+1).join("<i></i>")}
for(var k=0;k<dots.children.length;k++)dots.children[k].className=k===Math.min(i,n-1)?"on":"";
bs[0].disabled=t.scrollLeft<4;bs[1].disabled=t.scrollLeft+t.clientWidth>=t.scrollWidth-4;car.querySelector(".pk-nav").style.display=n>1?"":"none"}
bs.forEach(function(b){b.addEventListener("click",function(){t.scrollBy({left:step()*Number(b.dataset.dir),behavior:"smooth"})})});
t.addEventListener("keydown",function(e){if(e.key==="ArrowRight"||e.key==="ArrowLeft"){e.preventDefault();t.scrollBy({left:step()*(e.key==="ArrowRight"?1:-1),behavior:"smooth"})}});
var r;t.addEventListener("scroll",function(){cancelAnimationFrame(r);r=requestAnimationFrame(upd)},{passive:true});window.addEventListener("resize",upd);upd()})();
</script>
</body>
</html>`;
}
