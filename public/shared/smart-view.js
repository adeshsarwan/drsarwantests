// Smart report view – draws the smart report JSON (built by src/smart.js) as HTML.
// Used by the patient portal (/reports/) and by the admin's Preview. Everything is scoped under .smr.
(function (root) {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (typeof n === 'number' ? String(Math.round(n * 1000) / 1000) : esc(n));
  const rng = (r) => r.range_text && r.low == null && r.high == null ? esc(r.range_text)
    : r.low == null && r.high != null ? `below ${fmt(r.high)}` : r.high == null && r.low != null ? `above ${fmt(r.low)}` : r.low != null ? `${fmt(r.low)} – ${fmt(r.high)}` : '';
  const CHIP = { ok: ['Normal', 'ok'], high: ['High', 'fl'], low: ['Low', 'fl'], info: ['See note', 'in'], pending: ['Pending', 'in'] };
  const ARW = { high: ' ↑', low: ' ↓' };

  const css = `
.smr{font-family:Figtree,system-ui,sans-serif;color:#1b2a4e;font-size:16px;line-height:1.5}
.smr *{box-sizing:border-box}
.smr h1,.smr h2,.smr h3,.smr h4{font-family:Archivo,sans-serif;margin:0;line-height:1.25}
.smr .s-card{background:#fff;border:1px solid #e1e8ee;border-radius:18px;padding:20px;margin-top:16px;box-shadow:0 6px 20px rgba(27,42,78,.05)}
.smr .s-kick{font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1f6977}
.smr .s-smr-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.smr .s-verified{display:inline-flex;align-items:center;gap:6px;background:#e8f5ec;color:#15803d;font-weight:700;font-size:13px;padding:6px 12px;border-radius:999px;white-space:nowrap}
.smr .s-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:14px;font-size:14px;color:#5a6880}
.smr .s-meta b{display:block;color:#1b2a4e;font-weight:600}
.smr .s-glance{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
.smr .s-glance div{border-radius:14px;padding:14px}
.smr .s-glance strong{font-family:Archivo,sans-serif;font-size:30px;display:block;line-height:1.1}
.smr .s-g-ok{background:#e8f5ec;color:#15803d}.smr .s-g-fl{background:#fff1e8;color:#c2410c}
.smr .s-sum p{margin:6px 0 10px;color:#3b4a68}
.smr .s-key{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:12px}
.smr .s-key li{border-left:4px solid #f59e0b;background:#fffbeb;border-radius:0 12px 12px 0;padding:12px 14px}
.smr .s-key li.high{border-color:#c2410c;background:#fffaf6}
.smr .s-key b{display:block}.smr .s-key span{font-size:15px;color:#3b4a68}
.smr .s-good{margin-top:12px;padding:12px 14px;background:#f0f9f3;border-radius:12px;font-size:15px;color:#14532d}
.smr .s-ai{margin-top:14px;font-size:13px;color:#5a6880;border-top:1px dashed #e1e8ee;padding-top:12px}
.smr .s-pkg{display:inline-flex;background:#e6f3f1;color:#1f6977;font-weight:700;font-size:13px;padding:5px 12px;border-radius:999px;margin-top:8px}
.smr .s-qcard{border:1px solid #e1e8ee;border-radius:14px;padding:14px;margin-top:12px}
.smr .s-qcard h4{margin:0 0 6px;font-size:17px}.smr .s-qcard p{margin:0;font-size:15px;color:#3b4a68}
.smr .s-verdict{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px;color:#15803d}
.smr .s-verdict.discuss{color:#c2410c}.smr .s-verdict.missing{color:#5a6880}
.smr .s-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.smr .s-pill{font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;background:#e8f5ec;color:#15803d}
.smr .s-pill.fl{background:#fff1e8;color:#c2410c}.smr .s-pill.in,.smr .s-pill.miss{background:#eef1f5;color:#5a6880}.smr .s-pill.miss{border:1px dashed #c3ccd8}
.smr .s-claims{list-style:none;margin:10px 0 0;padding:0}.smr .s-claims li{display:flex;gap:10px;padding:10px 0;border-top:1px dashed #e1e8ee;font-size:15px;color:#3b4a68}
.smr .s-claims i{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:13px;font-weight:800;background:#e8f5ec;color:#15803d;margin-top:1px}
.smr .s-claims li.discuss i{background:#fff7ed;color:#c2410c}.smr .s-claims li.missing i{background:#eef1f5;color:#5a6880}.smr .s-claims b{color:#1b2a4e}
.smr .s-lst{margin:8px 0 0;padding-left:20px;color:#3b4a68;font-size:15px}.smr .s-lst li{margin:6px 0}
.smr .s-grp{margin-top:18px}.smr .s-grp header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:6px}
.smr .s-grp h3{font-size:19px}
.smr .s-chip{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap;background:#e8f5ec;color:#15803d}
.smr .s-chip.fl{background:#fff1e8;color:#c2410c}.smr .s-chip.in{background:#eef1f5;color:#5a6880}
.smr .s-tests{list-style:none;margin:0;padding:0}
.smr .s-t{padding:14px 0;border-top:1px dashed #e1e8ee}
.smr .s-t-top{display:flex;justify-content:space-between;gap:12px}
.smr .s-t-top b{display:block}.smr .s-t-top span{font-size:14px;color:#5a6880}
.smr .s-v{text-align:right;white-space:nowrap}.smr .s-v strong{font-family:Archivo,sans-serif;font-size:20px;display:block;color:#15803d}.smr .s-v small{color:#5a6880;font-size:13px}
.smr .s-t.high .s-v strong,.smr .s-t.low .s-v strong{color:#c2410c}.smr .s-t.info .s-v strong,.smr .s-t.pending .s-v strong{color:#1b2a4e}
.smr .s-bar{position:relative;height:8px;border-radius:99px;background:#e9eef3;margin:10px 0 8px}
.smr .s-band{position:absolute;left:30%;width:40%;top:0;bottom:0;background:#bfe5cb;border-radius:99px}
.smr .s-bar em{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.25);background:#16a34a}
.smr .s-t.high .s-bar em,.smr .s-t.low .s-bar em{background:#c2410c}
.smr .s-t-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;color:#5a6880}
.smr .s-note{margin:6px 0 0;font-size:13px;color:#1f6977}
.smr details.s-more summary{cursor:pointer;color:#1f6977;font-weight:700;padding:12px 0 2px;list-style:none}
.smr details.s-more summary::-webkit-details-marker{display:none}
.smr .missing{margin-top:14px;background:#f4f7fa;border-radius:12px;padding:12px 14px;font-size:14px;color:#3b4a68}
.smr .s-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.smr .s-sbtn{min-height:48px;display:flex;align-items:center;justify-content:center;border-radius:999px;font-weight:700;text-decoration:none;text-align:center;padding:0 12px;font:inherit;font-weight:700;cursor:pointer;border:0}
.smr .s-b1{background:#c2410c;color:#fff}.smr .s-b2{border:1.5px solid #1f6977;color:#1f6977;background:#fff}
.smr .s-pdfs{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.smr .s-fine{font-size:13px;color:#5a6880;margin-top:18px;text-align:center}
@media (max-width:420px){.smr .s-card{padding:16px}.smr .s-btns{grid-template-columns:1fr}}
`;

  function row(r) {
    const [lab, cls] = CHIP[r.status] || CHIP.info;
    const val = r.value != null ? fmt(r.value) : esc(r.value_text);
    return `<li class="s-t ${esc(r.status)}">
<div class="s-t-top"><div><b>${esc(r.name)}</b>${r.plain ? `<span>${esc(r.plain)}</span>` : ''}</div><div class="s-v"><strong>${val}${ARW[r.status] || ''}</strong><small>${esc(r.unit)}</small></div></div>
${r.pos != null ? `<div class="s-bar" aria-hidden="true"><i class="s-band"></i><em style="left:${r.pos}%"></em></div>` : ''}
<div class="s-t-foot"><span class="s-chip ${cls}">${lab}</span>${rng(r) ? `<span>Normal: ${rng(r)} ${r.range_text && r.low == null && r.high == null ? '' : esc(r.unit)}</span>` : ''}</div>
${r.note ? `<p class="s-note">${esc(r.note)}</p>` : ''}</li>`;
  }
  function group(g) {
    const fl = g.items.filter((r) => r.status === 'high' || r.status === 'low').length;
    let show = g.items, rest = [];
    if (g.items.length > 6) { const keep = Math.max(fl, 3); show = g.items.slice(0, keep); rest = g.items.slice(keep); }
    return `<section class="s-grp"><header><h3>${esc(g.name)}</h3><span class="s-chip ${fl ? 'fl' : ''}">${fl ? `${fl} to discuss` : 'All normal'}</span></header>
<ul class="s-tests">${show.map(row).join('')}</ul>
${rest.length ? `<details class="s-more"><summary>Show ${rest.length} more value${rest.length === 1 ? '' : 's'}</summary><ul class="s-tests">${rest.map(row).join('')}</ul></details>` : ''}</section>`;
  }
  const pill = (p) => `<span class="s-pill ${p.status === 'high' || p.status === 'low' ? 'fl' : p.status === 'ok' ? '' : 'in'}">${esc(p.name)} ${typeof p.value === 'number' ? fmt(p.value) : esc(p.value)}${ARW[p.status] || ''}</span>`;
  const VERD = { discuss: 'Something to discuss', ok: 'Normal in these tests', missing: 'Not in this report' };
  const CLAIM_IC = { ok: '✓', discuss: '!', missing: '–' };

  // opts: { logo, doctorHref, pdfs: [{ id, name }], pdfAttr: 'data-rid', banner }
  function html(d, opts) {
    opts = opts || {};
    const p = d.patient || {}, c = d.counts || { total: 0, ok: 0, flagged: 0 }, sm = d.summary || {};
    const pdfs = opts.pdfs || d.files || [];
    const attr = opts.pdfAttr || 'data-rid';
    return `<div class="smr">
${opts.banner ? `<div style="background:#fff7ed;color:#9a3412;font-size:13px;font-weight:600;text-align:center;padding:8px 12px;border-radius:12px">${esc(opts.banner)}</div>` : ''}
<div class="s-card">
<div class="s-smr-top"><div><span class="s-kick">Your smart report</span><h1 style="font-size:24px">${esc(p.name || p.booked_name)}</h1></div><span class="s-verified">✓ Verified</span></div>
<div class="s-meta">
${p.age || p.gender ? `<div>Age / gender<b>${esc([p.age, p.gender].filter(Boolean).join(' · '))}</b></div>` : ''}
${p.collected ? `<div>Sample collected<b>${esc(p.collected)}</b></div>` : ''}
${p.reported ? `<div>Report ready<b>${esc(p.reported)}</b></div>` : ''}
${p.barcode ? `<div>Barcode<b>${esc(p.barcode)}</b></div>` : `<div>Booking<b>${esc(d.booking)}</b></div>`}
</div>
<div class="s-glance"><div class="s-g-ok"><strong>${c.ok}</strong>of ${c.total} values in the normal range</div><div class="s-g-fl"><strong>${c.flagged}</strong>value${c.flagged === 1 ? '' : 's'} outside the range to discuss</div></div>
</div>

<div class="s-card s-sum"><span class="s-kick">In plain words</span><h2 style="font-size:20px;margin-top:4px">${c.flagged ? 'What stands out in this report' : 'Your results at a glance'}</h2>
${sm.intro ? `<p>${esc(sm.intro)}</p>` : ''}
${(sm.points || []).length ? `<ul class="s-key">${sm.points.map((x) => `<li class="${esc(x.level)}"><b>${esc(x.title)}</b><span>${esc(x.text)}</span></li>`).join('')}</ul>` : ''}
${sm.normal ? `<div class="s-good"><b>In the normal range:</b> ${esc(sm.normal)}</div>` : ''}
<div class="s-ai">✨ Written with AI from your lab report and checked by our team before sending. It explains your results; it isn't a diagnosis.</div>
</div>

${(d.questions || []).length || (d.claims || []).length ? `<div class="s-card"><span class="s-kick">The questions you booked for</span><h2 style="font-size:20px;margin-top:4px">Your answers, question by question</h2>
${(d.packages || []).map((n) => `<span class="s-pkg">${esc(n)}</span>`).join(' ')}
${(d.questions || []).map((q) => `<div class="s-qcard"><span class="s-verdict ${esc(q.verdict)}">${VERD[q.verdict] || ''}</span><h4>${esc(q.q)}</h4><p>${esc(q.answer)}</p>
${(q.pills || []).length || (q.missing || []).length ? `<div class="s-pills">${(q.pills || []).map(pill).join('')}${(q.missing || []).map((m) => `<span class="s-pill miss">${esc(m)}: not in report</span>`).join('')}</div>` : ''}</div>`).join('')}
${(d.claims || []).length ? `<h3 style="font-size:17px;margin-top:22px">What we said this package would check</h3><ul class="s-claims">${d.claims.map((x) => `<li class="${esc(x.status)}"><i>${CLAIM_IC[x.status] || '✓'}</i><span><b>${esc(x.claim.replace(/[.:]$/, ''))}:</b> ${esc(x.text)}</span></li>`).join('')}</ul>` : ''}
${(d.cant || []).length ? `<h3 style="font-size:17px;margin-top:20px">What these results can't tell you</h3><ul class="s-lst">${d.cant.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
</div>` : ''}

<div class="s-card"><span class="s-kick">Your results</span>
${(d.groups || []).map(group).join('')}
${(d.not_in_report || []).length ? `<div class="missing"><b>Not in this report yet:</b> ${d.not_in_report.map(esc).join(', ')}. If you expected ${d.not_in_report.length === 1 ? 'it' : 'them'}, WhatsApp us on 98180 28755.</div>` : ''}
</div>

${(d.lab_notes || []).length ? `<div class="s-card"><span class="s-kick">Notes from the lab</span><ul class="s-lst">${d.lab_notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}

<div class="s-card"><span class="s-kick">For your doctor's visit</span>
${(d.doctor_questions || []).length ? `<h3 style="font-size:19px;margin-top:4px">Questions you could ask</h3><ol class="s-lst">${d.doctor_questions.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
<div class="s-btns">
<a class="s-sbtn s-b1" href="${esc(opts.doctorHref || '#')}" target="_blank" rel="noopener">Talk to a doctor · ₹299</a>
${pdfs.length === 1 ? `<button type="button" class="s-sbtn s-b2" ${attr}="${pdfs[0].id}">Download lab PDF</button>` : ''}
</div>
${pdfs.length > 1 ? `<div class="s-pdfs">${pdfs.map((f) => `<button type="button" class="s-sbtn s-b2" ${attr}="${f.id}">📄 ${esc(String(f.name).replace(/\.pdf$/i, ''))}</button>`).join('')}</div>` : ''}
</div>
<p class="s-fine">Tested at Dr. Sarwan Diagnostic Labs · NABL accredited (MC-6975) · CGHS approved · ISO 9001:2015<br>All lab results need to be read by a qualified doctor. This summary doesn't replace their advice.</p>
</div>`;
  }
  root.DSLSmart = { css, html, esc };
})(typeof window !== 'undefined' ? window : globalThis);
