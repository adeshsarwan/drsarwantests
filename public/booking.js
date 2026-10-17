(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const root = $('#booker');
  if (!root) return;
  const state = { date: null, slot: null, slotLabel: '', booking: null, cfg: null, timer: null };
  const params = new URLSearchParams(location.search);
  const source = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'gclid']
    .filter((k) => params.get(k)).map((k) => `${k}=${params.get(k)}`).join('&').slice(0, 300);

  function show(step) {
    root.querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== String(step); });
    if (step > 1) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

  const fmtDate = (d, opts) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });
  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong. Please call 8368143677.'), { status: r.status });
    return j;
  }

  async function init() {
    try {
      state.cfg = await api('/api/config');
    } catch (e) {
      $('#bk-dates').innerHTML = '<span class="bk-err">Online booking is unavailable right now. Please call <a href="tel:8368143677">8368143677</a>.</span>';
      return;
    }
    root.querySelectorAll('.bk-amt').forEach((el) => (el.textContent = state.cfg.amount));
    root.querySelectorAll('.bk-hold').forEach((el) => (el.textContent = state.cfg.holdMinutes));
    const box = $('#bk-dates');
    box.innerHTML = '';
    if (!state.cfg.dates.length) { box.innerHTML = '<span class="bk-muted">No dates open right now. Please call 8368143677.</span>'; return; }
    state.cfg.dates.forEach((d, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bk-chip'; b.dataset.date = d;
      b.innerHTML = `<span>${fmtDate(d, { weekday: 'short' })}</span><strong>${fmtDate(d, { day: 'numeric' })}</strong><span>${fmtDate(d, { month: 'short' })}</span>`;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => pickDate(d));
      box.appendChild(b);
    });
    pickDate(state.cfg.dates[0]);
  }

  async function pickDate(d) {
    state.date = d; state.slot = null;
    root.querySelectorAll('.bk-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.date === d)));
    const box = $('#bk-slots');
    box.innerHTML = '<span class="bk-muted">Checking availability…</span>';
    try {
      const { slots } = await api('/api/slots?date=' + d);
      box.innerHTML = '';
      slots.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'bk-slot'; b.textContent = s.label.split(' – ')[0];
        b.disabled = !s.available;
        b.setAttribute('aria-label', `${s.label}${s.available ? '' : ' (booked)'}`);
        if (!s.available) b.title = 'Booked';
        b.addEventListener('click', () => {
          state.slot = s.time; state.slotLabel = s.label;
          $('#bk-picked-text').textContent = `${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })} · ${s.label}`;
          show(2);
          setTimeout(() => $('#bk-name').focus(), 300);
        });
        box.appendChild(b);
      });
      if (!slots.some((s) => s.available)) box.insertAdjacentHTML('beforeend', '<p class="bk-muted" style="width:100%;margin:6px 0 0">All slots are booked for this day. Please pick another date.</p>');
    } catch (e) { box.innerHTML = `<span class="bk-err">${e.message}</span>`; }
  }

  $('#bk-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, err = $('#bk-err2'), btn = $('#bk-continue');
    err.textContent = '';
    const data = Object.fromEntries(new FormData(f).entries());
    if (!/^[6-9]\d{9}$/.test((data.phone || '').replace(/\D/g, '').slice(-10))) { err.textContent = 'Please enter a valid 10-digit mobile number.'; $('#bk-phone').focus(); return; }
    if (!/^\d{6}$/.test(data.pincode || '')) { err.textContent = 'Please enter a valid 6-digit pincode.'; $('#bk-pin').focus(); return; }
    btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = 'Reserving your slot…';
    try {
      state.booking = await api('/api/bookings', { method: 'POST', body: JSON.stringify({ ...data, date: state.date, slot: state.slot, source }) });
      if (window.gtag) gtag('event', 'begin_checkout', { value: state.booking.amount, currency: 'INR' });
      startPayment();
    } catch (e) {
      err.textContent = e.message;
      if (e.status === 409) { pickDate(state.date); setTimeout(() => show(1), 1800); }
    } finally { btn.disabled = false; btn.textContent = btn.dataset.t; }
  });

  function startPayment() {
    const b = state.booking;
    $('#bk-ref').innerHTML = `Ref <strong>${b.id}</strong> · ${b.dateLabel} · ${b.slotLabel}`;
    const upiId = b.upiId;
    if (!upiId) {
      $('#bk-qr').innerHTML = '<p class="bk-muted" style="padding:12px">UPI details coming soon. Please call 8368143677 to pay.</p>';
    } else {
      const fixed = !!b.upiQr;
      const link = fixed ? b.upiQr : `upi://pay?pa=${upiId.replace(/[^A-Za-z0-9.@_-]/g, "")}&pn=${encodeURIComponent(b.upiName)}&am=${b.amount}.00&cu=INR&tn=${encodeURIComponent('Home test ' + b.id)}`;
      $('#bk-upi-link').href = link;
      $('#bk-amount-note').hidden = !fixed;
      $('#bk-upi-id').textContent = upiId;
      if (fixed) {
        $('#bk-qr').innerHTML = '<img src="/assets/upi-qr.svg" alt="" width="180" height="180" style="width:100%;height:100%;display:block">';
      } else if (window.qrcode) {
        const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
        $('#bk-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } else {
        $('#bk-qr').innerHTML = '<p class="bk-muted" style="padding:12px">Use the UPI ID below to pay.</p>';
      }
    }
    clearInterval(state.timer);
    const end = Date.parse(b.expiresAt);
    const tick = () => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      $('#bk-countdown').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (!s) { clearInterval(state.timer); $('#bk-countdown').textContent = 'expired, submit your UTR quickly'; }
    };
    tick(); state.timer = setInterval(tick, 1000);
    show(3);
  }

  $('#bk-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#bk-upi-id').textContent); $('#bk-copy').textContent = 'Copied'; } catch (e) {}
  });

  $('#bk-paid-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#bk-err3'), btn = $('#bk-paid-btn'), utr = $('#bk-utr').value.replace(/\s/g, '');
    err.textContent = '';
    if (!/^[A-Za-z0-9]{10,22}$/.test(utr)) { err.textContent = 'Please enter the 12-digit UPI transaction ID (UTR) from your payment app.'; $('#bk-utr').focus(); return; }
    btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = 'Submitting…';
    try {
      const b = state.booking;
      const r = await api(`/api/bookings/${b.id}/paid`, { method: 'POST', body: JSON.stringify({ token: b.token, utr }) });
      clearInterval(state.timer);
      $('#bk-done-ref').textContent = b.id;
      $('#bk-done-slot').textContent = `${r.dateLabel || b.dateLabel} · ${r.slotLabel || b.slotLabel}`;
      $('#bk-done-wa').href = 'https://wa.me/918368143677?text=' + encodeURIComponent(`Hi, I booked a home test. Ref ${b.id}, ${b.dateLabel} ${b.slotLabel}. UTR ${utr}.`);
      if (window.gtag) gtag('event', 'purchase', { transaction_id: b.id, value: b.amount, currency: 'INR' });
      show(4);
    } catch (e) { err.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = btn.dataset.t; }
  });

  const bar = document.querySelector('.bookbar'), sec = document.getElementById('book');
  if (bar && sec && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => es.forEach((e) => bar.classList.toggle('away', e.isIntersecting)), { threshold: 0.05 }).observe(sec);
  }

  init();
})();
