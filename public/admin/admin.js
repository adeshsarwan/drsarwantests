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
  let attTab = null;
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
    await load();
    loadPkgs().catch(() => {});
    if (tab === 'calendar' || cal.data) await loadCal();
    if (detailId && $('#detailDlg').open) { const b = findB(detailId); if (b) $('#detailBody').innerHTML = detailHTML(b); }
  }

  // ================= WORKFLOW (shared by list, calendar, detail) =================
  const sentMap = (b) => {
    const m = {};
    String(b.msgs || '').split(',').filter(Boolean).forEach((x) => { const i = x.indexOf('@'); const k = x.slice(0, i), at = x.slice(i + 1); if (!m[k] || at > m[k]) m[k] = at; });
    return m;
  };
  const hasPaidProof = (b) => !!(b.has_proof || b.utr);
  const pkgOf = (b) => PKGS.find((p) => p.id === b.package_id);
  const testLine = (b) => (b.package_name ? `<span class="test-l">🧪 ${esc(b.package_name)}</span>` : '');

  // The one most useful next action for a booking
  function nextStep(b, small = true) {
    const sm = small ? ' sm' : '';
    switch (b.status) {
      case 'pending': case 'expired':
        return hasPaidProof(b) ? `<button class="btn${sm}" data-act="status" data-id="${b.id}" data-st="confirmed">Confirm payment</button>`
          : `<button class="btn wa${sm}" data-act="wa" data-kind="pay" data-id="${b.id}">Payment reminder</button>`;
      case 'payment_submitted': return `<button class="btn${sm}" data-act="status" data-id="${b.id}" data-st="confirmed">Confirm payment</button>`;
      case 'confirmed': return `<button class="btn blue${sm}" data-act="collect" data-id="${b.id}">Sample collected</button>`;
      case 'collected': return `<button class="btn purple${sm}" data-act="report-one" data-id="${b.id}">Upload report</button>`;
      case 'report_ready': return `<button class="btn wa${sm}" data-act="wa" data-kind="report" data-id="${b.id}">Send report</button>`;
      case 'no_show': return `<button class="btn dark${sm}" data-act="move" data-id="${b.id}">Rebook (${money(b.fee_due || CFG.visitFee)} fee)</button>`;
      case 'completed': return '<span class="m-ok">Done ✓</span>';
      default: return '';
    }
  }

  const STAGES = ['Booked', 'Paid', 'Confirmed', 'Collected', 'Report', 'Sent'];
  function tracker(b) {
    const at = { pending: 0, expired: 0, payment_submitted: 1, confirmed: 2, no_show: 3, collected: 3, report_ready: 4, completed: 6 }[b.status];
    if (at == null) return '';
    return `<div class="track">${STAGES.map((s, i) => {
      let c = i < at || (b.status === 'completed') ? 'done' : i === at ? 'now' : '';
      if (b.status === 'no_show' && i === 3) { c = 'bad'; s = 'Not avail.'; }
      if (b.status === 'collected' && i === 3) c = 'done';
      if (b.status === 'report_ready' && i === 4) c = 'done';
      if (b.status === 'payment_submitted' && i === 1) c = 'done';
      return `<span class="${c}"><i></i>${s}</span>`;
    }).join('')}</div>`;
  }

  // ---------- WhatsApp messages ----------
  const MSG = {
    pay: 'Payment reminder', confirm: 'Booking confirmation', reminder: 'Visit reminder', slots: 'Suggest new slots',
    missed: 'Missed visit · fee & new slots', collected: 'Sample collected', report: 'Send report', chat: 'Open chat',
  };
  function msgKinds(b) {
    const s = b.status, k = [];
    if (['pending', 'expired'].includes(s)) k.push('pay', 'slots');
    if (s === 'payment_submitted') k.push('slots');
    if (s === 'confirmed') k.push('confirm', 'reminder', 'slots');
    if (s === 'no_show') k.push('missed');
    if (['collected', 'report_ready', 'completed'].includes(s)) k.push('collected');
    if (['report_ready', 'completed'].includes(s)) k.push('report');
    k.push('chat');
    return k;
  }
  function suggestedKind(b) {
    const sent = sentMap(b);
    return { pending: 'pay', expired: 'pay', confirmed: sent.confirm ? 'reminder' : 'confirm', no_show: 'missed', collected: sent.collected ? null : 'collected', report_ready: 'report' }[b.status] || null;
  }
  const NEEDS_SLOTS = ['slots', 'missed'];
  const dayWord = (d) => (d === ist() ? 'today' : d === addDays(ist(), 1) ? 'tomorrow' : 'on ' + fmtD(d));
  const reportLink = (b) => `${location.origin}/api/report/${b.report_token}`;

  function msgText(b, kind, sug) {
    const hi = `Hi ${b.name.split(' ')[0]} 👋`;
    const sign = '— Dr. Sarwan Diagnostic Labs · 8368143677';
    const list = (sug || []).map((s, i) => `${i + 1}) ${fmtD(s.date)}, ${slotLabel(s.slot)}`).join('\n');
    switch (kind) {
      case 'pay': return [hi, `We received your request for *${b.package_name || 'a home blood test'}* on *${fmtD(b.date)}, ${slotLabel(b.slot)}*, but your payment hasn't reached us yet.`, '',
        `Your slot is reserved only after payment. Please pay *${money(b.amount || CFG.amount)}* by UPI to *${CFG.upiId || 'our UPI ID'}* and reply here with the payment screenshot.`, '',
        'Want a different time? Just reply here.', sign].join('\n');
      case 'confirm': return confirmText(b);
      case 'reminder': return [hi, `Reminder: our phlebotomist will visit you *${dayWord(b.date)}, ${slotLabel(b.slot)}*${b.package_name ? ` for your *${b.package_name}* test` : ''}.`, `📍 ${fullAddr(b)}`, '',
        'Please fast for 10–12 hours before the test (water is fine). Our phlebotomist will call you before arriving.', '', 'Need to change the time? Reply here.', sign].join('\n');
      case 'slots': return [hi, (isPast(b.date, b.slot) || OCCUPY.includes(b.status)) ? `We need to find you a new time for your home blood test.` : `The slot you picked (${fmtD(b.date)}, ${slotLabel(b.slot)}) is no longer available.`, '',
        'These slots are free:', list || '(no free slots in the next few days – please call us)', '', 'Reply with the number of the slot that suits you and we\'ll book it.', sign].join('\n');
      case 'missed': return [hi, `Our phlebotomist reached your address ${b.missed_slot ? `on ${fmtD(b.missed_slot.slice(0, 10))} at ${fmtT(slotMin(b.missed_slot.slice(11)))}` : ''} but couldn't reach you, so the sample could not be collected.`, '',
        `To rebook, a visit fee of *${money(b.fee_due || CFG.visitFee)}* applies. Please pay it by UPI to *${CFG.upiId || 'our UPI ID'}* and send the screenshot here with the slot you want:`, list || '(please call us for a slot)', sign].join('\n');
      case 'collected': return [hi, 'Your blood sample has been collected ✅', b.vial_no ? `Vial no.: *${b.vial_no}*` : null, '',
        "We'll send your report here on WhatsApp as soon as it's ready.", sign].filter((x) => x !== null).join('\n');
      case 'report': return [hi, `Your ${b.package_name ? b.package_name + ' ' : 'test '}report is ready 📄`, '', `Download: ${reportLink(b)}`, b.vial_no ? `Vial no.: ${b.vial_no}` : null, '',
        'Please share it with your doctor. Questions? Reply here or call 8368143677.', sign].filter((x) => x !== null).join('\n');
      default: return '';
    }
  }
  function confirmText(b) {
    return [`Hi ${b.name}! 👋`, 'Your home blood test with *Dr. Sarwan Diagnostic Labs* is *confirmed* ✅', '',
      `🧾 Booking ref: ${b.id}`, `📅 Date: ${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`, `⏰ Time: ${slotLabel(b.slot)}`,
      `📍 Address: ${fullAddr(b)}`, `💳 Payment of ${money(b.amount)} received. Thank you!`,
      `🧪 Test: ${b.package_name || 'Blood test'}${pkgOf(b) && pkgOf(b).tests ? ` (${pkgOf(b).tests})` : ''}`, '',
      'Before the test:', '• Fast for 10–12 hours overnight (water is fine)', '• Our phlebotomist will call you before arriving', '',
      'Need to reschedule? Call/WhatsApp 8368143677.'].join('\n');
  }

  async function suggestSlots(b, n = 3) {
    const start = b.date > ist() && b.status !== 'no_show' ? b.date : ist();
    const dates = (CFG.dates || []).filter((d) => d >= start).slice(0, 7);
    const out = [];
    for (const d of dates) {
      try {
        const r = await fetch('/api/slots?date=' + d).then((x) => x.json());
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

  async function logSent(b, kind) {
    try {
      const r = await post(`/api/admin/bookings/${b.id}/sent`, { kind });
      await refreshAll();
      if (r.completed) toast('Report sent · job marked completed ✓', { label: 'Undo', fn: () => setStatus(b.id, 'report_ready', { quiet: true }) });
      else if (kind !== 'chat') toast(`${MSG[kind]} opened in WhatsApp`);
    } catch (e) { toast(e.message); }
  }

  // one click: open WhatsApp with the message (slot suggestions are looked up first, in a preview)
  async function sendWa(id, kind) {
    const b = findB(id); if (!b) return;
    if (kind === 'chat') { openWhatsApp(b.phone, ''); return; }
    if (kind === 'report' && !b.report_token) { toast('Upload the report first'); return; }
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
    if (!b) return `<div class="dt-empty"><b>Select a booking</b>Click any booking in the calendar to see the patient's details, the next step and WhatsApp messages here.</div>`;
    const s = ST[b.status], sent = sentMap(b), sug = suggestedKind(b);
    const f = [];
    if (b.status !== 'completed') { const ns = nextStep(b, false); if (ns) f.push(ns); }
    if (b.status === 'confirmed') f.push(`<button class="btn warn" data-act="status" data-id="${b.id}" data-st="no_show">Reached – patient not available</button>`);
    if (b.status === 'completed') f.push(`<button class="btn ghost" data-act="status" data-id="${b.id}" data-st="report_ready">Undo: report not sent</button>`);
    if (b.status === 'cancelled' && hasPaidProof(b)) f.push(`<button class="btn ghost" data-act="status" data-id="${b.id}" data-st="confirmed">Restore &amp; confirm</button>`);
    if (CANCELLABLE.includes(b.status)) f.push(`<button class="btn warn" data-act="status" data-id="${b.id}" data-st="cancelled">Cancel &amp; free slot</button>`);
    const payNote = b.status === 'payment_submitted' ? 'Payment submitted · check your Paytm app'
      : ['pending', 'expired'].includes(b.status) ? (hasPaidProof(b) ? 'Screenshot uploaded · slot not held' : 'Not paid yet · slot not reserved')
      : PAID.includes(b.status) ? 'Payment verified' : '—';
    return `<div class="dt-h">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div><div class="dt-name">${esc(b.name)}</div><div class="meta" style="margin-top:2px">Ref ${esc(b.id)}</div></div>
<span class="pill st-${b.status}" style="margin:0;flex:none">${s.label}</span></div>
${b.package_name ? `<div class="dt-test"><span class="dt-k">Test</span><b>${esc(b.package_name)}</b>${pkgOf(b) && pkgOf(b).tests ? `<span class="meta">${esc(pkgOf(b).tests)}</span>` : ''}</div>` : ''}
<div class="dt-when"><span>${fmtD(b.date)} · ${esc(slotLabel(b.slot))}</span>${MOVABLE.includes(b.status) ? `<button type="button" class="btn ghost sm" style="margin-left:auto" data-act="move" data-id="${b.id}">${b.status === 'no_show' ? 'Rebook' : 'Reschedule'}</button>` : ''}</div>
${tracker(b)}
</div>
<div class="dt-b">
${b.status === 'no_show' ? `<div class="fee">Phlebotomist reached${b.missed_slot ? ` on ${fmtD(b.missed_slot.slice(0, 10))}, ${fmtT(slotMin(b.missed_slot.slice(11)))}` : ''} – patient not available. <b>${money(b.fee_due || CFG.visitFee)} visit fee</b> is due before rebooking.</div>` : ''}
${b.fee_paid_at ? `<div class="meta">Visit fee ${money(b.fee_due)} received ${when(b.fee_paid_at)} · rebooked</div>` : ''}
<div class="dt-links"><a class="call" href="tel:+91${esc(b.phone)}">Call</a><a class="wa" href="#" data-act="wa" data-kind="chat" data-id="${b.id}">WhatsApp</a><a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></div>
${b.vial_no ? `<div class="kv"><div><div class="dt-k">Vial no.</div><div class="v">${esc(b.vial_no)}</div></div><button type="button" class="btn ghost sm" data-act="vial-edit" data-id="${b.id}">Edit</button></div>` : ''}
${b.report_name ? `<div class="kv"><div style="min-width:0"><div class="dt-k">Report</div><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${esc(b.report_name)}</div><div class="meta">${kb(b.report_size || 0)} · uploaded ${when(b.report_at)}</div></div><span style="display:flex;gap:6px;flex:none"><button type="button" class="btn ghost sm" data-act="report-view" data-id="${b.id}">View</button><button type="button" class="btn ghost sm" data-act="report-one" data-id="${b.id}">Replace</button></span></div>` : ''}
<div class="dt-sec"><div class="dt-k">WhatsApp messages</div><div class="wa-list">${msgKinds(b).map((k) => `<button type="button" class="wa-btn ${k === sug ? 'sug' : ''}" data-act="wa" data-kind="${k}" data-id="${b.id}"><span class="ic">✆</span><span><b>${MSG[k]}</b>${k === sug ? '<small>Suggested next</small>' : ''}</span>${sent[k] ? `<span class="ok">Sent ${when(sent[k])}</span>` : ''}</button>`).join('')}</div></div>
<div><div class="dt-k">Mobile</div><div style="font-weight:600;margin-top:2px">+91 ${esc(b.phone)}</div></div>
<div><div class="dt-k">Collection address</div><div style="margin-top:2px;line-height:1.45">${esc(b.address)}<br><b>${esc(b.city || '')}</b>${b.state ? ', ' + esc(b.state) : ''} – ${esc(b.pincode)}</div></div>
<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px"><div><div class="dt-k">Cycle</div><div style="margin-top:2px">${esc(b.cycle || '–')}</div></div><div><div class="dt-k">Source</div><div style="margin-top:2px">${esc(srcLabel(b.source))}</div></div></div>
<div class="pay"><div style="min-width:0;flex:1"><b>${money(b.amount)}</b><div class="meta">${payNote}${b.utr ? `<br>UTR ${esc(b.utr)}` : ''}</div></div>${b.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${b.id}">View screenshot</button>` : ''}</div>
${b.notes ? `<div><div class="dt-k">Notes</div><div style="margin-top:2px">${esc(b.notes)}</div></div>` : ''}
</div>
<div class="dt-f">${f.join('')}</div>`;
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
  async function load() {
    const today = ist();
    data = await api(`/api/admin/bookings?from=${addDays(today, -90)}&to=${addDays(today, 14)}&all=1`);
    renderBookings();
  }

  function card(b) {
    return `<div class="lrow"><div class="t">${fmtD(b.date)}<br><span class="meta">${esc(slotLabel(b.slot))}</span></div>
<div class="who"><div><button type="button" class="lnk n" data-act="open" data-id="${b.id}" style="background:none;border:0;padding:0;font:inherit;font-weight:700;font-size:16px;cursor:pointer;color:var(--ink)">${esc(b.name)}</button><span class="pill st-${b.status}">${ST[b.status].label}</span>${b.vial_no ? ` <span class="vial">${esc(b.vial_no)}</span>` : ''}${testLine(b)}</div>
<div class="meta"><a href="tel:+91${esc(b.phone)}">+91 ${esc(b.phone)}</a> · ${esc(b.city || '')} ${esc(b.pincode)} · ${money(b.amount)}${b.status === 'no_show' ? ` · <b style="color:#9b1c31">${money(b.fee_due || CFG.visitFee)} fee due</b>` : ''}${b.report_at ? ` · report ${when(b.report_at)}` : ''}${b.collected_at && !b.report_at ? ` · collected ${when(b.collected_at)}` : ''}</div>
<div class="acts">${nextStep(b)}${b.has_proof && ['payment_submitted', 'pending', 'expired'].includes(b.status) ? `<button class="btn ghost sm" data-act="shot" data-id="${b.id}">View screenshot</button>` : ''}<button class="btn ghost sm" data-act="open" data-id="${b.id}">Details &amp; messages</button></div></div></div>`;
  }

  function renderBookings() {
    const today = ist();
    const bookings = data.bookings.filter((b) => b.status !== 'blocked');
    const groups = [
      ['verify', 'Payments to verify', bookings.filter((b) => b.status === 'payment_submitted' || (['pending', 'expired'].includes(b.status) && hasPaidProof(b))), 'Open the screenshot, check the payment in your Paytm for Business app, then confirm.'],
      ['send', 'Reports to send', bookings.filter((b) => b.status === 'report_ready'), 'Click "Send report": WhatsApp opens with the download link and the job is marked completed.'],
      ['await', 'Waiting for report', bookings.filter((b) => b.status === 'collected'), 'Samples collected. Upload each report when the collection centre sends it (or use "Upload reports" at the top for many at once).'],
      ['noshow', 'Patient not available', bookings.filter((b) => b.status === 'no_show'), 'Send the missed-visit message, collect the visit fee, then rebook.'],
      ['unpaid', 'Unpaid bookings', bookings.filter((b) => b.status === 'pending' && b.date >= today && !hasPaidProof(b)), 'Booked on the website but not paid. The slot is not held. Send a payment reminder.'],
    ];
    const upcoming = bookings.filter((b) => b.date >= today && OCCUPY.includes(b.status));
    $('#stats').innerHTML = [
      [groups[0][2].length, 'Payments to verify'],
      [upcoming.filter((b) => b.date === today).length, 'Today'],
      [upcoming.filter((b) => b.date === addDays(today, 1)).length, 'Tomorrow'],
      [groups[2][2].length, 'Waiting for report'],
      [groups[1][2].length, 'Reports to send'],
      [money(revenue(bookings.filter((b) => b.date >= addDays(today, -30)))), 'Revenue (30 days + upcoming)'],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    if (!attTab || !groups.find((g) => g[0] === attTab)) attTab = (groups.find((g) => g[2].length) || groups[0])[0];
    $('#attTabs').innerHTML = groups.map(([k, l, list]) => `<button type="button" role="tab" data-att="${k}" aria-selected="${k === attTab}" class="${list.length ? '' : 'zero'}">${l}<b>${list.length}</b></button>`).join('');
    $$('[data-att]').forEach((x) => (x.onclick = () => { attTab = x.dataset.att; renderBookings(); }));
    const g = groups.find((x) => x[0] === attTab);
    const list = g[2].slice().sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
    $('#attention').innerHTML = `<p class="meta" style="margin:0 0 4px">${g[3]}</p>` + (list.length ? list.map(card).join('') : '<p class="meta" style="margin:0">Nothing here right now.</p>');
    renderTable();
  }

  function renderTable() {
    if (!data) return;
    const today = ist(), st = $('#fStatus').value, wh = $('#fWhen').value, q = $('#fSearch').value.trim().toLowerCase();
    let rows = data.bookings.filter((b) => b.status !== 'blocked');
    if (st === 'active') rows = rows.filter(live); else if (st !== 'all') rows = rows.filter((b) => b.status === st);
    if (wh === 'upcoming') rows = rows.filter((b) => b.date >= today); else if (wh === 'past') rows = rows.filter((b) => b.date < today);
    if (q) rows = rows.filter((b) => [b.name, b.phone, b.address, b.city, b.state, b.pincode, b.id, b.utr, b.vial_no, b.package_name].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => (wh === 'past' ? (b.date + b.slot).localeCompare(a.date + a.slot) : (a.date + a.slot).localeCompare(b.date + b.slot)));
    $('#tbody').innerHTML = rows.length ? rows.map((b) => `<tr class="row" data-row="${b.id}">
<td style="white-space:nowrap"><b>${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><small>${esc(slotLabel(b.slot))}</small><small>${esc(b.id)}</small></td>
<td><button type="button" class="lnk" data-act="open" data-id="${b.id}">${esc(b.name)}</button>${testLine(b)}${b.vial_no ? `<br><span class="vial">${esc(b.vial_no)}</span>` : ''}${b.cycle ? `<small>${esc(b.cycle)}</small>` : ''}</td>
<td style="white-space:nowrap"><a href="tel:+91${esc(b.phone)}">${esc(b.phone)}</a><small><a href="#" data-act="wa" data-kind="chat" data-id="${b.id}">WhatsApp</a></small></td>
<td class="addr">${esc(b.address)}<small>PIN ${esc(b.pincode)} · <a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></small>${b.notes ? `<small>Note: ${esc(b.notes)}</small>` : ''}</td>
<td>${esc(b.city || '–')}</td>
<td>${esc(b.state || '–')}</td>
<td class="num"><b>${money(b.amount)}</b>${b.utr ? `<small>UTR ${esc(b.utr)}</small>` : ''}${b.has_proof ? `<button class="btn ghost sm" style="margin-top:6px" data-act="shot" data-id="${b.id}">Screenshot</button>` : ''}</td>
<td><div class="next"><span class="pill st-${b.status}" style="margin:0">${ST[b.status].label}</span>${nextStep(b)}</div></td>
</tr>`).join('') : '<tr><td colspan="8" class="meta" style="padding:18px">No bookings match.</td></tr>';
    $('#tblCount').textContent = `${rows.length} booking${rows.length === 1 ? '' : 's'} · ${money(revenue(rows))} paid / submitted · click a name for details & WhatsApp messages`;
  }
  ['fStatus', 'fWhen'].forEach((id) => ($('#' + id).onchange = renderTable));
  $('#fSearch').oninput = renderTable;

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
  const occupant = (date, slot) => at(date, slot).find((b) => OCCUPY.includes(b.status));
  const dayBooked = (date) => cal.data.bookings.filter((b) => b.date === date && OCCUPY.includes(b.status) && b.status !== 'blocked').length;
  const fillColor = (n) => (n >= 8 ? '#e2603f' : '#1f8a6a');

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
    let free = 0; for (let d = vs; d <= ve; d = addDays(d, 1)) SLOTS.forEach((sl) => { if (!isPast(d, sl) && !occupant(d, sl)) free++; });
    const c = (s) => list.filter((b) => b.status === s).length;
    $('#railStatsTitle').textContent = cal.view === 'day' ? 'This day' : cal.view === 'month' ? 'This month' : 'This week';
    $('#railStats').innerHTML = `
<div class="rs"><b>${occ.length}</b><span>Bookings</span></div>
<div class="rs"><b>${free}</b><span>Free slots left</span></div>
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
    const list = at(date, slot), past = isPast(date, slot);
    const occ = list.find((b) => OCCUPY.includes(b.status));
    if (occ && occ.status === 'blocked') return `<button type="button" class="blk" data-act="unblock" data-date="${date}" data-slot="${slot}" title="Click to unblock">Blocked</button>`;
    let b = occ && shown(occ) ? occ : null, extra = '';
    if (!occ) {
      const pend = list.filter((x) => x.status === 'pending');
      if (pend.length && cal.filters.has('pending')) { b = pend[0]; if (pend.length > 1) extra = ` +${pend.length - 1}`; }
      else { const cx = list.find((x) => ['cancelled', 'expired'].includes(x.status)); if (cx && cal.filters.has('cancelled')) b = cx; }
    }
    if (!b) return occ ? '' : `<button type="button" class="fr" data-act="add" data-date="${date}" data-slot="${slot}" ${past ? 'disabled' : ''} aria-label="Free slot ${esc(slotLabel(slot))}, add booking">+</button>`;
    const s = ST[b.status];
    const cls = ['bk', b.id === cal.sel ? 'sel' : '', b.status === 'pending' ? 'dash' : '', ['cancelled', 'expired'].includes(b.status) ? 'cx' : ''].join(' ');
    return `<button type="button" class="${cls}" data-act="sel" data-id="${b.id}" style="background:${s.bg};border-left-color:${s.stripe}" title="${esc(b.package_name || '')}" aria-label="${esc(b.name)}, ${esc(b.package_name || '')}, ${esc(slotLabel(slot))}, ${s.label}">
<span class="nm">${esc(b.name)}</span><span class="ar">${b.vial_no ? '🧪 ' + esc(b.vial_no) : esc(b.city || '') + (b.pincode ? ' · ' + esc(b.pincode) : '')}</span><span class="tg" style="color:${s.fg}">${s.tag}${extra}${b.has_proof && b.status === 'payment_submitted' ? ' · 📎' : ''}</span></button>`;
  }

  function renderWeek() {
    const days = []; for (let i = 0; i < 7; i++) days.push(addDays(cal.anchor, i));
    const today = ist();
    let h = '<div class="wk"><div class="wk-grid"><div class="wk-h" style="cursor:default;border-left:0"></div>';
    days.forEach((d) => { const n = dayBooked(d); h += `<button type="button" class="wk-h ${d === today ? 'today' : ''}" data-act="goday" data-date="${d}" style="border-top:0;border-right:0"><div class="dw">${fmt(d, { weekday: 'short' })}</div><div class="dn">${fmt(d, { day: 'numeric' })}</div><div class="cap"><i style="width:${n * 10}%;background:${fillColor(n)}"></i></div><div class="cn"><b>${n}</b>/10 booked</div></button>`; });
    SLOTS.forEach((s) => {
      h += `<div class="wk-t">${fmtT(slotMin(s))}</div>`;
      days.forEach((d) => { h += `<div class="wk-c ${d === today ? 'today' : ''}">${cellHTML(d, s)}</div>`; });
    });
    $('#calMain').innerHTML = h + '</div></div>';
  }

  function runStops(date) {
    return cal.data.bookings.filter((b) => b.date === date && ['payment_submitted', 'confirmed'].includes(b.status)).sort((a, b) => a.slot.localeCompare(b.slot));
  }

  function renderDay() {
    const d = cal.anchor, list = cal.data.bookings.filter((b) => b.date === d);
    let strip = '';
    for (let i = -3; i <= 3; i++) {
      const x = addDays(d, i), n = dayBooked(x), on = i === 0;
      strip += `<button type="button" class="sd ${on ? 'on' : ''}" data-act="goday" data-date="${x}"><span class="l"><span>${fmt(x, { weekday: 'short', day: 'numeric' })}</span><b>${n}<small>/10</small></b></span><span class="bar"><i style="width:${n * 10}%;background:${n >= 8 ? '#e2603f' : on ? '#7fd1b9' : '#1f8a6a'}"></i></span></button>`;
    }
    const occ = list.filter((b) => OCCUPY.includes(b.status) && b.status !== 'blocked');
    const c = (s) => list.filter((b) => b.status === s).length;
    let rows = '';
    SLOTS.forEach((s) => {
      const all = list.filter((b) => b.slot === s), oc = all.find((b) => OCCUPY.includes(b.status)), past = isPast(d, s);
      const tm = `<div class="tm"><b>${fmtT(slotMin(s))}</b><small>to ${fmtT(slotMin(s) + 30)}</small></div>`;
      let body;
      if (oc && oc.status === 'blocked') body = `<div class="dblk">Blocked <button type="button" class="btn ghost sm" data-act="unblock" data-date="${d}" data-slot="${s}">Unblock</button></div>`;
      else if (oc && shown(oc)) {
        const st = ST[oc.status];
        body = `<div class="dbk" data-act="open" data-id="${oc.id}" style="border-left-color:${st.stripe};background:${['completed', 'collected'].includes(oc.status) ? '#fafbff' : '#fff'}" role="button" tabindex="0" aria-label="Open ${esc(oc.name)}">
<div class="p1"><b>${esc(oc.name)}</b><div>+91 ${esc(oc.phone)}</div>${testLine(oc)}${oc.vial_no ? `<span class="vial">${esc(oc.vial_no)}</span>` : ''}</div>
<div class="p2">${esc(oc.address)}<br><b style="color:#1b2a4e">${esc(oc.city || '')}</b> · ${esc(oc.pincode)}</div>
<span class="pill st-${oc.status}" style="margin:0">${st.label}</span>
<div class="acts" style="margin:0">${oc.status === 'payment_submitted' && oc.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${oc.id}">Screenshot</button>` : ''}${nextStep(oc)}</div></div>`;
      } else if (oc) body = `<div class="dfree">Booked (hidden by filter)</div>`;
      else body = `<div class="dfree">${past ? 'Free (past)' : `Free slot <button type="button" class="btn ghost sm" data-act="add" data-date="${d}" data-slot="${s}">+ Add booking</button><button type="button" class="btn warn sm" data-act="block" data-date="${d}" data-slot="${s}">Block</button>`}</div>`;
      rows += `<div class="drow">${tm}${body}</div>`;
      const pend = all.filter((b) => b.status === 'pending' && cal.filters.has('pending'));
      const cx = all.filter((b) => ['cancelled', 'expired'].includes(b.status) && cal.filters.has('cancelled'));
      if (pend.length || cx.length) rows += `<div class="extra">${pend.map((b) => `<button type="button" class="btn ghost sm" data-act="open" data-id="${b.id}">${esc(b.name)} · awaiting payment</button>`).join(' ')} ${cx.map((b) => `<button type="button" class="btn ghost sm" data-act="open" data-id="${b.id}" style="opacity:.7">${esc(b.name)} · ${ST[b.status].label.toLowerCase()}</button>`).join(' ')}</div>`;
    });
    $('#calMain').innerHTML = `<div class="strip">${strip}</div>
<div class="dsum">
<div class="ds"><b>${occ.length}<small style="font-size:14px;color:#8492a6">/10</small></b><span>Slots booked</span></div>
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
      const n = dayBooked(d), cnt = (st) => list.filter((b) => b.status === st).length;
      const v = cnt('payment_submitted'), p = cnt('pending'), r = cnt('report_ready'), w = cnt('collected');
      const out = d < s || d > e;
      h += `<button type="button" class="mo-c ${out ? 'out' : ''} ${d === today ? 'today' : ''}" data-act="goday" data-date="${d}" aria-label="${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${n} booked">
<span class="num">${Number(d.slice(8))}</span>
<span class="chips">${n ? `<span class="chip" style="background:${n >= 8 ? '#ffe3d9' : '#dff3ea'};color:${n >= 8 ? '#a33a1f' : '#17694a'}">${n}/10 booked</span>` : ''}${v ? `<span class="chip st-payment_submitted">${v} to verify</span>` : ''}${w ? `<span class="chip st-collected">${w} awaiting report</span>` : ''}${r ? `<span class="chip st-report_ready">${r} report to send</span>` : ''}${p && cal.filters.has('pending') ? `<span class="chip st-pending">${p} unpaid</span>` : ''}</span>
${n ? `<span class="cap" style="width:100%;margin:auto 0 0"><i style="width:${n * 10}%;background:${fillColor(n)}"></i></span>` : ''}</button>`;
    }
    $('#calMain').innerHTML = h + '</div></div>';
  }

  function runSheetHTML(date) {
    const stops = runStops(date);
    return `<div class="run-h"><div class="run-k">Phlebotomist run sheet</div><div class="run-t">${stops.length} pickup${stops.length === 1 ? '' : 's'} · ${fmtD(date)}</div><div class="meta" style="margin-top:2px">Confirmed + paid-to-verify bookings, in slot order</div></div>
<div class="run-b">${stops.length ? stops.map((b, i) => `<div class="stop"><div style="display:flex;flex-direction:column;align-items:center"><span class="n">${i + 1}</span><span class="ln"></span></div><div class="bd"><div style="font-weight:800">${fmtT(slotMin(b.slot))} · <a href="#" data-act="open" data-id="${b.id}" style="color:inherit">${esc(b.name)}</a></div><div style="font-size:12.5px;color:#3b4a68;margin-top:2px">${esc(b.address)}, ${esc(b.city || '')} · ${esc(b.pincode)}</div><div style="font-size:12px;color:#8492a6;margin-top:2px">${b.package_name ? esc(b.package_name) + ' · ' : ''}+91 ${esc(b.phone)}${b.status === 'payment_submitted' ? ' · payment to verify' : ''}</div></div></div>`).join('') : '<p class="meta">No confirmed pickups for this day yet.</p>'}</div>
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
  async function viewReport(id) {
    const w = window.open('', '_blank');
    try {
      const r = await fetch(`/api/admin/bookings/${id}/report`, { headers: { 'x-admin-key': KEY } });
      if (!r.ok) throw new Error('Report not found');
      const u = URL.createObjectURL(await r.blob());
      if (w) w.location = u; else window.open(u, '_blank');
    } catch (e) { if (w) w.close(); toast(e.message); }
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
  function openVial(id, edit) {
    const b = findB(id); if (!b) return;
    vialCtx = { id, edit, force: false };
    $('#vialSub').textContent = `${b.name} · ${fmtD(b.date)}, ${slotLabel(b.slot)}`;
    $('#vialNo').value = b.vial_no || ''; $('#vialErr').textContent = '';
    $('#vialSave').textContent = edit ? 'Save vial number' : 'Save & mark collected';
    $('#vialEg').textContent = (b.vial_no || 'AB1234') + '.pdf';
    $$('dialog[open]').forEach((x) => x.close());
    $('#vialDlg').showModal(); setTimeout(() => $('#vialNo').focus(), 50);
  }
  $('#vialNo').oninput = () => { if (vialCtx) vialCtx.force = false; $('#vialEg').textContent = (norm($('#vialNo').value) || 'AB1234') + '.pdf'; };
  $('#vialForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#vialNo').value.trim(); if (!v) { $('#vialErr').textContent = 'Enter the vial number.'; return; }
    const { id, edit, force } = vialCtx;
    $('#vialSave').disabled = true;
    try {
      if (edit) await post(`/api/admin/bookings/${id}/vial`, { vial_no: v, force });
      else await post(`/api/admin/bookings/${id}/status`, { status: 'collected', vial_no: v, force });
      $('#vialDlg').close();
      await refreshAll();
      const b = findB(id);
      if (!edit && b) openMsg({ b, kind: 'collected', title: 'Sample collected ✓', sub: `Let ${b.name} know · vial ${b.vial_no}`, text: msgText(b, 'collected') });
      else toast('Vial number saved');
    } catch (err) {
      $('#vialErr').textContent = err.message + (err.code === 'dup_vial' ? ' Click save again to use it anyway.' : '');
      if (err.code === 'dup_vial') vialCtx.force = true;
    } finally { $('#vialSave').disabled = false; }
  };

  // ---------- reports ----------
  async function uploadReport(id, file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error(`${file.name} is not a PDF`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB`);
    const r = await fetch(`/api/admin/bookings/${id}/report`, { method: 'POST', body: file, headers: { 'content-type': 'application/pdf', 'x-admin-key': KEY, 'x-filename': encodeURIComponent(file.name) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    return j;
  }
  let oneReportId = null;
  $('#oneReport').onchange = async () => {
    const f = $('#oneReport').files[0], id = oneReportId; $('#oneReport').value = '';
    if (!f || !id) return;
    const b0 = findB(id);
    if (b0 && b0.vial_no && !norm(f.name).includes(norm(b0.vial_no)) && !confirm(`The file name "${f.name}" doesn't contain vial no. ${b0.vial_no}.\n\nUpload it for ${b0.name} anyway?`)) return;
    toast('Uploading report…');
    try {
      await uploadReport(id, f);
      await refreshAll();
      const b = findB(id);
      openMsg({ b, kind: 'report', title: 'Report uploaded ✓', sub: `Send it to ${b.name} · +91 ${b.phone}. Sending marks the job completed.`, text: msgText(b, 'report') });
    } catch (e) { toast(e.message); }
  };

  // bulk upload: match "vial no." in each file name
  let repRows = [];
  const awaiting = () => (data ? data.bookings.filter((b) => b.vial_no && ['collected', 'report_ready', 'completed'].includes(b.status)) : []);
  function matchFile(name) {
    const n = norm(name);
    let best = null, tie = false;
    awaiting().forEach((b) => {
      const v = norm(b.vial_no);
      if (v.length >= 3 && n.includes(v)) {
        if (!best || v.length > norm(best.vial_no).length) { best = b; tie = false; } else if (v.length === norm(best.vial_no).length && best.id !== b.id) tie = true;
      }
    });
    return tie ? null : best;
  }
  function openReports() {
    repRows = []; renderRep();
    $$('dialog[open]').forEach((x) => x.close());
    $('#repDlg').showModal();
  }
  function addRepFiles(files) {
    Array.from(files).forEach((f) => { const m = matchFile(f.name); repRows.push({ file: f, id: m ? m.id : '', auto: !!m, state: '' }); });
    renderRep();
  }
  function renderRep() {
    const opts = awaiting().sort((a, b) => (a.status === 'collected' ? 0 : 1) - (b.status === 'collected' ? 0 : 1) || (b.date + b.slot).localeCompare(a.date + a.slot));
    $('#repList').innerHTML = repRows.length ? `<table class="rep-t"><tr><th>File</th><th>Patient</th><th></th></tr>${repRows.map((r, i) => `<tr>
<td style="word-break:break-all">📄 ${esc(r.file.name)}<br><span class="meta">${kb(r.file.size)}</span></td>
<td><select class="inp" data-rep="${i}" ${r.state === 'done' ? 'disabled' : ''}><option value="">— Not matched · pick patient —</option>${opts.map((b) => `<option value="${b.id}" ${b.id === r.id ? 'selected' : ''}>${esc(b.vial_no)} · ${esc(b.name)} · ${fmtD(b.date)}${b.report_name ? ' (has report)' : ''}</option>`).join('')}</select></td>
<td style="white-space:nowrap">${r.state === 'done' ? '<span class="m-ok">Uploaded ✓</span>' : r.state === 'busy' ? 'Uploading…' : r.state ? `<span class="m-no">${esc(r.state)}</span>` : r.id ? `<span class="m-ok">${r.auto ? 'Matched by vial no.' : 'Picked'}</span>` : '<span class="m-no">No match</span>'}</td></tr>`).join('')}</table>`
      : `<p class="meta" style="margin:12px 0 0">${awaiting().filter((b) => b.status === 'collected').length} patient(s) are waiting for a report.</p>`;
    $$('[data-rep]').forEach((s) => (s.onchange = () => { const r = repRows[+s.dataset.rep]; r.id = s.value; r.auto = false; renderRep(); }));
    const todo = repRows.filter((r) => r.id && r.state !== 'done');
    $('#repUpload').disabled = !todo.length;
    $('#repUpload').textContent = todo.length ? `Upload ${todo.length} report${todo.length === 1 ? '' : 's'}` : 'Upload';
  }
  $('#repFiles').onchange = () => { addRepFiles($('#repFiles').files); $('#repFiles').value = ''; };
  const drop = $('#repDrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addRepFiles(e.dataTransfer.files); });
  $('#repUpload').onclick = async () => {
    const ids = repRows.filter((r) => r.id && r.state !== 'done').map((r) => r.id);
    if (new Set(ids).size !== ids.length) { toast('Two files are matched to the same patient. Fix that first.'); return; }
    $('#repUpload').disabled = true;
    let ok = 0;
    for (const r of repRows) {
      if (!r.id || r.state === 'done') continue;
      r.state = 'busy'; renderRep();
      try { await uploadReport(r.id, r.file); r.state = 'done'; ok++; } catch (e) { r.state = e.message; }
      renderRep();
    }
    await refreshAll();
    if (ok) { attTab = 'send'; renderBookings(); toast(`${ok} report${ok === 1 ? '' : 's'} uploaded · send them from "Reports to send"`); }
  };

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
<td><b>${esc(p.name)}</b><span class="tests">${esc(p.tests || '—')}</span></td>
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
    $('#pActive').checked = p ? !!p.active : true; $('#pDefault').checked = p ? !!p.is_default : false;
    $('#pkgDel').hidden = !p;
    $$('dialog[open]').forEach((d) => d.close());
    $('#pkgDlg').showModal(); setTimeout(() => $('#pName').focus(), 50);
  }
  $('#pkgForm').onsubmit = async (e) => {
    e.preventDefault(); $('#pkgErr').textContent = '';
    const body = { name: $('#pName').value, tests: $('#pTests').value, price: $('#pPrice').value, mrp: $('#pMrp').value, margin: $('#pMargin').value, target: $('#pTarget').value, active: $('#pActive').checked, is_default: $('#pDefault').checked };
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
    const sel = $('#fSlot');
    sel.innerHTML = '<option>Loading…</option>';
    try {
      const r = await api(`/api/admin/bookings?from=${date}&to=${date}&all=1`);
      const occ = new Map(r.bookings.filter((b) => OCCUPY.includes(b.status) && b.id !== ownId).map((b) => [b.slot, b]));
      sel.innerHTML = SLOTS.map((s) => { const o = occ.get(s); return `<option value="${s}" ${o ? 'disabled' : ''} ${s === keep ? 'selected' : ''}>${slotLabel(s)}${o ? (o.status === 'blocked' ? ' (blocked)' : ' (booked)') : ''}</option>`; }).join('');
      if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) { const free = $$('option:not([disabled])', sel)[0]; if (free) free.selected = true; }
    } catch (e) { sel.innerHTML = ''; toast(e.message); }
  }
  function openForm(mode, ctx) {
    form = { mode, id: ctx.id || null, fee: mode === 'move' && ctx.status === 'no_show' };
    $('#bkForm').reset(); $('#formErr').textContent = '';
    $$('.add-only', $('#bkForm')).forEach((el) => (el.hidden = mode !== 'add'));
    $$('.fee-only', $('#bkForm')).forEach((el) => (el.hidden = !form.fee));
    $('#fFeeLbl').textContent = `${money(ctx.fee_due || CFG.visitFee)} visit fee received`;
    if (mode === 'add') { $('#formTitle').textContent = 'Add booking'; $('#formSub').textContent = 'For phone or walk-in bookings'; $('#formSave').textContent = 'Save booking'; }
    else { $('#formTitle').textContent = `${form.fee ? 'Rebook' : 'Reschedule'} ${ctx.name}`; $('#formSub').textContent = `Currently ${fmtD(ctx.date)} · ${slotLabel(ctx.slot)}`; $('#formSave').textContent = form.fee ? 'Rebook' : 'Move booking'; }
    const date = mode === 'move' && ctx.date < ist() ? ist() : (ctx.date || ist());
    if (mode === 'add') fillPkgSelect();
    if (mode === 'add' && !PKGS.length) loadPkgs().then(fillPkgSelect).catch(() => {});
    $('#fDate').value = date;
    fillSlots(date, mode === 'move' && ctx.date < ist() ? null : ctx.slot, form.id);
    $$('dialog[open]').forEach((d) => d.close());
    $('#formDlg').showModal();
    setTimeout(() => (mode === 'add' ? $('#fName') : $('#fDate')).focus(), 50);
  }
  function fillPkgSelect() {
    const act = PKGS.filter((p) => p.active);
    const def = act.find((p) => p.is_default) || act[0];
    $('#fPkg').innerHTML = act.map((p) => `<option value="${p.id}" ${def && p.id === def.id ? 'selected' : ''}>${esc(p.name)} – ${money(p.price)}</option>`).join('') || '<option value="">No tests – add one in the Tests tab</option>';
    pkgPicked();
  }
  function pkgPicked() {
    const p = PKGS.find((x) => String(x.id) === $('#fPkg').value);
    $('#fAmt').value = p ? p.price : '';
    $('#fPkgTests').textContent = p && p.tests ? p.tests : '';
  }
  $('#fPkg').onchange = pkgPicked;
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
      if (r.found) { $('#fCity').value = r.city; setState(r.state); }
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
        if (!fd.package_id) throw new Error('Pick the test.');
        if (!fd.state) throw new Error('Pick the state.');
        await post('/api/admin/bookings', fd); toast('Booking added');
      }
      else { await post(`/api/admin/bookings/${form.id}/move`, { date: fd.date, slot: fd.slot, feePaid: form.fee ? true : undefined }); }
      $('#formDlg').close();
      if (form.mode === 'move' && cal.view !== 'week') cal.anchor = fd.date;
      await refreshAll();
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
    else if (a === 'report-one') { oneReportId = id; $('#oneReport').click(); }
    else if (a === 'report-view') viewReport(id);
    else if (a === 'reports') openReports();
    else if (a === 'pkg-add') openPkg(null);
    else if (a === 'pkg-edit') openPkg(Number(el.dataset.pid));
    else if (a === 'move') { const b = findB(id); if (b) openForm('move', b); }
    else if (a === 'add') openForm('add', { date: el.dataset.date || (tab === 'calendar' ? cal.anchor : ist()), slot: el.dataset.slot });
    else if (a === 'block') block(el.dataset.date, el.dataset.slot, true);
    else if (a === 'unblock') block(el.dataset.date, el.dataset.slot, false);
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

  if (KEY) refreshAll().then(() => { $('#app').hidden = false; showTab(tab); }).catch(() => logout());
  else $('#login').hidden = false;
})();
