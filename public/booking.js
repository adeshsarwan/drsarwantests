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
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong. Please call 8368143677.'), { status: r.status, code: j.code });
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
    if (state.cfg.mapsKey) initPlaces(state.cfg.mapsKey);
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
      const cityEl = document.getElementById('bk-city');
      const { slots } = await api('/api/slots?date=' + d + (cityEl && cityEl.value.trim() ? '&city=' + encodeURIComponent(cityEl.value.trim()) : ''));
      box.innerHTML = '';
      slots.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'bk-slot'; b.textContent = s.label.split(' – ')[0];
        b.disabled = !s.available;
        b.setAttribute('aria-label', `${s.label}${s.available ? '' : ' (booked)'}`);
        if (!s.available) b.title = 'Booked';
        b.addEventListener('click', () => {
          if (state.reslot) return moveBooking(d, s);
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
    data.address = [data.house, data.area].map((x) => (x || '').trim()).filter(Boolean).join(', ');
    delete data.house; delete data.area;
    if (!(data.city || '').trim() || !(data.state || '').trim()) { err.textContent = 'Please enter your city and state.'; $(data.city ? '#bk-state' : '#bk-city').focus(); return; }
    if (!/^[6-9]\d{9}$/.test((data.phone || '').replace(/\D/g, '').slice(-10))) { err.textContent = 'Please enter a valid 10-digit mobile number.'; $('#bk-phone').focus(); return; }
    if (!/^\d{6}$/.test(data.pincode || '')) { err.textContent = 'Please enter a valid 6-digit pincode.'; $('#bk-pin').focus(); return; }
    btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = 'Reserving your slot…';
    try {
      state.form = data;
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
      $('#bk-amount-note').hidden = !fixed;
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') || navigator.maxTouchPoints > 1;
      if (isMobile) {
        $('#bk-upi-link').href = link;
        $('#bk-upi-link').hidden = false;
        $('#bk-pay-hint').textContent = 'Tap the button to open your UPI app, or scan the QR.';
      }
      $('#bk-upi-id').textContent = upiId;
      if (fixed) {
        $('#bk-qr').innerHTML = '<img src="/assets/upi-qr.png" alt="Payment QR code" style="width:100%;height:100%;display:block;object-fit:contain">';
      } else if (window.qrcode) {
        const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
        $('#bk-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } else {
        $('#bk-qr').innerHTML = '<p class="bk-muted" style="padding:12px">Use the UPI ID below to pay.</p>';
      }
    }
    show(3);
  }

  $('#bk-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#bk-upi-id').textContent); $('#bk-copy').textContent = 'Copied'; } catch (e) {}
  });

  // ---- payment screenshot: compress in the browser, then upload with the booking ----
  async function compressImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const max = 1600, scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.75, out = c.toDataURL('image/jpeg', q);
      while (out.length > 900000 && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  $('#bk-shot').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    const err = $('#bk-err3'); err.textContent = '';
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) { err.textContent = 'Please choose an image (your payment screenshot).'; return; }
    try {
      state.shot = await compressImage(file);
      $('#bk-shot-preview').src = state.shot;
      $('#bk-upload-empty').hidden = true; $('#bk-upload-done').hidden = false; $('#bk-upload-box').classList.add('has');
    } catch (e) { state.shot = null; err.textContent = 'Could not read that image. Please try a different screenshot.'; }
  });

  $('#bk-paid-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#bk-err3'), btn = $('#bk-paid-btn'), utr = $('#bk-utr').value.replace(/\s/g, '');
    err.textContent = '';
    if (!state.shot && !utr) { err.textContent = 'Please upload your payment screenshot first.'; $('#bk-upload-box').scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (utr && !/^[A-Za-z0-9]{10,22}$/.test(utr)) { err.textContent = "That transaction ID doesn't look right. You can leave it empty and just upload the screenshot."; return; }
    btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = 'Uploading…';
    try {
      const b = state.booking;
      const r = await api(`/api/bookings/${b.id}/paid`, { method: 'POST', body: JSON.stringify({ token: b.token, utr, screenshot: state.shot || undefined }) });
      finishBooking(b, r, utr);
    } catch (e) {
      if (e.code === 'slot_taken') return startReslot(e.message);
      err.textContent = e.message;
    }
    finally { btn.disabled = false; btn.textContent = btn.dataset.t; }
  });

  function finishBooking(b, r, utr) {
      $('#bk-done-ref').textContent = b.id;
      $('#bk-done-slot').textContent = `${r.dateLabel || b.dateLabel} · ${r.slotLabel || b.slotLabel}`;
      const f = state.form || {};
      const msg = [
        'Hi Dr. Sarwan Diagnostic Labs, I have booked the Hormone & Fertility Panel home test and paid.',
        `Booking Ref: ${b.id}`,
        `Slot: ${b.dateLabel}, ${b.slotLabel}`,
        `Name: ${f.name || ''}`,
        `Mobile: ${f.phone || ''}`,
        `Address: ${f.address || ''}, ${f.city || ''}, ${f.state || ''} - ${f.pincode || ''}`,
        `Amount paid: Rs. ${b.amount}`,
        state.shot ? 'Payment screenshot uploaded on the website.' : `UPI UTR: ${utr}`,
      ].join('\n');
      $('#bk-done-wa').href = 'https://wa.me/918368143677?text=' + encodeURIComponent(msg);
      if (window.gtag) gtag('event', 'purchase', { transaction_id: b.id, value: b.amount, currency: 'INR' });
      show(4);
  }

  // ---- slot taken after payment: let the patient pick a new slot without paying again ----
  function startReslot(message) {
    state.reslot = true;
    $('#bk-reslot-text').textContent = message;
    $('#bk-reslot').hidden = false;
    $('#bk-step1-kicker').textContent = 'Choose a new collection slot';
    show(1);
    pickDate(state.date);
  }
  async function moveBooking(d, s) {
    const b = state.booking;
    try {
      const r = await api(`/api/bookings/${b.id}/reslot`, { method: 'POST', body: JSON.stringify({ token: b.token, date: d, slot: s.time }) });
      state.reslot = false; $('#bk-reslot').hidden = true;
      b.date = r.date; b.dateLabel = r.dateLabel; b.slot = r.slot; b.slotLabel = r.slotLabel;
      finishBooking(b, r, $('#bk-utr').value.replace(/\s/g, ''));
    } catch (e) {
      $('#bk-reslot-text').textContent = e.message;
      pickDate(d);
    }
  }

  // ---- Save QR to Photos (iPhone share sheet → "Save Image"; elsewhere a normal download) ----
  $('#bk-save-qr').addEventListener('click', async () => {
    try {
      const blob = await fetch('/assets/upi-qr.png').then((r) => r.blob());
      const file = new File([blob], 'DrSarwan-UPI-QR.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Dr. Sarwan UPI QR' });
        return;
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { /* user closed the share sheet */ }
  });


  // ---- PIN code → city / state ----
  const pinEl = $('#bk-pin'), cityEl = $('#bk-city'), stateEl = $('#bk-state'), pinMsg = $('#bk-pin-msg');
  const auto = { city: '', state: '' };
  async function lookupPin(pin) {
    pinMsg.textContent = 'Looking up…';
    try {
      const r = await api('/api/pincode/' + pin);
      if (pinEl.value !== pin) return;
      if (r.found) {
        // only overwrite fields the user hasn't typed themselves
        if (!cityEl.value || cityEl.value === auto.city) { cityEl.value = r.city; auto.city = r.city; }
        if (!stateEl.value || stateEl.value === auto.state) { stateEl.value = r.state; auto.state = r.state; }
        pinMsg.textContent = r.areas && r.areas.length ? r.areas.slice(0, 3).join(', ') + (r.areas.length > 3 ? '…' : '') : '';
      } else pinMsg.textContent = 'PIN not found. Please check it, or type city and state.';
    } catch (e) { pinMsg.textContent = ''; }
  }
  pinEl.addEventListener('input', () => {
    pinEl.value = pinEl.value.replace(/\D/g, '').slice(0, 6);
    if (pinEl.value.length === 6) lookupPin(pinEl.value); else pinMsg.textContent = '';
  });

  // ---- Google Maps address suggestions (only if a key is configured) ----
  const areaEl = $('#bk-area'), list = $('#bk-ac-list');
  let places = null, session = null, items = [], active = -1, timer = null, reqNo = 0;
  function loadMaps(key) {
    return new Promise((resolve, reject) => {
      if (window.google && google.maps && google.maps.importLibrary) return resolve();
      window.__dslMapsReady = resolve;
      const sc = document.createElement('script');
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=__dslMapsReady&region=IN&language=en`;
      sc.async = true; sc.onerror = reject; document.head.appendChild(sc);
    });
  }
  async function initPlaces(key) {
    try {
      await loadMaps(key);
      places = await google.maps.importLibrary('places');
      session = new places.AutocompleteSessionToken();
      $('#bk-ac-note').hidden = false;
    } catch (e) { places = null; }
  }
  function closeList() { list.hidden = true; list.innerHTML = ''; items = []; active = -1; areaEl.setAttribute('aria-expanded', 'false'); }
  function render() {
    list.innerHTML = '';
    items.forEach((s, i) => {
      const p = s.placePrediction;
      const li = document.createElement('li');
      li.id = 'bk-ac-' + i; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === active));
      const main = document.createElement('span'); main.textContent = p.mainText ? p.mainText.text : p.text.text;
      const sub = document.createElement('small'); sub.textContent = p.secondaryText ? p.secondaryText.text : '';
      li.append(main, sub);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    list.hidden = !items.length; areaEl.setAttribute('aria-expanded', String(!!items.length));
    if (active >= 0) areaEl.setAttribute('aria-activedescendant', 'bk-ac-' + active); else areaEl.removeAttribute('aria-activedescendant');
  }
  async function suggest() {
    const q = areaEl.value.trim();
    if (!places || q.length < 3) return closeList();
    const my = ++reqNo;
    try {
      const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: q, includedRegionCodes: ['in'], sessionToken: session, language: 'en-IN', region: 'in',
      });
      if (my !== reqNo) return;
      items = (suggestions || []).filter((s) => s.placePrediction).slice(0, 5); active = -1; render();
    } catch (e) { closeList(); }
  }
  async function choose(i) {
    const pred = items[i] && items[i].placePrediction;
    closeList();
    if (!pred) return;
    areaEl.value = pred.text.text.replace(/,?\s*India$/, '');
    try {
      const place = pred.toPlace();
      await place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] });
      session = new places.AutocompleteSessionToken(); // new session after each selection
      const get = (t) => { const c = (place.addressComponents || []).find((x) => x.types.includes(t)); return c ? c.longText : ''; };
      const pin = get('postal_code'), city = get('locality') || get('administrative_area_level_3') || get('administrative_area_level_2'), st = get('administrative_area_level_1');
      // keep the area text short: drop city / state / PIN / country from the end
      let area = (place.formattedAddress || areaEl.value).replace(/,?\s*India$/, '');
      [pin, st, city].forEach((x) => { if (x) area = area.replace(new RegExp(',?\\s*' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s+\\d{6})?\\s*$', 'i'), ''); });
      area = area.replace(/,?\s*\d{6}\s*$/, '').trim();
      if (area) areaEl.value = area;
      if (city) { cityEl.value = city; auto.city = city; }
      if (st) { stateEl.value = st; auto.state = st; }
      if (pin) { pinEl.value = pin; pinMsg.textContent = ''; } else if (!pinEl.value) pinEl.focus();
    } catch (e) {}
  }
  areaEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(suggest, 250); });
  areaEl.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') closeList();
  });
  areaEl.addEventListener('blur', () => setTimeout(closeList, 150));

  const bar = document.querySelector('.bookbar'), sec = document.getElementById('book');
  if (bar && sec && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => es.forEach((e) => bar.classList.toggle('away', e.isIntersecting)), { threshold: 0.05 }).observe(sec);
  }

  init();
})();
