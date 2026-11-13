// Collection-centre portal: see the bookings given to this centre, mark samples collected (vial no.), upload report PDFs.
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ist = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const mapUrl = (b) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([b.address, b.city, b.state, b.pincode].filter(Boolean).join(', '));
  const STATUS = {
    confirmed: ['To collect', 'st-confirmed'], collected: ['Collected – report pending', 'st-collected'],
    report_ready: ['Report uploaded', 'st-report_ready'], completed: ['Report sent to patient', 'st-completed'], no_show: ['Patient not available', 'st-no_show'],
  };
  let TOKEN = '';
  try { TOKEN = sessionStorage.getItem('dsl_centre') || localStorage.getItem('dsl_centre') || ''; } catch (e) {}
  let DATA = null, filter = 'todo', vialOpen = null;

  function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = 'none'), 3000); }
  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-session': TOKEN, ...(opts.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/api/centre/login') { signOut(); throw new Error(j.error || 'Please sign in again.'); }
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }
  function signOut() {
    if (TOKEN) fetch('/api/centre/logout', { method: 'POST', headers: { 'x-session': TOKEN } }).catch(() => {});
    TOKEN = ''; try { sessionStorage.removeItem('dsl_centre'); localStorage.removeItem('dsl_centre'); } catch (e) {}
    $('#app').hidden = true; $('#login').hidden = false;
  }
  $('#logout').onclick = signOut;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault(); $('#loginErr').textContent = '';
    try {
      const r = await api('/api/centre/login', { method: 'POST', body: JSON.stringify({ username: $('#un').value, password: $('#pw').value }) });
      TOKEN = r.token; try { localStorage.setItem('dsl_centre', TOKEN); } catch (e2) {}
      $('#pw').value = ''; await load(); $('#login').hidden = true; $('#app').hidden = false;
    } catch (err) { $('#loginErr').textContent = err.message; }
  };

  async function load() {
    DATA = await api('/api/centre/bookings');
    $('#centreName').textContent = DATA.centre ? DATA.centre.name : '';
    $('#userName').textContent = DATA.user ? `${DATA.user.name} · ${DATA.user.username}` : '';
    render();
  }
  $('#refresh').onclick = () => load().then(() => toast('Updated')).catch((e) => toast(e.message));

  const shown = () => {
    const t = ist(), all = DATA ? DATA.bookings : [];
    if (filter === 'today') return all.filter((b) => b.date === t);
    if (filter === 'upcoming') return all.filter((b) => b.date >= t && b.status === 'confirmed');
    if (filter === 'todo') return all.filter((b) => (b.status === 'confirmed' && b.date <= t) || b.status === 'collected');
    return all.slice().reverse();
  };
  function render() {
    $$('.seg [data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));
    const list = shown();
    $('#count').textContent = filter === 'todo' ? `${list.length} job${list.length === 1 ? '' : 's'} waiting: samples to collect today or earlier, and reports to upload` : `${list.length} booking${list.length === 1 ? '' : 's'}`;
    $('#jobs').innerHTML = list.length ? list.map(card).join('') : `<div class="empty">Nothing here right now.</div>`;
  }
  function card(b) {
    const [label, cls] = STATUS[b.status] || [b.status, ''];
    const after = ['collected', 'report_ready', 'completed'].includes(b.status);
    const acts = [];
    if (b.status === 'confirmed') acts.push(`<button type="button" class="btn blue sm" data-a="vial" data-id="${b.id}">Sample collected</button>`);
    if (after) {
      acts.push(`<label class="btn sm" style="cursor:pointer">Upload report PDF<input type="file" accept="application/pdf,.pdf" multiple hidden data-a="upload" data-id="${b.id}"></label>`);
      acts.push(`<button type="button" class="btn ghost sm" data-a="vial" data-id="${b.id}">${b.vial_no ? 'Edit vial no.' : 'Add vial no.'}</button>`);
    }
    return `<article class="job" id="job-${esc(b.id)}">
<div class="job-h"><div class="job-when">${fmtD(b.date)} · ${esc(b.slot_label)}</div><span class="pill ${cls}" style="margin:0">${esc(label)}</span></div>
<div class="job-name">${esc(b.name)} <span class="meta" style="font-weight:500">· ${esc(b.id)}</span></div>
<div class="job-l">🧪 ${esc(b.tests.join(', ') || b.package_name || 'Blood test')}</div>
<div class="job-l">📍 ${esc(b.address)}, ${esc(b.city || '')}${b.state ? ', ' + esc(b.state) : ''} – ${esc(b.pincode)} · <a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></div>
<div class="job-l">📞 <a href="tel:+91${esc(b.phone)}">+91 ${esc(b.phone)}</a>${b.cycle ? ` · ${esc(b.cycle)}` : ''}</div>
${b.notes ? `<div class="job-l">📝 ${esc(b.notes)}</div>` : ''}
${b.vial_no ? `<div class="job-l"><b>Vial no.: ${esc(b.vial_no)}</b></div>` : after ? '<div class="job-l" style="color:#a33a1f"><b>⚠ Vial no. missing</b></div>' : ''}
${vialOpen === b.id ? `<form class="vial-f" data-a="vial-save" data-id="${b.id}"><input class="inp" id="vialIn" placeholder="Vial no. on the tube" value="${esc(b.vial_no || '')}" autocomplete="off" aria-label="Vial number"><button class="btn blue sm">${b.status === 'confirmed' ? 'Save – sample collected' : 'Save'}</button><button type="button" class="btn ghost sm" data-a="vial-cancel">Cancel</button></form>` : ''}
${b.reports.length ? `<ul class="job-reps">${b.reports.map((r) => `<li>📄 <button type="button" class="lnk-b" style="width:auto;text-align:left;color:var(--teal)" data-a="view" data-rid="${r.id}">${esc(r.name)}</button><span class="meta">${kb(r.size)}</span></li>`).join('')}</ul>` : ''}
<div class="job-acts">${acts.join('')}</div>
</article>`;
  }

  document.addEventListener('click', async (e) => {
    const f = e.target.closest('.seg [data-f]');
    if (f) { filter = f.dataset.f; vialOpen = null; render(); return; }
    const el = e.target.closest('[data-a]'); if (!el) return;
    const a = el.dataset.a;
    if (a === 'vial') { vialOpen = el.dataset.id; render(); setTimeout(() => $('#vialIn') && $('#vialIn').focus(), 30); }
    else if (a === 'vial-cancel') { vialOpen = null; render(); }
    else if (a === 'view') {
      const w = window.open('', '_blank'); // open now so the browser doesn't block it
      try {
        const r = await fetch(`/api/centre/reports/${el.dataset.rid}`, { headers: { 'x-session': TOKEN } });
        if (!r.ok) throw new Error('Could not open the report');
        const u = URL.createObjectURL(await r.blob());
        if (w) w.location = u; else location.href = u;
      } catch (err) { if (w) w.close(); toast(err.message); }
    }
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-a="vial-save"]'); if (!f) return;
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      await api(`/api/centre/bookings/${f.dataset.id}/collected`, { method: 'POST', body: JSON.stringify({ vial_no: $('#vialIn').value }) });
      vialOpen = null; toast('Saved ✓'); await load();
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  document.addEventListener('change', async (e) => {
    const inp = e.target.closest('input[data-a="upload"]'); if (!inp || !inp.files.length) return;
    const id = inp.dataset.id, files = Array.from(inp.files);
    let ok = 0;
    for (const file of files) {
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB`);
        const r = await fetch(`/api/centre/bookings/${id}/reports`, { method: 'POST', headers: { 'x-session': TOKEN, 'content-type': 'application/pdf', 'x-filename': encodeURIComponent(file.name) }, body: file });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { signOut(); return; }
        if (!r.ok) throw new Error(j.error || `Upload failed: ${file.name}`);
        ok++;
      } catch (err) { toast(err.message); }
    }
    if (ok) toast(`${ok} report${ok === 1 ? '' : 's'} uploaded ✓ Dr. Sarwan Diagnostic Labs will send ${ok === 1 ? 'it' : 'them'} to the patient.`);
    await load().catch(() => {});
  });

  if (TOKEN) load().then(() => { $('#app').hidden = false; }).catch(() => { $('#login').hidden = false; });
  else $('#login').hidden = false;
})();
