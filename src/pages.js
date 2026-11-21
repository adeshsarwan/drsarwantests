// Package pages: every package can have its own landing page at /package/<slug>, with the same layout as the home page.
// The page content is JSON (stored in packages.page), edited in Admin → Packages → "Edit page", and drawn into
// public/index.html with HTMLRewriter: the home page's content sections are swapped for this package's sections,
// and the booking form is preselected for this package (price, tests and payment all come from the package).

export const PAGE_SECTIONS = ["hero", "questions", "stories", "canCant", "tests", "precautions", "faq", "seo"];

// ---------------- the current home page, as page JSON (seed for the website test) ----------------
export const HORMONE_PAGE = {
  hero: {
    kicker: "Complete Hormone & Fertility Panel · 7 tests",
    headline: "Is it [PCOS], [Thyroid], or Something Else?",
    subtitle: "Stop guessing. Track your hormones, fertility & thyroid at home, with one morning blood sample.",
    chips: ["Fasting sample", "Home sample collection", "E-report"],
    cta: "Book Home Test",
    badge: "TOTAL 7 TESTS @",
  },
  questions: {
    kicker: "Start with your question",
    title: "Which question brought you here?",
    intro: "Each of the 7 tests answers a specific part of the puzzle. Here is how they map to the questions women ask most.",
    items: [
      { title: "Fatigue, weight shifts or hair loss?", body: "An under- or overactive thyroid is one of the most common hormonal causes of tiredness, weight change and thinning hair, and one of the simplest to check.", answered_by: "T3 · T4 · TSH" },
      { title: "Is it PCOS?", body: "Irregular periods, acne and facial hair have several possible causes. See your LH and FSH pattern, and rule out two common look-alikes: thyroid problems and high prolactin.", answered_by: "LH · FSH · PRL · TSH" },
      { title: "Am I ovulating?", body: "Ovulation is driven by two signals from the brain, LH and FSH. Raised prolactin or an underactive thyroid can quietly disrupt it.", answered_by: "LH · FSH · PRL · Thyroid" },
      { title: "How's my egg reserve?", body: "AMH reflects roughly how many eggs your ovaries hold. Read with FSH, it gives you and your doctor a baseline for planning.", answered_by: "AMH · FSH" },
    ],
  },
  stories: {
    kicker: "What women are talking about right now",
    title: "Hormone health is all over your feed. Here's what's true.",
    intro: "We looked at the conversations happening online in 2026 and checked them against the evidence, so you know what a blood test can settle and what it can't.",
    helps_label: "Where this panel helps:",
    items: [
      { tag: "Trending: PCOS → PMOS", title: "PCOS is being renamed. What does that mean for you?",
        paras: ["In 2026, a global consensus published in The Lancet proposed a new name: polyendocrine metabolic ovarian syndrome (PMOS). Many women with the condition have no ovarian cysts at all, and it affects metabolism, skin, heart health and mood, not only fertility.",
          "The diagnostic criteria largely stay the same, but up to 70% of affected women are thought to be undiagnosed. In India, a 2024 study estimated it affects roughly 7–20% of women of reproductive age, depending on the criteria used."],
        helps: "it shows your LH and FSH pattern and rules out thyroid and prolactin problems that cause similar symptoms. Confirming PCOS also needs a doctor's assessment, which may include testosterone and an ultrasound." },
      { tag: "Debated: the \"egg timer\" test", title: "Does AMH tell me how long I can wait?",
        paras: ["AMH is often sold online as a fertility countdown. A study in JAMA Network Open that reviewed 27 websites selling the test found that most overstated what it can predict, and fewer than half mentioned its limits.",
          "AMH reflects egg quantity. It does not measure egg quality or predict whether, or how quickly, you will conceive."],
        helps: "AMH with FSH gives your gynaecologist a reliable baseline for conversations about family planning, egg freezing or IVF, without the false promises." },
      { tag: "Viral: \"signs of hormone imbalance\"", title: "Brain fog, hair thinning, acne: is it my hormones?",
        paras: ["Symptom lists linking brain fog, hair loss, acne and poor sleep to \"hormones\" get millions of views. The symptoms are real, but they have many possible causes, including thyroid, iron levels, androgens and stress.",
          "For hair loss and fatigue, the thyroid is the first check most doctors recommend."],
        helps: "a full thyroid profile (T3, T4, TSH) from the same sample, so you can quickly rule a major cause in or out." },
      { tag: "Common worry: irregular cycles", title: "My app can't predict my period. Am I ovulating?",
        paras: ["Cycle-tracking apps struggle when periods are irregular. Two treatable causes are often missed: high prolactin, which can interfere with ovulation, and thyroid disorders, which are linked to irregular or missed periods.",
          "Both can make conceiving harder, and both show up on a simple blood test."],
        helps: "prolactin, thyroid and LH/FSH are all measured together, giving your doctor the full picture in one visit." },
    ],
    sources: [
      { label: "Bupa: Polycystic Ovary Syndrome is being renamed (2026)", url: "https://www.bupa.co.uk/newsroom/ourviews/pcos-to-pmos" },
      { label: "The South First: PCOS is now PMOS (2026)", url: "https://thesouthfirst.com/health/pcos-is-now-pmos-but-this-isnt-just-about-a-name-change/" },
      { label: "Contemporary OB/GYN: High PCOS prevalence reported in India (JAMA Netw Open, 2024)", url: "https://www.contemporaryobgyn.net/view/high-pcos-prevalence-reported-in-india" },
      { label: "University of Sydney: Websites selling home fertility tests making misleading claims", url: "https://www.sydney.edu.au/news-opinion/news/2023/08/22/many-websites-selling-home-fertility-tests-making-misleading-claims.html" },
      { label: "VARTA: Beware \"egg timer\" test", url: "https://www.varta.org.au/resources/news-and-blogs/beware-egg-timer-test-researchers-say" },
      { label: "NHS Gloucestershire: LH and FSH tests", url: "https://www.gloshospitals.nhs.uk/our-services/services-we-offer/pathology/tests-and-investigations/lh-and-fsh-gonadotrophins/" },
      { label: "Hertility: Best day for a hormone test", url: "https://hertilityhealth.com/blog/best-day-hormone-test-cycle-day-3" },
      { label: "Apollo Hospitals: Hyperprolactinemia", url: "https://www.apollohospitals.com/diseases-and-conditions/hyperprolactinemia" },
    ],
  },
  canCant: {
    title: "What this panel can, and can't, tell you",
    can: ["Show whether your thyroid is underactive or overactive", "Flag raised prolactin, a hidden cause of missed periods", "Give a baseline for LH and FSH, the hormones behind ovulation", "Estimate your egg reserve with AMH", "Give your doctor a solid starting point"],
    cant: ["Diagnose PCOS on its own: that needs a clinical exam, and may need testosterone and an ultrasound", "Predict whether or when you will get pregnant", "Measure egg quality", "Replace a consultation with your gynaecologist or endocrinologist"],
  },
  tests: {
    kicker: "What's included",
    title: "7 tests. Two systems. One sample.",
    groups: [
      { name: "Fertility & cycle", items: [
        { code: "AMH", name: "Anti-Müllerian Hormone", desc: "Egg reserve", icon: "/assets/icon4.png" },
        { code: "FSH", name: "Follicle Stimulating Hormone", desc: "Ovarian function and follicle growth", icon: "/assets/icon1.png" },
        { code: "LH", name: "Luteinising Hormone", desc: "The signal that triggers ovulation", icon: "/assets/icon2.png" },
        { code: "PRL", name: "Prolactin", desc: "High levels can suppress ovulation", icon: "/assets/icon3.png" },
      ] },
      { name: "Thyroid & metabolism", items: [
        { code: "TSH", name: "Thyroid Stimulating Hormone", desc: "The first and most sensitive thyroid check", icon: "/assets/icon7.png" },
        { code: "T3", name: "Triiodothyronine", desc: "The active thyroid hormone", icon: "/assets/icon5.png" },
        { code: "T4", name: "Thyroxine", desc: "The main hormone your thyroid makes", icon: "/assets/icon6.png" },
      ] },
    ],
  },
  precautions: {
    nav: "When to test",
    kicker: "Get accurate results",
    title: "When should I book my test?",
    intro: "Some hormones change through your cycle. Booking on the right day makes your results easier to read and compare.",
    items: [
      { big: "Day 2–5", title: "FSH, LH and AMH", body: "Book for day 2 to 5 of your period, counting day 1 as the first day of full flow, not spotting." },
      { big: "Any day", title: "T3, T4 and TSH", body: "Thyroid hormones don't follow your cycle, so timing doesn't matter for these." },
      { big: "Morning", title: "Prolactin", body: "Best tested in the morning, rested, before food or exercise, which is why we collect a fasting morning sample." },
    ],
    note: "**On the pill or other hormonal contraception?** FSH and LH results won't be meaningful, but thyroid, prolactin and AMH can still be tested. **Irregular cycles?** Mention it when you book and our team will advise on timing.",
  },
  faq: {
    title: "Questions women ask us",
    items: [
      { q: "Can this test tell me if I have PCOS?", a: "Not on its own. PCOS (now being renamed PMOS) is diagnosed by a doctor using your symptoms, cycle history and often testosterone levels and an ultrasound. This panel gives important pieces: your LH/FSH pattern, and it rules out thyroid and prolactin problems that mimic PCOS." },
      { q: "Will AMH tell me how long I can wait to have a baby?", a: "No. AMH estimates how many eggs you have, not their quality or your chance of conceiving. A low result is not a \"no\", and a high result is not a guarantee. It is most useful as part of a planning conversation with your doctor." },
      { q: "Can I take the test while on birth control?", a: "Yes, but hormonal contraception suppresses FSH and LH, so those two results won't reflect your natural levels. Thyroid, prolactin and AMH can still be measured." },
      { q: "Why do I need to fast?", a: "Prolactin can rise after food, exercise or stress. A rested, fasting morning sample gives the most reliable reading." },
      { q: "What should I do after I get my report?", a: "Share it with your gynaecologist or endocrinologist, along with your cycle history and symptoms. Hormone results are always read in context, so please don't self-diagnose from reference ranges." },
    ],
  },
  seo: {
    title: "Hormone & Fertility Panel at Home – 7 Tests @ Rs. 1899 | Dr. Sarwan Diagnostic Labs",
    description: "Is it PCOS, thyroid, or something else? Check FSH, LH, Prolactin, AMH, T3, T4 and TSH with home sample collection and e-report. 7 tests for Rs. 1899. Call 8368143677.",
  },
  book: { sub: "Complete Hormone & Fertility Panel, 7 tests, collected at your doorstep.", meta: "Fasting · Home sample collection · E-report", bar: "Hormone & Fertility Panel · 7 tests" },
};

