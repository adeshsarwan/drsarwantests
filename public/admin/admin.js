(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------- helpers ----------
  let KEY = '';
  try { KEY = sessionStorage.getItem('dsl_admin') || ''; } catch (e) {}
  const pref = {
    get(k, d) { try { const v = localStorage.getItem('dsl_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dsl_' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ist = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const istMin = () => { const d = new Date(Date.now() + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const fmt = (d, o) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', ...o });
  const fmtD = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const dowMon = (d) => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
  const monthStart = (d) => d.slice(0, 8) + '01';
  const monthEnd = (d) => { const x = new Date(d.slice(0, 8) + '01T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
  const addMonths = (d, n) => { const x = new Date(d.slice(0, 8) + '01T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const slotMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmtT = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const slotLabel = (t) => `${fmtT(slotMin(t))} – ${fmtT(slotMin(t) + 30)}`;
  const SLOTS = []; for (let m = 360; m < 660; m += 30) SLOTS.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const isPast = (date, slot) => { const t = ist(); return date < t || (date === t && slotMin(slot) <= istMin()); };
  const fullAddr = (b) => [b.address, b.city, b.state].filter(Boolean).join(', ') + (b.pincode ? ` – ${b.pincode}` : '');
  const mapUrl = (b) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([b.address, b.city, b.state, b.pincode].filter(Boolean).join(', '));
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const ST = {
    pending: { label: 'Awaiting payment', fg: '#8a5a00', bg: '#fff4d6', stripe: '#e9a23b', tag: 'Awaiting payment' },
    payment_submitted: { label: 'Paid – verify', fg: '#a33a1f', bg: '#ffe3d9', stripe: '#e2603f', tag: 'Paid · verify' },
    confirmed: { label: 'Confirmed', fg: '#17694a', bg: '#dff3ea', stripe: '#1f8a6a', tag: 'Confirmed' },
    collected: { label: 'Collected – report pending', fg: '#2a4a8a', bg: '#e6ecfb', stripe: '#4c6fd8', tag: 'Collected' },
    report_ready: { label: 'Report ready – send', fg: '#5b2d8a', bg: '#f1e8fb', stripe: '#8a55c9', tag: 'Report ready' },
    completed: { label: 'Completed', fg: '#3b4a68', bg: '#e9edf2', stripe: '#6b7686', tag: 'Completed ✓' },
    no_show: { label: 'Patient not available', fg: '#9b1c31', bg: '#fbe4e6', stripe: '#c2334d', tag: 'Not available' },
    cancelled: { label: 'Cancelled', fg: '#5a6880', bg: '#f1f3f5', stripe: '#b8c1cc', tag: 'Cancelled' },
    expired: { label: 'Expired (unpaid)', fg: '#5a6880', bg: '#f1f3f5', stripe: '#b8c1cc', tag: 'Expired' },
    blocked: { label: 'Blocked', fg: '#ffffff', bg: '#2b2f36', stripe: '#2b2f36', tag: 'Blocked' },
  };
  const OCCUPY = ['payment_submitted', 'confirmed', 'collected', 'report_ready', 'completed', 'no_show', 'blocked'];
  const PAID = ['payment_submitted', 'confirmed', 'collected', 'report_ready', 'completed', 'no_show'];
  const MOVABLE = ['pending', 'payment_submitted', 'confirmed', 'expired', 'no_show'];
  const CANCELLABLE = ['pending', 'payment_submitted', 'confirmed', 'expired', 'no_show'];
  const live = (b) => !['cancelled', 'expired'].includes(b.status);
  const revenue = (list) => list.reduce((a, b) => a + (PAID.includes(b.status) ? b.amount || 0 : 0) + (b.fee_paid_at ? b.fee_due || 0 : 0), 0);

  function srcLabel(src) {
    if (!src) return 'Website';
    if (src === 'admin') return 'Added by admin';
    const p = new URLSearchParams(src);
    if (p.get('gclid') || /google/i.test(p.get('utm_source') || '')) return 'Google Ads' + (p.get('utm_content') ? ' · ' + p.get('utm_content') : '');
    return p.get('utm_source') || 'Website';
  }

  function toast(m, action) {
    const t = $('#toast');
    t.innerHTML = esc(m) + (action ? ` <button type="button" class="btn ghost sm" style="margin-left:10px;min-height:28px;padding:2px 10px">${esc(action.label)}</button>` : '');
    if (action) t.querySelector('button').onclick = () => { t.style.display = 'none'; action.fn(); };
    t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = 'none'), action ? 7000 : 2600);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-admin-key': KEY, ...(opts.headers || {}) } });
    if (r.status === 401 || r.status === 503) { const j = await r.json().catch(() => ({})); logout(); throw new Error(j.error || 'Wrong password'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.code = j.code; throw e; }
    return j;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

  // ---------- state ----------
  let data = null; // bookings tab (last 90 days → next 14)
  let CFG = { amount: 1899, upiId: '', visitFee: 300, dates: [] };
  const cal = {
    view: pref.get('view', 'week'), anchor: ist(), mm: monthStart(ist()), sel: null, data: null,
    filters: new Set(pref.get('filters2', ['payment_submitted', 'pending', 'confirmed', 'collected', 'report_ready', 'completed', 'no_show'])),
  };
  let tab = pref.get('tab', 'bookings');
  let PKGS = [];
  let detailId = null;

  const findB = (id) => (cal.data && cal.data.bookings.find((b) => b.id === id)) || (data && data.bookings.find((b) => b.id === id));

  // ---------- auth ----------
  function logout() { KEY = ''; try { sessionStorage.removeItem('dsl_admin'); } catch (e) {} $('#app').hidden = true; $('#login').hidden = false; }
  $('#logout').onclick = logout;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault(); KEY = $('#pw').value.trim(); $('#loginErr').textContent = '';
    try { await refreshAll(); try { sessionStorage.setItem('dsl_admin', KEY); } catch (e2) {} $('#login').hidden = true; $('#app').hidden = false; showTab(tab); }
    catch (err) { $('#loginErr').textContent = err.message; }
  };
  fetch('/api/config').then((r) => r.json()).then((c) => (CFG = { ...CFG, ...c })).catch(() => {});

  // ---------- tabs ----------
  function showTab(name) {
    tab = name; pref.set('tab', name);
    $$('.tab').forEach((t) => (t.getAttribute('data-tab') === name ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
    $('#view-bookings').hidden = name !== 'bookings';
    $('#view-calendar').hidden = name !== 'calendar';
    $('#view-tests').hidden = name !== 'tests';
    if (name === 'calendar') loadCal().catch((e) => toast(e.message));
    if (name === 'tests') loadPkgs().catch((e) => toast(e.message));
  }
  $$('.tab').forEach((t) => (t.onclick = () => showTab(t.getAttribute('data-tab'))));

  async function refreshAll() {
    await Promise.all([load(), loadPkgs().catch(() => {})]);
    if (tab === 'calendar' || cal.data) await loadCal();
    if (detailId && $('#detailDlg').open) { const b = findB(detailId); if (b) $('#detailBody').innerHTML = detailHTML(b); }
    else if (slotOpen && $('#detailDlg').open && cal.data) $('#detailBody').innerHTML = slotListHTML(slotOpen.date, slotOpen.slot);
    if (repId && $('#repDlg').open) renderRepDlg();
    if (stepsId && $('#stepsDlg').open) { const b = findB(stepsId); if (b) $('#stepsBody').innerHTML = stepsPopHTML(b); }
  }

  // ================= WORKFLOW (shared by list, calendar, detail) =================
  // kind → latest time. "done:<kind>" rows are steps ticked by hand (sent outside the system); sentMap(b).manual says which.
  const sentMap = (b) => {
    const m = {}, man = {};
    String(b.msgs || '').split(',').filter(Boolean).forEach((x) => {
      const i = x.indexOf('@'); let k = x.slice(0, i); const at = x.slice(i + 1);
      const hand = k.startsWith('done:'); if (hand) k = k.slice(5);
      if (!m[k] || at > m[k]) { m[k] = at; man[k] = hand; }
    });
    Object.defineProperty(m, 'manual', { value: man, enumerable: false });
    return m;
  };
  const hasPaidProof = (b) => !!(b.has_proof || b.utr);
  const testsOf = (b) => (b.tests && b.tests.length ? b.tests : b.package_name ? [{ name: b.package_name, package_id: b.package_id, price: b.amount, margin: null }] : []);
  const testNames = (b) => testsOf(b).map((t) => t.name).join(', ');
  const pkgFor = (t) => PKGS.find((p) => p.id === t.package_id);
  const reportsOf = (b) => b.reports || [];
  const marginOf = (b) => { const t = testsOf(b); return t.reduce((a, x) => a + (x.margin || 0), 0) - (t.reduce((a, x) => a + (x.price || 0), 0) - (b.amount || 0)); };
  const CALL_LINE = '• Our phlebotomist will call you before arriving';
  // "Before the test" for all the booking's tests together (no repeats; fasting wins over "no fasting")
  const prepOf = (b) => {
    const lines = []; let call = !testsOf(b).some(pkgFor);
    testsOf(b).forEach((t) => {
      const p = pkgFor(t);
      String(p ? p.prep || '' : '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { if (/phlebotomist will call/i.test(l)) call = true; else if (!lines.includes(l)) lines.push(l); });
    });
    const fasting = lines.some((l) => /^•?\s*fast for/i.test(l));
    const out = lines.filter((l) => !(fasting && /no fasting needed/i.test(l)));
    if (call) out.push(CALL_LINE);
    return out.join('\n');
  };
  const testLine = (b) => (testsOf(b).length ? `<span class="test-l">🧪 ${esc(testNames(b))}</span>` : '');
  const PAID_LIKE = ['confirmed', 'collected', 'report_ready', 'completed'];
  const AFTER_COLLECT = ['collected', 'report_ready', 'completed'];

  // The process, step by step (also drives the "next step" button everywhere).
  // msg = the WhatsApp message a step sends (those steps can be skipped or ticked as done by hand).
  function steps(b) {
    const s = b.status, sent = sentMap(b), reps = reportsOf(b), nSent = reps.filter((r) => r.sent_at).length;
    const W = (kind, label, ghost) => `<button type="button" class="btn ${ghost ? 'ghost' : 'wa'} sm" data-act="wa" data-kind="${kind}" data-id="${b.id}">${label}</button>`;
    const unpaid = ['pending', 'expired'].includes(s);
    const M = (key, msg, label, btn) => ({ key, msg, label, btn, cls: 'wa', done: !!sent[msg], hand: !!sent.manual[msg], at: sent[msg], avail: PAID_LIKE.includes(s),
      act: W(msg, btn), again: W(msg, 'Resend', true) });
    const vialBtn = b.vial_no ? `<button type="button" class="btn ghost sm" data-act="vial-edit" data-id="${b.id}">Edit vial</button>`
      : `<button type="button" class="btn sm" data-act="vial-edit" data-id="${b.id}">Add vial no.</button>`;
    return [
      { key: 'pay', label: 'Payment confirmed', done: PAID_LIKE.includes(s), at: b.paid_at, avail: s === 'payment_submitted' || unpaid,
        act: s === 'payment_submitted' || (unpaid && hasPaidProof(b))
          ? `<button type="button" class="btn sm" data-act="status" data-id="${b.id}" data-st="confirmed">Confirm payment</button>${b.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${b.id}">Screenshot</button>` : ''}`
          : W('pay', 'Payment reminder') },
      M('confirm', 'confirm', 'Booking confirmation sent to patient', 'Send confirmation'),
      M('center', 'center', `Booking sent to collection centre (${CFG.centerPhone || '8368143677'})`, 'Send to centre'),
      M('reminder', 'reminder', 'Visit reminder sent to patient', 'Send reminder'),
      { key: 'collect', label: AFTER_COLLECT.includes(s) ? (b.vial_no ? `Sample collected · vial ${b.vial_no}` : 'Sample collected · ⚠ vial no. missing') : 'Sample collected (enter vial no.)',
        btn: 'Sample collected', cls: 'blue', done: AFTER_COLLECT.includes(s), at: b.collected_at, avail: s === 'confirmed',
        act: `<button type="button" class="btn blue sm" data-act="collect" data-id="${b.id}">Sample collected</button>`, again: vialBtn },
      { ...M('received', 'collected', '"Sample received at lab" sent to patient', 'Send to patient'), avail: AFTER_COLLECT.includes(s) },
      { key: 'upload', label: reps.length ? `${reps.length} report${reps.length === 1 ? '' : 's'} uploaded` : 'Reports uploaded', btn: 'Upload reports', cls: 'purple',
        done: reps.length > 0, at: reps.length ? reps[reps.length - 1].created_at : null, avail: AFTER_COLLECT.includes(s),
        act: `<button type="button" class="btn purple sm" data-act="reports" data-id="${b.id}">Upload reports</button>`, again: `<button type="button" class="btn ghost sm" data-act="reports" data-id="${b.id}">Add more</button>` },
      { key: 'send', label: reps.length ? `Reports sent to patient (${nSent} of ${reps.length})` : 'Reports sent to patient', btn: 'Send reports', cls: 'wa',
        done: s === 'completed' || (reps.length > 0 && nSent === reps.length), at: b.completed_at, avail: reps.length > 0,
        act: `<button type="button" class="btn wa sm" data-act="reports" data-id="${b.id}">Send reports</button>`, again: `<button type="button" class="btn ghost sm" data-act="reports" data-id="${b.id}">Resend</button>` },
    ];
  }
  // Steps with where the booking really is: a message step left undone before a later finished step is "skipped",
  // and the next step is the first one after that (so a forgotten reminder doesn't hold the booking back).
  const NO_FLOW = ['cancelled', 'no_show', 'blocked'];
  function flow(b) {
    const all = steps(b);
    let last = -1; all.forEach((st, i) => { if (st.done) last = i; });
    all.forEach((st, i) => { st.skipped = !st.done && !!st.msg && i < last; });
    const cur = all.find((st) => !st.done && !st.skipped && st.avail) || null;
    return { all, cur };
  }
  // can this step be done from the steps pop-up right now? (later steps open once the patient has paid)
  const canDo = (b, st) => st.key === 'pay' || ['payment_submitted', ...PAID_LIKE].includes(b.status);
  // The one most useful next action for a booking
  function nextStep(b) {
    if (b.status === 'cancelled' || b.status === 'blocked') return '';
    if (b.status === 'no_show') return `<button type="button" class="btn dark sm" data-act="move" data-id="${b.id}">Rebook (${money(b.fee_due || CFG.visitFee)} fee)</button>`;
    if (b.status === 'completed') return '<span class="m-ok">Done ✓</span>';
    const { cur } = flow(b);
    return cur ? cur.act : '';
  }
  // small icon (steps done, e.g. 4/8) that opens every step in a pop-up
  const STEPS_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3.5h1.5M2 8h1.5M2 12.5h1.5M6 3.5h8M6 8h8M6 12.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
  function stepsBtn(b) {
    if (NO_FLOW.includes(b.status)) return '';
    const { all } = flow(b), n = all.filter((st) => st.done).length, sk = all.filter((st) => st.skipped).length;
    return `<button type="button" class="stp-ic${sk ? ' sk' : ''}" data-act="steps" data-id="${b.id}" title="All steps${sk ? ` · ${sk} skipped` : ''} – click to do any step" aria-label="All steps, ${n} of ${all.length} done${sk ? `, ${sk} skipped` : ''}">${STEPS_SVG}<span>${n}/${all.length}</span></button>`;
  }
  const nextBar = (b) => `<div class="nx">${nextStep(b)}${stepsBtn(b)}</div>`;
  const vialWarn = (b) => (AFTER_COLLECT.includes(b.status) && !b.vial_no ? `<button type="button" class="vial miss" data-act="vial-edit" data-id="${b.id}" title="Add the vial number">⚠ vial no. missing</button>` : '');

  // compact progress for the booking panel: dots + the next step + "All steps"
  function stepsCompact(b) {
    if (NO_FLOW.includes(b.status)) return '';
    const { all, cur } = flow(b), sk = all.filter((st) => st.skipped).length, i = cur ? all.indexOf(cur) : -1;
    const dots = all.map((st) => `<i class="${st.done ? 'd' : st.skipped ? 's' : st === cur ? 'c' : ''}" title="${esc(st.label)}${st.skipped ? ' – skipped' : ''}"></i>`).join('');
    const head = cur ? `<small>Next · step ${i + 1} of ${all.length}</small><b>${esc(cur.label)}</b>` : b.status === 'completed' ? '<b>All done ✓</b>' : '<b>Waiting for payment</b>';
    return `<div class="stc"><div class="stc-dots">${dots}</div>
<div class="stc-row"><div class="stc-t">${head}${sk ? `<small class="m-skip">${sk} step${sk === 1 ? '' : 's'} skipped</small>` : ''}</div>
<div class="stc-a">${cur ? cur.act : ''}<button type="button" class="btn ghost sm" data-act="steps" data-id="${b.id}">${STEPS_SVG} All steps</button></div></div></div>`;
  }

  // the pop-up: every step, with the option to do any later one
  function stepsPopHTML(b) {
    const { all, cur } = flow(b), unpaid = ['pending', 'expired'].includes(b.status);
    const note = b.status === 'payment_submitted' ? 'Payment isn’t verified yet. Doing a later step also marks the payment as verified.'
      : unpaid ? 'Payment not received yet. The later steps open once the payment is confirmed.'
      : 'Forgot to tick something? You can do any step directly – steps left out are marked skipped. Already done outside the system? Tick it with “Mark done”.';
    const rows = all.map((st, i) => {
      const locked = !st.done && !canDo(b, st);
      const cls = st.done ? 'done' : st.skipped ? 'skip' : st === cur ? 'cur' : locked ? 'wait' : '';
      const sub = st.done ? (st.at ? when(st.at) + (st.hand ? ' · ticked by hand' : '') : '') : st.skipped ? 'Skipped' : locked ? 'After payment' : '';
      const doBtn = `<button type="button" class="btn ${st === cur ? st.cls : 'ghost'} sm" data-act="step" data-key="${st.key}" data-id="${b.id}">${st.skipped ? 'Do it now' : st.btn}</button>`;
      const markBtn = st.msg ? `<button type="button" class="btn ghost sm" data-act="step-mark" data-kind="${st.msg}" data-id="${b.id}">Mark done</button>` : '';
      const acts = st.done ? (st.hand ? `<button type="button" class="btn ghost sm" data-act="step-unmark" data-kind="${st.msg}" data-id="${b.id}">Undo</button>` : st.again || '')
        : locked ? '' : st.key === 'pay' ? st.act : doBtn + markBtn;
      return `<li class="stp ${cls}"><span class="n" aria-hidden="true">${st.done ? '✓' : st.skipped ? '↷' : i + 1}</span>
<div class="t"><b>${esc(st.label)}</b>${sub ? `<small>${sub}</small>` : ''}</div><div class="a">${acts}</div></li>`;
    }).join('');
    return `<div class="dlg-h"><b>Steps · ${esc(b.name)}</b><div class="meta">${esc(b.id)} · ${fmtD(b.date)}, ${esc(slotLabel(b.slot))} · <span class="pill st-${b.status}" style="margin:0">${ST[b.status].label}</span></div></div>
<div class="dlg-b"><p class="meta" style="margin:0 0 10px">${note}</p><ol class="steps">${rows}</ol></div>`;
  }
  let stepsId = null;
  function openSteps(id) {
    const b = findB(id); if (!b) return;
    stepsId = id; $('#stepsBody').innerHTML = stepsPopHTML(b);
    $$('dialog[open]').forEach((x) => x !== $('#stepsDlg') && x.close());
    if (!$('#stepsDlg').open) $('#stepsDlg').showModal();
  }
  // do a step from the pop-up; earlier steps it needs are done first (payment verified, sample collected)
  async function runStep(id, key) {
    let b = findB(id); if (!b) return;
    const needsSample = ['received', 'upload', 'send'].includes(key) && !AFTER_COLLECT.includes(b.status);
    if (key === 'collect' || needsSample) { openVial(id, false, key === 'collect' ? null : key); return; }
    if (b.status === 'payment_submitted') {
      if (!confirm(`${b.name}'s payment isn't verified yet.\n\nMark the payment as verified and continue?`)) return;
      try { await post(`/api/admin/bookings/${id}/status`, { status: 'confirmed' }); await refreshAll(); b = findB(id); }
      catch (e) { toast(e.message); return; }
    }
    if (key === 'upload' || key === 'send') { openReports(id); return; }
    sendWa(id, key === 'received' ? 'collected' : key);
  }
  async function markStep(id, kind, undo) {
    try {
      await post(`/api/admin/bookings/${id}/sent`, undo ? { kind: 'undo-done', target: kind } : { kind: 'done:' + kind });
      await refreshAll();
      if (undo) toast('Step un-ticked');
      else toast(`${MSG[kind]} ticked as done`, { label: 'Undo', fn: () => markStep(id, kind, true) });
    } catch (e) { toast(e.message); }
  }

  // ---------- WhatsApp messages ----------
  const MSG = {
    pay: 'Payment reminder', confirm: 'Booking confirmation', center: 'Booking details to collection centre', reminder: 'Visit reminder', slots: 'Suggest new slots',
    missed: 'Missed visit · fee & new slots', collected: 'Sample received at lab', report: 'Reports', chat: 'Open chat',
  };
  const NEEDS_SLOTS = ['slots', 'missed'];
  const dayWord = (d) => (d === ist() ? 'today' : d === addDays(ist(), 1) ? 'tomorrow' : 'on ' + fmtD(d));

  function msgText(b, kind, sug, files) {
    const hi = `Hi ${b.name.split(' ')[0]} 👋`;
    const sign = '— Dr. Sarwan Diagnostic Labs · 8368143677';
    const list = (sug || []).map((s, i) => `${i + 1}) ${fmtD(s.date)}, ${slotLabel(s.slot)}`).join('\n');
    const tests = testNames(b) || 'home blood test';
    switch (kind) {
      case 'pay': return [hi, `We received your request for *${tests}* on *${fmtD(b.date)}, ${slotLabel(b.slot)}*, but your payment hasn't reached us yet.`, '',
        `Your slot is reserved only after payment. Please pay *${money(b.amount || CFG.amount)}* by UPI to *${CFG.upiId || 'our UPI ID'}* and reply here with the payment screenshot.`, '',
        'Want a different time? Just reply here.', sign].join('\n');
      case 'confirm': return confirmText(b);
      case 'center': return ['📋 *New home collection* – Dr. Sarwan Diagnostic Labs', '',
        `Ref: ${b.id}`, `Patient: ${b.name} · +91 ${b.phone}`, `Date: ${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`, `Time: ${slotLabel(b.slot)}`,
        `Address: ${fullAddr(b)}`, `Map: ${mapUrl(b)}`, `Tests: ${tests}`, b.notes ? `Notes: ${b.notes}` : null, '', 'Please confirm the visit. 🙏'].filter((x) => x !== null).join('\n');
      case 'reminder': return [hi, `Reminder: our phlebotomist will visit you *${dayWord(b.date)}, ${slotLabel(b.slot)}* for your *${tests}*.`, `📍 ${fullAddr(b)}`, '',
        ...(prepOf(b) ? ['Before the test:', prepOf(b), ''] : []), 'Need to change the time? Reply here.', sign].join('\n');
      case 'slots': return [hi, (isPast(b.date, b.slot) || OCCUPY.includes(b.status)) ? `We need to find you a new time for your home blood test.` : `The slot you picked (${fmtD(b.date)}, ${slotLabel(b.slot)}) is no longer available.`, '',
        'These slots are free:', list || '(no free slots in the next few days – please call us)', '', 'Reply with the number of the slot that suits you and we\'ll book it.', sign].join('\n');
      case 'missed': return [hi, `Our phlebotomist reached your address ${b.missed_slot ? `on ${fmtD(b.missed_slot.slice(0, 10))} at ${fmtT(slotMin(b.missed_slot.slice(11)))}` : ''} but couldn't reach you, so the sample could not be collected.`, '',
        `To rebook, a visit fee of *${money(b.fee_due || CFG.visitFee)}* applies. Please pay it by UPI to *${CFG.upiId || 'our UPI ID'}* and send the screenshot here with the slot you want:`, list || '(please call us for a slot)', sign].join('\n');
      case 'collected': return [hi, 'Your blood sample has reached our lab ✅', b.vial_no ? `Vial no.: *${b.vial_no}*` : null, '',
        "We'll send your reports here on WhatsApp as soon as they're ready.", sign].filter((x) => x !== null).join('\n');
      case 'report': {
        const fs = files && files.length ? files : reportsOf(b).filter((f) => !f.sent_at);
        return [hi, `Your report${fs.length === 1 ? ' is' : 's are'} ready 📄 Sending the PDF${fs.length === 1 ? '' : 's'} here:`, '',
          ...fs.map((f) => `• ${f.name.replace(/\.pdf$/i, '')}`), '', b.vial_no ? `Vial no.: ${b.vial_no}` : null,
          `Please share ${fs.length === 1 ? 'it' : 'them'} with your doctor. Questions? Reply here or call 8368143677.`, sign].filter((x) => x !== null).join('\n');
      }
      default: return '';
    }
  }
  function confirmText(b) {
    const t = testsOf(b);
    return [`Hi ${b.name}! 👋`, 'Your home blood test with *Dr. Sarwan Diagnostic Labs* is *confirmed* ✅', '',
      `🧾 Booking ref: ${b.id}`, `📅 Date: ${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`, `⏰ Time: ${slotLabel(b.slot)}`,
      `📍 Address: ${fullAddr(b)}`, `💳 Payment of ${money(b.amount)} received. Thank you!`,
      t.length > 1 ? `🧪 Tests:\n${t.map((x) => `   – ${x.name}`).join('\n')}` : `🧪 Test: ${t[0] ? t[0].name : 'Blood test'}${t[0] && pkgFor(t[0]) && pkgFor(t[0]).tests ? ` (${pkgFor(t[0]).tests})` : ''}`, '',
      ...(prepOf(b) ? ['Before the test:', prepOf(b), '(If your doctor gave you different instructions, follow your doctor.)', ''] : []),
      'Need to reschedule? Call/WhatsApp 8368143677.'].join('\n');
  }

  async function suggestSlots(b, n = 3) {
    const start = b.date > ist() && b.status !== 'no_show' ? b.date : ist();
    const dates = (CFG.dates || []).filter((d) => d >= start).slice(0, 7);
    const out = [];
    for (const d of dates) {
      try {
        const r = await fetch('/api/slots?date=' + d + (b.city ? '&city=' + encodeURIComponent(b.city) : '')).then((x) => x.json());
        r.slots.filter((s) => s.available && !(d === b.date && s.time === b.slot)).forEach((s) => out.push({ date: d, slot: s.time }));
      } catch (e) {}
      if (out.length >= n) break;
    }
    return out.slice(0, n);
  }

  // where WhatsApp opens: phone → wa.me (opens the app); computer → desktop app or WhatsApp Web
  const isTouch = () => window.matchMedia && window.matchMedia('(pointer:coarse)').matches && window.innerWidth < 1000;
  $('#waPref').value = pref.get('wa', 'app');
  $('#waPref').onchange = () => pref.set('wa', $('#waPref').value);
  function openWhatsApp(phone, text) {
    const ph = phone ? '91' + phone : '';
    const t = text ? encodeURIComponent(text) : '';
    let url;
    if (isTouch()) url = `https://wa.me/${ph}${t ? '?text=' + t : ''}`;
    else if (pref.get('wa', 'app') === 'web') url = `https://web.whatsapp.com/send?${ph ? 'phone=' + ph + '&' : ''}text=${t}`;
    else url = `whatsapp://send?${ph ? 'phone=' + ph + '&' : ''}text=${t}`;
    if (window.__dslOpen) return window.__dslOpen(url); // test hook
    if (url.startsWith('whatsapp:')) { const a = document.createElement('a'); a.href = url; a.click(); }
    else window.open(url, '_blank', 'noopener');
  }

  async function logSent(b, kind, extra = {}) {
    try {
      const r = await post(`/api/admin/bookings/${b.id}/sent`, { kind, ...extra });
      await refreshAll();
      if (kind === 'report') {
        const undo = { label: 'Undo', fn: async () => { await post(`/api/admin/bookings/${b.id}/sent`, { kind: 'report-undo', reportIds: r.marked || [] }); await refreshAll(); toast('Marked as not sent'); } };
        toast(r.completed ? 'Reports sent · job marked completed ✓' : `${(r.marked || []).length} report${(r.marked || []).length === 1 ? '' : 's'} marked as sent`, undo);
      } else if (kind !== 'chat') toast(`${MSG[kind]} opened in WhatsApp`);
    } catch (e) { toast(e.message); }
  }

  // one click: open WhatsApp with the message (slot suggestions are looked up first, in a preview)
  async function sendWa(id, kind) {
    const b = findB(id); if (!b) return;
    if (kind === 'chat') { openWhatsApp(b.phone, ''); return; }
    if (kind === 'report') { openReports(id); return; }
    if (kind === 'center') { openWhatsApp(CFG.centerPhone || '8368143677', msgText(b, 'center')); logSent(b, 'center'); return; }
    if (NEEDS_SLOTS.includes(kind)) {
      openMsg({ b, kind, title: MSG[kind], sub: `To ${b.name} · +91 ${b.phone}`, text: 'Finding free slots…' });
      const sug = await suggestSlots(b);
      if ($('#msgDlg').open && $('#msgDlg').dataset.id === b.id) $('#msgText').value = msgText(b, kind, sug);
      return;
    }
    openWhatsApp(b.phone, msgText(b, kind));
    logSent(b, kind);
  }

  // preview dialog (used after confirming / collecting, and for slot suggestions)
  function openMsg({ b, kind, title, sub, text, phone }) {
    const d = $('#msgDlg');
    $('#msgTitle').textContent = title; $('#msgSub').textContent = sub || '';
    $('#msgText').value = text;
    d.dataset.id = b ? b.id : ''; d.dataset.kind = kind || ''; d.dataset.phone = b ? b.phone : (phone || '');
    $('#msgCopy').textContent = 'Copy';
    $$('dialog[open]').forEach((x) => x !== d && x.close());
    if (!d.open) d.showModal();
  }
  $('#msgSend').onclick = () => {
    const d = $('#msgDlg'), b = d.dataset.id ? findB(d.dataset.id) : null;
    openWhatsApp(d.dataset.phone, $('#msgText').value);
    d.close();
    if (b && d.dataset.kind) logSent(b, d.dataset.kind);
  };
  $('#msgCopy').onclick = async () => {
    const t = $('#msgText'); let ok = false;
    try { ok = await Promise.race([navigator.clipboard.writeText(t.value).then(() => true), new Promise((r) => setTimeout(() => r(false), 1200))]); } catch (e) { ok = false; }
    if (!ok) { t.focus(); t.select(); t.setSelectionRange(0, t.value.length); try { document.execCommand('copy'); } catch (e) {} }
    $('#msgCopy').textContent = 'Copied ✓';
  };

  // ---------- detail (side panel on calendar, dialog everywhere else) ----------
  function detailHTML(b) {
    if (!b) return `<div class="dt-empty"><b>Select a booking</b>Click any booking in the calendar to see the patient's details, the steps and WhatsApp messages here.</div>`;
    const s = ST[b.status], reps = reportsOf(b);
    const f = [];
    if (b.status === 'no_show') f.push(nextStep(b));
    if (b.status === 'report_ready') f.push(`<button class="btn ghost" data-act="status" data-id="${b.id}" data-st="completed">Mark job complete</button>`);
    if (b.status === 'confirmed') f.push(`<button class="btn warn" data-act="status" data-id="${b.id}" data-st="no_show">Reached – patient not available</button>`);
    if (b.status === 'cancelled' && hasPaidProof(b)) f.push(`<button class="btn ghost" data-act="status" data-id="${b.id}" data-st="confirmed">Restore &amp; confirm</button>`);
    if (CANCELLABLE.includes(b.status)) f.push(`<button class="btn warn" data-act="status" data-id="${b.id}" data-st="cancelled">Cancel &amp; free slot</button>`);
    const payNote = b.status === 'payment_submitted' ? 'Payment submitted · check your Paytm app'
      : ['pending', 'expired'].includes(b.status) ? (hasPaidProof(b) ? 'Screenshot uploaded · slot not held' : 'Not paid yet · slot not reserved')
      : PAID.includes(b.status) ? 'Payment verified' : '—';
    const other = [];
    if (['pending', 'expired'].includes(b.status)) other.push('pay');
    if (['pending', 'expired', 'payment_submitted', 'confirmed'].includes(b.status)) other.push('slots');
    if (b.status === 'no_show') other.push('missed');
    other.push('chat');
    const sent = sentMap(b);
    const t = testsOf(b);
    return `<div class="dt-h">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div><div class="dt-name">${esc(b.name)}</div><div class="meta" style="margin-top:2px">Ref ${esc(b.id)} · +91 ${esc(b.phone)}</div></div>
<span class="pill st-${b.status}" style="margin:0;flex:none">${s.label}</span></div>
<div class="dt-when"><span>${fmtD(b.date)} · ${esc(slotLabel(b.slot))}</span>${MOVABLE.includes(b.status) ? `<button type="button" class="btn ghost sm" style="margin-left:auto" data-act="move" data-id="${b.id}">${b.status === 'no_show' ? 'Rebook' : 'Reschedule'}</button>` : ''}</div>
</div>
<div class="dt-b">
${b.status === 'no_show' ? `<div class="fee">Phlebotomist reached${b.missed_slot ? ` on ${fmtD(b.missed_slot.slice(0, 10))}, ${fmtT(slotMin(b.missed_slot.slice(11)))}` : ''} – patient not available. <b>${money(b.fee_due || CFG.visitFee)} visit fee</b> is due before rebooking.</div>` : ''}
${b.fee_paid_at ? `<div class="meta">Visit fee ${money(b.fee_due)} received ${when(b.fee_paid_at)} · rebooked</div>` : ''}
<div class="dt-sec"><div class="dt-k" style="display:flex;justify-content:space-between;align-items:center">Tests (${t.length})${b.status !== 'cancelled' ? `<button type="button" class="btn ghost sm" data-act="tests-edit" data-id="${b.id}">Edit tests</button>` : ''}</div>
<ul class="tl">${t.map((x) => `<li><b>${esc(x.name)}</b><span>${money(x.price)}</span></li>`).join('') || '<li class="meta">No test recorded</li>'}</ul>
<div class="pay"><div style="min-width:0;flex:1"><b>${money(b.amount)}</b><div class="meta">${payNote}${b.utr ? ` · UTR ${esc(b.utr)}` : ''}${t.some((x) => x.margin != null) ? ` · margin ${money(marginOf(b))}` : ''}</div></div>${b.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${b.id}">Screenshot</button>` : ''}</div></div>
${stepsCompact(b) ? `<div class="dt-sec"><div class="dt-k">Steps</div>${stepsCompact(b)}</div>` : ''}
<div class="dt-sec"><div class="dt-k" style="display:flex;justify-content:space-between;align-items:center">Reports (${reps.length})${AFTER_COLLECT.includes(b.status) ? `<button type="button" class="btn ghost sm" data-act="reports" data-id="${b.id}">${reps.length ? 'Manage / send' : 'Upload'}</button>` : ''}</div>
${reps.length ? `<ul class="rl">${reps.map((r) => `<li>📄 ${esc(r.name)} <span class="${r.sent_at ? 'm-ok' : 'meta'}">${r.sent_at ? 'sent ' + when(r.sent_at) : 'not sent'}</span></li>`).join('')}</ul>` : `<div class="meta">${AFTER_COLLECT.includes(b.status) ? 'No reports uploaded yet.' : 'Reports can be uploaded after the sample is collected.'}</div>`}</div>
<div class="dt-sec"><div class="dt-k">Other WhatsApp messages</div><div class="wa-list">${other.map((k) => `<button type="button" class="wa-btn" data-act="wa" data-kind="${k}" data-id="${b.id}"><span class="ic">✆</span><span><b>${MSG[k]}</b></span>${sent[k] ? `<span class="ok">Sent ${when(sent[k])}</span>` : ''}</button>`).join('')}</div></div>
<div class="dt-links"><a class="call" href="tel:+91${esc(b.phone)}">Call</a><a class="wa" href="#" data-act="wa" data-kind="chat" data-id="${b.id}">WhatsApp</a><a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></div>
<div><div class="dt-k">Collection address</div><div style="margin-top:2px;line-height:1.45">${esc(b.address)}<br><b>${esc(b.city || '')}</b>${b.state ? ', ' + esc(b.state) : ''} – ${esc(b.pincode)}</div></div>
<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">${b.cycle ? `<div><div class="dt-k">Cycle</div><div style="margin-top:2px">${esc(b.cycle)}</div></div>` : ''}<div><div class="dt-k">Source</div><div style="margin-top:2px">${esc(srcLabel(b.source))}</div></div></div>
${b.notes ? `<div><div class="dt-k">Notes</div><div style="margin-top:2px">${esc(b.notes)}</div></div>` : ''}
</div>
${f.length ? `<div class="dt-f">${f.join('')}</div>` : ''}`;
  }

  function openDetail(id) {
    const b = findB(id); if (!b) return;
    detailId = id;
    $('#detailBody').innerHTML = detailHTML(b);
    $$('dialog[open]').forEach((x) => x !== $('#detailDlg') && x.close());
    if (!$('#detailDlg').open) $('#detailDlg').showModal();
  }
  $('#detailDlg').addEventListener('close', () => (detailId = null));

  // ================= BOOKINGS TAB =================
  const period = { preset: pref.get('period', 'month'), from: pref.get('pfrom', ''), to: pref.get('pto', '') };
  function presetRange(p) {
    const t = ist();
    switch (p) {
      case 'today': return [t, t];
      case 'tomorrow': return [addDays(t, 1), addDays(t, 1)];
      case 'next7': return [t, addDays(t, 6)];
      case 'week': { const s = addDays(t, -dowMon(t)); return [s, addDays(s, 6)]; }
      case 'lastmonth': { const s = addMonths(monthStart(t), -1); return [s, monthEnd(s)]; }
      case 'last30': return [addDays(t, -29), t];
      case 'custom': return [period.from || t, period.to || period.from || t];
      default: return [monthStart(t), monthEnd(t)];
    }
  }
  function syncPeriod() {
    [period.from, period.to] = presetRange(period.preset);
    $('#perPreset').value = period.preset; $('#perFrom').value = period.from; $('#perTo').value = period.to;
  }
  syncPeriod();
  $('#perPreset').onchange = () => { period.preset = $('#perPreset').value; pref.set('period', period.preset); syncPeriod(); load().catch((e) => toast(e.message)); };
  ['perFrom', 'perTo'].forEach((id) => ($('#' + id).onchange = () => {
    let f = $('#perFrom').value, t = $('#perTo').value; if (!f || !t) return;
    if (t < f) [f, t] = [t, f];
    period.preset = 'custom'; period.from = f; period.to = t; pref.set('period', 'custom'); pref.set('pfrom', f); pref.set('pto', t);
    syncPeriod(); load().catch((e) => toast(e.message));
  }));

  async function load() {
    const today = ist();
    syncPeriod();
    const from = [period.from, addDays(today, -90)].sort()[0], to = [period.to, addDays(today, 14)].sort()[1];
    data = await api(`/api/admin/bookings?from=${from}&to=${to}&all=1`);
    renderBookings();
  }
  const inPeriod = (b) => b.date >= period.from && b.date <= period.to;

  function renderBookings() {
    const list = data.bookings.filter((b) => b.status !== 'blocked' && inPeriod(b));
    const active = list.filter((b) => HOLD_ST.includes(b.status));
    const reps = list.flatMap(reportsOf);
    const paid = list.filter((b) => PAID.includes(b.status));
    const card = ([v, l, filt, cls]) => `<${filt ? `button type="button" data-filt="${filt}"` : 'div'} class="stat ${cls || ''}"><b>${v}</b><span>${l}</span></${filt ? 'button' : 'div'}>`;
    $('#stats1').innerHTML = [
      [active.reduce((a, b) => a + Math.max(1, testsOf(b).length), 0), 'Total tests', 'active'],
      [list.filter((b) => AFTER_COLLECT.includes(b.status)).length, 'Total samples collected', 'collected_any'],
      [reps.length, 'Total reports'],
      [list.filter((b) => NEW_ST.includes(b.status)).reduce((a, b) => a + Math.max(1, testsOf(b).length), 0), 'New tests (not collected yet)', 'new'],
    ].map(card).join('');
    $('#stats2').innerHTML = [
      [money(revenue(list)), 'Total price'],
      [money(paid.reduce((a, b) => a + marginOf(b), 0) + list.reduce((a, b) => a + (b.fee_paid_at ? b.fee_due || 0 : 0), 0)), 'Total margin'],
      [list.filter((b) => b.status === 'no_show').length, 'Patient not available', 'no_show', 'red'],
      [list.filter((b) => b.status === 'pending').length, 'Unpaid bookings', 'pending', 'amber'],
    ].map(card).join('');
    const ver = data.bookings.filter((b) => b.status === 'payment_submitted' || (['pending', 'expired'].includes(b.status) && hasPaidProof(b) && b.date >= ist()));
    $('#verifyNote').innerHTML = ver.length ? `<div class="vnote">⚠ ${ver.length} payment${ver.length === 1 ? '' : 's'} to verify <button type="button" class="btn sm" data-filt="payment_submitted">Show</button></div>` : '';
    renderTable();
  }
  const NEW_ST = ['payment_submitted', 'confirmed'];
  const HOLD_ST = ['payment_submitted', 'confirmed', 'collected', 'report_ready', 'completed', 'no_show'];

  function renderTable() {
    if (!data) return;
    const st = $('#fStatus').value, q = $('#fSearch').value.trim().toLowerCase();
    let rows = data.bookings.filter((b) => b.status !== 'blocked' && (st === 'payment_submitted' || inPeriod(b)));
    if (st === 'active') rows = rows.filter(live);
    else if (st === 'collected_any') rows = rows.filter((b) => AFTER_COLLECT.includes(b.status));
    else if (st === 'new') rows = rows.filter((b) => NEW_ST.includes(b.status));
    else if (st !== 'all') rows = rows.filter((b) => b.status === st);
    if (q) rows = rows.filter((b) => [b.name, b.phone, b.address, b.city, b.state, b.pincode, b.id, b.utr, b.vial_no, testNames(b)].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
    $('#tbody').innerHTML = rows.length ? rows.map((b) => {
      const reps = reportsOf(b), nSent = reps.filter((r) => r.sent_at).length;
      const repBtn = AFTER_COLLECT.includes(b.status) ? `<button type="button" class="btn ghost sm rep-b" data-act="reports" data-id="${b.id}">📄 ${reps.length ? `Reports (${nSent}/${reps.length} sent)` : 'Upload reports'}</button>` : '';
      return `<tr class="row" data-row="${b.id}">
<td style="white-space:nowrap"><b>${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><small>${esc(slotLabel(b.slot))}</small><small>${esc(b.id)}</small></td>
<td><button type="button" class="lnk" data-act="open" data-id="${b.id}">${esc(b.name)}</button>${testsOf(b).map((t) => `<span class="test-l">🧪 ${esc(t.name)}</span>`).join('')}${b.vial_no ? `<span class="vial">${esc(b.vial_no)}</span>` : vialWarn(b)}${repBtn}</td>
<td style="white-space:nowrap"><a href="tel:+91${esc(b.phone)}">${esc(b.phone)}</a><small><a href="#" data-act="wa" data-kind="chat" data-id="${b.id}">WhatsApp</a></small></td>
<td class="addr">${esc(b.address)}<small>PIN ${esc(b.pincode)} · <a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></small>${b.notes ? `<small>Note: ${esc(b.notes)}</small>` : ''}</td>
<td>${esc(b.city || '–')}</td>
<td>${esc(b.state || '–')}</td>
<td class="num"><b>${money(b.amount)}</b>${testsOf(b).some((x) => x.margin != null) ? `<small>margin ${money(marginOf(b))}</small>` : ''}${b.utr ? `<small>UTR ${esc(b.utr)}</small>` : ''}</td>
<td><div class="next"><span class="pill st-${b.status}" style="margin:0">${ST[b.status].label}</span>${nextBar(b)}</div></td>
</tr>`;
    }).join('') : '<tr><td colspan="8" class="meta" style="padding:18px">No bookings in this period.</td></tr>';
    $('#tblCount').textContent = `${rows.length} booking${rows.length === 1 ? '' : 's'} · ${fmtD(period.from)}${period.to !== period.from ? ' – ' + fmtD(period.to) : ''} · click a name for the steps & WhatsApp messages`;
  }
  $('#fStatus').onchange = renderTable;
  $('#fSearch').oninput = renderTable;
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-filt]'); if (!c) return;
    const v = c.dataset.filt, sel = $('#fStatus');
    if (![...sel.options].some((o) => o.value === v)) sel.insertAdjacentHTML('beforeend', `<option value="${v}">${v === 'new' ? 'New – not collected yet' : 'Collected (incl. reports)'}</option>`);
    sel.value = v; renderTable(); $('.tbl-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ================= CALENDAR TAB =================
  function viewRange() {
    if (cal.view === 'day') return [cal.anchor, cal.anchor];
    if (cal.view === 'month') { const s = monthStart(cal.anchor), e = monthEnd(cal.anchor); return [addDays(s, -dowMon(s)), addDays(e, 6 - dowMon(e))]; }
    return [cal.anchor, addDays(cal.anchor, 6)];
  }
  async function loadCal() {
    if (window.innerWidth < 960 && cal.view === 'week') cal.view = 'day';
    const [vs, ve] = viewRange();
    const ms = cal.mm, me = monthEnd(cal.mm);
    const mmS = addDays(ms, -dowMon(ms)), mmE = addDays(me, 6 - dowMon(me));
    const dayStrip = cal.view === 'day' ? [addDays(cal.anchor, -3), addDays(cal.anchor, 3)] : [vs, ve];
    const from = [vs, mmS, dayStrip[0]].sort()[0], to = [ve, mmE, dayStrip[1]].sort()[2];
    cal.data = await api(`/api/admin/bookings?from=${from}&to=${to}&all=1`);
    renderCal();
  }

  const at = (date, slot) => cal.data.bookings.filter((b) => b.date === date && b.slot === slot);
  const HOLD = OCCUPY.filter((x) => x !== 'blocked');
  const CAP = () => CFG.slotCapacity || 20;
  const cityKey = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const isBlocked = (date, slot) => at(date, slot).some((b) => b.status === 'blocked');
  const dayBooked = (date) => cal.data.bookings.filter((b) => b.date === date && HOLD.includes(b.status)).length;
  const slotsUsed = (date) => new Set(cal.data.bookings.filter((b) => b.date === date && HOLD.includes(b.status)).map((b) => b.slot)).size;
  const fillColor = (n) => (n >= 8 ? '#e2603f' : '#1f8a6a'); // n = slots in use out of 10
  // bookings to show in a slot (respecting the filters): paid first, then unpaid, then cancelled
  const rank = (st) => (HOLD.includes(st) ? 0 : st === 'pending' ? 1 : 2);
  const slotItems = (date, slot) => at(date, slot).filter((b) => b.status !== 'blocked' && shown(b))
    .sort((a, b) => rank(a.status) - rank(b.status) || String(a.created_at).localeCompare(String(b.created_at)));
  function slotSummary(items) {
    const cities = {}; items.forEach((b) => { const c = b.city || '—'; cities[c] = (cities[c] || 0) + 1; });
    return Object.entries(cities).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ');
  }

  function renderCal() {
    if (!cal.data) return;
    const [vs, ve] = viewRange();
    const sameMonth = vs.slice(0, 7) === ve.slice(0, 7);
    $('#calTitle').textContent = cal.view === 'day' ? fmt(cal.anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : cal.view === 'month' ? fmt(cal.anchor, { month: 'long', year: 'numeric' })
      : sameMonth ? `${fmt(vs, { day: 'numeric' })} – ${fmt(ve, { day: 'numeric', month: 'long', year: 'numeric' })}`
      : `${fmt(vs, { day: 'numeric', month: 'short' })} – ${fmt(ve, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === cal.view)));
    renderMini(); renderRail();
    if (cal.view === 'week') renderWeek(); else if (cal.view === 'day') renderDay(); else renderMonth();
    renderSide();
  }

  function renderMini() {
    const s = cal.mm, e = monthEnd(s), today = ist();
    const [vs, ve] = viewRange();
    $('#mmTitle').textContent = fmt(s, { month: 'long', year: 'numeric' });
    let h = '';
    for (let i = 0; i < dowMon(s); i++) h += '<span></span>';
    for (let d = s; d <= e; d = addDays(d, 1)) {
      const cls = ['mm-d', d === today ? 'today' : '', d >= vs && d <= ve && cal.view !== 'month' ? 'inrange' : '', dayBooked(d) ? 'has' : ''].join(' ');
      h += `<button type="button" class="${cls}" data-act="goday" data-date="${d}" aria-label="${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}">${Number(d.slice(8))}<i></i></button>`;
    }
    $('#mmGrid').innerHTML = h;
  }

  function inView(b) { const [vs, ve] = cal.view === 'month' ? [monthStart(cal.anchor), monthEnd(cal.anchor)] : viewRange(); return b.date >= vs && b.date <= ve; }
  function renderRail() {
    const list = cal.data.bookings.filter(inView);
    const occ = list.filter((b) => OCCUPY.includes(b.status) && b.status !== 'blocked');
    const [vs, ve] = cal.view === 'month' ? [monthStart(cal.anchor), monthEnd(cal.anchor)] : viewRange();
    let free = 0; for (let d = vs; d <= ve; d = addDays(d, 1)) SLOTS.forEach((sl) => { if (!isPast(d, sl) && !isBlocked(d, sl)) free++; });
    const c = (s) => list.filter((b) => b.status === s).length;
    $('#railStatsTitle').textContent = cal.view === 'day' ? 'This day' : cal.view === 'month' ? 'This month' : 'This week';
    $('#railStats').innerHTML = `
<div class="rs"><b>${occ.length}</b><span>Bookings</span></div>
<div class="rs"><b>${free}</b><span>Open slots left</span></div>
<div class="rs v"><b>${c('payment_submitted')}</b><span>To verify</span></div>
<div class="rs c"><b>${c('confirmed')}</b><span>Confirmed</span></div>
<div class="rs"><b>${c('collected')}</b><span>Awaiting report</span></div>
<div class="rs"><b>${c('report_ready')}</b><span>Report to send</span></div>
<div class="rs-wide"><span class="meta">Revenue (paid)</span><b>${money(revenue(list))}</b></div>`;
    const F = [['payment_submitted', 'Paid – verify'], ['pending', 'Awaiting payment'], ['confirmed', 'Confirmed'], ['collected', 'Collected'], ['report_ready', 'Report ready'], ['completed', 'Completed'], ['no_show', 'Not available'], ['cancelled', 'Cancelled / expired']];
    $('#filters').innerHTML = F.map(([k, l]) => `<label class="flt"><input type="checkbox" data-flt="${k}" ${cal.filters.has(k) ? 'checked' : ''}> ${l} <span>${k === 'cancelled' ? c('cancelled') + c('expired') : c(k)}</span></label>`).join('');
    $$('[data-flt]').forEach((x) => (x.onchange = () => { x.checked ? cal.filters.add(x.dataset.flt) : cal.filters.delete(x.dataset.flt); pref.set('filters2', [...cal.filters]); renderCal(); }));
  }
  const shown = (b) => b.status === 'blocked' || cal.filters.has(['cancelled', 'expired'].includes(b.status) ? 'cancelled' : b.status);

  function cellHTML(date, slot) {
    const items = slotItems(date, slot), past = isPast(date, slot), blocked = isBlocked(date, slot);
    const lock = blocked ? ' · 🔒' : '';
    if (!items.length) {
      if (blocked) return `<button type="button" class="blk" data-act="unblock" data-date="${date}" data-slot="${slot}" title="Click to unblock">Blocked</button>`;
      return `<button type="button" class="fr" data-act="add" data-date="${date}" data-slot="${slot}" ${past ? 'disabled' : ''} aria-label="Free slot ${esc(slotLabel(slot))}, add booking">+</button>`;
    }
    if (items.length === 1) {
      const b = items[0], st = ST[b.status];
      const cls = ['bk', b.id === cal.sel ? 'sel' : '', b.status === 'pending' ? 'dash' : '', ['cancelled', 'expired'].includes(b.status) ? 'cx' : ''].join(' ');
      return `<button type="button" class="${cls}" data-act="sel" data-id="${b.id}" data-tip="${date}|${slot}" style="background:${st.bg};border-left-color:${st.stripe}" aria-label="${esc(b.name)}, ${esc(b.package_name || '')}, ${esc(slotLabel(slot))}, ${st.label}">
<span class="nm">${esc(b.name)}</span><span class="ar">${b.vial_no ? '🧪 ' + esc(b.vial_no) : esc(b.city || '') + (b.pincode ? ' · ' + esc(b.pincode) : '')}</span><span class="tg" style="color:${st.fg}">${st.tag}${b.has_proof && b.status === 'payment_submitted' ? ' · 📎' : ''}${lock}</span></button>`;
    }
    const held = items.filter((b) => HOLD.includes(b.status)).length;
    const dots = items.slice(0, 12).map((b) => `<i style="background:${ST[b.status].stripe}"></i>`).join('');
    return `<button type="button" class="bk multi" data-act="slotlist" data-date="${date}" data-slot="${slot}" data-tip="${date}|${slot}" aria-label="${items.length} bookings at ${esc(slotLabel(slot))}: ${esc(items.map((b) => b.name).join(', '))}">
<span class="nm"><b class="cnt">${items.length}</b> bookings${lock}</span><span class="ar">${esc(slotSummary(items))}</span><span class="dots">${dots}</span>${held !== items.length ? `<span class="tg" style="color:#5a6880">${held} paid</span>` : ''}</button>`;
  }

  function renderWeek() {
    const days = []; for (let i = 0; i < 7; i++) days.push(addDays(cal.anchor, i));
    const today = ist();
    let h = '<div class="wk"><div class="wk-grid"><div class="wk-h" style="cursor:default;border-left:0"></div>';
    days.forEach((d) => { const n = dayBooked(d), u = slotsUsed(d); h += `<button type="button" class="wk-h ${d === today ? 'today' : ''}" data-act="goday" data-date="${d}" style="border-top:0;border-right:0" title="${n} bookings in ${u} of 10 slots"><div class="dw">${fmt(d, { weekday: 'short' })}</div><div class="dn">${fmt(d, { day: 'numeric' })}</div><div class="cap"><i style="width:${u * 10}%;background:${fillColor(u)}"></i></div><div class="cn"><b>${n}</b> booked</div></button>`; });
    SLOTS.forEach((s) => {
      h += `<div class="wk-t">${fmtT(slotMin(s))}</div>`;
      days.forEach((d) => { h += `<div class="wk-c ${d === today ? 'today' : ''}">${cellHTML(d, s)}</div>`; });
    });
    $('#calMain').innerHTML = h + '</div></div>';
  }

  function runStops(date) {
    return cal.data.bookings.filter((b) => b.date === date && ['payment_submitted', 'confirmed'].includes(b.status)).sort((a, b) => a.slot.localeCompare(b.slot) || String(a.city || '').localeCompare(String(b.city || '')) || String(a.pincode).localeCompare(String(b.pincode)));
  }

  function renderDay() {
    const d = cal.anchor, list = cal.data.bookings.filter((b) => b.date === d);
    let strip = '';
    for (let i = -3; i <= 3; i++) {
      const x = addDays(d, i), n = dayBooked(x), u = slotsUsed(x), on = i === 0;
      strip += `<button type="button" class="sd ${on ? 'on' : ''}" data-act="goday" data-date="${x}" title="${n} bookings in ${u} of 10 slots"><span class="l"><span>${fmt(x, { weekday: 'short', day: 'numeric' })}</span><b>${n}</b></span><span class="bar"><i style="width:${u * 10}%;background:${u >= 8 ? '#e2603f' : on ? '#7fd1b9' : '#1f8a6a'}"></i></span></button>`;
    }
    const occ = list.filter((b) => OCCUPY.includes(b.status) && b.status !== 'blocked');
    const c = (s) => list.filter((b) => b.status === s).length;
    let rows = '';
    const dbk = (oc) => {
      const st = ST[oc.status];
      return `<div class="dbk ${['cancelled', 'expired'].includes(oc.status) ? 'cx' : ''}" data-act="open" data-id="${oc.id}" style="border-left-color:${st.stripe};background:${['completed', 'collected'].includes(oc.status) ? '#fafbff' : '#fff'}" role="button" tabindex="0" aria-label="Open ${esc(oc.name)}">
<div class="p1"><b>${esc(oc.name)}</b><div>+91 ${esc(oc.phone)}</div>${testLine(oc)}${oc.vial_no ? `<span class="vial">${esc(oc.vial_no)}</span>` : vialWarn(oc)}</div>
<div class="p2">${esc(oc.address)}<br><b style="color:#1b2a4e">${esc(oc.city || '')}</b> · ${esc(oc.pincode)}</div>
<span class="pill st-${oc.status}" style="margin:0">${st.label}</span>
<div class="acts" style="margin:0">${oc.status === 'payment_submitted' && oc.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${oc.id}">Screenshot</button>` : ''}${nextBar(oc)}</div></div>`;
    };
    SLOTS.forEach((s) => {
      const items = slotItems(d, s), past = isPast(d, s), blocked = isBlocked(d, s);
      const held = at(d, s).filter((b) => HOLD.includes(b.status)).length;
      const tm = `<div class="tm"><b>${fmtT(slotMin(s))}</b><small>to ${fmtT(slotMin(s) + 30)}</small>${items.length > 1 ? `<span class="tmc" data-tip="${d}|${s}">${items.length} bookings</span>` : ''}</div>`;
      let tools;
      if (blocked) tools = `<div class="dblk">${items.length ? 'Closed to new bookings' : 'Blocked'} <button type="button" class="btn ghost sm" data-act="unblock" data-date="${d}" data-slot="${s}">Unblock</button></div>`;
      else if (past) tools = items.length ? '' : '<div class="dfree">Free (past)</div>';
      else tools = `<div class="dfree">${items.length ? `${held} paid booking${held === 1 ? '' : 's'} · up to ${CAP()} per city` : 'Free slot'} <button type="button" class="btn ghost sm" data-act="add" data-date="${d}" data-slot="${s}">+ Add booking</button><button type="button" class="btn warn sm" data-act="block" data-date="${d}" data-slot="${s}">Block</button></div>`;
      rows += `<div class="drow">${tm}<div class="dcol">${items.map(dbk).join('')}${tools}</div></div>`;
    });
    $('#calMain').innerHTML = `<div class="strip">${strip}</div>
<div class="dsum">
<div class="ds"><b>${occ.length}</b><span>Bookings · ${slotsUsed(d)} of 10 slots</span></div>
<div class="ds v"><b>${c('payment_submitted')}</b><span>Payment to verify</span></div>
<div class="ds p"><b>${c('pending')}</b><span>Awaiting payment</span></div>
<div class="ds c"><b>${c('confirmed')}</b><span>Confirmed</span></div>
<div class="ds"><b>${c('collected') + c('report_ready') + c('completed')}</b><span>Collected</span></div>
</div>
<button type="button" class="btn ghost run-btn" data-act="run-open">Phlebotomist run sheet · ${runStops(d).length} pickup${runStops(d).length === 1 ? '' : 's'}</button>
<div class="dlist">${rows}</div>`;
    const on = $('.strip .sd.on'); if (on && on.scrollIntoView && window.innerWidth < 960) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderMonth() {
    const s = monthStart(cal.anchor), e = monthEnd(cal.anchor), today = ist();
    const gs = addDays(s, -dowMon(s)), ge = addDays(e, 6 - dowMon(e));
    let h = '<div class="mo"><div class="mo-grid">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<div class="mo-dow">${x}</div>`).join('');
    for (let d = gs; d <= ge; d = addDays(d, 1)) {
      const list = cal.data.bookings.filter((b) => b.date === d);
      const n = dayBooked(d), u = slotsUsed(d), cnt = (st) => list.filter((b) => b.status === st).length;
      const v = cnt('payment_submitted'), p = cnt('pending'), r = cnt('report_ready'), w = cnt('collected');
      const out = d < s || d > e;
      h += `<button type="button" class="mo-c ${out ? 'out' : ''} ${d === today ? 'today' : ''}" data-act="goday" data-date="${d}" aria-label="${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${n} booked">
<span class="num">${Number(d.slice(8))}</span>
<span class="chips">${n ? `<span class="chip" style="background:${u >= 8 ? '#ffe3d9' : '#dff3ea'};color:${u >= 8 ? '#a33a1f' : '#17694a'}">${n} booked</span>` : ''}${v ? `<span class="chip st-payment_submitted">${v} to verify</span>` : ''}${w ? `<span class="chip st-collected">${w} awaiting report</span>` : ''}${r ? `<span class="chip st-report_ready">${r} report to send</span>` : ''}${p && cal.filters.has('pending') ? `<span class="chip st-pending">${p} unpaid</span>` : ''}</span>
${n ? `<span class="cap" style="width:100%;margin:auto 0 0"><i style="width:${u * 10}%;background:${fillColor(u)}"></i></span>` : ''}</button>`;
    }
    $('#calMain').innerHTML = h + '</div></div>';
  }

  // all bookings in one slot (click on a "3 bookings" cell)
  function slotListHTML(date, slot) {
    const items = slotItems(date, slot), blocked = isBlocked(date, slot), past = isPast(date, slot);
    const byCity = {}; at(date, slot).filter((b) => HOLD.includes(b.status)).forEach((b) => { const k = b.city || '—'; byCity[k] = (byCity[k] || 0) + 1; });
    return `<div class="dt-h"><div class="dt-name">${esc(slotLabel(slot))}</div><div class="meta">${fmt(date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${items.length} booking${items.length === 1 ? '' : 's'}${blocked ? ' · closed to new bookings' : ''}</div>
<div class="cityc">${Object.entries(byCity).map(([c, n]) => `<span class="badge ${n >= CAP() ? 'full' : 'web'}">${esc(c)} ${n}/${CAP()}</span>`).join('')}</div></div>
<div class="dt-b">${items.map((b) => `<div class="sl-row" style="border-left-color:${ST[b.status].stripe}"><div style="min-width:0;flex:1"><button type="button" class="lnk" data-act="open" data-id="${b.id}">${esc(b.name)}</button>${testLine(b)}<div class="meta">${esc(b.city || '')} · ${esc(b.pincode || '')} · +91 ${esc(b.phone)}</div></div><div class="next" style="align-items:flex-end"><span class="pill st-${b.status}" style="margin:0">${ST[b.status].label}</span>${nextBar(b)}</div></div>`).join('') || '<p class="meta">No bookings shown (check the filters).</p>'}</div>
<div class="dt-f">${!past && !blocked ? `<button class="btn" data-act="add" data-date="${date}" data-slot="${slot}">+ Add booking in this slot</button>` : ''}${blocked ? `<button class="btn ghost" data-act="unblock" data-date="${date}" data-slot="${slot}">Unblock slot</button>` : !past ? `<button class="btn warn" data-act="block" data-date="${date}" data-slot="${slot}">Block slot (no new bookings)</button>` : ''}</div>`;
  }
  let slotOpen = null;
  function openSlotList(date, slot) {
    slotOpen = { date, slot }; detailId = null;
    $('#detailBody').innerHTML = slotListHTML(date, slot);
    $$('dialog[open]').forEach((x) => x !== $('#detailDlg') && x.close());
    if (!$('#detailDlg').open) $('#detailDlg').showModal();
  }
  $('#detailDlg').addEventListener('close', () => (slotOpen = null));

  // hover card listing every booking in a slot
  const tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true; document.body.appendChild(tip);
  function showTip(el) {
    if (!cal.data) return;
    const [date, slot] = el.dataset.tip.split('|');
    const items = slotItems(date, slot); if (!items.length) return;
    tip.innerHTML = `<div class="tip-h">${esc(slotLabel(slot))} · ${fmtD(date)} · ${items.length} booking${items.length === 1 ? '' : 's'}</div>` + items.slice(0, 20).map((b) => `<div class="tip-r"><i style="background:${ST[b.status].stripe}"></i><div><b>${esc(b.name)}</b> <span>${esc(b.city || '')}</span><div class="tip-s">${esc(b.package_name || '')}${b.package_name ? ' · ' : ''}${ST[b.status].label}${b.vial_no ? ' · ' + esc(b.vial_no) : ''}</div></div></div>`).join('') + (items.length > 20 ? `<div class="tip-s">+${items.length - 20} more – click to see all</div>` : '');
    tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = r.right + 8, y = r.top;
    if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 8);
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip]'); if (el) showTip(el); else tip.hidden = true; });
  document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el); else tip.hidden = true; });
  window.addEventListener('scroll', () => (tip.hidden = true), true);

  function runSheetHTML(date) {
    const stops = runStops(date);
    return `<div class="run-h"><div class="run-k">Phlebotomist run sheet</div><div class="run-t">${stops.length} pickup${stops.length === 1 ? '' : 's'} · ${fmtD(date)}</div><div class="meta" style="margin-top:2px">Confirmed + paid-to-verify bookings, in slot order</div></div>
<div class="run-b">${stops.length ? stops.map((b, i) => `<div class="stop"><div style="display:flex;flex-direction:column;align-items:center"><span class="n">${i + 1}</span><span class="ln"></span></div><div class="bd"><div style="font-weight:800">${fmtT(slotMin(b.slot))} · <a href="#" data-act="open" data-id="${b.id}" style="color:inherit">${esc(b.name)}</a> <span class="meta" style="font-weight:600">${esc(b.city || '')}</span></div><div style="font-size:12.5px;color:#3b4a68;margin-top:2px">${esc(b.address)}, ${esc(b.city || '')} · ${esc(b.pincode)}</div><div style="font-size:12px;color:#8492a6;margin-top:2px">${b.package_name ? esc(b.package_name) + ' · ' : ''}+91 ${esc(b.phone)}${b.status === 'payment_submitted' ? ' · payment to verify' : ''}</div></div></div>`).join('') : '<p class="meta">No confirmed pickups for this day yet.</p>'}</div>
<div class="dt-f">
<button class="btn wa" data-act="run-wa" ${stops.length ? '' : 'disabled'}>Send run sheet on WhatsApp</button>
<div style="display:flex;gap:8px"><button class="btn ghost" style="flex:1" data-act="run-map" ${stops.length ? '' : 'disabled'}>Open route in Maps</button><button class="btn ghost" style="flex:1" data-act="run-print" ${stops.length ? '' : 'disabled'}>Print</button></div>
</div>`;
  }

  function renderSide() {
    const side = $('#side');
    if (cal.view === 'month') { side.hidden = true; return; }
    side.hidden = false;
    if (cal.view === 'day') { side.innerHTML = runSheetHTML(cal.anchor); return; }
    side.innerHTML = detailHTML(cal.sel ? findB(cal.sel) : null);
  }

  // ---------- run sheet actions ----------
  function runText(date) {
    const stops = runStops(date);
    return [`🩸 Home collections – ${fmt(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`, `${stops.length} pickup${stops.length === 1 ? '' : 's'}`, '',
      ...stops.flatMap((b, i) => [`${i + 1}) ${slotLabel(b.slot)} · ${b.name} · +91 ${b.phone}`, `   Test: ${b.package_name || '-'}`, `   ${b.address}, ${b.city || ''} – ${b.pincode}`, `   Map: ${mapUrl(b)}`, b.notes ? `   Note: ${b.notes}` : null, ''].filter((x) => x !== null)),
      'Please write the vial no. against each patient and share it after collection.'].join('\n');
  }
  function runMap(date) {
    const stops = runStops(date).map((b) => [b.address, b.city, b.state, b.pincode].filter(Boolean).join(', '));
    if (!stops.length) return;
    const dest = stops[stops.length - 1], way = stops.slice(0, -1).slice(0, 9);
    window.open(`https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(dest)}${way.length ? '&waypoints=' + encodeURIComponent(way.join('|')) : ''}`, '_blank', 'noopener');
  }
  function runPrint(date) {
    const stops = runStops(date);
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print'); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Run sheet ${date}</title><style>body{font-family:system-ui,sans-serif;margin:28px;color:#111}h1{font-size:20px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}td,th{border:1px solid #bbb;padding:8px;text-align:left;vertical-align:top}th{background:#f2f2f2}</style>
<h1>Dr. Sarwan Diagnostic Labs – Home collections</h1><div>${esc(fmt(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))} · ${stops.length} pickups</div>
<table><tr><th>#</th><th>Time</th><th>Patient</th><th>Phone</th><th>Address</th><th>Payment</th><th>Vial no.</th></tr>
${stops.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(slotLabel(b.slot))}</td><td>${esc(b.name)}<br><small>${esc(b.package_name || '')} · ${esc(b.id)}</small></td><td>+91 ${esc(b.phone)}</td><td>${esc(b.address)}, ${esc(b.city || '')} – ${esc(b.pincode)}${b.notes ? `<br><small>${esc(b.notes)}</small>` : ''}</td><td>${b.status === 'payment_submitted' ? 'To verify' : 'Paid'}</td><td style="min-width:110px"></td></tr>`).join('')}</table>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }

  async function viewShot(id) {
    try {
      const r = await fetch(`/api/admin/bookings/${id}/screenshot`, { headers: { 'x-admin-key': KEY } });
      if (!r.ok) throw new Error('Screenshot not found');
      const u = URL.createObjectURL(await r.blob());
      const im = $('#shotImg'); if (im.dataset.u) URL.revokeObjectURL(im.dataset.u); im.src = u; im.dataset.u = u;
      const b = findB(id); $('#shotTitle').textContent = `Payment screenshot · ${b ? b.name : ''}`;
      $('#shotDlg').showModal();
    } catch (e) { toast(e.message); }
  }
  // ---------- mutations ----------
  async function setStatus(id, st, opts = {}) {
    const b0 = findB(id);
    if (st === 'cancelled' && !confirm('Cancel this booking and free the slot?')) return false;
    if (st === 'no_show' && !confirm(`Mark "Reached – patient not available"?\n\nA ${money(CFG.visitFee)} visit fee will be due before the patient can rebook.`)) return false;
    try {
      await post(`/api/admin/bookings/${id}/status`, { status: st });
      await refreshAll();
      const b = findB(id) || b0;
      if (st === 'confirmed') openMsg({ b, kind: 'confirm', title: 'Payment confirmed ✓', sub: `Send the confirmation to ${b.name} · +91 ${b.phone}`, text: msgText(b, 'confirm') });
      else if (st === 'no_show') { sendWa(id, 'missed'); }
      else if (!opts.quiet) toast('Updated');
      else toast('Marked as not sent');
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  async function block(date, slot, on) {
    if (!on && !confirm(`Unblock ${slotLabel(slot)} on ${fmt(date, { day: 'numeric', month: 'short' })}?`)) return;
    try { await post('/api/admin/block', { date, slot, block: on }); toast(on ? 'Slot blocked' : 'Slot unblocked'); await refreshAll(); }
    catch (e) { toast(e.message); }
  }

  // ---------- sample collected (vial no.) ----------
  let vialCtx = null;
  // then = the step to carry on with once the sample is marked collected (when jumping ahead from the steps pop-up)
  const THEN_LBL = { received: 'send "Sample received"', upload: 'upload reports', send: 'send reports' };
  function openVial(id, edit, then) {
    const b = findB(id); if (!b) return;
    vialCtx = { id, edit, force: false, then: then || null };
    $('#vialTitle').textContent = edit ? (b.vial_no ? 'Edit vial number' : 'Add vial number') : 'Sample collected';
    $('#vialSub').textContent = `${b.name} · ${fmtD(b.date)}, ${slotLabel(b.slot)}`;
    const notes = [];
    if (!edit && then) notes.push(`The sample has to be marked collected first – then you'll ${THEN_LBL[then]}.`);
    if (!edit && b.status === 'payment_submitted') notes.push('This also marks the payment as verified.');
    $('#vialNote').textContent = notes.join(' '); $('#vialNote').hidden = !notes.length;
    $('#vialSkip').hidden = !!edit;
    $('#vialNo').value = b.vial_no || ''; $('#vialErr').textContent = '';
    $('#vialSave').textContent = edit ? 'Save vial number' : then ? 'Save & continue' : 'Save & mark collected';
    $('#vialEg').textContent = (b.vial_no || 'AB1234') + '.pdf';
    $$('dialog[open]').forEach((x) => x.close());
    $('#vialDlg').showModal(); setTimeout(() => $('#vialNo').focus(), 50);
  }
  $('#vialNo').oninput = () => { if (vialCtx) vialCtx.force = false; $('#vialEg').textContent = (norm($('#vialNo').value) || 'AB1234') + '.pdf'; };
  async function saveVial(noVial) {
    const v = noVial ? '' : $('#vialNo').value.trim();
    if (!v && !noVial) { $('#vialErr').textContent = 'Enter the vial number (or continue without it).'; return; }
    const { id, edit, force, then } = vialCtx;
    $('#vialSave').disabled = $('#vialSkip').disabled = true;
    try {
      if (edit) await post(`/api/admin/bookings/${id}/vial`, { vial_no: v, force });
      else await post(`/api/admin/bookings/${id}/status`, { status: 'collected', vial_no: v, no_vial: noVial || undefined, force });
      $('#vialDlg').close();
      await refreshAll();
      const b = findB(id);
      if (edit || !b) toast('Vial number saved');
      else if (then) { toast(noVial ? 'Sample collected ✓ (add the vial no. later)' : 'Sample collected ✓'); runStep(id, then); }
      else { toast(noVial ? 'Sample collected ✓ – add the vial no. when you have it' : 'Sample collected ✓ – once the centre confirms, send "Sample received" to the patient'); openDetail(id); }
    } catch (err) {
      $('#vialErr').textContent = err.message + (err.code === 'dup_vial' ? ' Click save again to use it anyway.' : '');
      if (err.code === 'dup_vial') vialCtx.force = true;
    } finally { $('#vialSave').disabled = $('#vialSkip').disabled = false; }
  }
  $('#vialForm').onsubmit = (e) => { e.preventDefault(); saveVial(false); };
  $('#vialSkip').onclick = () => {
    if (!confirm('Mark the sample collected without a vial number?\n\nThe vial no. is needed to match the reports – the booking will show "vial no. missing" until you add it.')) return;
    saveVial(true);
  };

  // ---------- reports of one patient ----------
  async function uploadReport(id, file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error(`${file.name} is not a PDF`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB`);
    const r = await fetch(`/api/admin/bookings/${id}/reports`, { method: 'POST', body: file, headers: { 'content-type': 'application/pdf', 'x-admin-key': KEY, 'x-filename': encodeURIComponent(file.name) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    return j;
  }
  let repId = null, repPicked = null;
  function openReports(id) {
    repId = id; repPicked = null; $('#repErr').textContent = '';
    renderRepDlg();
    $$('dialog[open]').forEach((x) => x !== $('#repDlg') && x.close());
    if (!$('#repDlg').open) $('#repDlg').showModal();
  }
  function renderRepDlg() {
    const b = findB(repId); if (!b) return;
    const reps = reportsOf(b), can = AFTER_COLLECT.includes(b.status);
    if (!repPicked) repPicked = new Set(reps.filter((r) => !r.sent_at).map((r) => r.id));
    $('#repTitle').textContent = `Reports · ${b.name}`;
    $('#repSub').textContent = `${testNames(b)}${b.vial_no ? ' · vial ' + b.vial_no : ' · ⚠ vial no. missing'} · +91 ${b.phone}`;
    $('#repList').innerHTML = reps.length ? `<ul class="rp-l">${reps.map((r) => `<li class="rp">
<label><input type="checkbox" data-rp="${r.id}" ${repPicked.has(r.id) ? 'checked' : ''}><span><b>📄 ${esc(r.name)}</b><small>${kb(r.size)} · uploaded ${when(r.created_at)}${r.sent_at ? ` · <span class="m-ok">sent ${when(r.sent_at)}</span>` : ' · not sent yet'}</small></span></label>
<span class="rp-a"><button type="button" class="btn ghost sm" data-act="rp-view" data-rid="${r.id}">View</button><button type="button" class="btn warn sm" data-act="rp-del" data-rid="${r.id}" aria-label="Delete ${esc(r.name)}">Delete</button></span></li>`).join('')}</ul>` : '<p class="meta" style="margin:0 0 10px">No reports uploaded yet.</p>';
    $('#repDrop').hidden = !can; $('#repLocked').hidden = can;
    const n = repPicked.size;
    $('#repSend').disabled = !n;
    $('#repSend').textContent = n ? `Send ${n} report${n === 1 ? '' : 's'} on WhatsApp` : 'Tick the reports to send';
    $('#repDone').hidden = b.status !== 'report_ready';
  }
  $('#repList').addEventListener('change', (e) => { const id = Number(e.target.dataset.rp); if (!id) return; e.target.checked ? repPicked.add(id) : repPicked.delete(id); renderRepDlg(); });
  async function addRepFiles(files) {
    const list = Array.from(files); if (!list.length) return;
    $('#repErr').textContent = ''; let ok = 0;
    for (const [i, f] of list.entries()) {
      $('#repErr').innerHTML = `<span class="meta">Uploading ${i + 1} of ${list.length}: ${esc(f.name)}…</span>`;
      try { const r = await uploadReport(repId, f); ok++; repPicked && repPicked.add(r.id); }
      catch (e) { $('#repErr').textContent = e.message; await new Promise((r) => setTimeout(r, 1200)); }
    }
    await refreshAll(); renderRepDlg();
    if (ok) { $('#repErr').innerHTML = `<span class="m-ok">${ok} report${ok === 1 ? '' : 's'} uploaded ✓</span>`; }
  }
  $('#repFiles').onchange = () => { const f = $('#repFiles').files; addRepFiles(f).finally(() => ($('#repFiles').value = '')); };
  const drop = $('#repDrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addRepFiles(e.dataTransfer.files); });
  $('#repSend').onclick = () => {
    const b = findB(repId); if (!b) return;
    const files = reportsOf(b).filter((r) => repPicked.has(r.id)); if (!files.length) return;
    openWhatsApp(b.phone, msgText(b, 'report', null, files));
    $('#repDlg').close();
    logSent(b, 'report', { reportIds: files.map((f) => f.id) });
  };
  $('#repDone').onclick = () => { const id = repId; $('#repDlg').close(); setStatus(id, 'completed'); };
  async function viewReportFile(rid) {
    const w = window.open('', '_blank');
    try {
      const r = await fetch(`/api/admin/reports/${rid}`, { headers: { 'x-admin-key': KEY } });
      if (!r.ok) throw new Error('Report not found');
      const u = URL.createObjectURL(await r.blob());
      if (w) w.location = u; else window.open(u, '_blank');
    } catch (e) { if (w) w.close(); toast(e.message); }
  }
  async function deleteReportFile(rid) {
    const b = findB(repId), f = b && reportsOf(b).find((r) => r.id === rid);
    if (!confirm(`Delete "${f ? f.name : 'this report'}"? It will be removed from our records.`)) return;
    try { await api(`/api/admin/reports/${rid}`, { method: 'DELETE' }); repPicked && repPicked.delete(rid); await refreshAll(); renderRepDlg(); toast('Report deleted'); }
    catch (e) { $('#repErr').textContent = e.message; }
  }

  // ---------- tests / packages ----------
  async function loadPkgs() {
    const r = await api('/api/admin/packages');
    PKGS = r.packages;
    renderPkgs();
  }
  function renderPkgs() {
    const q = ($('#pkgSearch').value || '').trim().toLowerCase();
    const rows = PKGS.filter((p) => !q || (p.name + ' ' + (p.tests || '')).toLowerCase().includes(q));
    $('#pkgBody').innerHTML = rows.length ? rows.map((p) => `<tr class="${p.active ? '' : 'off'}">
<td><b>${esc(p.name)}</b><span class="tests">${esc(p.tests || '—')}</span>${p.prep ? `<span class="prep"><b>Before the test:</b> ${esc(p.prep).replace(/\n/g, ' ')}</span>` : '<span class="prep none">No "before the test" instructions</span>'}</td>
<td class="num">${p.mrp ? money(p.mrp) : '—'}</td>
<td class="num"><b>${money(p.price)}</b></td>
<td class="num">${p.margin != null ? money(p.margin) : '—'}</td>
<td>${esc(p.target || '—')}</td>
<td class="num">${p.bookings || 0}</td>
<td>${p.is_default ? '<span class="badge web">Website test</span>' : ''}<span class="badge ${p.active ? 'on' : 'off'}">${p.active ? 'Active' : 'Hidden'}</span></td>
<td><button type="button" class="btn ghost sm" data-act="pkg-edit" data-pid="${p.id}">Edit</button></td></tr>`).join('')
      : '<tr><td colspan="8" class="meta" style="padding:18px">No tests match.</td></tr>';
    $('#pkgCount').textContent = `${PKGS.filter((p) => p.active).length} active · ${PKGS.filter((p) => !p.active).length} hidden`;
  }
  $('#pkgSearch').oninput = renderPkgs;
  let pkgEditing = null;
  function openPkg(id) {
    const p = id ? PKGS.find((x) => x.id === id) : null;
    pkgEditing = p ? p.id : null;
    $('#pkgForm').reset(); $('#pkgErr').textContent = '';
    $('#pkgTitle').textContent = p ? `Edit ${p.name}` : 'Add test';
    $('#pName').value = p ? p.name : ''; $('#pTests').value = p ? p.tests || '' : '';
    $('#pPrice').value = p ? p.price : ''; $('#pMrp').value = p && p.mrp != null ? p.mrp : '';
    $('#pMargin').value = p && p.margin != null ? p.margin : ''; $('#pTarget').value = p ? p.target || '' : '';
    $('#pPrep').value = p ? p.prep || '' : '• Our phlebotomist will call you before arriving';
    $('#pActive').checked = p ? !!p.active : true; $('#pDefault').checked = p ? !!p.is_default : false;
    $('#pkgDel').hidden = !p;
    $$('dialog[open]').forEach((d) => d.close());
    $('#pkgDlg').showModal(); setTimeout(() => $('#pName').focus(), 50);
  }
  $('#pkgForm').onsubmit = async (e) => {
    e.preventDefault(); $('#pkgErr').textContent = '';
    const body = { name: $('#pName').value, tests: $('#pTests').value, price: $('#pPrice').value, mrp: $('#pMrp').value, margin: $('#pMargin').value, target: $('#pTarget').value, prep: $('#pPrep').value, active: $('#pActive').checked, is_default: $('#pDefault').checked };
    $('#pkgSave').disabled = true;
    try {
      await post(pkgEditing ? `/api/admin/packages/${pkgEditing}` : '/api/admin/packages', body);
      $('#pkgDlg').close(); toast(pkgEditing ? 'Test updated' : 'Test added');
      await loadPkgs();
    } catch (err) { $('#pkgErr').textContent = err.message; }
    finally { $('#pkgSave').disabled = false; }
  };
  $('#pkgDel').onclick = async () => {
    const p = PKGS.find((x) => x.id === pkgEditing); if (!p) return;
    if (!confirm(`Delete "${p.name}"? This can't be undone.`)) return;
    try { await api(`/api/admin/packages/${p.id}`, { method: 'DELETE' }); $('#pkgDlg').close(); toast('Test deleted'); await loadPkgs(); }
    catch (err) { $('#pkgErr').textContent = err.message; }
  };

  // ---------- add / reschedule form ----------
  let form = { mode: 'add', id: null, fee: false };
  async function fillSlots(date, keep, ownId) {
    const sel = $('#fSlot'), cur = sel.value;
    const city = form.mode === 'add' ? $('#fCity').value.trim() : form.city || '';
    sel.innerHTML = '<option>Loading…</option>';
    try {
      const r = await api(`/api/admin/bookings?from=${date}&to=${date}&all=1`);
      const blocked = new Set(r.bookings.filter((b) => b.status === 'blocked').map((b) => b.slot));
      const n = {}; r.bookings.filter((b) => HOLD.includes(b.status) && b.id !== ownId && cityKey(b.city) === cityKey(city)).forEach((b) => (n[b.slot] = (n[b.slot] || 0) + 1));
      const want = keep || cur;
      sel.innerHTML = SLOTS.map((s) => {
        const c = n[s] || 0, off = blocked.has(s) || c >= CAP();
        const note = blocked.has(s) ? ' (blocked)' : c >= CAP() ? ` (full${city ? ' for ' + city : ''})` : c ? ` (${c} booked${city ? ' in ' + city : ''})` : '';
        return `<option value="${s}" ${off ? 'disabled' : ''} ${s === want ? 'selected' : ''}>${slotLabel(s)}${note}</option>`;
      }).join('');
      if (!sel.selectedOptions[0] || sel.selectedOptions[0].disabled) { const free = $$('option:not([disabled])', sel)[0]; if (free) free.selected = true; }
    } catch (e) { sel.innerHTML = ''; toast(e.message); }
  }
  let cityT; $('#fCity').addEventListener('input', () => { clearTimeout(cityT); cityT = setTimeout(() => fillSlots($('#fDate').value, null, form.id), 400); });
  function openForm(mode, ctx) {
    form = { mode, id: ctx.id || null, fee: mode === 'move' && ctx.status === 'no_show', city: ctx.city || '' };
    $('#bkForm').reset(); $('#formErr').textContent = '';
    $$('.add-only', $('#bkForm')).forEach((el) => (el.hidden = mode !== 'add'));
    $$('.tests-f', $('#bkForm')).forEach((el) => (el.hidden = !(mode === 'add' || mode === 'tests')));
    $$('.slot-f', $('#bkForm')).forEach((el) => (el.hidden = mode === 'tests'));
    $$('.fee-only', $('#bkForm')).forEach((el) => (el.hidden = !form.fee));
    $('#fFeeLbl').textContent = `${money(ctx.fee_due || CFG.visitFee)} visit fee received`;
    if (mode === 'add') { $('#formTitle').textContent = 'Add booking'; $('#formSub').textContent = 'For phone or walk-in bookings'; $('#formSave').textContent = 'Save booking'; }
    else if (mode === 'tests') { $('#formTitle').textContent = `Tests for ${ctx.name}`; $('#formSub').textContent = `${fmtD(ctx.date)} · ${slotLabel(ctx.slot)} · currently ${money(ctx.amount)}`; $('#formSave').textContent = 'Save tests'; }
    else { $('#formTitle').textContent = `${form.fee ? 'Rebook' : 'Reschedule'} ${ctx.name}`; $('#formSub').textContent = `Currently ${fmtD(ctx.date)} · ${slotLabel(ctx.slot)}`; $('#formSave').textContent = form.fee ? 'Rebook' : 'Move booking'; }
    $('#tSearch').value = '';
    if (mode === 'add') {
      const def = PKGS.find((p) => p.active && p.is_default) || PKGS.find((p) => p.active);
      pick = new Set(def ? [def.id] : []); amtTouched = false; renderPick();
      if (!PKGS.length) loadPkgs().then(() => { const d = PKGS.find((p) => p.active && p.is_default); if (d && !pick.size) pick.add(d.id); renderPick(); }).catch(() => {});
    }
    if (mode === 'tests') {
      pick = new Set(testsOf(ctx).map((t) => t.package_id).filter(Boolean));
      const total = [...pick].reduce((a, id) => a + ((PKGS.find((p) => p.id === id) || {}).price || 0), 0);
      amtTouched = total !== ctx.amount; renderPick(); $('#fAmt').value = ctx.amount;
    }
    if (mode !== 'tests') {
      const date = mode === 'move' && ctx.date < ist() ? ist() : (ctx.date || ist());
      $('#fDate').value = date;
      fillSlots(date, mode === 'move' && ctx.date < ist() ? null : ctx.slot, form.id);
    }
    $$('dialog[open]').forEach((d) => d.close());
    $('#formDlg').showModal();
    setTimeout(() => (mode === 'add' ? $('#fName') : mode === 'tests' ? $('#tSearch') : $('#fDate')).focus(), 50);
  }
  // pick one or more tests
  let pick = new Set(), amtTouched = false;
  function renderPick() {
    const q = $('#tSearch').value.trim().toLowerCase();
    const shown = PKGS.filter((p) => (p.active || pick.has(p.id)) && (!q || (p.name + ' ' + (p.tests || '')).toLowerCase().includes(q)));
    $('#tList').innerHTML = shown.map((p) => `<label class="tp ${pick.has(p.id) ? 'on' : ''}"><input type="checkbox" data-tp="${p.id}" ${pick.has(p.id) ? 'checked' : ''}><span><b>${esc(p.name)}</b>${p.tests ? `<small>${esc(p.tests)}</small>` : ''}</span><em>${money(p.price)}</em></label>`).join('') || '<p class="meta" style="padding:8px 10px;margin:0">No test matches.</p>';
    const sel = PKGS.filter((p) => pick.has(p.id)), total = sel.reduce((a, p) => a + p.price, 0);
    $('#tSum').innerHTML = sel.length ? `<b>${sel.length} selected:</b> ${esc(sel.map((p) => p.name).join(', '))} · total ${money(total)}` : '<span class="m-no">Pick at least one test</span>';
    if (!amtTouched) $('#fAmt').value = sel.length ? total : '';
  }
  $('#tList').addEventListener('change', (e) => { const id = Number(e.target.dataset.tp); if (!id) return; e.target.checked ? pick.add(id) : pick.delete(id); renderPick(); });
  $('#tSearch').oninput = renderPick;
  $('#tSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('#fAmt').oninput = () => (amtTouched = true);
  function setState(name) {
    const sel = $('#fState'); if (!name) return;
    const want = name.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
    let o = $$('option', sel).find((x) => x.value && x.value.toLowerCase() === want);
    if (!o) { o = document.createElement('option'); o.value = o.textContent = name; sel.appendChild(o); }
    sel.value = o.value;
  }
  $('#fDate').onchange = () => fillSlots($('#fDate').value, $('#fSlot').value, form.id);
  $('#fPin').oninput = async () => {
    const v = $('#fPin').value.replace(/\D/g, '').slice(0, 6); $('#fPin').value = v;
    if (v.length !== 6) return;
    try {
      const r = await fetch('/api/pincode/' + v).then((x) => x.json());
      if (r.found) { $('#fCity').value = r.city; setState(r.state); fillSlots($('#fDate').value, null, form.id); }
      else toast('Pincode not found – enter city and state');
    } catch (e) {}
  };
  $('#bkForm').onsubmit = async (e) => {
    e.preventDefault(); $('#formErr').textContent = '';
    const fd = Object.fromEntries(new FormData($('#bkForm')).entries());
    if (form.fee && !$('#fFee').checked) { $('#formErr').textContent = 'Tick "visit fee received" once the patient has paid it.'; return; }
    const btn = $('#formSave'); btn.disabled = true;
    try {
      if (form.mode === 'add') {
        delete fd.feePaid;
        if (!pick.size) throw new Error('Pick at least one test.');
        if (!fd.state) throw new Error('Pick the state.');
        fd.package_ids = [...pick];
        await post('/api/admin/bookings', fd); toast('Booking added');
      }
      else if (form.mode === 'tests') {
        if (!pick.size) throw new Error('Pick at least one test.');
        await post(`/api/admin/bookings/${form.id}/tests`, { package_ids: [...pick], amount: $('#fAmt').value });
        toast('Tests updated');
      }
      else { await post(`/api/admin/bookings/${form.id}/move`, { date: fd.date, slot: fd.slot, feePaid: form.fee ? true : undefined }); }
      $('#formDlg').close();
      if (form.mode === 'move' && cal.view !== 'week') cal.anchor = fd.date;
      await refreshAll();
      if (form.mode === 'tests') openDetail(form.id);
      if (form.mode === 'move') {
        const b = findB(form.id);
        if (b) openMsg({ b, kind: 'confirm', title: form.fee ? 'Rebooked ✓' : 'Booking moved ✓', sub: `Send the new time to ${b.name} · +91 ${b.phone}`, text: msgText(b, 'confirm') });
      }
    } catch (err) { $('#formErr').textContent = err.message; }
    finally { btn.disabled = false; }
  };

  // ---------- one click handler for every action (list, calendar, panels, dialogs) ----------
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) { $('#' + c.dataset.close).close(); return; }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) { const row = e.target.closest('tr[data-row]'); if (row && !e.target.closest('a,button,select,input')) openDetail(row.dataset.row); return; }
    if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    const a = el.dataset.act, id = el.dataset.id;
    if (a === 'status') setStatus(id, el.dataset.st);
    else if (a === 'shot') viewShot(id);
    else if (a === 'wa') sendWa(id, el.dataset.kind);
    else if (a === 'collect') openVial(id, false);
    else if (a === 'vial-edit') openVial(id, true);
    else if (a === 'reports') openReports(id);
    else if (a === 'steps') openSteps(id);
    else if (a === 'step') runStep(id, el.dataset.key);
    else if (a === 'step-mark') markStep(id, el.dataset.kind, false);
    else if (a === 'step-unmark') markStep(id, el.dataset.kind, true);
    else if (a === 'rp-view') viewReportFile(Number(el.dataset.rid));
    else if (a === 'rp-del') deleteReportFile(Number(el.dataset.rid));
    else if (a === 'tests-edit') { const b = findB(id); if (b) openForm('tests', b); }
    else if (a === 'pkg-add') openPkg(null);
    else if (a === 'pkg-edit') openPkg(Number(el.dataset.pid));
    else if (a === 'move') { const b = findB(id); if (b) openForm('move', b); }
    else if (a === 'add') openForm('add', { date: el.dataset.date || (tab === 'calendar' ? cal.anchor : ist()), slot: el.dataset.slot });
    else if (a === 'block') block(el.dataset.date, el.dataset.slot, true);
    else if (a === 'unblock') block(el.dataset.date, el.dataset.slot, false);
    else if (a === 'slotlist') { tip.hidden = true; openSlotList(el.dataset.date, el.dataset.slot); }
    else if (a === 'sel') { cal.sel = id; if (window.innerWidth < 1180) openDetail(id); else renderCal(); }
    else if (a === 'open') openDetail(id);
    else if (a === 'nav') {
      const dir = Number(el.dataset.dir);
      cal.anchor = cal.view === 'day' ? addDays(cal.anchor, dir) : cal.view === 'week' ? addDays(cal.anchor, 7 * dir) : addMonths(cal.anchor, dir);
      cal.mm = monthStart(cal.anchor); loadCal().catch((x) => toast(x.message));
    }
    else if (a === 'today') { cal.anchor = ist(); cal.mm = monthStart(cal.anchor); loadCal().catch((x) => toast(x.message)); }
    else if (a === 'view') { cal.view = el.dataset.view; pref.set('view', cal.view); if (cal.view === 'month') cal.anchor = monthStart(cal.anchor); loadCal().catch((x) => toast(x.message)); }
    else if (a === 'mm') { cal.mm = addMonths(cal.mm, Number(el.dataset.dir)); loadCal().catch((x) => toast(x.message)); }
    else if (a === 'goday') { cal.view = 'day'; cal.anchor = el.dataset.date; cal.mm = monthStart(cal.anchor); loadCal().catch((x) => toast(x.message)); }
    else if (a === 'run-open') { detailId = null; $('#detailBody').innerHTML = runSheetHTML(cal.anchor); $('#detailDlg').showModal(); }
    else if (a === 'run-wa') openMsg({ title: 'Run sheet', sub: 'Pick the phlebotomist in WhatsApp', text: runText(cal.anchor) });
    else if (a === 'run-map') runMap(cal.anchor);
    else if (a === 'run-print') runPrint(cal.anchor);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.dbk[data-act]')) { e.preventDefault(); e.target.click(); }
  });
  $('#shotDlg').addEventListener('click', (e) => { if (e.target.id === 'shotDlg') $('#shotDlg').close(); });

  $('#refresh').onclick = () => refreshAll().then(() => toast('Refreshed')).catch((e) => toast(e.message));
  $('#csv').onclick = async () => {
    try {
      const r = await fetch('/api/admin/export.csv', { headers: { 'x-admin-key': KEY } }); if (!r.ok) throw new Error('Export failed');
      const u = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = u; a.download = `bookings_${ist()}.csv`; a.click(); URL.revokeObjectURL(u);
    } catch (e) { toast(e.message); }
  };
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (tab === 'calendar' && window.innerWidth < 960 && cal.view === 'week') loadCal().catch(() => {}); }, 250); });
  setInterval(() => { if (KEY && !document.hidden && !$$('dialog[open]').length) refreshAll().catch(() => {}); }, 60000);

  // a visible close (×) on every pop-up
  $$('dialog.dlg').forEach((d) => {
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.dataset.close = d.id; x.setAttribute('aria-label', 'Close'); x.innerHTML = '&times;';
    d.prepend(x);
  });

  if (KEY) refreshAll().then(() => { $('#app').hidden = false; showTab(tab); }).catch(() => logout());
  else $('#login').hidden = false;
})();
