'use strict';

const $ = (id) => document.getElementById(id);
const state = { leads: [], today: '', mode: 'web', config: null, selectedId: null, pending: new Map(), saving: null, saveTimer: null, jobTimer: null };
let toastTimer;

async function api(url, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(url, { method, headers: body !== undefined || method === 'DELETE' ? { 'Content-Type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(url.endsWith('/draft') ? 110000 : 20000) });
  } catch { throw new Error('Connection interrupted. Check your connection and refresh the dashboard.'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server returned an unreadable response. Refresh and try again.'); }
  if (!response.ok) throw new Error(data.error || 'This action could not be completed.');
  return data;
}

function showError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function selected() { return state.leads.find((lead) => lead.id === state.selectedId); }
function due(lead) { return lead.followup_date && lead.followup_date <= state.today && !['replied', 'won', 'lost'].includes(lead.status); }
function formatDate(value, short = false) {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: short ? 'short' : 'long', ...(short ? {} : { year: 'numeric' }), timeZone: value.length === 10 ? 'UTC' : state.config?.timezone || 'Asia/Karachi' });
}
function countWords(text) { return text.trim().split(/\s+/u).filter(Boolean).length; }
function validLink(link) { try { const url = new URL(link); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
function setLink(id, href) { const link = $(id); const safe = validLink(href); if (safe) { link.href = safe; link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex'); } else { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.tabIndex = -1; } }
function whatsapp(phone, message) {
  let digits = (phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^0\d{10}$/.test(digits)) digits = `92${digits.slice(1)}`;
  if (/^3\d{9}$/.test(digits)) digits = `92${digits}`;
  return /^\d{8,15}$/.test(digits) && !digits.startsWith('0') ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : '';
}

function render() {
  for (const status of ['new', 'sent', 'replied', 'won']) $(`count-${status}`).textContent = state.leads.filter((lead) => lead.status === status).length;
  $('total-count').textContent = state.leads.length;
  const followups = state.leads.filter(due).sort((a, b) => a.followup_date.localeCompare(b.followup_date));
  $('followup-section').hidden = !followups.length;
  $('followup-caption').textContent = `${followups.length} ${followups.length === 1 ? 'conversation to pick up' : 'conversations to pick up'}`;
  $('followup-list').replaceChildren(...followups.map((lead) => {
    const button = element('button', 'followup-item');
    button.type = 'button';
    button.append(element('span', '', lead.name), element('span', `followup-date${lead.followup_date < state.today ? ' overdue' : ''}`, lead.followup_date < state.today ? `Overdue · ${formatDate(lead.followup_date, true)}` : 'Today'), element('span', '', '↗'));
    button.addEventListener('click', () => openDetail(lead.id));
    return button;
  }));
  const query = $('name-filter').value.trim().toLocaleLowerCase();
  const filtered = state.leads.filter((lead) => (!query || lead.name.toLocaleLowerCase().includes(query)) && (!$('type-filter').value || lead.type === $('type-filter').value) && (!$('status-filter').value || lead.status === $('status-filter').value));
  filtered.sort((a, b) => {
    if ($('sort-order').value === 'name') return a.name.localeCompare(b.name);
    if ($('sort-order').value === 'newest') return b.created_at.localeCompare(a.created_at);
    return Number(due(b)) - Number(due(a)) || (a.followup_date || '9999').localeCompare(b.followup_date || '9999') || b.created_at.localeCompare(a.created_at);
  });
  $('lead-rows').replaceChildren(...filtered.map((lead) => {
    const row = element('tr', 'lead-row');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `Open ${lead.name}, ${lead.status}`);
    const cell = (label) => { const td = element('td'); td.dataset.label = label; row.append(td); return td; };
    cell('NAME / SOURCE').append(element('span', 'lead-name', lead.name), element('span', 'lead-source', lead.source_label));
    cell('TYPE').textContent = lead.type === 'web' ? 'Web' : 'Video';
    const contact = cell('CONTACT');
    contact.append(element('span', '', lead.phone || lead.email || (lead.type === 'video' ? 'YouTube channel ↗' : lead.link ? 'View link ↗' : 'No contact')));
    if (lead.email && lead.phone) contact.append(element('span', 'table-detail', lead.email));
    if (!lead.phone && !lead.email) contact.append(element('span', 'table-detail', lead.type === 'video' ? 'Check About for email' : 'No phone listed'));
    const audience = cell('RATING / AUDIENCE');
    if (lead.type === 'web') { audience.append(element('span', '', lead.rating ? `${lead.rating} / 5` : '—')); if (lead.reviews) audience.append(element('span', 'table-detail', `${Number(lead.reviews).toLocaleString()} reviews`)); }
    else { audience.append(element('span', '', lead.subscribers ? Number(lead.subscribers).toLocaleString() : '—')); if (lead.subscribers) audience.append(element('span', 'table-detail', 'subscribers')); }
    cell('STATUS').append(element('span', `status ${lead.status}`, lead.status));
    const dateCell = cell('FOLLOWUP');
    dateCell.textContent = lead.followup_date === state.today ? 'Today' : formatDate(lead.followup_date, true);
    if (due(lead) && lead.followup_date < state.today) dateCell.className = 'overdue';
    cell('').append(element('span', 'row-arrow', '↗'));
    row.addEventListener('click', () => openDetail(lead.id));
    row.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); openDetail(lead.id); } });
    return row;
  }));
  $('empty-state').hidden = Boolean(filtered.length);
  $('empty-state').querySelector('h3').textContent = state.leads.length ? 'No leads match this view.' : 'Your next conversation starts here.';
  $('empty-state').querySelector('p').textContent = state.leads.length ? 'Try another name, type or status.' : 'Run a search above, or add a lead you already have.';
  $('empty-add').hidden = Boolean(state.leads.length);
  $('visible-count').textContent = `${filtered.length} of ${state.leads.length} ${state.leads.length === 1 ? 'lead' : 'leads'}`;
}

async function refresh() {
  const data = await api('/api/leads');
  state.leads = data.leads.map((lead) => ({ ...lead, ...state.pending.get(lead.id) }));
  state.today = data.today;
  $('today-label').textContent = formatDate(state.today);
  showError('load-error');
  render();
}

function showDialog(id) { $(id).showModal(); document.body.classList.add('modal-open'); }
function closeDialog(id) { $(id).close(); if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open'); }
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', () => { if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open'); }));