export function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const testList = (pkg) => String(pkg.tests || "").split(/[,+\n;]/).map((x) => x.trim()).filter(Boolean);

// A plain starting page for a package nobody has written yet (shown in the editor; the AI can fill it properly).
export function defaultPageFor(pkg) {
  const tests = testList(pkg);
  return {
    hero: { kicker: pkg.name, headline: pkg.name, subtitle: "Home sample collection by a trained phlebotomist, with your e-report on WhatsApp.",
      chips: ["Home sample collection", "E-report"], cta: "Book Home Test", badge: "ONLY" },
    questions: { kicker: "Start with your question", title: "Which question brought you here?", intro: "", items: [] },
    stories: { kicker: "What people are talking about right now", title: "", intro: "", items: [], sources: [] },
    canCant: { title: "What this package can, and can't, tell you", can: [], cant: [] },
    tests: { kicker: "What's included", title: tests.length ? `${tests.length} test${tests.length === 1 ? "" : "s"}. One home visit.` : "What's included",
      groups: tests.length ? [{ name: pkg.name, items: tests.map((t) => ({ code: t, name: "", desc: "" })) }] : [] },
    precautions: { nav: "Before the test", kicker: "Get accurate results", title: "Before your test", intro: "", items: [], note: "" },
    faq: { title: "Questions people ask us", items: [] },
    seo: { title: `${pkg.name} at Home | Dr. Sarwan Diagnostic Labs`, description: `${pkg.name} with home sample collection and e-report. Call 8368143677.` },
    book: { sub: `${pkg.name}, collected at your doorstep.`, meta: "Home sample collection · E-report", bar: pkg.name },
  };
}

