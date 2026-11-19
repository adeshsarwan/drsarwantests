// Home page ("/"): our story (timeline) first, then the packages – each card opens /package/<slug>.
// Content is JSON in settings key "home_page", edited in Admin → Packages → "Edit home page". Package cards come live from Packages.

export const HOME_DEFAULT = {
  hero: {
    badge: "Since 2015",
    title: "From one radiology centre to diagnostics across India",
    text: "Dr. Sarwan Diagnostic Labs began in 2015 as a radiology centre. Today we run multi-specialty diagnostic centres and collection centres across the country, and collect samples at your home with reports on WhatsApp.",
    cta: "See our packages",
  },
  stats: [
    { big: "NABL", small: "Accredited lab" },
    { big: "CGHS", small: "Approved centre" },
    { big: "2015", small: "Serving patients since" },
    { big: "7 AM – 6 PM", small: "Home sample collection" },
  ],
  story: {
    title: "Our journey",
    intro: "Each step added a specialty, and each specialty kept the same rule: accurate results, explained simply.",
    items: [
      { year: "2015", title: "Radiology centre opens", text: "We start as a diagnostic lab with radiology." },
      { year: "", title: "Multi-specialty diagnostics", text: "Pathology and more specialties join radiology under one roof." },
      { year: "", title: "NABL accredited", text: "Our lab is assessed against national quality standards." },
      { year: "", title: "CGHS approved", text: "Approved to serve Central Government Health Scheme members." },
      { year: "Today", title: "Collection centres across India", text: "Home sample collection from 7 AM to 6 PM, with reports on WhatsApp." },
    ],
  },
  packages: { title: "Health packages", intro: "Sample collected at home. Each package page explains exactly what it can, and can't, tell you." },
  features: [
    { title: "Home collection", text: "A trained phlebotomist visits at the time you choose, between 7 AM and 6 PM. You get WhatsApp updates at each step." },
    { title: "Pay online, securely", text: "Book in a minute and pay by UPI, card or net banking. Your slot is confirmed as soon as you pay." },
    { title: "Reports on WhatsApp", text: "Your report comes to you digitally, and you can open it any time in My reports with your mobile number and date of birth." },
  ],
  seo: {
    title: "Dr. Sarwan Diagnostic Labs – NABL & CGHS approved, home sample collection",
    description: "Diagnostic labs since 2015: radiology, pathology and health packages with home sample collection from 7 AM to 6 PM and e-reports on WhatsApp. Call 9818028755.",
  },
};