function detailMetadata(lead) {
  $('detail-status').value = lead.status;
  $('detail-followup').value = lead.followup_date;
  $('sent-on').textContent = lead.sent_date ? `Sent on ${formatDate(lead.sent_date)}` : 'Mark as sent after you send the message. Followup is set for 3 days later.';
}

function messageMetadata() {
  const lead = selected();
  if (!lead) return;
  const words = countWords($('detail-message').value);
  $('word-count').textContent = `${words} / 60 words${words > 60 ? ' · consider shortening' : ''}`;
  setLink('open-whatsapp', whatsapp(lead.phone, $('detail-message').value));
  $('no-phone').hidden = Boolean(whatsapp(lead.phone, ''));
  $('no-phone').textContent = lead.type === 'video' ? 'No phone number. Use the channel About page to look for contact details.' : 'No phone number is listed. Use the business link to find contact details manually.';
  const email = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(lead.email || '') ? lead.email : '';
  $('open-email').hidden = !email;
  if (email) $('open-email').href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Website project - ' + lead.name)}&body=${encodeURIComponent($('detail-message').value)}`;
  else $('open-email').removeAttribute('href');
  $('copy-message').disabled = !$('detail-message').value.trim();
}

async function openDetail(id) {
  if (state.selectedId && state.selectedId !== id && !(await flush())) return;
  const lead = state.leads.find((item) => item.id === id);
  if (!lead) return;
  state.selectedId = id;
  $('detail-name').textContent = lead.name;
  $('detail-type').textContent = lead.type === 'web' ? 'WEB DEVELOPMENT' : 'VIDEO EDITING';
  $('detail-source').textContent = [lead.source_label, lead.address].filter(Boolean).join(' · ');
  const facts = [];
  if (lead.phone) facts.push(['PHONE', lead.phone]);
  if (lead.email) facts.push(['EMAIL', lead.email]);
  if (lead.rating) facts.push(['RATING', `${lead.rating} / 5 · ${lead.reviews || '0'} reviews`]);
  if (lead.subscribers) facts.push(['SUBSCRIBERS', Number(lead.subscribers).toLocaleString()]);
  if (lead.last_upload) facts.push(['LAST UPLOAD', formatDate(lead.last_upload)]);
  $('detail-facts').replaceChildren(...facts.map(([label, text]) => { const div = element('div'); div.append(element('span', 'micro', label), element('span', '', text)); return div; }));
  setLink('open-link', lead.link);
  $('about-link').hidden = !lead.about_link;
  setLink('about-link', lead.about_link);
  $('recent-section').hidden = !lead.recent_videos.length;
  $('recent-videos').replaceChildren(...lead.recent_videos.map((video) => { const li = element('li'); li.append(element('span', '', video.title), element('time', '', formatDate(video.published_at))); return li; }));
  $('research-section').hidden = !lead.research;
  $('research-evidence').replaceChildren(...Object.entries(lead.research?.evidence || {}).map(([field, item]) => {
    const div = element('div', 'research-item');
    const link = element('a', 'text-button', `View ${field} source ↗`);
    const href = validLink(item.url); if (href) link.href = href;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    div.append(element('span', 'micro', field.toUpperCase()), element('blockquote', '', item.quote), link);
    return div;
  }));
  $('research-pages').replaceChildren(...(lead.research?.pages || []).map(url => {
    const link = element('a', 'text-button', url);
    const href = validLink(url); if (href) link.href = href;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }));
  $('detail-message').value = lead.message;
  $('detail-notes').value = lead.notes;
  detailMetadata(lead);
  messageMetadata();
  showError('detail-error');
  $('save-state').textContent = state.pending.has(id) ? 'Unsaved changes' : 'All changes saved';
  if (!$('detail-dialog').open) showDialog('detail-dialog');
}

