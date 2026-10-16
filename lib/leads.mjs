import { randomUUID } from 'node:crypto';
import { AppError, dateToday, addDays } from './config.mjs';

export const COLUMNS = ['id', 'type', 'name', 'source', 'address', 'phone', 'email', 'link', 'rating', 'reviews', 'subscribers', 'last_upload', 'message', 'wa_link', 'status', 'notes', 'sent_date', 'followup_date', 'created_at'];
export const STATUSES = ['new', 'sent', 'replied', 'won', 'lost'];

export function safeLink(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^0\d{10}$/.test(digits)) digits = `92${digits.slice(1)}`;
  if (/^3\d{9}$/.test(digits)) digits = `92${digits}`;
  return /^\d{8,15}$/.test(digits) && !digits.startsWith('0') ? digits : '';
}

export function whatsappLink(phone, message) {
  const digits = normalizePhone(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message || '')}` : '';
}

export function sourceData(source) {
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const match = /^(google|youtube):(.+)$/.exec(source || '');
    return match ? { provider: match[1], id: match[2] } : {};
  }
}

export function canonicalLink(value) {
  const valid = safeLink(value);
  if (!valid) return '';
  const url = new URL(valid);
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|si$)/i.test(key)) url.searchParams.delete(key);
  }
  if (url.hostname === 'youtube.com') url.pathname = url.pathname.replace(/\/(about|videos|featured)\/?$/, '');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return `${url.hostname}${url.pathname}${url.search}`;
}

export function identityKeys(lead) {
  const source = sourceData(lead.source);
  const keys = [];
  if (source.provider && source.id) keys.push(`source:${source.provider}:${source.id}`);
  const link = canonicalLink(lead.link);
  if (link) keys.push(`link:${link}`);
  return keys;
}

function stringField(input, name, max = 2000) {
  if (input[name] == null) return '';
  if (typeof input[name] !== 'string') throw new AppError(`${name} must be text.`);
  if (input[name].length > max) throw new AppError(`${name} is too long (maximum ${max} characters).`);
  return input[name];
}

export function createLead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Enter lead details.');
  if (!['web', 'video'].includes(input.type)) throw new AppError('Choose web or video.');
  const name = stringField(input, 'name', 300).trim();
  if (!name) throw new AppError('A lead needs a name.');
  const lead = Object.fromEntries(COLUMNS.map((key) => [key, '']));
  for (const key of ['source', 'address', 'phone', 'email', 'link', 'rating', 'reviews', 'subscribers', 'last_upload', 'message', 'notes']) {
    lead[key] = stringField(input, key, ['message', 'notes', 'source'].includes(key) ? 20000 : 2000);
  }
  if (lead.link && !safeLink(lead.link)) throw new AppError('Use a full http:// or https:// link.');
  if (lead.phone && !normalizePhone(lead.phone)) throw new AppError('Enter a valid international phone number, or a Pakistani mobile number.');
  Object.assign(lead, { id: randomUUID(), type: input.type, name, status: 'new', created_at: new Date().toISOString() });
  lead.wa_link = whatsappLink(lead.phone, lead.message);
  return lead;
}

export function updateLead(lead, input, today = dateToday()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Enter changes to save.');
  const updated = { ...lead };
  for (const key of ['message', 'notes']) {
    if (Object.hasOwn(input, key)) updated[key] = stringField(input, key, 20000);
  }
  if (Object.hasOwn(input, 'followup_date')) {
    const date = stringField(input, 'followup_date', 10);
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date)) {
      throw new AppError('Enter a valid followup date.');
    }
    updated.followup_date = date;
  }
  if (Object.hasOwn(input, 'status')) {
    if (!STATUSES.includes(input.status)) throw new AppError('Choose a valid status.');
    if (input.status === 'sent' && lead.status !== 'sent') {
      updated.sent_date = today;
      updated.followup_date = addDays(today, 3);
    }
    if (['replied', 'won', 'lost'].includes(input.status)) updated.followup_date = '';
    updated.status = input.status;
  }
  updated.wa_link = whatsappLink(updated.phone, updated.message);
  return updated;
}

export function publicLead(lead) {
  const source = sourceData(lead.source);
  return {
    ...lead,
    wa_link: whatsappLink(lead.phone, lead.message),
    source_label: source.provider === 'google' ? 'Google Places' : source.provider === 'youtube' ? 'YouTube' : source.provider === 'gemini_web' ? 'Gemini website research' : lead.source || 'Manual',
    research: source.provider === 'gemini_web' ? { pages: source.pages || [], evidence: source.evidence || {}, researched_at: source.researched_at || '' } : null,
    recent_videos: Array.isArray(source.recent_videos) ? source.recent_videos : [],
    about_link: lead.type === 'video' && /^(https?:\/\/)?(www\.)?youtube\.com\//i.test(lead.link) ? `${lead.link.replace(/\/(about|videos|featured)\/?$/, '').replace(/\/$/, '')}/about` : '',
  };
}
