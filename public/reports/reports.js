// Patient portal: sign in with mobile number + date of birth, see bookings and open released reports.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const CLS = { completed: 'st-completed', collected: 'st-collected', report_ready: 'st-report_ready', confirmed: 'st-confirmed', no_show: 'st-no_show', cancelled: 'st-cancelled', pending: 'st-pending', payment_submitted: 'st-payment_submitted' };
  let TOKEN = '';
  try { TOKEN = sessionStorage.getItem('dsl_patient') || ''; } catch (e) {}

  function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = 'none'), 3500); }
  function signOut() {
    if (TOKEN) fetch('/api/patient/logout', { method: 'POST', headers: { 'x-session': TOKEN } }).catch(() => {});
    TOKEN = ''; try { sessionStorage.removeItem('dsl_patient'); } catch (e) {}
    $('#app').hidden = true; $('#login').hidden = false;
  }
  $('#logout').onclick = signOut;

  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault(); $('#loginErr').textContent = '';
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      const r = await fetch('/api/patient/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: $('#ph').value, dob: $('#dob').value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not sign in');
      TOKEN = j.token; try { sessionStorage.setItem('dsl_patient', TOKEN); } catch (e2) {}
      await load(); $('#login').hidden = true; $('#app').hidden = false; deep();
    } catch (err) { $('#loginErr').textContent = err.message; }
    finally { btn.disabled = false; }
  };

  async function load() {
    const r = await fetch('/api/patient/bookings', { headers: { 'x-session': TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { signOut(); throw new Error('Please sign in again.'); }
    if (!r.ok) throw new Error(j.error || 'Could not load your bookings');
    $('#hello').textContent = `Hi ${String(j.name || '').split(' ')[0]} 👋`;
    $('#list').innerHTML = j.bookings.length ? j.bookings.map((b) => `<section class="bk">
<div class="bk-h"><div class="bk-when">${fmtD(b.date)}</div><span class="pill ${CLS[b.status] || ''}" style="margin:0">${esc(b.status_label)}</span></div>
<div class="bk-l">🧪 ${esc(b.tests.join(', ') || b.package_name || 'Blood test')}</div>
<div class="bk-l meta">Booking ${esc(b.id)}${b.vial_no ? ` · Vial no. ${esc(b.vial_no)}` : ''}${b.name ? ` · ${esc(b.name)}` : ''}</div>
${b.smart ? `<div class="rep" style="background:#f3f0ff;border-color:#ddd3fb"><span>✨ <b>Smart report</b> <span class="meta">your results explained in plain words</span></span><button type="button" class="btn sm smart" data-smart="${esc(b.id)}">Open smart report</button></div>` : ''}
${b.reports.map((f) => `<div class="rep"><span>📄 <b>${esc(f.name.replace(/\.pdf$/i, ''))}</b> <span class="meta">${kb(f.size)}</span></span><button type="button" class="btn sm" data-rid="${f.id}">Open report</button></div>`).join('')}
</section>`).join('') : '<div class="bk">No bookings found yet.</div>';
  }

  // ---- smart report: shown inside this page (it needs the sign-in), with the lab PDFs and "Talk to a doctor" ----
  try { const st = document.createElement('style'); st.textContent = window.DSLSmart ? window.DSLSmart.css : ''; document.head.appendChild(st); } catch (e) {}
  const intro = () => $('#hello').nextElementSibling;
  function showList() { $('#smartView').hidden = true; $('#list').hidden = false; $('#hello').hidden = false; intro().hidden = false; }
  async function openSmart(id) {
    const r = await fetch(`/api/patient/smart/${encodeURIComponent(id)}`, { headers: { 'x-session': TOKEN } });
    if (r.status === 401) { signOut(); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || 'Could not open the smart report'); if (location.hash) history.replaceState(null, '', location.pathname); return; }
    const msg = `Hi, I'd like to talk to a doctor (₹299) about my report – booking ${id}`;
    $('#smartBody').innerHTML = window.DSLSmart.html(d, { pdfs: d.files, doctorHref: 'https://wa.me/919818028755?text=' + encodeURIComponent(msg) });
    $('#list').hidden = true; $('#hello').hidden = true; intro().hidden = true; $('#smartView').hidden = false; window.scrollTo(0, 0);
  }
  $('#smartBack').onclick = () => { if (location.hash) history.back(); else showList(); };
  window.addEventListener('hashchange', () => { const m = /^#smart\/(DSL-[A-Z0-9]{6})$/.exec(location.hash); if (m && TOKEN) openSmart(m[1]); else showList(); });

  document.addEventListener('click', async (e) => {
    const sm = e.target.closest('[data-smart]');
    if (sm) { location.hash = 'smart/' + sm.dataset.smart; return; }
    const el = e.target.closest('[data-rid]'); if (!el) return;
    const w = window.open('', '_blank'); // open now so the browser doesn't block it
    try {
      const r = await fetch(`/api/patient/reports/${el.dataset.rid}`, { headers: { 'x-session': TOKEN } });
      if (r.status === 401) { if (w) w.close(); signOut(); return; }
      if (!r.ok) throw new Error('Could not open the report');
      const u = URL.createObjectURL(await r.blob());
      if (w) w.location = u; else location.href = u;
    } catch (err) { if (w) w.close(); toast(err.message); }
  });

  const deep = () => { const m = /^#smart\/(DSL-[A-Z0-9]{6})$/.exec(location.hash); if (m) openSmart(m[1]); };
  if (TOKEN) load().then(() => { $('#app').hidden = false; deep(); }).catch(() => { $('#login').hidden = false; });
  else $('#login').hidden = false;
})();