function scheduleSave(patch) {
  const lead = selected();
  if (!lead) return;
  const changes = { ...patch };
  if (patch.status === 'sent' && lead.status !== 'sent') {
    const date = new Date(`${state.today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 3);
    changes.sent_date = state.today;
    changes.followup_date = date.toISOString().slice(0, 10);
  }
  if (['replied', 'won', 'lost'].includes(patch.status)) changes.followup_date = '';
  state.pending.set(lead.id, { ...state.pending.get(lead.id), ...changes });
  Object.assign(lead, changes);
  $('save-state').textContent = 'Saving…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(savePending, 350);
  detailMetadata(lead);
  render();
}

async function savePending() {
  if (state.saving) return state.saving;
  state.saving = (async () => {
    while (state.pending.size) {
      const [id, patch] = state.pending.entries().next().value;
      state.pending.delete(id);
      try {
        const saved = await api(`/api/leads/${id}`, { method: 'PATCH', body: patch });
        const lead = state.leads.find((item) => item.id === id);
        if (lead) Object.assign(lead, saved, state.pending.get(id));
        if (state.selectedId === id) { detailMetadata(lead); showError('detail-error'); }
        render();
      } catch (error) {
        state.pending.set(id, { ...patch, ...state.pending.get(id) });
        $('save-state').textContent = 'Not saved · retry';
        showError('detail-error', `${error.message} Your changes are still in this tab. Click Retry save.`);
        $('retry-save').hidden = false;
        return false;
      }
    }
    $('save-state').textContent = 'All changes saved';
    $('retry-save').hidden = true;
    return true;
  })();
  try { return await state.saving; } finally { state.saving = null; }
}

async function flush() {
  clearTimeout(state.saveTimer);
  if (state.saving && !(await state.saving)) return false;
  return state.pending.size ? savePending() : true;
}

async function closeDetail() {
  if (!(await flush())) return;
  closeDialog('detail-dialog');
  state.selectedId = null;
}
$('detail-close').addEventListener('click', closeDetail);
$('detail-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDetail(); });
$('detail-message').addEventListener('input', () => { messageMetadata(); scheduleSave({ message: $('detail-message').value }); });
$('detail-notes').addEventListener('input', () => scheduleSave({ notes: $('detail-notes').value }));
$('detail-status').addEventListener('change', () => scheduleSave({ status: $('detail-status').value }));
$('detail-followup').addEventListener('change', () => scheduleSave({ followup_date: $('detail-followup').value }));
$('copy-message').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('detail-message').value); toast('Message copied.'); }
  catch { $('detail-message').focus(); $('detail-message').select(); toast('Select and copy the message with Ctrl+C.'); }
});
$('draft-button').addEventListener('click', async () => {
  if (!(await flush())) return;
  const id = state.selectedId;
  const button = $('draft-button');
  button.disabled = true; button.textContent = 'Drafting…'; $('detail-message').disabled = true;
  showError('detail-error');
  try {
    const lead = await api(`/api/leads/${id}/draft`, { method: 'POST', body: {} });
    const existing = state.leads.find((item) => item.id === id);
    if (existing) Object.assign(existing, lead);
    if (state.selectedId === id) { $('detail-message').value = lead.message; messageMetadata(); }
    toast('Draft saved. Review it before sending.');
  } catch (error) { if (state.selectedId === id) showError('detail-error', error.message); else toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Draft with Gemini ↗'; $('detail-message').disabled = false; }
});
const retrySave = element('button', 'text-button', 'Retry save');
retrySave.id = 'retry-save'; retrySave.type = 'button'; retrySave.hidden = true;
$('detail-error').after(retrySave);
retrySave.addEventListener('click', savePending);
window.addEventListener('beforeunload', (event) => { if (state.pending.size || state.saving) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && state.pending.size) savePending(); });

function openAdd() { showError('add-error'); showDialog('add-dialog'); }
$('add-open').addEventListener('click', openAdd);
$('empty-add').addEventListener('click', openAdd);
$('add-close').addEventListener('click', () => closeDialog('add-dialog'));
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('add-submit').disabled = true;
  showError('add-error');
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const lead = await api('/api/leads', { method: 'POST', body: input });
    state.leads.push(lead);
    $('add-form').reset();
    closeDialog('add-dialog');
    render();
    await openDetail(lead.id);
    toast('Lead added.');
  } catch (error) { showError('add-error', error.message); }
  finally { $('add-submit').disabled = false; }
});
$('delete-lead').addEventListener('click', async () => {
  if (!(await flush())) return;
  showError('delete-error');
  $('confirm-copy').textContent = `${selected().name} will be removed. A copy of the CSV is saved in backups before deletion.`;
  showDialog('confirm-dialog');
});
$('delete-cancel').addEventListener('click', () => closeDialog('confirm-dialog'));
$('delete-confirm').addEventListener('click', async () => {
  const id = state.selectedId;
  $('delete-confirm').disabled = true;
  try {
    await api(`/api/leads/${id}`, { method: 'DELETE' });
    state.leads = state.leads.filter((lead) => lead.id !== id);
    state.selectedId = null;
    closeDialog('confirm-dialog'); closeDialog('detail-dialog'); render();
    toast('Lead deleted. Backup saved.');
  } catch (error) { showError('delete-error', error.message); }
  finally { $('delete-confirm').disabled = false; }
});

function updateEstimate() {
  const limit = Number($('search-limit').value);
  const web = state.mode === 'web';
  const research = web && $('web-provider').value === 'gemini';
  $('web-research-controls').hidden = !web;
  $('website-links-field').hidden = !research;
  $('website-links').required = research;
  $('search-query').required = !research;
  $('search-query').hidden = research;
  $('query-label').hidden = research;
  $('reviews-field').hidden = !web || research;
  $('query-label').textContent = web ? 'BUSINESS & LOCATION' : 'NICHE OR KEYWORD';
  $('search-query').placeholder = web ? 'e.g. clothing store Lahore' : 'e.g. urdu vlog or podcast pakistan';
  $('run-search').textContent = research ? 'Research websites ↗' : 'Run search ↗';
  $('search-estimate').textContent = research ? `Up to ${limit} businesses · one Gemini reading call per business, plus optional drafts. Uses your Gemini quota; no Google Search or Places calls. Missing contacts stay blank.` : state.mode === 'video' ? `Up to ${101 + limit} quota units · 1 search + stats + up to ${limit} uploads checks. Conservative 100-unit search budget; check your project quotas.` : `One Places request · up to ${limit} businesses · API billing applies.`;
}
$('web-provider').addEventListener('change', updateEstimate);
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  updateEstimate();
}));
$('search-limit').addEventListener('change', updateEstimate);
$('hide-output').addEventListener('click', () => { $('search-output-box').hidden = true; });
function renderJob(job) {
  const running = job.status === 'running';
  $('run-search').disabled = running;
  $('run-search').textContent = running ? (job.options?.webProvider === 'gemini' ? 'Reading websites…' : 'Searching…') : state.mode === 'web' && $('web-provider').value === 'gemini' ? 'Research websites ↗' : 'Run search ↗';
  $('job-label').textContent = running ? 'SEARCH RUNNING' : job.status === 'done' ? 'SEARCH COMPLETE' : 'SEARCH STOPPED';
  $('search-output').textContent = job.output || 'Starting the finder…';
  $('search-output').scrollTop = $('search-output').scrollHeight;
  $('search-output-box').hidden = false;
}
async function pollJob(id) {
  clearTimeout(state.jobTimer);
  try {
    const job = await api(`/api/search/${id}`);
    renderJob(job);
    if (job.status === 'running') state.jobTimer = setTimeout(() => pollJob(id), 1000);
    else { await refresh(); toast(job.status === 'done' ? 'Search finished. Your shortlist is up to date.' : 'Search stopped. See the output for details.'); }
  } catch (error) {
    $('search-output').textContent = error.message;
    state.jobTimer = setTimeout(() => pollJob(id), 4000);
  }
}
$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('run-search').disabled = true;
  const options = { mode: state.mode, query: $('search-query').value, webProvider: $('web-provider').value, urls: $('website-links').value, limit: Number($('search-limit').value), minReviews: Number($('min-reviews').value), draft: $('search-draft').checked };
  try {
    await api('/api/search/estimate', { method: 'POST', body: options });
    const job = await api('/api/search', { method: 'POST', body: options });
    renderJob(job); pollJob(job.id);
  } catch (error) {
    $('search-output-box').hidden = false;
    $('job-label').textContent = 'SEARCH COULD NOT START';
    $('search-output').textContent = error.message;
    $('run-search').disabled = false;
  }
});

for (const id of ['name-filter', 'type-filter', 'status-filter', 'sort-order']) $(id).addEventListener(id === 'name-filter' ? 'input' : 'change', render);
document.querySelectorAll('[data-count-status]').forEach((button) => button.addEventListener('click', () => { $('status-filter').value = button.dataset.countStatus; render(); $('leads-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }));
$('refresh-button').addEventListener('click', async () => { try { if (!(await flush())) return; await refresh(); toast('Shortlist refreshed.'); } catch (error) { showError('load-error', error.message); } });
$('settings-open').addEventListener('click', () => showDialog('settings-dialog'));
$('settings-close').addEventListener('click', () => closeDialog('settings-dialog'));

async function initialize() {
  try {
    state.config = await api('/api/config');
    $('model-label').textContent = state.config.model;
    $('key-status').replaceChildren(...[['Google Places', 'GOOGLE_PLACES_API_KEY'], ['YouTube', 'YOUTUBE_API_KEY'], ['Gemini', 'GEMINI_API_KEY']].map(([label, key]) => { const div = element('div'); div.append(element('dt', '', label), element('dd', '', state.config.keys[key] ? 'Configured' : 'Missing key')); return div; }));
    await refresh();
    const job = await api('/api/search');
    if (job) { renderJob(job); if (job.status === 'running') pollJob(job.id); }
  } catch (error) { showError('load-error', error.message); $('empty-state').hidden = true; }
}
updateEstimate();
initialize();