const str = (v, max = 400) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
export function homeFromBody(b) {
  b = b && typeof b === "object" ? b : {};
  const h = b.hero || {}, s = b.story || {}, p = b.packages || {}, seo = b.seo || {};
  return {
    hero: { badge: str(h.badge, 40), title: str(h.title, 160), text: str(h.text, 500), cta: str(h.cta, 40) || "See our packages" },
    stats: arr(b.stats, 6).map((x) => ({ big: str(x && x.big, 20), small: str(x && x.small, 60) })).filter((x) => x.big),
    story: { title: str(s.title, 100), intro: str(s.intro, 300),
      items: arr(s.items, 12).map((x) => ({ year: str(x && x.year, 12), title: str(x && x.title, 100), text: str(x && x.text, 300) })).filter((x) => x.title) },
    packages: { title: str(p.title, 100), intro: str(p.intro, 300) },
    features: arr(b.features, 6).map((x) => ({ title: str(x && x.title, 60), text: str(x && x.text, 300) })).filter((x) => x.title),
    seo: { title: str(seo.title, 120), description: str(seo.description, 300) },
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rs = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const testCount = (t) => { const m = /(\d+)\s*tests?/i.exec(String(t || "")); if (m) return Number(m[1]); const n = String(t || "").split(/[,+;\n]/).filter((x) => x.trim()).length; return n; };
const PHONE_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"></path></svg>';
const COLORS = ["#1f6977", "#1f6977", "#c2410c", "#c2410c", "#1b2a4e", "#1f6977", "#c2410c"];

// pkgs: [{ name, slug, price, mrp, tests, page }] – only packages with a published page
export function renderHome(home, pkgs, opts = {}) {
  const h = homeFromBody(home);
  const title = h.seo.title || "Dr. Sarwan Diagnostic Labs";
  const desc = h.seo.description || "";
  const cards = pkgs.map((p) => {
    let pg = {}; try { pg = JSON.parse(p.page || "{}"); } catch {}
    const hero = pg.hero || {}, n = testCount(p.tests);
    const line = hero.subtitle || p.tests || "";
    const tag = hero.kicker ? String(hero.kicker).split("·")[0].trim() : "Home collection";
    return `<article style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 18px; padding: 24px; display: flex; flex-direction: column; gap: 12px">
<span style="align-self: flex-start; font-size: 12.5px; font-weight: 800; color: #1f6977; background: #e6f3f1; border-radius: 999px; padding: 3px 10px">${esc(tag)}</span>
<h3 style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 21px; line-height: 1.2">${esc(String(hero.headline || p.name).replace(/\[|\]/g, ""))}</h3>
<p style="margin: 0; color: #3b4a68; line-height: 1.5; font-size: 15px">${esc(line)}</p>
<div style="display: flex; align-items: baseline; gap: 10px; margin-top: auto; flex-wrap: wrap"><b style="font-family: Archivo, sans-serif; font-size: 26px">${rs(p.price)}</b>${p.mrp && p.mrp > p.price ? `<s style="color: #8492a6; font-size: 15px">${rs(p.mrp)}</s>` : ""}<span style="color: #5a6880; font-size: 14px">${esc(p.name)}${n > 1 ? ` · ${n} tests` : ""}</span></div>
<a href="/package/${esc(p.slug)}" style="min-height: 44px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: #1f6977; color: #ffffff; text-decoration: none; font-weight: 700">See what it shows &amp; book</a>
</article>`;
  }).join("\n");
  const ld = { "@context": "https://schema.org", "@type": "MedicalOrganization", name: "Dr. Sarwan Diagnostic Labs", url: "https://drsarwantests.com/", telephone: "+91-9818028755",
    address: { "@type": "PostalAddress", streetAddress: "Shop 37-38, Vardhaman Crown Mall, Sector 19, Dwarka", addressLocality: "New Delhi", postalCode: "110078", addressCountry: "IN" } };
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
.tl{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
@media (max-width:760px){.navlink{display:none !important}.hero-h{font-size:38px !important}}
</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<div style="font-family: Figtree, system-ui, sans-serif; color: #1b2a4e; font-size: 16px; line-height: 1.55">

<header style="background: #ffffff; border-bottom: 1px solid #e3edf3; position: sticky; top: 0; z-index: 20">
<div style="max-width: 1180px; margin: 0 auto; padding: 12px 24px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px">
<a href="/"><img src="/assets/logo.png" alt="Dr. Sarwan Diagnostic Labs" style="height: 52px; width: auto; display: block"></a>
<nav aria-label="Main" style="display: flex; flex-wrap: wrap; align-items: center; gap: 22px; font-weight: 600; font-size: 15px">
<a class="navlink" href="#story" style="color: #1b2a4e; text-decoration: none">Our story</a>
<a class="navlink" href="#packages" style="color: #1b2a4e; text-decoration: none">Packages</a>
<a class="navlink" href="/reports/" style="color: #1b2a4e; text-decoration: none">My reports</a>
<a class="navlink" href="tel:9818028755" style="color: #1b2a4e; text-decoration: none; display: inline-flex; align-items: center; gap: 6px">${PHONE_SVG}9818028755</a>
<a href="#packages" style="background: #1f6977; color: #ffffff; text-decoration: none; padding: 11px 20px; border-radius: 999px; min-height: 44px; display: inline-flex; align-items: center">Book a home test</a>
</nav>
</div>
</header>

<section style="background: #f4f7fa">
<div style="max-width: 1180px; margin: 0 auto; padding: 72px 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 48px; align-items: center">
<div style="display: flex; flex-direction: column; gap: 20px">
${h.hero.badge ? `<span style="align-self: flex-start; font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #1f6977; background: #e6f3f1; border-radius: 999px; padding: 5px 12px">${esc(h.hero.badge)}</span>` : ""}
<h1 class="hero-h" style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 52px; line-height: 1.05">${esc(h.hero.title)}</h1>
${h.hero.text ? `<p style="margin: 0; font-size: 19px; line-height: 1.55; color: #3b4a68">${esc(h.hero.text)}</p>` : ""}
<div style="display: flex; gap: 12px; flex-wrap: wrap">
<a href="#packages" style="min-height: 48px; display: inline-flex; align-items: center; padding: 0 22px; border-radius: 999px; background: #1f6977; color: #ffffff; text-decoration: none; font-weight: 700">${esc(h.hero.cta)}</a>
<a href="tel:9818028755" style="min-height: 48px; display: inline-flex; align-items: center; gap: 8px; padding: 0 22px; border-radius: 999px; border: 1.5px solid #1f6977; color: #1f6977; text-decoration: none; font-weight: 700">${PHONE_SVG}Call 9818028755</a>
</div>
</div>
${h.stats.length ? `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px">
${h.stats.map((s) => `<div style="background: #ffffff; border: 1px solid #e1e8ee; border-radius: 18px; padding: 22px"><div style="font-family: Archivo, sans-serif; font-weight: 800; font-size: ${s.big.length > 6 ? 24 : 34}px; line-height: 1.15">${esc(s.big)}</div><div style="color: #5a6880; margin-top: 4px">${esc(s.small)}</div></div>`).join("\n")}
</div>` : ""}
</div>
</section>

${h.story.items.length ? `<section id="story" aria-labelledby="story-h">
<div style="max-width: 1180px; margin: 0 auto; padding: 72px 24px; display: flex; flex-direction: column; gap: 32px">
<div style="max-width: 640px"><h2 id="story-h" style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 36px">${esc(h.story.title || "Our journey")}</h2>
${h.story.intro ? `<p style="margin: 10px 0 0; color: #3b4a68; font-size: 17px; line-height: 1.55">${esc(h.story.intro)}</p>` : ""}</div>
<ol class="tl">
${h.story.items.map((t, i) => { const c = COLORS[i % COLORS.length]; return `<li style="border-top: 4px solid ${c}; background: #f8fafb; border-radius: 0 0 16px 16px; padding: 18px; display: flex; flex-direction: column; gap: 8px">
${t.year ? `<span style="font-family: Archivo, sans-serif; font-weight: 800; font-size: 26px; color: ${c}">${esc(t.year)}</span>` : `<span aria-hidden="true" style="width: 14px; height: 14px; border-radius: 50%; background: ${c}; margin: 8px 0 4px"></span>`}
<b style="font-size: 17px">${esc(t.title)}</b>
${t.text ? `<span style="color: #3b4a68; line-height: 1.5; font-size: 15px">${esc(t.text)}</span>` : ""}
</li>`; }).join("\n")}
</ol>
</div>
</section>` : ""}

<section id="packages" aria-labelledby="pk-h" style="background: #f4f7fa">
<div style="max-width: 1180px; margin: 0 auto; padding: 72px 24px; display: flex; flex-direction: column; gap: 28px">
<div><h2 id="pk-h" style="margin: 0; font-family: Archivo, sans-serif; font-weight: 800; font-size: 36px">${esc(h.packages.title || "Health packages")}</h2>
${h.packages.intro ? `<p style="margin: 8px 0 0; color: #3b4a68">${esc(h.packages.intro)}</p>` : ""}</div>
${cards ? `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 18px">\n${cards}\n</div>`
  : '<p style="margin: 0; color: #3b4a68">Our packages are being updated. Please call <a href="tel:9818028755">9818028755</a> to book.</p>'}
</div>
</section>

${h.features.length ? `<section>
<div style="max-width: 1180px; margin: 0 auto; padding: 64px 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 24px">
${h.features.map((f) => `<div><h3 style="margin: 0 0 6px; font-family: Archivo, sans-serif; font-weight: 800; font-size: 19px">${esc(f.title)}</h3><p style="margin: 0; color: #3b4a68; line-height: 1.5">${esc(f.text)}</p></div>`).join("\n")}
</div>
</section>` : ""}

<footer style="background: #1b2a4e; color: #d6deea">
<div style="max-width: 1180px; margin: 0 auto; padding: 36px 24px; display: flex; flex-direction: column; gap: 12px; font-size: 14px">
<b style="color: #ffffff; font-family: Archivo, sans-serif; font-size: 17px">Dr. Sarwan Diagnostic Labs</b>
<span>Shop 37–38, Vardhaman Crown Mall, Sector 19, Dwarka, New Delhi 110078 · <a href="tel:9818028755" style="color: #d6deea">9818028755</a></span>
<span style="display: flex; gap: 16px; flex-wrap: wrap"><a href="/contact" style="color: #d6deea">Contact us</a><a href="/privacy" style="color: #d6deea">Privacy Policy</a><a href="/service" style="color: #d6deea">Terms of Service</a><a href="/refund" style="color: #d6deea">Refunds</a><a href="/delivery" style="color: #d6deea">Delivery</a><a href="/reports/" style="color: #d6deea">My reports</a></span>
<span style="color: #9fb0c8">© Dr. Sarwan Diagnostic Labs</span>
</div>
</footer>
</div>
</body>
</html>`;
}
