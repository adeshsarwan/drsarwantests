// Admin → Packages → "Edit page": the web page of one package (/package/<slug>), section by section, with AI writing.
// Also "Edit home page" (address #home): our story timeline, numbers and texts of drsarwantests.com.
// Its own screen (address #page/<id> or #home) so it doesn't mix with the booking admin.
(function () {
  'use strict';
  const A = () => window.DSLAdmin;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = $('#peRoot');
  let S = null; // { id, pkg, page, slug, live, saved, ai, dirty, busy: {section: true} }

  // ---------- what each section has ----------
  // field: [key, label, type, hint]; type: text | ta | csv (comma list) | lines (one per line) | paras (blank line between)
  const SEC = [
    { key: 'hero', title: 'Hero – the main question', help: 'The first thing people see: the question they came with, a short line, and the booking button with the price.',
      fields: [['kicker', 'Small label above', 'text', 'e.g. Complete Thyroid Profile · 3 tests'], ['headline', 'Main question (headline)', 'text', 'Put [square brackets] around words to colour them orange'],
        ['subtitle', 'Line under the question', 'ta'], ['chips', 'Small chips', 'csv', 'Comma separated, e.g. Fasting sample, Home sample collection, E-report'],
        ['cta', 'Button text', 'text', 'The price is added automatically'], ['badge', 'Text above the price in the yellow badge', 'text', 'e.g. TOTAL 7 TESTS @']] },
    { key: 'questions', title: 'Which question brought you here?', help: 'Cards that match visitors’ worries to the tests that answer them.',
      fields: [['kicker', 'Small label', 'text'], ['title', 'Heading', 'text'], ['intro', 'Intro line', 'ta']],
      list: { key: 'items', label: 'Question card', fields: [['title', 'Question', 'text'], ['body', 'Answer', 'ta'], ['answered_by', 'Answered by (tests)', 'text', 'e.g. T3 · T4 · TSH']] } },
    { key: 'stories', title: 'Stories – what people are talking about', help: 'Current conversations, news and myths, checked against the evidence. The AI searches the web for these and lists its sources (shown at the bottom of the page).',
      fields: [['kicker', 'Small label', 'text'], ['title', 'Heading', 'text'], ['intro', 'Intro line', 'ta'], ['helps_label', 'Label of the green box', 'text', 'Where this test helps:']],
      list: { key: 'items', label: 'Story', fields: [['tag', 'Tag', 'text', 'e.g. Trending: …, Debated: …, Viral: …'], ['title', 'Headline', 'text'], ['paras', 'Text (blank line between paragraphs)', 'paras'], ['helps', 'Where this test helps', 'ta']] },
      list2: { key: 'sources', label: 'Source', fields: [['label', 'Name', 'text'], ['url', 'Link', 'text']] } },
    { key: 'canCant', title: 'What it can and can’t tell you', help: 'Honest limits build trust – keep both lists.',
      fields: [['title', 'Heading', 'text'], ['can', 'It can (one per line)', 'lines'], ['cant', 'It can’t (one per line)', 'lines']] },
    { key: 'tests', title: 'The tests', help: 'Every test in the package, grouped. Each line: short code, full name, what it shows.',
      fields: [['kicker', 'Small label', 'text'], ['title', 'Heading', 'text']],
      list: { key: 'groups', label: 'Group', fields: [['name', 'Group name', 'text']],
        sub: { key: 'items', label: 'Test', fields: [['code', 'Code', 'text'], ['name', 'Full name', 'text'], ['desc', 'What it shows', 'text']] } } },
    { key: 'precautions', title: 'Precautions – before the test', help: 'Fasting, timing, medicines – what to do so the result is accurate.',
      fields: [['nav', 'Menu label', 'text', 'e.g. Before the test'], ['kicker', 'Small label', 'text'], ['title', 'Heading', 'text'], ['intro', 'Intro line', 'ta']],
      list: { key: 'items', label: 'Precaution', fields: [['big', 'Big label', 'text', 'e.g. 10–12 hrs, Morning, Day 2–5'], ['title', 'Applies to', 'text'], ['body', 'What to do', 'ta']] },
      after: [['note', 'Extra note (special cases)', 'ta', 'Wrap lead-ins in **double stars** to make them bold']] },
    { key: 'faq', title: 'FAQ', help: 'Questions people really ask. Also shown to Google as FAQ results.',
      fields: [['title', 'Heading', 'text']], list: { key: 'items', label: 'Question', fields: [['q', 'Question', 'text'], ['a', 'Answer', 'ta']] } },
    { key: 'seo', title: 'Google & booking box', help: 'Title and description Google shows, and the short texts in the booking box and bottom bar.',
      fields: [['title', 'Page title (Google)', 'text', 'Under 65 characters'], ['description', 'Description (Google)', 'ta', 'Under 155 characters']],
      extra: [['book.sub', 'Booking box: line under “Book a home test”', 'text'], ['book.meta', 'Booking box: small line under the price', 'text'], ['book.bar', 'Bottom bar: package name', 'text']] },
  ];
  const AI_SECTIONS = SEC.map((x) => x.key);
  const HOME_SEC = [
    { key: 'hero', title: 'Top of the home page', help: 'The first thing visitors see on drsarwantests.com.',
      fields: [['badge', 'Small label', 'text', 'e.g. Since 2015'], ['title', 'Main heading', 'ta'], ['text', 'Text under the heading', 'ta'], ['cta', 'Button text', 'text', 'Scrolls to the packages']] },
    { key: 'stats', title: 'Numbers / badges', help: 'The boxes beside the heading (NABL, CGHS, years, centres…). Only write numbers you can stand behind.',
      fields: [], list: { path: 'stats', label: 'Box', fields: [['big', 'Big text', 'text', 'e.g. NABL, 25+, 2015'], ['small', 'Small text', 'text']] } },
    { key: 'story', title: 'Our journey – timeline', help: 'Milestones from 2015 to today, left to right. Leave the year empty to show a dot instead.',
      fields: [['title', 'Heading', 'text'], ['intro', 'Intro line', 'ta']],
      list: { key: 'items', label: 'Milestone', fields: [['year', 'Year', 'text', 'e.g. 2015, 2019, Today'], ['title', 'Title', 'text'], ['text', 'Text', 'ta']] } },
    { key: 'packages', title: 'Packages section', help: 'The cards come by themselves from every package with a published page (Packages → Edit page → Publish).',
      fields: [['title', 'Heading', 'text'], ['intro', 'Intro line', 'ta']] },
    { key: 'features', title: 'Why us – three points', help: 'Short points under the packages.',
      fields: [], list: { path: 'features', label: 'Point', fields: [['title', 'Title', 'text'], ['text', 'Text', 'ta']] } },
    { key: 'seo', title: 'Google', help: 'Title and description Google shows for the home page.',
      fields: [['title', 'Page title (Google)', 'text', 'Under 65 characters'], ['description', 'Description (Google)', 'ta', 'Under 155 characters']] },
  ];
  const secs = () => (S.home ? HOME_SEC : SEC);

  // ---------- path helpers ----------
  const getP = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setP(o, path, v) { const ks = path.split('.'); let a = o; ks.slice(0, -1).forEach((k, i) => { if (a[k] == null) a[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; a = a[k]; }); a[ks[ks.length - 1]] = v; }
  const toText = (v, t) => (t === 'csv' ? (v || []).join(', ') : t === 'lines' ? (v || []).join('\n') : t === 'paras' ? (v || []).join('\n\n') : v ?? '');
  const fromText = (v, t) => (t === 'csv' ? v.split(',').map((x) => x.trim()).filter(Boolean) : t === 'lines' ? v.split('\n').map((x) => x.trim()).filter(Boolean) : t === 'paras' ? v.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) : v);

  function field(path, [k, label, type, hint]) {
    const p = path ? path + '.' + k : k, v = toText(getP(S.page, p), type), id = 'pe_' + p.replace(/\./g, '_');
    const big = type === 'ta' || type === 'lines' || type === 'paras';
    const rows = type === 'paras' ? 5 : type === 'lines' ? Math.max(3, (getP(S.page, p) || []).length + 1) : 2;
    return `<div class="pe-f ${big ? 'wide' : ''}"><label for="${id}">${esc(label)}</label>${big
      ? `<textarea id="${id}" class="inp ta" rows="${rows}" data-p="${esc(p)}" data-t="${type}">${esc(v)}</textarea>`
      : `<input id="${id}" class="inp" data-p="${esc(p)}" data-t="${type}" value="${esc(v)}" autocomplete="off">`}${hint ? `<span class="meta">${esc(hint)}</span>` : ''}</div>`;
  }
  function listHTML(path, L) {
    const items = getP(S.page, path) || [];
    return `<div class="pe-list"><div class="pe-list-h">${esc(L.label)}s <span class="meta">(${items.length})</span></div>
${items.map((_, i) => `<div class="pe-item"><div class="pe-item-h"><b>${esc(L.label)} ${i + 1}</b><span>
<button type="button" class="ibtn" data-pe="up" data-l="${path}" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button type="button" class="ibtn" data-pe="down" data-l="${path}" data-i="${i}" ${i < items.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button><button type="button" class="ibtn del" data-pe="del" data-l="${path}" data-i="${i}" aria-label="Remove">✕</button></span></div>
<div class="pe-grid">${L.fields.map((f) => field(`${path}.${i}`, f)).join('')}</div>
${L.sub ? listHTML(`${path}.${i}.${L.sub.key}`, L.sub) : ''}</div>`).join('')}
<button type="button" class="btn ghost sm" data-pe="add" data-l="${path}">+ Add ${esc(L.label.toLowerCase())}</button></div>`;
  }
  function secHTML(x) {
    const busy = S.busy[x.key];
    return `<section class="pe-sec card" id="pe-${x.key}">
<div class="pe-sec-h"><div><h2 class="h2" style="margin:0">${esc(x.title)}</h2><p class="meta" style="margin:4px 0 0">${esc(x.help)}</p></div>
${S.ai && !S.home ? `<div class="pe-ai"><input class="inp" data-ins="${x.key}" placeholder="Tell the AI something (optional)" value="${esc(S.ins[x.key] || '')}" aria-label="Instructions for the AI">
<button type="button" class="btn sm ai" data-pe="ai" data-s="${x.key}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spin"></span> Writing…' : '✨ Write with AI'}</button></div>` : ''}</div>
${x.key === 'hero' && !S.home ? `<div class="pe-price">Price on the page: <b>${A().money(S.pkg.price)}</b>${S.pkg.mrp ? ` <span class="meta">(MRP ${A().money(S.pkg.mrp)})</span>` : ''} <span class="meta">– comes from the package. Change it in Packages → Edit.</span></div>` : ''}
<div class="pe-grid">${x.fields.map((f) => field(x.key, f)).join('')}${(x.extra || []).map((f) => field('', f)).join('')}</div>
${x.list ? listHTML(x.list.path || `${x.key}.${x.list.key}`, x.list) : ''}
${x.after ? `<div class="pe-grid">${x.after.map((f) => field(x.key, f)).join('')}</div>` : ''}
${x.list2 ? listHTML(`${x.key}.${x.list2.key}`, x.list2) : ''}
</section>`;
  }
  const filled = (k) => { const v = S.page[k] || {}; if (Array.isArray(v)) return !!v.length; if (S.home) return k === 'story' ? !!(v.items || []).length : !!(v.title || v.badge); return k === 'hero' ? !!v.headline : k === 'seo' ? !!v.title : k === 'canCant' ? !!(v.can || []).length : k === 'tests' ? !!(v.groups || []).length : !!(v.items || []).length; };

  function render() {
    const y = window.scrollY;
    if (S.home) {
      root.innerHTML = `<div class="pe-bar"><div class="pe-bar-in">
<button type="button" class="btn ghost sm" data-pe="back">← Packages</button>
<div class="pe-t"><b>Home page</b><span class="meta">drsarwantests.com – our story, then the packages</span></div>
<span class="pe-st live">● Live${S.dirty ? ' · unsaved changes' : ''}</span>
<span class="pe-acts"><button type="button" class="btn ghost sm" data-pe="preview">Preview</button><button type="button" class="btn sm" data-pe="publish">Save &amp; update home page</button></span></div></div>
<div class="pe-wrap"><nav class="pe-nav" aria-label="Page sections">
<div class="pe-url"><a href="/" target="_blank" rel="noopener">Open home page ↗</a><span class="meta">Package cards shown: ${S.packages.length ? S.packages.map((p) => esc(p.name)).join(', ') : 'none yet – publish a package page'}</span></div>
${HOME_SEC.map((x) => `<a href="#pe-${x.key}" data-pe="jump" data-s="${x.key}"><i class="${filled(x.key) ? 'ok' : ''}"></i>${esc(x.title.split(' – ')[0])}</a>`).join('')}
</nav><div class="pe-main">${HOME_SEC.map(secHTML).join('')}</div></div>`;
      window.scrollTo(0, y); return;
    }
    const url = '/package/' + S.slug;
    root.innerHTML = `<div class="pe-bar"><div class="pe-bar-in">
<button type="button" class="btn ghost sm" data-pe="back">← Packages</button>
<div class="pe-t"><b>${esc(S.pkg.name)}</b><span class="meta">${A().money(S.pkg.price)} · ${esc(S.pkg.tests || '')}</span></div>
<span class="pe-st ${S.live ? 'live' : ''}">${S.live ? '● Published' : S.saved ? 'Draft' : 'Not saved yet'}${S.dirty ? ' · unsaved changes' : ''}</span>
<span class="pe-acts">
${S.ai ? `<button type="button" class="btn sm ai" data-pe="aiall" ${Object.keys(S.busy).length ? 'disabled' : ''}>✨ Write whole page</button>` : ''}
<button type="button" class="btn ghost sm" data-pe="preview">Preview</button>
<button type="button" class="btn ghost sm" data-pe="save">Save draft</button>
${S.live ? `<button type="button" class="btn ghost sm" data-pe="unpublish">Unpublish</button><button type="button" class="btn sm" data-pe="publish">Save &amp; update live page</button>` : `<button type="button" class="btn sm" data-pe="publish">Publish</button>`}
</span></div></div>
<div class="pe-wrap">
<nav class="pe-nav" aria-label="Page sections">
<div class="pe-url"><label for="peSlug" class="meta">Web address</label><div class="pe-slug"><span>drsarwantests.com/package/</span><input id="peSlug" class="inp" value="${esc(S.slug)}" autocomplete="off" spellcheck="false"></div>
${S.live && S.pkg.active ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open live page ↗</a>` : '<span class="meta">Visible once published</span>'}<span class="meta">Published pages also get a card on the home page.</span></div>
${SEC.map((x) => `<a href="#pe-${x.key}" data-pe="jump" data-s="${x.key}"><i class="${S.busy[x.key] ? 'busy' : filled(x.key) ? 'ok' : ''}"></i>${esc(x.title.split(' – ')[0])}</a>`).join('')}
${S.ai ? '' : '<p class="meta" style="margin-top:12px">AI writing needs the ANTHROPIC_API_KEY secret in Cloudflare.</p>'}
</nav>
<div class="pe-main">${SEC.map(secHTML).join('')}</div>
</div>`;
    window.scrollTo(0, y);
  }

  // ---------- load / save ----------
  async function open(id) {
    if (!id) return;
    if (S && S.id === id && S.page && S.dirty) { render(); return; } // came back without leaving: keep the edits
    root.innerHTML = '<p class="meta" style="padding:30px">Loading page…</p>';
    if (id === 'home') {
      try {
        const r = await A().api('/api/admin/home');
        S = { id, home: true, page: r.page, packages: r.packages, dirty: false, busy: {}, ins: {} };
        render(); window.scrollTo(0, 0);
      } catch (e) { root.innerHTML = `<p class="err" style="padding:30px">${esc(e.message)}</p>`; }
      return;
    }
    try {
      const r = await A().api(`/api/admin/packages/${id}/page`);
      S = { id, pkg: r.package, page: r.page, slug: r.slug, live: r.live, saved: r.saved, ai: r.ai, dirty: false, busy: {}, ins: {} };
      render(); window.scrollTo(0, 0);
    } catch (e) { root.innerHTML = `<p class="err" style="padding:30px">${esc(e.message)}</p>`; }
  }
  async function save(live) {
    if (S.home) {
      try { await A().post('/api/admin/home', { page: S.page }); S.dirty = false; A().toast('Home page updated ✓'); render(); } catch (e) { A().toast(e.message); }
      return;
    }
    const btns = root.querySelectorAll('[data-pe="save"],[data-pe="publish"],[data-pe="unpublish"]'); btns.forEach((b) => (b.disabled = true));
    try {
      const r = await A().post(`/api/admin/packages/${S.id}/page`, { page: S.page, slug: $('#peSlug').value, live });
      S.slug = r.slug; S.live = r.live; S.saved = true; S.dirty = false;
      A().toast(live ? 'Published ✓ – the page is live' : S.live === false && live === false ? 'Saved as draft' : 'Saved');
      A().reloadPkgs(); render();
    } catch (e) { A().toast(e.message); btns.forEach((b) => (b.disabled = false)); }
  }
  async function ai(sec) {
    S.busy[sec] = true; render();
    try {
      const r = await A().post(`/api/admin/packages/${S.id}/page/ai`, { section: sec, instructions: S.ins[sec] || '', page: S.page });
      Object.assign(S.page, r.content); S.dirty = true;
    } catch (e) { A().toast(e.message); }
    delete S.busy[sec]; render();
  }
  async function aiAll() {
    if (AI_SECTIONS.some(filled) && !confirm('Write every section again with AI? What is there now is replaced (nothing is saved until you press Save).')) return;
    await Promise.all(AI_SECTIONS.map((k) => ai(k)));
    A().toast('All sections written – read them through, then Save or Publish');
  }
  async function preview() {
    const dlg = $('#pePrev'), f = $('#pePrevF');
    f.srcdoc = '<p style="font-family:sans-serif;padding:30px;color:#5a6880">Loading preview…</p>';
    dlg.showModal();
    try {
      const r = await fetch(S.home ? '/api/admin/home/preview' : `/api/admin/packages/${S.id}/page/preview`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': sessionStorage.getItem('dsl_staff') || '' }, body: JSON.stringify({ page: S.page }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Preview failed');
      f.srcdoc = await r.text();
    } catch (e) { f.srcdoc = `<p style="font-family:sans-serif;padding:30px;color:#b23f28">${esc(e.message)}</p>`; }
  }
  document.querySelectorAll('[data-pv]').forEach((b) => (b.onclick = () => { $('#pePrevF').style.width = b.dataset.pv === '100%' ? '100%' : b.dataset.pv + 'px'; }));

  // ---------- events ----------
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.ins) { S.ins[el.dataset.ins] = el.value; return; }
    if (el.id === 'peSlug') { S.dirty = true; return; }
    if (!el.dataset.p) return;
    setP(S.page, el.dataset.p, fromText(el.value, el.dataset.t));
    if (!S.dirty) { S.dirty = true; const st = root.querySelector('.pe-st'); if (st) st.textContent += ' · unsaved changes'; }
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pe]'); if (!b) return;
    const a = b.dataset.pe;
    if (a === 'back') { if (canLeave()) { S = null; history.replaceState(null, '', location.pathname); A().showTab('tests'); } return; }
    if (a === 'jump') { e.preventDefault(); const t = $('#pe-' + b.dataset.s); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 130, behavior: 'smooth' }); return; }
    if (a === 'save') return save(S.live);
    if (a === 'publish') return save(true);
    if (a === 'unpublish') { if (confirm('Take this page off the website? It stays here as a draft.')) save(false); return; }
    if (a === 'preview') return preview();
    if (a === 'ai') return ai(b.dataset.s);
    if (a === 'aiall') return aiAll();
    const list = getP(S.page, b.dataset.l) || [], i = Number(b.dataset.i);
    if (a === 'add') { if (!getP(S.page, b.dataset.l)) setP(S.page, b.dataset.l, list); list.push({}); }
    else if (a === 'del') { if (!confirm('Remove this item?')) return; list.splice(i, 1); }
    else if (a === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (a === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else return;
    S.dirty = true; render();
  });
  window.addEventListener('beforeunload', (e) => { if (S && S.dirty && !$('#view-page').hidden) { e.preventDefault(); e.returnValue = ''; } });

  function canLeave() {
    if (!S || !S.dirty || $('#view-page').hidden) return true;
    if (!confirm('You have unsaved changes on this page. Leave without saving?')) return false;
    S = null; return true;
  }
  window.DSLPage = { open, canLeave };
})();
