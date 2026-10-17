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
  const dowMon = (d) => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
  const monthStart = (d) => d.slice(0, 8) + '01';
  const monthEnd = (d) => { const x = new Date(d.slice(0, 8) + '01T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
  const addMonths = (d, n) => { const x = new Date(d.slice(0, 8) + '01T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
  const money = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
  const slotMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmtT = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const slotLabel = (t) => `${fmtT(slotMin(t))} – ${fmtT(slotMin(t) + 30)}`;
  const SLOTS = []; for (let m = 360; m < 660; m += 30) SLOTS.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const isPast = (date, slot) => { const t = ist(); return date < t || (date === t && slotMin(slot) <= istMin()); };
  const mapUrl = (b) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([b.address, b.city, b.state, b.pincode].filter(Boolean).join(', '));

  const ST = {
    pending: { label: 'Awaiting payment', fg: '#8a5a00', bg: '#fff4d6', stripe: '#e9a23b', tag: 'Awaiting payment' },
    payment_submitted: { label: 'Paid – verify', fg: '#a33a1f', bg: '#ffe3d9', stripe: '#e2603f', tag: 'Paid · verify' },
    confirmed: { label: 'Confirmed', fg: '#17694a', bg: '#dff3ea', stripe: '#1f8a6a', tag: 'Confirmed' },
    collected: { label: 'Collected', fg: '#2a4a8a', bg: '#e6ecfb', stripe: '#4c6fd8', tag: 'Collected ✓' },
    cancelled: { label: 'Cancelled', fg: '#5a6880', bg: '#f1f3f5', stripe: '#b8c1cc', tag: 'Cancelled' },
    expired: { label: 'Expired (unpaid)', fg: '#5a6880', bg: '#f1f3f5', stripe: '#b8c1cc', tag: 'Expired' },
    blocked: { label: 'Blocked', fg: '#ffffff', bg: '#2b2f36', stripe: '#2b2f36', tag: 'Blocked' },
  };
  const OCCUPY = ['payment_submitted', 'confirmed', 'collected', 'blocked'];
  const PAID = ['payment_submitted', 'confirmed', 'collected'];
  const live = (b) => !['cancelled', 'expired'].includes(b.status);

  function srcLabel(src) {
    if (!src) return 'Website';
    if (src === 'admin') return 'Added by admin';
    const p = new URLSearchParams(src);
    if (p.get('gclid') || /google/i.test(p.get('utm_source') || '')) return 'Google Ads' + (p.get('utm_content') ? ' · ' + p.get('utm_content') : '');
    return p.get('utm_source') || 'Website';
  }

  function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = 'none'), 2600); }

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-admin-key': KEY, ...(opts.headers || {}) } });
    if (r.status === 401 || r.status === 503) { const j = await r.json().catch(() => ({})); logout(); throw new Error(j.error || 'Wrong password'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }

  // ---------- state ----------
  let data = null; // bookings tab (last 90 days → next 14)
  const cal = {
    view: pref.get('view', 'week'),
    anchor: ist(),
    mm: monthStart(ist()),
    sel: null,
    data: null,
    filters: new Set(pref.get('filters', ['payment_submitted', 'pending', 'confirmed', 'collected'])),
  };
  let tab = pref.get('tab', 'bookings');

  const findB = (id) => (cal.data && cal.data.bookings.find((b) => b.id === id)) || (data && data.bookings.find((b) => b.id === id));

  // ---------- auth ----------
  function logout() { KEY = ''; try { sessionStorage.removeItem('dsl_admin'); } catch (e) {} $('#app').hidden = true; $('#login').hidden = false; }
  $('#logout').onclick = logout;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault(); KEY = $('#pw').value.trim(); $('#loginErr').textContent = '';
    try { await refreshAll(); try { sessionStorage.setItem('dsl_admin', KEY); } catch (e2) {} $('#login').hidden = true; $('#app').hidden = false; showTab(tab); }
    catch (err) { $('#loginErr').textContent = err.message; }
  };

  // ---------- tabs ----------
  function showTab(name) {
    tab = name; pref.set('tab', name);
    $$('.tab').forEach((t) => (t.getAttribute('data-tab') === name ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
    $('#view-bookings').hidden = name !== 'bookings';
    $('#view-calendar').hidden = name !== 'calendar';
    if (name === 'calendar') loadCal().catch((e) => toast(e.message));
  }
  $$('.tab').forEach((t) => (t.onclick = () => showTab(t.getAttribute('data-tab'))));

  async function refreshAll() {
    await load();
    if (tab === 'calendar' || cal.data) await loadCal();
  }

  // ================= BOOKINGS TAB =================
  async function load() {
    const today = ist();
    data = await api(`/api/admin/bookings?from=${addDays(today, -90)}&to=${addDays(today, 14)}&all=1`);
    renderBookings();
  }

  function card(b) {
    const acts = [];
    if (['pending', 'payment_submitted'].includes(b.status)) acts.push(`<button class="btn sm" data-act="status" data-id="${b.id}" data-st="confirmed">Payment received – Confirm</button>`);
    if (b.status === 'confirmed') acts.push(`<button class="btn sm blue" data-act="status" data-id="${b.id}" data-st="collected">Mark sample collected</button>`);
    if (live(b)) acts.push(`<button class="btn ghost sm" data-act="move" data-id="${b.id}">Reschedule</button>`);
    if (live(b)) acts.push(`<button class="btn warn sm" data-act="status" data-id="${b.id}" data-st="cancelled">Cancel &amp; free slot</button>`);
    return `<div class="who"><div><span class="n">${esc(b.name)}</span><span class="pill st-${b.status}">${ST[b.status].label}</span></div>
  <div><a href="tel:+91${esc(b.phone)}">+91 ${esc(b.phone)}</a> · <a href="https://wa.me/91${esc(b.phone)}" target="_blank" rel="noopener">WhatsApp</a>${['confirmed', 'collected'].includes(b.status) ? ` · <button class="btn ghost sm" data-act="msg" data-id="${b.id}">Copy confirmation</button>` : ''}</div>
  <div class="meta">${esc(b.address)}${b.city ? `, ${esc(b.city)}` : ''}${b.state ? `, ${esc(b.state)}` : ''} – ${esc(b.pincode)} · <a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></div>
  <div class="meta">Ref ${esc(b.id)} · ${money(b.amount)}${b.utr ? ` · UTR <b>${esc(b.utr)}</b>` : ''}${b.has_proof ? ` · <button class="btn ghost sm" data-act="shot" data-id="${b.id}">View screenshot</button>` : ''}${b.cycle ? ` · ${esc(b.cycle)}` : ''}${b.notes ? ` · Note: ${esc(b.notes)}` : ''}</div>
  <div class="acts">${acts.join('')}</div></div>`;
  }

  function renderBookings() {
    const today = ist();
    const bookings = data.bookings.filter((b) => b.status !== 'blocked');
    const up = bookings.filter((b) => b.date >= today && live(b));
    const toVerify = bookings.filter((b) => b.status === 'payment_submitted');
    const confirmedUp = up.filter((b) => ['confirmed', 'collected'].includes(b.status));
    $('#stats').innerHTML = [
      [toVerify.length, 'Payments to verify'],
      [up.filter((b) => b.date === today && OCCUPY.includes(b.status)).length, 'Today'],
      [up.filter((b) => b.date === addDays(today, 1) && OCCUPY.includes(b.status)).length, 'Tomorrow'],
      [up.filter((b) => OCCUPY.includes(b.status)).length, 'Upcoming (14 days)'],
      [money(confirmedUp.reduce((a, b) => a + (b.amount || 0), 0)), 'Confirmed revenue (upcoming)'],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    $('#attention').innerHTML = toVerify.length
      ? toVerify.map((b) => `<div class="lrow"><div class="t">${fmt(b.date, { day: 'numeric', month: 'short' })}<br><span class="meta">${esc(slotLabel(b.slot))}</span></div><div>${card(b)}</div></div>`).join('')
      : '<p class="meta" style="margin:0">Nothing to verify right now.</p>';
    renderTable();
  }

  function renderTable() {
    if (!data) return;
    const today = ist(), st = $('#fStatus').value, when = $('#fWhen').value, q = $('#fSearch').value.trim().toLowerCase();
    let rows = data.bookings.filter((b) => b.status !== 'blocked');
    if (st === 'active') rows = rows.filter(live); else if (st !== 'all') rows = rows.filter((b) => b.status === st);
    if (when === 'upcoming') rows = rows.filter((b) => b.date >= today); else if (when === 'past') rows = rows.filter((b) => b.date < today);
    if (q) rows = rows.filter((b) => [b.name, b.phone, b.address, b.city, b.state, b.pincode, b.id, b.utr].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => (when === 'past' ? (b.date + b.slot).localeCompare(a.date + a.slot) : (a.date + a.slot).localeCompare(b.date + b.slot)));
    $('#tbody').innerHTML = rows.length ? rows.map((b) => {
      const s = ST[b.status];
      const opts = ['pending', 'payment_submitted', 'confirmed', 'collected', 'cancelled', 'expired'].filter((x) => x === b.status || ['confirmed', 'collected', 'cancelled'].includes(x));
      return `<tr>
<td style="white-space:nowrap"><b>${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><small>${esc(slotLabel(b.slot))}</small><small>${esc(b.id)}</small></td>
<td><b>${esc(b.name)}</b>${b.cycle ? `<small>${esc(b.cycle)}</small>` : ''}</td>
<td style="white-space:nowrap"><a href="tel:+91${esc(b.phone)}">${esc(b.phone)}</a><small><a href="https://wa.me/91${esc(b.phone)}" target="_blank" rel="noopener">WhatsApp</a></small></td>
<td class="addr">${esc(b.address)}<small>PIN ${esc(b.pincode)} · <a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></small>${b.notes ? `<small>Note: ${esc(b.notes)}</small>` : ''}</td>
<td>${esc(b.city || '–')}</td>
<td>${esc(b.state || '–')}</td>
<td class="num"><b>${money(b.amount)}</b>${b.utr ? `<small>UTR ${esc(b.utr)}</small>` : ''}${b.has_proof ? `<button class="btn ghost sm" style="margin-top:6px" data-act="shot" data-id="${b.id}">View screenshot</button>` : ''}</td>
<td><select class="st" data-sel="${b.id}" aria-label="Status for ${esc(b.name)}" style="background:${s.bg};color:${s.fg}">${opts.map((o) => `<option value="${o}" ${o === b.status ? 'selected' : ''}>${ST[o].label}</option>`).join('')}</select>${['confirmed', 'collected'].includes(b.status) ? `<button class="btn ghost sm" style="margin-top:6px;display:block" data-act="msg" data-id="${b.id}">Copy message</button>` : ''}</td>
</tr>`;
    }).join('') : '<tr><td colspan="8" class="meta" style="padding:18px">No bookings match.</td></tr>';
    $('#tblCount').textContent = `${rows.length} booking${rows.length === 1 ? '' : 's'} · ${money(rows.filter((b) => PAID.includes(b.status)).reduce((a, b) => a + (b.amount || 0), 0))} paid / submitted`;
    $$('[data-sel]').forEach((sel) => (sel.onchange = async () => {
      const id = sel.dataset.sel, prev = findB(id).status, nv = sel.value;
      if (['pending', 'payment_submitted', 'expired'].includes(nv) && nv !== prev) { sel.value = prev; return; }
      const ok = await setStatus(id, nv);
      if (!ok) sel.value = prev;
    }));
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
<div class="rs-wide"><span class="meta">Revenue (paid)</span><b>${money(list.filter((b) => PAID.includes(b.status)).reduce((a, b) => a + (b.amount || 0), 0))}</b></div>`;
    const F = [['payment_submitted', 'Paid – verify'], ['pending', 'Awaiting payment'], ['confirmed', 'Confirmed'], ['collected', 'Collected'], ['cancelled', 'Cancelled / expired']];
    $('#filters').innerHTML = F.map(([k, l]) => `<label class="flt"><input type="checkbox" data-flt="${k}" ${cal.filters.has(k) ? 'checked' : ''}> ${l} <span>${k === 'cancelled' ? c('cancelled') + c('expired') : c(k)}</span></label>`).join('');
    $$('[data-flt]').forEach((x) => (x.onchange = () => { x.checked ? cal.filters.add(x.dataset.flt) : cal.filters.delete(x.dataset.flt); pref.set('filters', [...cal.filters]); renderCal(); }));
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
    return `<button type="button" class="${cls}" data-act="sel" data-id="${b.id}" style="background:${s.bg};border-left-color:${s.stripe}" aria-label="${esc(b.name)}, ${esc(slotLabel(slot))}, ${s.label}">
<span class="nm">${esc(b.name)}</span><span class="ar">${esc(b.city || '')}${b.pincode ? ' · ' + esc(b.pincode) : ''}</span><span class="tg" style="color:${s.fg}">${s.tag}${extra}${b.has_proof && b.status === 'payment_submitted' ? ' · 📎' : ''}</span></button>`;
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
    const paid = list.filter((b) => PAID.includes(b.status)).reduce((a, b) => a + (b.amount || 0), 0);
    let rows = '';
    SLOTS.forEach((s) => {
      const all = list.filter((b) => b.slot === s), oc = all.find((b) => OCCUPY.includes(b.status)), past = isPast(d, s);
      const tm = `<div class="tm"><b>${fmtT(slotMin(s))}</b><small>to ${fmtT(slotMin(s) + 30)}</small></div>`;
      let body;
      if (oc && oc.status === 'blocked') body = `<div class="dblk">Blocked <button type="button" class="btn ghost sm" data-act="unblock" data-date="${d}" data-slot="${s}">Unblock</button></div>`;
      else if (oc) {
        const st = ST[oc.status];
        const next = oc.status === 'payment_submitted' ? (oc.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${oc.id}">View screenshot</button>` : '') + `<button type="button" class="btn sm" data-act="status" data-id="${oc.id}" data-st="confirmed">Confirm</button>`
          : oc.status === 'confirmed' ? `<button type="button" class="btn sm blue" data-act="status" data-id="${oc.id}" data-st="collected">Mark collected</button>` : '';
        body = `<div class="dbk" data-act="open" data-id="${oc.id}" style="border-left-color:${st.stripe};background:${oc.status === 'collected' ? '#fafbff' : '#fff'}" role="button" tabindex="0" aria-label="Open ${esc(oc.name)}">
<div class="p1"><b>${esc(oc.name)}</b><div>+91 ${esc(oc.phone)}</div></div>
<div class="p2">${esc(oc.address)}<br><b style="color:#1b2a4e">${esc(oc.city || '')}</b> · ${esc(oc.pincode)}</div>
<span class="pill st-${oc.status}" style="margin:0">${st.label}</span>
<div class="acts" style="margin:0">${next}</div></div>`;
      } else body = `<div class="dfree">${past ? 'Free (past)' : `Free slot <button type="button" class="btn ghost sm" data-act="add" data-date="${d}" data-slot="${s}">+ Add booking</button><button type="button" class="btn warn sm" data-act="block" data-date="${d}" data-slot="${s}">Block</button>`}</div>`;
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
<div class="ds"><b>${money(paid)}</b><span>Paid for the day</span></div>
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
      const n = dayBooked(d), v = list.filter((b) => b.status === 'payment_submitted').length, p = list.filter((b) => b.status === 'pending').length;
      const out = d < s || d > e;
      h += `<button type="button" class="mo-c ${out ? 'out' : ''} ${d === today ? 'today' : ''}" data-act="goday" data-date="${d}" aria-label="${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${n} booked">
<span class="num">${Number(d.slice(8))}</span>
<span class="chips">${n ? `<span class="chip" style="background:${n >= 8 ? '#ffe3d9' : '#dff3ea'};color:${n >= 8 ? '#a33a1f' : '#17694a'}">${n}/10 booked</span>` : ''}${v ? `<span class="chip st-payment_submitted">${v} to verify</span>` : ''}${p && cal.filters.has('pending') ? `<span class="chip st-pending">${p} unpaid</span>` : ''}</span>
${n ? `<span class="cap" style="width:100%;margin:auto 0 0"><i style="width:${n * 10}%;background:${fillColor(n)}"></i></span>` : ''}</button>`;
    }
    $('#calMain').innerHTML = h + '</div></div>';
  }

  // ---------- side panel ----------
  function detailHTML(b) {
    if (!b) return `<div class="dt-empty"><b>Select a booking</b>Click any booking in the calendar to see the patient's details, payment and actions here.</div>`;
    const s = ST[b.status];
    const f = [];
    if (['pending', 'payment_submitted'].includes(b.status)) f.push(`<button class="btn" data-act="status" data-id="${b.id}" data-st="confirmed">Payment received – Confirm</button>`);
    if (b.status === 'confirmed') f.push(`<button class="btn blue" data-act="status" data-id="${b.id}" data-st="collected">Mark sample collected</button>`);
    if (['confirmed', 'collected'].includes(b.status)) f.push(`<button class="btn ghost" data-act="msg" data-id="${b.id}">Copy confirmation message</button>`);
    if (['cancelled', 'expired'].includes(b.status) && (b.has_proof || b.utr)) f.push(`<button class="btn ghost" data-act="status" data-id="${b.id}" data-st="confirmed">Restore &amp; confirm</button>`);
    if (live(b)) f.push(`<button class="btn warn" data-act="status" data-id="${b.id}" data-st="cancelled">Cancel &amp; free slot</button>`);
    return `<div class="dt-h">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div><div class="dt-name">${esc(b.name)}</div><div class="meta" style="margin-top:2px">Ref ${esc(b.id)}</div></div>
<span class="pill st-${b.status}" style="margin:0;flex:none">${s.label}</span></div>
<div class="dt-when"><span>${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${esc(slotLabel(b.slot))}</span>${live(b) ? `<button type="button" class="btn ghost sm" style="margin-left:auto" data-act="move" data-id="${b.id}">Reschedule</button>` : ''}</div>
</div>
<div class="dt-b">
<div class="dt-links"><a class="call" href="tel:+91${esc(b.phone)}">Call</a><a class="wa" href="https://wa.me/91${esc(b.phone)}" target="_blank" rel="noopener">WhatsApp</a><a href="${mapUrl(b)}" target="_blank" rel="noopener">Map</a></div>
<div><div class="dt-k">Mobile</div><div style="font-weight:600;margin-top:2px">+91 ${esc(b.phone)}</div></div>
<div><div class="dt-k">Collection address</div><div style="margin-top:2px;line-height:1.45">${esc(b.address)}<br><b>${esc(b.city || '')}</b>${b.state ? ', ' + esc(b.state) : ''} – ${esc(b.pincode)}</div></div>
<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px"><div><div class="dt-k">Cycle</div><div style="margin-top:2px">${esc(b.cycle || '–')}</div></div><div><div class="dt-k">Source</div><div style="margin-top:2px">${esc(srcLabel(b.source))}</div></div></div>
<div class="pay"><div style="min-width:0;flex:1"><b>${money(b.amount)}</b><div class="meta">${b.status === 'payment_submitted' ? 'Payment submitted · check your Paytm app' : b.status === 'pending' ? 'Not paid yet · slot not reserved' : PAID.includes(b.status) ? 'Payment verified' : '—'}${b.utr ? `<br>UTR ${esc(b.utr)}` : ''}</div></div>${b.has_proof ? `<button type="button" class="btn ghost sm" data-act="shot" data-id="${b.id}">View screenshot</button>` : ''}</div>
${b.notes ? `<div><div class="dt-k">Notes</div><div style="margin-top:2px">${esc(b.notes)}</div></div>` : ''}
</div>
<div class="dt-f">${f.join('')}</div>`;
  }

  function runSheetHTML(date) {
    const stops = runStops(date);
    return `<div class="run-h"><div class="run-k">Phlebotomist run sheet</div><div class="run-t">${stops.length} pickup${stops.length === 1 ? '' : 's'} · ${fmt(date, { weekday: 'short', day: 'numeric', month: 'short' })}</div><div class="meta" style="margin-top:2px">Confirmed + paid-to-verify bookings, in slot order</div></div>
<div class="run-b">${stops.length ? stops.map((b, i) => `<div class="stop"><div style="display:flex;flex-direction:column;align-items:center"><span class="n">${i + 1}</span><span class="ln"></span></div><div class="bd"><div style="font-weight:800">${fmtT(slotMin(b.slot))} · ${esc(b.name)}</div><div style="font-size:12.5px;color:#3b4a68;margin-top:2px">${esc(b.address)}, ${esc(b.city || '')} · ${esc(b.pincode)}</div><div style="font-size:12px;color:#8492a6;margin-top:2px">+91 ${esc(b.phone)}${b.status === 'payment_submitted' ? ' · payment to verify' : ''}</div></div></div>`).join('') : '<p class="meta">No confirmed pickups for this day yet.</p>'}</div>
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
    const b = cal.sel ? findB(cal.sel) : null;
    side.innerHTML = detailHTML(b);
  }

  function openDetail(id) {
    const b = findB(id); if (!b) return;
    $('#detailBody').innerHTML = detailHTML(b);
    if (!$('#detailDlg').open) $('#detailDlg').showModal();
  }

  // ---------- run sheet actions ----------
  function runText(date) {
    const stops = runStops(date);
    return [`🩸 Home collections – ${fmt(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`, `${stops.length} pickup${stops.length === 1 ? '' : 's'}`, '',
      ...stops.flatMap((b, i) => [`${i + 1}) ${slotLabel(b.slot)} · ${b.name} · +91 ${b.phone}`, `   ${b.address}, ${b.city || ''} – ${b.pincode}`, `   Map: ${mapUrl(b)}`, b.notes ? `   Note: ${b.notes}` : null, ''].filter((x) => x !== null)),
      'Please carry the requisition forms for: FSH, LH, Prolactin, AMH, T3, T4, TSH (fasting).'].join('\n');
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
<table><tr><th>#</th><th>Time</th><th>Patient</th><th>Phone</th><th>Address</th><th>Payment</th><th>Collected ✓</th></tr>
${stops.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(slotLabel(b.slot))}</td><td>${esc(b.name)}<br><small>${esc(b.id)}</small></td><td>+91 ${esc(b.phone)}</td><td>${esc(b.address)}, ${esc(b.city || '')} – ${esc(b.pincode)}${b.notes ? `<br><small>${esc(b.notes)}</small>` : ''}</td><td>${b.status === 'payment_submitted' ? 'To verify' : 'Paid'}</td><td></td></tr>`).join('')}</table>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }

  // ---------- messages ----------
  function confirmText(b) {
    const addr = [b.address, b.city, b.state].filter(Boolean).join(', ') + (b.pincode ? ` – ${b.pincode}` : '');
    return [`Hi ${b.name}! 👋`, `Your home blood test with *Dr. Sarwan Diagnostic Labs* is *confirmed* ✅`, '',
      `🧾 Booking ref: ${b.id}`, `📅 Date: ${fmt(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`, `⏰ Time: ${slotLabel(b.slot)}`,
      `📍 Address: ${addr}`, `💳 Payment of ${money(b.amount)} received. Thank you!`, '',
      'Test: Complete Hormone & Fertility Panel (FSH, LH, Prolactin, AMH, T3, T4, TSH)', '',
      'Before the test:', '• Fast for 10–12 hours overnight (water is fine)', '• Our phlebotomist will call you before arriving', '',
      'Need to reschedule? Call/WhatsApp 8368143677.'].join('\n');
  }
  function openMsg({ title, sub, text, phone }) {
    $('#msgTitle').textContent = title; $('#msgSub').textContent = sub || '';
    $('#msgText').value = text;
    const sync = () => { $('#msgWa').href = `https://wa.me/${phone ? '91' + phone : ''}?text=` + encodeURIComponent($('#msgText').value); };
    sync(); $('#msgText').oninput = sync;
    $('#msgCopy').textContent = 'Copy message';
    $$('dialog[open]').forEach((d) => d !== $('#msgDlg') && d.close());
    if (!$('#msgDlg').open) $('#msgDlg').showModal();
  }
  function openConfirmMsg(id) {
    const b = findB(id); if (!b) return;
    openMsg({ title: 'Booking confirmed ✓', sub: `Send to ${b.name} · +91 ${b.phone}`, text: confirmText(b), phone: b.phone });
  }
  $('#msgCopy').onclick = async () => {
    const t = $('#msgText'); let ok = false;
    try { ok = await Promise.race([navigator.clipboard.writeText(t.value).then(() => true), new Promise((r) => setTimeout(() => r(false), 1200))]); } catch (e) { ok = false; }
    if (!ok) { t.focus(); t.select(); t.setSelectionRange(0, t.value.length); try { document.execCommand('copy'); } catch (e) {} }
    $('#msgCopy').textContent = 'Copied ✓'; toast('Copied – paste it in WhatsApp');
  };

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
  async function setStatus(id, st) {
    if (st === 'cancelled' && !confirm('Cancel this booking and free the slot?')) return false;
    try {
      await api(`/api/admin/bookings/${id}/status`, { method: 'POST', body: JSON.stringify({ status: st }) });
      toast('Updated');
      await refreshAll();
      if ($('#detailDlg').open) { const b = findB(id); if (b) $('#detailBody').innerHTML = detailHTML(b); }
      if (st === 'confirmed') openConfirmMsg(id);
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  async function block(date, slot, on) {
    if (!on && !confirm(`Unblock ${slotLabel(slot)} on ${fmt(date, { day: 'numeric', month: 'short' })}?`)) return;
    try { await api('/api/admin/block', { method: 'POST', body: JSON.stringify({ date, slot, block: on }) }); toast(on ? 'Slot blocked' : 'Slot unblocked'); await refreshAll(); }
    catch (e) { toast(e.message); }
  }

  // ---------- add / reschedule form ----------
  let form = { mode: 'add', id: null };
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
    form = { mode, id: ctx.id || null };
    $('#bkForm').reset(); $('#formErr').textContent = '';
    $$('.add-only', $('#bkForm')).forEach((el) => (el.hidden = mode !== 'add'));
    if (mode === 'add') { $('#formTitle').textContent = 'Add booking'; $('#formSub').textContent = 'For phone or walk-in bookings'; $('#formSave').textContent = 'Save booking'; }
    else { $('#formTitle').textContent = `Reschedule ${ctx.name}`; $('#formSub').textContent = `Currently ${fmt(ctx.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${slotLabel(ctx.slot)}`; $('#formSave').textContent = 'Move booking'; }
    const date = ctx.date || ist();
    $('#fDate').value = date; $('#fDate').min = mode === 'add' ? '' : '';
    fillSlots(date, ctx.slot, form.id);
    $$('dialog[open]').forEach((d) => d.close());
    $('#formDlg').showModal();
    setTimeout(() => (mode === 'add' ? $('#fName') : $('#fDate')).focus(), 50);
  }
  $('#fDate').onchange = () => fillSlots($('#fDate').value, $('#fSlot').value, form.id);
  $('#fPin').oninput = async () => {
    const v = $('#fPin').value.replace(/\D/g, '').slice(0, 6); $('#fPin').value = v;
    if (v.length !== 6) return;
    try { const r = await fetch('/api/pincode/' + v).then((x) => x.json()); if (r.found) { if (!$('#fCity').value) $('#fCity').value = r.city; if (!$('#fState').value) $('#fState').value = r.state; } } catch (e) {}
  };
  $('#bkForm').onsubmit = async (e) => {
    e.preventDefault(); $('#formErr').textContent = '';
    const fd = Object.fromEntries(new FormData($('#bkForm')).entries());
    const btn = $('#formSave'); btn.disabled = true;
    try {
      if (form.mode === 'add') { await api('/api/admin/bookings', { method: 'POST', body: JSON.stringify(fd) }); toast('Booking added'); }
      else { await api(`/api/admin/bookings/${form.id}/move`, { method: 'POST', body: JSON.stringify({ date: fd.date, slot: fd.slot }) }); toast('Booking moved'); }
      $('#formDlg').close();
      if (form.mode === 'move') { cal.anchor = cal.view === 'week' ? cal.anchor : fd.date; }
      await refreshAll();
    } catch (err) { $('#formErr').textContent = err.message; }
    finally { btn.disabled = false; }
  };

  // ---------- one click handler for every action ----------
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) { $('#' + c.dataset.close).close(); return; }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const a = el.dataset.act, id = el.dataset.id;
    if (a === 'status') setStatus(id, el.dataset.st);
    else if (a === 'shot') viewShot(id);
    else if (a === 'msg') openConfirmMsg(id);
    else if (a === 'move') { const b = findB(id); if (b) openForm('move', b); }
    else if (a === 'add') openForm('add', { date: el.dataset.date || (tab === 'calendar' ? cal.anchor : ist()), slot: el.dataset.slot });
    else if (a === 'block') block(el.dataset.date, el.dataset.slot, true);
    else if (a === 'unblock') block(el.dataset.date, el.dataset.slot, false);
    else if (a === 'sel') {
      cal.sel = id;
      if (window.innerWidth < 1180) openDetail(id); else renderCal();
    }
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
    else if (a === 'run-open') { $('#detailBody').innerHTML = runSheetHTML(cal.anchor); $('#detailDlg').showModal(); }
    else if (a === 'run-wa') openMsg({ title: 'Run sheet', sub: 'Copy, or open WhatsApp and pick the phlebotomist', text: runText(cal.anchor) });
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
