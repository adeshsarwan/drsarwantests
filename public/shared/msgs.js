// WhatsApp message texts – ONE place for both ways of sending:
//   • manual: the admin page opens WhatsApp with this text (wa.me)
//   • automatic: the server sends the same text through the WhatsApp Cloud API
// Loaded by the admin page (<script src="/shared/msgs.js">) and imported by the worker (src/worker.js).
// The admin can edit each text in Admin → Messages; these are the defaults.
//
// Text rules:
//   {{name}} etc. are filled in from the booking (see VARS).
//   A line whose {{…}} are all empty is left out.
//   If a line holding ONLY a {{value}} is empty, its whole paragraph (lines between blank lines) is left out –
//   e.g. "Before the test:" + {{prep}} disappears together when the test has no instructions.
(function (root) {
  'use strict';
  const SIGN = '— Dr. Sarwan Diagnostic Labs · 8368143677';

  // key: what the message is for. to: who gets it. meta: false = only sent inside an open chat (no WhatsApp template).
  // buttons: quick-reply buttons (WhatsApp only; with manual sending they're simply not there).
  const TEMPLATES = [
    { key: 'confirm', label: 'Booking confirmation', to: 'patient', wa_name: 'dsl_booking_confirmed',
      buttons: [{ id: 'prep', text: 'How to prepare' }, { id: 'menu', text: 'Menu' }],
      body: [
        'Hi {{name}}! 👋', 'Your home blood test with *Dr. Sarwan Diagnostic Labs* is *confirmed* ✅', '',
        '🧾 Booking ref: {{ref}}', '📅 Date: {{date_long}}', '⏰ Time: {{slot}}', '📍 Address: {{address}}',
        '💳 Payment of {{amount}} received. Thank you!', '🧪 Tests: {{tests_detail}}', '',
        'Before the test:', '{{prep}}', '(If your doctor gave you different instructions, follow your doctor.)', '',
        '📄 Your reports will also be on https://drsarwantests.com/reports/ (sign in with your mobile number and date of birth).', '',
        'Need to reschedule? Call/WhatsApp 8368143677.'].join('\n') },
    { key: 'center', label: 'Booking details to collection centre', to: 'centre', wa_name: 'dsl_centre_new_job',
      buttons: [{ id: 'c_accept', text: 'Accept' }, { id: 'c_decline', text: "Can't do" }],
      body: [
        '📋 *New home collection* – Dr. Sarwan Diagnostic Labs', '',
        'Ref: {{ref}}', 'Patient: {{name}} · +91 {{phone}}', 'Date: {{date_long}}', 'Time: {{slot}}',
        'Address: {{address}}', 'Map: {{map}}', 'Tests: {{tests}}', 'Notes: {{notes}}', '',
        'Please confirm the visit. 🙏'].join('\n') },
    { key: 'collector', label: 'Collector details to patient', to: 'patient', wa_name: 'dsl_collector_details',
      buttons: [{ id: 'prep', text: 'How to prepare' }, { id: 'resched', text: 'Change time' }],
      body: [
        'Hi {{first_name}} 👋', 'Your home sample collection on *{{date}}, {{slot}}* is all set.', '',
        '👤 Collector: {{collector}}', '🏥 Centre: {{centre}}', '',
        "They'll call you before arriving. Need to change the time? Reply here.", SIGN].join('\n') },
    { key: 'reminder', label: 'Visit reminder', to: 'patient', wa_name: 'dsl_visit_reminder',
      buttons: [{ id: 'prep', text: 'How to prepare' }, { id: 'resched', text: 'Change time' }],
      body: [
        'Hi {{first_name}} 👋', 'Reminder: our phlebotomist will visit you *{{day_word}}, {{slot}}* for your *{{tests}}*.', '📍 {{address}}', '',
        'Before the test:', '{{prep}}', '', 'Need to change the time? Reply here.', SIGN].join('\n') },
    { key: 'collected', label: 'Sample received at lab', to: 'patient', wa_name: 'dsl_sample_received', buttons: [],
      body: [
        'Hi {{first_name}} 👋', 'Your blood sample has reached our lab ✅', 'Vial no.: *{{vial}}*', '',
        "We'll send your reports here on WhatsApp as soon as they're ready.", SIGN].join('\n') },
    { key: 'report', label: 'Reports ready', to: 'patient', wa_name: 'dsl_report_ready',
      buttons: [{ id: 'report', text: 'Get my report' }],
      body: [
        'Hi {{first_name}} 👋', 'Your test results are ready 📄', '', '{{reports_list}}', '', 'Vial no.: {{vial}}',
        'Please share them with your doctor. Questions? Reply here or call 8368143677.', '',
        'You can open your reports any time on https://drsarwantests.com/reports/ with your mobile number and date of birth.', SIGN].join('\n') },
    { key: 'pay', label: 'Payment reminder', to: 'patient', wa_name: 'dsl_payment_reminder', buttons: [{ id: 'pay', text: 'How to pay' }],
      body: [
        'Hi {{first_name}} 👋', "We received your request for *{{tests}}* on *{{date}}, {{slot}}*, but your payment hasn't reached us yet.", '',
        'Your slot is reserved only after payment. Please pay *{{amount}}* by UPI to *{{upi_id}}* and reply here with the payment screenshot.', '',
        'Want a different time? Just reply here.', SIGN].join('\n') },
    { key: 'slots', label: 'Suggest new slots', to: 'patient', meta: false, buttons: [],
      body: [
        'Hi {{first_name}} 👋', '{{slots_reason}}', '', 'These slots are free:', '{{slots_list}}', '',
        "Reply with the number of the slot that suits you and we'll book it.", SIGN].join('\n') },
    { key: 'missed', label: 'Missed visit · fee & new slots', to: 'patient', meta: false, buttons: [],
      body: [
        'Hi {{first_name}} 👋', "Our phlebotomist reached your address {{missed_when}} but couldn't reach you, so the sample could not be collected.", '',
        'To rebook, a visit fee of *{{fee}}* applies. Please pay it by UPI to *{{upi_id}}* and send the screenshot here with the slot you want:',
        '{{slots_list}}', SIGN].join('\n') },
    { key: 'prep', label: 'How to prepare (sent when the patient asks)', to: 'patient', meta: false, buttons: [],
      body: ['Before your *{{tests}}*:', '{{prep}}', '', '(If your doctor gave you different instructions, follow your doctor.)'].join('\n') },
    { key: 'team_paid', label: 'Team: payment confirmed – choose centre', to: 'team', wa_name: 'dsl_team_new_paid',
      buttons: [{ id: 'o_assign', text: 'Choose centre' }],
      body: ['💳 Payment confirmed – please choose a collection centre', '', 'Booking {{ref}} · {{name}}', '📅 {{date}}, {{slot}}', '📍 {{city}}, PIN {{pincode}}', '🧪 {{tests}}', '', 'Tap the button to choose the centre.'].join('\n') },
    { key: 'team_alert', label: 'Team: alert', to: 'team', wa_name: 'dsl_team_alert', buttons: [],
      body: ['🔔 Dr. Sarwan Diagnostic Labs: {{alert}}', '', 'Booking {{ref}} · {{name}} · +91 {{phone}}', '', 'Open the admin page for details.'].join('\n') },
  ];

  const VARS = [
    ['name', "Patient's full name"], ['first_name', 'First name'], ['ref', 'Booking ref (DSL-…)'], ['phone', "Patient's mobile"],
    ['date', 'e.g. Sun, 18 Oct'], ['date_long', 'e.g. Sun, 18 Oct 2026'], ['day_word', 'today / tomorrow / on Sun, 18 Oct'], ['slot', 'e.g. 9:30 AM – 10:00 AM'],
    ['address', 'Full address with pincode'], ['city', 'City'], ['pincode', 'Pincode'], ['map', 'Google Maps link'],
    ['tests', 'Test names, comma separated'], ['tests_detail', 'Test name with what it includes (list if several)'], ['prep', '"Before the test" lines of the tests'],
    ['amount', 'e.g. ₹1,899'], ['upi_id', 'UPI ID'], ['fee', 'Visit fee after a missed visit'], ['missed_when', 'When the missed visit was'],
    ['notes', 'Booking notes'], ['vial', 'Vial no.'], ['centre', 'Collection centre name'], ['collector', 'Collector name, phone and time from the centre'],
    ['reports_list', 'Names of the reports being sent'], ['slots_reason', 'Why new slots are offered'], ['slots_list', 'Numbered free slots'], ['alert', 'Team alert text'],
  ];
  const MULTILINE = ['prep', 'slots_list', 'reports_list', 'tests_detail'];

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dt = (d) => new Date(d + 'T00:00:00Z');
  const fmtDate = (d) => (d ? `${DOW[dt(d).getUTCDay()]}, ${dt(d).getUTCDate()} ${MON[dt(d).getUTCMonth()]}` : '');
  const fmtLong = (d) => (d ? `${fmtDate(d)} ${dt(d).getUTCFullYear()}` : '');
  const tMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const fmtT = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const slotLabel = (s) => (s ? `${fmtT(tMin(s))} – ${fmtT(tMin(s) + 30)}` : '');
  const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = dt(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

  // "Before the test" of all the booking's tests together (no repeats; fasting wins over "no fasting")
  function prepText(tests) {
    const lines = []; let call = !tests.some((t) => t.prep != null);
    tests.forEach((t) => String(t.prep || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
      if (/phlebotomist will call/i.test(l)) call = true; else if (!lines.includes(l)) lines.push(l);
    }));
    const fasting = lines.some((l) => /^•?\s*fast for/i.test(l));
    const out = lines.filter((l) => !(fasting && /no fasting needed/i.test(l)));
    if (call) out.push('• Our phlebotomist will call you before arriving');
    return out.join('\n');
  }

  // b: booking row. ctx: { tests: [{name, includes, prep}], cfg: {amount, upiId, visitFee}, centre: {name}, files: [{name}], sug: [{date, slot}], kind, alert }
  function vars(b, ctx = {}) {
    const tests = ctx.tests && ctx.tests.length ? ctx.tests : b.package_name ? [{ name: b.package_name }] : [];
    const cfg = ctx.cfg || {};
    const today = istToday();
    const addr = [b.address, b.city, b.state].filter(Boolean).join(', ') + (b.pincode ? ` – ${b.pincode}` : '');
    const sug = ctx.sug || [];
    const past = b.date < today || ['payment_submitted', 'confirmed', 'collected', 'report_ready', 'completed', 'no_show', 'blocked'].includes(b.status);
    const ms = b.missed_slot ? `on ${fmtDate(b.missed_slot.slice(0, 10))} at ${fmtT(tMin(b.missed_slot.slice(11)))}` : '';
    return {
      name: b.name || '', first_name: String(b.name || '').split(' ')[0], ref: b.id || '', phone: b.phone || '',
      date: fmtDate(b.date), date_long: fmtLong(b.date), slot: slotLabel(b.slot),
      day_word: b.date === today ? 'today' : b.date === addDays(today, 1) ? 'tomorrow' : 'on ' + fmtDate(b.date),
      address: addr, city: b.city || '', pincode: b.pincode || '',
      map: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([b.address, b.city, b.state, b.pincode].filter(Boolean).join(', ')),
      tests: tests.map((t) => t.name).join(', ') || 'home blood test',
      tests_detail: tests.length > 1 ? '\n' + tests.map((t) => `   – ${t.name}`).join('\n') : tests[0] ? `${tests[0].name}${tests[0].includes ? ` (${tests[0].includes})` : ''}` : 'Blood test',
      prep: prepText(tests),
      amount: money(b.amount || cfg.amount), upi_id: cfg.upiId || 'our UPI ID', fee: money(b.fee_due || cfg.visitFee), missed_when: ms,
      notes: b.notes || '', vial: b.vial_no || '', centre: (ctx.centre && ctx.centre.name) || '', collector: b.collector_info || '',
      reports_list: (ctx.files || []).map((f) => `• ${String(f.name).replace(/\.pdf$/i, '')}`).join('\n'),
      slots_reason: past ? 'We need to find you a new time for your home blood test.' : `The slot you picked (${fmtDate(b.date)}, ${slotLabel(b.slot)}) is no longer available.`,
      slots_list: sug.map((s, i) => `${i + 1}) ${fmtDate(s.date)}, ${slotLabel(s.slot)}`).join('\n') ||
        (ctx.kind === 'missed' ? '(please call us for a slot)' : '(no free slots in the next few days – please call us)'),
      alert: ctx.alert || '',
    };
  }

  const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
  const varsIn = (s) => Array.from(String(s).matchAll(VAR_RE), (m) => m[1]);
  const empty = (v) => v == null || String(v).trim() === '';
  // Fill in a text. Lines / paragraphs whose variables are all empty are dropped.
  function render(body, v) {
    const paras = String(body || '').replace(/\r/g, '').split(/\n\s*\n/);
    const out = [];
    for (const p of paras) {
      const solo = p.split('\n').map((l) => /^\s*\{\{\s*([a-z_]+)\s*\}\}\s*$/.exec(l)).filter(Boolean);
      if (solo.some((m) => empty(v[m[1]]))) continue;
      const lines = p.split('\n').filter((l) => { const lv = varsIn(l); return !lv.length || lv.some((k) => !empty(v[k])); });
      if (lines.length) out.push(lines.map((l) => l.replace(VAR_RE, (_, k) => (v[k] == null ? '' : String(v[k])))).join('\n'));
    }
    return out.join('\n\n').trim();
  }

  // The WhatsApp-template version of a text: paragraphs with multi-line values are left out (the buttons cover them),
  // and every value must be one line. Returns { text, params: [names in order] }.
  function metaBody(body) {
    const paras = String(body || '').replace(/\r/g, '').split(/\n\s*\n/).filter((p) => !varsIn(p).some((k) => MULTILINE.includes(k) && k !== 'tests_detail'));
    const text = paras.join('\n\n').replace(VAR_RE, (_, k) => `{{${k === 'tests_detail' ? 'tests' : k}}}`).trim();
    const params = []; varsIn(text).forEach((k) => { if (!params.includes(k)) params.push(k); });
    return { text, params };
  }
  const oneLine = (s) => String(s == null ? '' : s).replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, '   ').trim() || '-';

  const api = { SIGN, TEMPLATES, VARS, MULTILINE, vars, render, metaBody, oneLine, prepText, fmtDate, fmtLong, slotLabel, money };
  root.DSLMsg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
