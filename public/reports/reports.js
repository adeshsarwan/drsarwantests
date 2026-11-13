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
      await load(); $('#login').hidden = true; $('#app').hidden = false;
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
${b.reports.map((f) => `<div class="rep"><span>📄 <b>${esc(f.name.replace(/\.pdf$/i, ''))}</b> <span class="meta">${kb(f.size)}</span></span><button type="button" class="btn sm" data-rid="${f.id}">Open report</button></div>`).join('')}
</section>`).join('') : '<div class="bk">No bookings found yet.</div>';
  }

  document.addEventListener('click', async (e) => {
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

  if (TOKEN) load().then(() => { $('#app').hidden = false; }).catch(() => { $('#login').hidden = false; });
  else $('#login').hidden = false;
})();