// ---------------- cleaning what the editor (or the AI) sends ----------------
const str = (v, max = 400) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
const strs = (v, max, len) => arr(v, max).map((x) => str(x, len)).filter(Boolean);
const okUrl = (u) => (/^https?:\/\/[^\s"'<>]{3,500}$/i.test(String(u || "").trim()) ? String(u).trim() : "");
const okIcon = (u) => (/^\/assets\/[a-z0-9_\-./]{1,80}$/i.test(String(u || "")) && !String(u).includes("..") ? String(u) : "");

export function pageFromBody(b) {
  b = b && typeof b === "object" ? b : {};
  const h = b.hero || {}, q = b.questions || {}, st = b.stories || {}, cc = b.canCant || {}, t = b.tests || {}, pr = b.precautions || {}, f = b.faq || {}, seo = b.seo || {}, bk = b.book || {};
  return {
    hero: { kicker: str(h.kicker, 120), headline: str(h.headline, 160), subtitle: str(h.subtitle, 300), chips: strs(h.chips, 5, 40), cta: str(h.cta, 40) || "Book Home Test", badge: str(h.badge, 30) },
    questions: { kicker: str(q.kicker, 80), title: str(q.title, 140), intro: str(q.intro, 400),
      items: arr(q.items, 8).map((x) => ({ title: str(x && x.title, 120), body: str(x && x.body, 500), answered_by: str(x && x.answered_by, 120) })).filter((x) => x.title) },
    stories: { kicker: str(st.kicker, 80), title: str(st.title, 160), intro: str(st.intro, 400), helps_label: str(st.helps_label, 40),
      items: arr(st.items, 8).map((x) => ({ tag: str(x && x.tag, 60), title: str(x && x.title, 160), paras: strs(x && x.paras, 4, 800), helps: str(x && x.helps, 500) })).filter((x) => x.title),
      sources: arr(st.sources, 20).map((x) => ({ label: str(x && x.label, 200), url: okUrl(x && x.url) })).filter((x) => x.label && x.url) },
    canCant: { title: str(cc.title, 140), can: strs(cc.can, 10, 240), cant: strs(cc.cant, 10, 240) },
    tests: { kicker: str(t.kicker, 80), title: str(t.title, 140),
      groups: arr(t.groups, 6).map((g) => ({ name: str(g && g.name, 60),
        items: arr(g && g.items, 40).map((x) => ({ code: str(x && x.code, 40), name: str(x && x.name, 100), desc: str(x && x.desc, 200), icon: okIcon(x && x.icon) })).filter((x) => x.code || x.name) }))
        .filter((g) => g.items.length) },
    precautions: { nav: str(pr.nav, 30), kicker: str(pr.kicker, 80), title: str(pr.title, 140), intro: str(pr.intro, 400),
      items: arr(pr.items, 6).map((x) => ({ big: str(x && x.big, 20), title: str(x && x.title, 100), body: str(x && x.body, 400) })).filter((x) => x.title || x.body),
      note: str(pr.note, 700) },
    faq: { title: str(f.title, 120), items: arr(f.items, 15).map((x) => ({ q: str(x && x.q, 200), a: str(x && x.a, 1000) })).filter((x) => x.q && x.a) },
    seo: { title: str(seo.title, 120), description: str(seo.description, 300) },
    book: { sub: str(bk.sub, 160), meta: str(bk.meta, 100), bar: str(bk.bar, 60) },
  };
}

// ---------------- HTML ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong style="color: #1b2a4e">$1</strong>');
const H2 = "font-family: Archivo, sans-serif; font-weight: 800; font-size: clamp(30px, 3.6vw, 44px); line-height: 1.1";
const KICK = "margin: 0; font-weight: 700; font-size: 14px; letter-spacing: 1.2px; text-transform: uppercase; color: #1f6977";
const kicker = (k) => (k ? `<p style="${KICK}">${esc(k)}</p>` : "");
const rs = (n) => `Rs. ${Number(n || 0) >= 10000 ? Number(n).toLocaleString("en-IN") : Number(n || 0)}`;

function heroHTML(p, pkg) {
  const h = p.hero;
  const head = esc(h.headline || pkg.name).replace(/\[(.+?)\]/g, '<span style="color: #d9533a">$1</span>');
  return `<section style="background: linear-gradient(100deg, #e6f5fd 0%, #c9e8f8 55%, #f59a3c 75%, #f28520 100%); overflow: hidden">
<div style="max-width: 1200px; margin: 0 auto; padding: 56px 24px 0; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 32px">
<div style="flex: 999 1 520px; min-width: 0; padding-bottom: 56px">
${h.kicker ? `<p style="margin: 0 0 14px; font-weight: 700; font-size: 14px; letter-spacing: 1.2px; text-transform: uppercase; color: #1f6977">${esc(h.kicker)}</p>` : ""}
<h1 style="margin: 0; font-family: Archivo, sans-serif; font-weight: 900; font-size: clamp(40px, 5.6vw, 72px); line-height: 1.02; letter-spacing: -1px; color: #1b2a4e">${head}</h1>
${h.subtitle ? `<p style="margin: 28px 0 0; font-size: clamp(19px, 2vw, 24px); line-height: 1.4; max-width: 560px">${esc(h.subtitle)}</p>` : ""}
${h.chips.length ? `<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px">${h.chips.map((c) => `<span style="background: #ffffff; border-radius: 999px; padding: 7px 14px; font-weight: 600; font-size: 14px">${esc(c)}</span>`).join("")}</div>` : ""}
<div style="display: flex; flex-wrap: wrap; gap: 14px; margin-top: 32px">
<a href="#book" style="background: #1f6977; color: #ffffff; text-decoration: none; font-family: Archivo, sans-serif; font-weight: 800; font-size: 18px; padding: 16px 28px; border-radius: 999px; box-shadow: 0 6px 16px rgba(20,70,80,0.25)">${esc(h.cta || "Book Home Test")} · ${rs(pkg.price)}</a>
<a href="tel:8368143677" style="background: #ffffff; color: #1b2a4e; text-decoration: none; font-family: Archivo, sans-serif; font-weight: 700; font-size: 18px; padding: 16px 26px; border-radius: 999px; border: 2px solid #1b2a4e">Call 8368143677</a>
</div>
</div>
<div style="flex: 1 1 340px; min-width: 0; position: relative; display: flex; justify-content: center; align-items: flex-end; min-height: 460px">
<img src="/assets/doctor.png" alt="Smiling woman doctor with arms crossed" style="height: 460px; width: auto; display: block; position: relative; z-index: 1">
<div style="position: absolute; left: 0; bottom: 36px; z-index: 2; width: 200px; height: 200px; border-radius: 50%; background: radial-gradient(circle, #fffbe0 0%, #ffe574 40%, #ffc93a 64%, rgba(255,201,58,0) 72%); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-family: Anton, sans-serif; line-height: 1">
${h.badge ? `<span style="font-size: 17px; color: #0b0b0b">${esc(h.badge)}</span>` : ""}
<span style="font-size: 46px; color: #0b0b0b">${rs(pkg.price)}</span>
</div>
</div>
</div>
</section>`;
}

function questionsHTML(p) {
  const q = p.questions;
  if (!q.items.length) return "";
  return `<section id="questions" style="padding: 88px 24px 40px">
<div style="max-width: 1200px; margin: 0 auto">
${kicker(q.kicker)}
<h2 style="margin: 8px 0 12px; ${H2}">${esc(q.title || "Which question brought you here?")}</h2>
${q.intro ? `<p style="margin: 0 0 36px; max-width: 720px; color: #3b4a68">${esc(q.intro)}</p>` : '<div style="height: 24px"></div>'}
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px">
${q.items.map((x, i) => `<article style="background: ${i % 2 ? "#fdf2ee" : "#f3f9fd"}; border-radius: 20px; padding: 26px; display: flex; flex-direction: column; gap: 12px">
<h3 style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 22px; line-height: 1.2">${esc(x.title)}</h3>
${x.body ? `<p style="margin: 0; color: #3b4a68; font-size: 16px">${esc(x.body)}</p>` : ""}
${x.answered_by ? `<p style="margin: auto 0 0; font-weight: 700; font-size: 14px; color: #1f6977">Answered by: ${esc(x.answered_by)}</p>` : ""}
</article>`).join("\n")}
</div>
</div>
</section>`;
}

function storiesHTML(p) {
  const s = p.stories;
  if (!s.items.length) return "";
  return `<section id="stories" style="padding: 56px 24px 88px">
<div style="max-width: 1200px; margin: 0 auto">
${kicker(s.kicker)}
<h2 style="margin: 8px 0 12px; ${H2}">${esc(s.title)}</h2>
${s.intro ? `<p style="margin: 0 0 36px; max-width: 760px; color: #3b4a68">${esc(s.intro)}</p>` : '<div style="height: 24px"></div>'}
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 22px">
${s.items.map((x) => `<article style="border: 1px solid #dfe8ef; border-radius: 22px; padding: 28px; display: flex; flex-direction: column; gap: 14px">
${x.tag ? `<p style="margin: 0; display: inline-block; align-self: flex-start; background: #fdf2ee; color: #b23f28; font-weight: 700; font-size: 13px; letter-spacing: 0.6px; text-transform: uppercase; border-radius: 999px; padding: 5px 12px">${esc(x.tag)}</p>` : ""}
<h3 style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 24px; line-height: 1.2">${esc(x.title)}</h3>
${x.paras.map((t) => `<p style="margin: 0; color: #3b4a68; font-size: 16px">${esc(t)}</p>`).join("\n")}
${x.helps ? `<div style="background: #f3f9fd; border-radius: 14px; padding: 16px 18px; font-size: 15.5px"><strong style="color: #1f6977">${esc(s.helps_label || "Where this test helps:")}</strong> ${esc(x.helps)}</div>` : ""}
</article>`).join("\n")}
</div>
</div>
</section>`;
}

function canHTML(p) {
  const c = p.canCant;
  if (!c.can.length && !c.cant.length) return "";
  const box = (title, color, list) => (list.length ? `<div style="background: rgba(255,255,255,0.07); border-radius: 20px; padding: 28px">
<h3 style="margin: 0 0 16px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 22px; color: ${color}">${title}</h3>
<ul style="margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 10px">${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
</div>` : "");
  return `<section id="can" style="background: #1b2a4e; color: #ffffff; padding: 80px 24px">
<div style="max-width: 1200px; margin: 0 auto">
<h2 style="margin: 0 0 32px; ${H2}">${esc(c.title || "What this test can, and can't, tell you")}</h2>
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 24px">
${box("It can", "#9fe0d0", c.can)}
${box("It can't", "#ffc6b8", c.cant)}
</div>
</div>
</section>`;
}

// ---------------- "What's included": every package looks like the Female Fertility page ----------------
// Tests with no full name / description get them from Admin → Tests (linked tests), and a package written as one plain
// list is grouped by the tests' categories. Every test gets an icon: the drawn PNGs where we have one, else a line icon by category.
const nt = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const PNG = { amh: "/assets/icon4.png", fsh: "/assets/icon1.png", lh: "/assets/icon2.png", prl: "/assets/icon3.png", prolactin: "/assets/icon3.png",
  t3: "/assets/icon5.png", t4: "/assets/icon6.png", tsh: "/assets/icon7.png" };
const ICON_PATHS = {
  hormone: '<circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.8 2.8M16.2 16.2L19 19M5 19l2.8-2.8M16.2 7.8L19 5"/>',
  thyroid: '<path d="M7 5c-2.5 1-3.5 4-3 7s2 6 4.5 6 3-2.5 3.5-5h0c.5 2.5 1 5 3.5 5S19.5 15 20 12s-.5-6-3-7c-2-.8-3.5 1-5 3-1.5-2-3-3.8-5-3z"/>',
  sugar: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/><path d="M9 14h6M12 11v6"/>',
  liver: '<path d="M3 9c0-3 3-5 8-5 6 0 10 2 10 5 0 4-4 9-9 9-2 0-3-1-4-2-3-1-5-3-5-7z"/><path d="M11 4v8"/>',
  kidney: '<path d="M9 3C5 3 3 7 3 11s2 9 6 9c3 0 3-3 2-5-1-1.5-1-3.5 0-5 1-2 1-7-2-7z"/><path d="M15 6c2 0 6 2 6 6s-4 6-6 6"/>',
  heart: '<path d="M12 20s-8-4.6-8-10.5A4.5 4.5 0 0112 7a4.5 4.5 0 018 2.5C20 15.4 12 20 12 20z"/><path d="M4 12h4l2-3 3 6 2-3h5"/>',
  vitamin: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-35 12 12)"/><path d="M10.3 7.7l6 6"/>',
  blood: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 15a2.5 2.5 0 002.5 2.5"/>',
  infection: '<circle cx="12" cy="12" r="5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5L19 19M5 19l3.5-3.5M15.5 8.5L19 5"/>',
  marker: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/>',
  pregnancy: '<circle cx="12" cy="5" r="2.5"/><path d="M10 9c-1.5 2-1.5 5 0 7v5M14 9c3 1 4 4 2.5 6.5-1 1.5-2.5 2-4.5 1.5"/>',
  urine: '<path d="M8 3h8M9 3v4l-3 4v8a2 2 0 002 2h8a2 2 0 002-2v-8l-3-4V3"/><path d="M6 14h12"/>',
  allergy: '<path d="M12 3c3 3 3 6 0 9s-3 6 0 9M7 6c2 2 2 4 0 6M17 12c2 2 2 4 0 6"/>',
  lab: '<path d="M9 3h6M10 3v6L5 18a2 2 0 002 3h10a2 2 0 002-3l-5-9V3"/><path d="M7.5 14h9"/>',
};
const iconKey = (cat, label) => {
  const t = (String(cat || "") + " " + String(label || "")).toLowerCase();
  return /thyro|tsh|\bt3\b|\bt4\b/.test(t) ? "thyroid" : /fertil|hormone|estro|estra|progest|testost|cortisol|lh\b|fsh|amh|prolactin/.test(t) ? "hormone"
    : /diabet|glucose|sugar|hba1c|insulin/.test(t) ? "sugar" : /liver|lft|bilirubin|sgot|sgpt|alt\b|ast\b/.test(t) ? "liver"
    : /kidney|renal|creatinine|urea|kft|uric/.test(t) ? "kidney" : /heart|lipid|cholest|cardiac|triglycer|crp|apo/.test(t) ? "heart"
    : /vitamin|mineral|iron|calcium|ferritin|b12|\bd3\b/.test(t) ? "vitamin" : /blood count|cbc|haemo|hemo|platelet|esr|blood group/.test(t) ? "blood"
    : /infect|hiv|hbsag|hcv|vdrl|viral|dengue|typhoid/.test(t) ? "infection" : /cancer|psa|cea|ca 1|ca-1|ca 12|marker/.test(t) ? "marker"
    : /pregnan|antenatal|beta hcg|nipt|double|triple/.test(t) ? "pregnancy" : /urine/.test(t) ? "urine" : /allerg|ige/.test(t) ? "allergy" : "lab";
};
function enrichTests(t, linked, pkg) {
  if (!t.groups.length || !linked || !linked.length) return t;
  const find = (x) => { const a = nt(x.code), b = nt(x.name);
    return linked.find((l) => [l.code, l.name, ...String(l.also_called || "").split(/[,;/]/)].map(nt).filter(Boolean).some((v) => v === a || v === b))
      || linked.find((l) => a && a.length > 2 && nt(l.name).includes(a)); };
  const short = (s) => { s = String(s || "").replace(/\s+/g, " ").trim(); const m = /^(.{20,110}?[.;])(\s|$)/.exec(s); s = m ? m[1] : s;
    if (s.length > 90) s = s.slice(0, 88).replace(/\s+\S*$/, "") + "…"; return s.replace(/[.;]$/, ""); };
  const fill = (x) => { const l = find(x); if (!l) return { ...x };
    // auto-made items (only a short name): show the catalogue's code, e.g. "PRL · Prolactin"; hand-written items keep their code
    const code = (!x.name && l.code) || x.code || l.code || "";
    const full = String(l.name || "").replace(/\s*\(([^)]*)\)\s*/g, (m, inner) => ([nt(code), nt(x.code)].includes(nt(inner)) ? " " : m)).trim();
    return { ...x, code: code || full, name: x.name || (nt(full) !== nt(code) ? full : ""), desc: x.desc || short(l.purpose), cat: l.category || "" }; };
  let groups = t.groups.map((g) => ({ ...g, items: g.items.map(fill) }));
  // one plain group named after the package (an auto-made page): split it by the tests' categories
  if (groups.length === 1 && nt(groups[0].name) === nt(pkg.name)) {
    const by = new Map();
    for (const x of groups[0].items) { const k = x.cat || "Tests"; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
    if (by.size > 1 && by.size <= 6) groups = [...by].map(([name, items]) => ({ name, items }));
    else groups = [{ name: by.size === 1 && [...by.keys()][0] !== "Tests" ? [...by.keys()][0] : groups[0].name, items: groups[0].items }];
  }
  return { ...t, groups };
}

function testsHTML(p, linked, pkg) {
  const t = enrichTests(p.tests, linked, pkg || {});
  if (!t.groups.length) return "";
  const colors = [["#f3f9fd", "#1f6977"], ["#fdf2ee", "#b23f28"]];
  const icon = (x, c, g) => { const png = x.icon || PNG[nt(x.code)] || PNG[nt(x.name)];
    return png ? `<img src="${esc(png)}" alt="" style="width: 52px; height: 40px; object-fit: contain; flex: none">`
      : `<svg aria-hidden="true" viewBox="0 0 24 24" style="width: 52px; height: 40px; flex: none" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[iconKey(x.cat || g.name, (x.code || "") + " " + (x.name || ""))]}</svg>`; };
  return `<section id="tests" style="padding: 88px 24px">
<div style="max-width: 1200px; margin: 0 auto">
${kicker(t.kicker)}
<h2 style="margin: 8px 0 36px; ${H2}">${esc(t.title || "What's included")}</h2>
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 24px">
${t.groups.map((g, i) => { const [bg, c] = colors[i % 2]; return `<div style="background: ${bg}; border-radius: 22px; padding: 28px">
${g.name ? `<h3 style="margin: 0 0 18px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.5px; text-transform: uppercase; color: ${c}">${esc(g.name)}</h3>` : ""}
<div style="display: flex; flex-direction: column; gap: 16px">
${g.items.map((x) => `<div style="display: flex; align-items: center; gap: 14px">${icon(x, c, g)}<div><strong style="font-family: Archivo, sans-serif; font-size: 18px">${esc(x.code || x.name)}</strong>${x.code && x.name ? " · " + esc(x.name) : ""}${x.desc ? `<br><span style="color: #3b4a68; font-size: 15px">${esc(x.desc)}</span>` : ""}</div></div>`).join("\n")}
</div>
</div>`; }).join("\n")}
</div>
</div>
</section>`;
}

function precautionsHTML(p) {
  const r = p.precautions;
  if (!r.items.length && !r.note) return "";
  const colors = ["#d9533a", "#1f6977", "#f28520"];
  return `<section id="timing" style="background: #e6f5fd; padding: 88px 24px">
<div style="max-width: 1200px; margin: 0 auto">
${kicker(r.kicker)}
<h2 style="margin: 8px 0 12px; ${H2}">${esc(r.title || "Before your test")}</h2>
${r.intro ? `<p style="margin: 0 0 36px; max-width: 720px; color: #3b4a68">${esc(r.intro)}</p>` : '<div style="height: 24px"></div>'}
${r.items.length ? `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px">
${r.items.map((x, i) => `<div style="background: #ffffff; border-radius: 20px; padding: 26px">
${x.big ? `<p style="margin: 0; font-family: Anton, sans-serif; font-size: 40px; line-height: 1; color: ${colors[i % 3]}">${esc(x.big)}</p>` : ""}
${x.title ? `<h3 style="margin: 10px 0 8px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 20px">${esc(x.title)}</h3>` : ""}
${x.body ? `<p style="margin: 0; color: #3b4a68; font-size: 16px">${esc(x.body)}</p>` : ""}
</div>`).join("\n")}
</div>` : ""}
${r.note ? `<div style="margin-top: 22px; background: #ffffff; border-radius: 16px; padding: 18px 22px; font-size: 16px; color: #3b4a68">${bold(r.note)}</div>` : ""}
</div>
</section>`;
}

const HOW = (fasting) => `<section style="padding: 88px 24px">
<div style="max-width: 1200px; margin: 0 auto">
<h2 style="margin: 0 0 36px; ${H2}">How it works</h2>
<ol style="margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px">
${[["Book online or call", "Pick a time between 7 AM and 6 PM and pay online. Or call 8368143677 / WhatsApp 9818028755."],
  [fasting ? "Fasting sample at home" : "Sample collected at home", fasting ? "A trained phlebotomist collects your sample at your doorstep after an overnight fast." : "A trained phlebotomist collects your sample at your doorstep."],
  ["Get your e-report", "Receive your report digitally on WhatsApp and take it to your doctor."]]
  .map(([t, d], i) => `<li style="border: 1px solid #dfe8ef; border-radius: 20px; padding: 26px"><span style="display: inline-flex; width: 44px; height: 44px; border-radius: 50%; background: #1f6977; color: #ffffff; align-items: center; justify-content: center; font-family: Archivo, sans-serif; font-weight: 800; font-size: 20px">${i + 1}</span><h3 style="margin: 16px 0 8px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 20px">${t}</h3><p style="margin: 0; color: #3b4a68; font-size: 16px">${d}</p></li>`).join("\n")}
</ol>
</div>
</section>`;

function faqHTML(p) {
  const f = p.faq;
  if (!f.items.length) return "";
  return `<section id="faq" style="background: #f7fafc; padding: 88px 24px">
<div style="max-width: 860px; margin: 0 auto">
<h2 style="margin: 0 0 28px; ${H2}">${esc(f.title || "Questions people ask us")}</h2>
<div style="display: flex; flex-direction: column; gap: 12px">
${f.items.map((x) => `<details style="background: #ffffff; border-radius: 16px; padding: 20px 24px"><summary style="display: flex; justify-content: space-between; align-items: center; gap: 16px; font-family: Archivo, sans-serif; font-weight: 700; font-size: 19px">${esc(x.q)}<span class="faq-plus" aria-hidden="true" style="font-size: 26px; color: #1f6977; transition: transform 0.2s">+</span></summary><p style="margin: 14px 0 0; color: #3b4a68">${esc(x.a)}</p></details>`).join("\n")}
</div>
</div>
</section>`;
}

const isFasting = (pkg, p) => p.hero.chips.some((c) => /fasting/i.test(c))
  || (/fast/i.test(String(pkg.prep || "")) && !/no fasting|fasting (is )?not (needed|required)|no need to fast/i.test(String(pkg.prep || "")));

// FAQ rich results for Google
function faqLd(p) {
  if (!p.faq.items.length) return "";
  const ld = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: p.faq.items.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) };
  return `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
}

// Draw a package page into the home page's layout (index.html from the static assets).
// opts: { canonical: absolute URL, preview: true when shown inside the admin editor }
export async function renderPackagePage(env, req, pkg, page, opts = {}) {
  const p = pageFromBody(page);
  const base = await env.ASSETS.fetch(new Request(new URL("/", req.url), { method: "GET" }));
  if (!base.ok) return base;
  const fasting = isFasting(pkg, p);
  const body = [heroHTML(p, pkg), questionsHTML(p), storiesHTML(p), canHTML(p), testsHTML(p, opts.linked, pkg), precautionsHTML(p), HOW(fasting), faqHTML(p)].filter(Boolean).join("\n\n");
  const has = { "#questions": !!p.questions.items.length, "#tests": !!p.tests.groups.length, "#timing": !!(p.precautions.items.length || p.precautions.note), "#faq": !!p.faq.items.length };
  const title = p.seo.title || `${pkg.name} at Home – ${rs(pkg.price)} | Dr. Sarwan Diagnostic Labs`;
  const desc = p.seo.description || `${pkg.name} with home sample collection and e-report. Call 8368143677.`;
  const srcs = p.stories.sources;
  let inserted = false;
  const rw = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", desc); } })
    .on('meta[property="og:title"]', { element(el) { el.setAttribute("content", title); } })
    .on('meta[property="og:description"]', { element(el) { el.setAttribute("content", desc); } })
    .on('link[rel="canonical"]', { element(el) { el.setAttribute("href", opts.canonical || "https://drsarwantests.com/"); } })
    .on('meta[property="og:url"]', { element(el) { el.setAttribute("content", opts.canonical || "https://drsarwantests.com/"); } })
    .on("head", { element(el) { el.append(faqLd(p), { html: true }); if (opts.preview) el.append('<meta name="robots" content="noindex">', { html: true }); } })
    .on("a.navlink", { element(el) {
      const h = el.getAttribute("href") || "";
      if (h in has && !has[h]) el.remove();
      else if (h === "#timing") el.setInnerContent(p.precautions.nav || "Before the test");
    } })
    .on("section", { element(el) {
      if (el.getAttribute("id") === "book") { if (!inserted) { el.before(body + "\n\n", { html: true }); inserted = true; } return; }
      el.remove();
    } })
    .on('[data-pk="book-sub"]', { element(el) { el.setInnerContent(p.book.sub || `${pkg.name}, collected at your doorstep.`); } })
    .on('[data-pk="book-price"]', { element(el) { el.setInnerContent(rs(opts.formPrice ?? pkg.price)); } })
    .on('[data-pk="book-meta"]', { element(el) { el.setInnerContent(p.book.meta || (fasting ? "Fasting · " : "") + "Home sample collection · E-report"); } })
    .on('[data-pk="bar"]', { element(el) {
      el.setInnerContent(`<span class="hide-sm">${esc(p.book.bar || pkg.name)} · </span><span style="font-family: Anton, sans-serif; font-size: 22px; font-weight: 400">${rs(pkg.price)}</span>`, { html: true });
    } })
    .on('[data-pk="slot-hint"]', { element(el) { el.setInnerContent(fasting ? "(7 AM – 6 PM · fasting: pick a morning slot)" : "(7 AM – 6 PM)"); } })
    .on('[data-pk="done-note"]', { element(el) {
      el.setInnerContent(fasting ? "We'll confirm your slot on WhatsApp. Please fast for 10–12 hours overnight before your slot (water is fine)." : "We'll confirm your slot on WhatsApp and send you how to prepare.");
    } })
    .on("#booker", { element(el) { el.setAttribute("data-package", String(pkg.id)); if (opts.preview) el.setAttribute("data-preview", "1"); } })
    .on('[data-pk="sources"]', { element(el) {
      if (!srcs.length) { el.remove(); return; }
      el.setInnerContent(`<p style="margin: 0 0 6px; font-weight: 700; color: #1b2a4e">Sources</p><ul style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px">${srcs.map((s) => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul>`, { html: true });
    } })
    .on('[data-pk="disclaimer"]', { element(el) { el.setInnerContent("These tests support, but do not replace, a consultation with a qualified doctor. Results should be interpreted by your doctor alongside your symptoms and history."); } });
  const out = rw.transform(base);
  const headers = new Headers(out.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", opts.preview ? "no-store" : "public, max-age=60");
  headers.delete("etag"); headers.delete("content-length");
  return new Response(out.body, { status: 200, headers });
}

// ---------------- AI: write a section (or all of them) with Claude ----------------
const S = (props, req) => ({ type: "object", additionalProperties: false, required: req || Object.keys(props), properties: props });
const T = (d) => ({ type: "string", description: d });
const L = (items, d) => ({ type: "array", items, description: d });
export const SECTION_SCHEMAS = {
  hero: S({ kicker: T("short label above the headline, e.g. 'Complete Thyroid Profile · 3 tests'"),
    headline: T("the main question the visitor is asking themselves, max ~9 words; wrap 1-3 key words in [square brackets] to colour them"),
    subtitle: T("one sentence: what the test settles, at home, with one sample"), chips: L(T(""), "2-4 very short facts, e.g. 'Fasting sample', 'Home sample collection', 'E-report'"),
    cta: T("button text, usually 'Book Home Test'"), badge: T("short text above the price in the round badge, e.g. 'TOTAL 7 TESTS @' or 'ONLY'") }),
  questions: S({ kicker: T(""), title: T("e.g. 'Which question brought you here?'"), intro: T("one sentence"),
    items: L(S({ title: T("a worry in the visitor's own words, phrased as a question"), body: T("2 sentences: what may cause it and how these tests help"), answered_by: T("test codes from THIS package that answer it, separated by ' · '") }), "3-4 questions") }),
  stories: S({ kicker: T(""), title: T(""), intro: T("one sentence"),
    items: L(S({ tag: T("short label like 'Trending: …', 'Debated: …', 'Viral: …', 'Common worry: …'"), title: T("headline question"),
      paras: L(T(""), "1-2 short paragraphs with the facts, citing the study / body by name"), helps: T("how this package helps – starts lower-case, completes 'Where this test helps: …'") }), "3-4 stories that people are discussing right now, checked against evidence"),
    sources: L(S({ label: T("publisher: title (year)"), url: T("the exact URL you read") }), "the real web pages the stories rely on") }),
  canCant: S({ title: T("e.g. 'What this panel can, and can't, tell you'"), can: L(T(""), "4-5 things the tests can show"), cant: L(T(""), "3-4 honest limits") }),
  tests: S({ kicker: T(""), title: T("short punchy title, e.g. '7 tests. Two systems. One sample.'"),
    groups: L(S({ name: T("group name, e.g. 'Thyroid & metabolism'"), items: L(S({ code: T("short code as on the report, e.g. TSH"), name: T("full name"), desc: T("what it shows, max 8 words") }), "") }), "1-3 groups covering EVERY test in the package") }),
  precautions: S({ nav: T("2-3 word menu label, e.g. 'Before the test' or 'When to test'"), kicker: T(""), title: T("e.g. 'Before your test'"), intro: T("one sentence"),
    items: L(S({ big: T("very short big label, e.g. '10–12 hrs', 'Morning', 'Day 2–5'"), title: T("what it applies to"), body: T("the instruction and why, 1-2 sentences") }), "3 key precautions / timing rules"),
    note: T("one extra line for special cases (medicines, pregnancy, contraception…); wrap lead-ins in **double stars**") }),
  faq: S({ title: T(""), items: L(S({ q: T(""), a: T("2-4 sentences") }), "5-6 questions people really ask about these tests") }),
  seo: S({ title: T("page title under 65 characters, include the package name and price"), description: T("meta description under 155 characters, include 'home sample collection' and 8368143677") }),
};

const RULES = `You write landing-page sections for Dr. Sarwan Diagnostic Labs (drsarwantests.com), a diagnostic lab in India offering home sample collection with e-reports on WhatsApp. Phone (calls): 8368143677. WhatsApp: 9818028755.
Rules:
- Medically accurate and evidence-based. Never promise a diagnosis or cure, never scare people, never invent statistics, studies or prices.
- Only say a test shows something if it really measures it. Be honest about limits.
- Plain, warm Indian English (gynaecologist, haemoglobin), short sentences, no emojis, no exclamation marks, no hype.
- Write for the people who usually book this package (infer from the tests); speak to them as "you".
- Prices come from the package and are added by the website – don't write prices except in the SEO title.
- Answer only by calling the page_content tool once, filling every field you were asked for.`;

// cfg: { url, key, model }. section: one of PAGE_SECTIONS or "all".
export async function aiGeneratePage(cfg, pkg, section, instructions, current) {
  const secs = section === "all" ? PAGE_SECTIONS : [section];
  if (!secs.every((s) => SECTION_SCHEMAS[s])) throw new Error("Unknown section");
  const schema = S(Object.fromEntries(secs.map((s) => [s, SECTION_SCHEMAS[s]])));
  const research = secs.includes("stories");
  const facts = [`Package: ${pkg.name}`, `Tests included: ${pkg.tests || pkg.name}`, `Price: Rs. ${pkg.price}${pkg.mrp ? ` (MRP Rs. ${pkg.mrp})` : ""}`,
    pkg.target ? `Who it's for: ${pkg.target}` : "", pkg.prep ? `Preparation we tell patients:\n${pkg.prep}` : "", `Home collection hours: 7 AM to 6 PM.`].filter(Boolean).join("\n");
  const example = JSON.stringify(Object.fromEntries(secs.map((s) => [s, HORMONE_PAGE[s]])));
  const cur = current && typeof current === "object" ? JSON.stringify(Object.fromEntries(secs.map((s) => [s, current[s]]).filter(([, v]) => v))) : "";
  const prompt = `${facts}

Write the ${secs.length > 1 ? "sections " + secs.join(", ") : `"${section}" section`} of this package's landing page.
Style example – the same sections written for our Hormone & Fertility Panel (match the tone, length and structure, NOT the content):
${example.slice(0, 9000)}
${cur && cur.length > 30 ? `\nWhat the page says now (improve on it; keep anything that is good):\n${cur.slice(0, 6000)}` : ""}
${research ? `\nFor "stories": use web search to find 3-4 things people are discussing right now (${new Date().getUTCFullYear()}) about these tests or the conditions they check – news, new guidelines, viral claims, common myths – especially in India. Check each against reliable sources and list the pages you used in "sources" with their exact URLs.` : ""}
${instructions ? `\nExtra instructions from our team: ${String(instructions).slice(0, 1000)}` : ""}`;

  const tools = [{ name: "page_content", description: "The finished landing-page content.", input_schema: schema }];
  const run = async (withSearch) => {
    const t = withSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, ...tools] : tools;
    const messages = [{ role: "user", content: prompt }];
    for (let turn = 0; turn < 4; turn++) {
      const r = await fetch(`${cfg.url}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model, max_tokens: section === "all" ? 12000 : 5000, system: RULES, tools: t, tool_choice: { type: "auto" }, messages }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.type === "error") { const e = new Error((j.error && j.error.message) || `AI request failed (${r.status})`); e.status = r.status; throw e; }
      const use = (j.content || []).find((c) => c.type === "tool_use" && c.name === "page_content");
      if (use && use.input) return use.input;
      const txt = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      const m = /\{[\s\S]*\}/.exec(txt);
      if (m) { try { const o = JSON.parse(m[0]); if (secs.some((s) => o[s])) return o; } catch {} }
      if (j.stop_reason === "pause_turn" || j.stop_reason === "end_turn") {
        messages.push({ role: "assistant", content: j.content });
        if (j.stop_reason === "end_turn") messages.push({ role: "user", content: "Now call the page_content tool with the finished content." });
        continue;
      }
      break;
    }
    throw new Error("The AI didn't return the page content. Please try again.");
  };
  let out;
  try { out = await run(research); }
  catch (e) { if (research && e.status === 400) out = await run(false); else throw e; } // web search not enabled for this key → write without it
  const clean = pageFromBody(out);
  return Object.fromEntries(secs.map((s) => [s, clean[s]]));
}
