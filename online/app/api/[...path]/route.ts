import { env } from 'cloudflare:workers';
import { AppError, dateToday, TIMEZONE, runtimeValue, withRuntimeSettings } from '@/hunter/config.mjs';
import { createLead, updateLead, publicLead } from '@/hunter/leads.mjs';
import { LeadStore, fromCSV } from '@/hunter/store.mjs';
import { draftMessage, draftModel, searchOptions, quotaEstimate } from '@/hunter/providers.mjs';
import { readSettings, saveSettings } from '@/hunter/settings.mjs';
import { startJob, advanceJob, latestJob, readJob } from '@/hunter/jobs.mjs';

export const dynamic = 'force-dynamic';
const KEYS = ['GOOGLE_PLACES_API_KEY', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY'];
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function csvResponse(csv: string, filename: string) {
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function handle(request: Request) {
  const url = new URL(request.url);
  const segments = url.pathname.slice(5).split('/');
  const method = request.method;
  try {
    // Sites enforces owner-only access before this Worker receives any request.
    if (!env.DB) throw new AppError('Notebook storage is unavailable. Please try again.', 503);
    if (['POST', 'PATCH', 'DELETE'].includes(method)) {
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new AppError('Use application/json for changes.', 415);
      if (Number(request.headers.get('Content-Length') || 0) > 1900000) throw new AppError('This upload is too large.', 413);
    }
    let body: any = {};
    if (['POST', 'PATCH'].includes(method)) {
      const raw = await request.text();
      if (raw.length > 1900000) throw new AppError('This upload is too large.', 413);
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw new AppError('Request contains invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Enter valid details.');
    }
    if (['POST', 'PATCH', 'DELETE'].includes(method)) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new AppError('Changes must come from this dashboard.', 403);
    }
    const database = env.DB;
    const store = new LeadStore(database);
    const settings = await readSettings(database);
    return await withRuntimeSettings(settings, async () => {
      if (segments[0] === 'config' && method === 'GET') return json({ today: dateToday(), timezone: TIMEZONE, model: draftModel(), keys: Object.fromEntries(KEYS.map((key) => [key, Boolean(runtimeValue(key).trim())])), sender_name: runtimeValue('SENDER_NAME'), portfolio_url: runtimeValue('PORTFOLIO_URL'), hosted: true });
      if (segments[0] === 'settings' && method === 'POST') { await saveSettings(database, body); return json({ saved: true }); }
      if (segments[0] === 'export' && method === 'GET') return csvResponse((await store.state()).csv, 'leads.csv');
      if (segments[0] === 'import' && method === 'POST') {
        if (typeof body.csv !== 'string') throw new AppError('Choose a leads.csv file.');
        const candidates = fromCSV(body.csv);
        const added = await store.addMany(candidates);
        return json({ added: added.length, skipped: candidates.length - added.length });
      }
      if (segments[0] === 'backups' && method === 'GET') {
        if (segments[1]) {
          const revision = Number(segments[1].replace(/\.csv$/, ''));
          if (!Number.isInteger(revision) || revision < 0) throw new AppError('Backup not found.', 404);
          const backup = await database.prepare('SELECT csv, created_at FROM csv_backups WHERE revision = ?').bind(revision).first<{csv:string;created_at:string}>();
          if (!backup) throw new AppError('Backup not found.', 404);
          return csvResponse(backup.csv, `leads-${backup.created_at.replace(/[:.]/g, '-')}-${revision}.csv`);
        }
        return json({ backups: (await database.prepare('SELECT revision, created_at FROM csv_backups ORDER BY revision DESC LIMIT 20').all()).results });
      }
      if (segments[0] === 'leads') {
        if (!segments[1] && method === 'GET') return json({ leads: (await store.read()).map(publicLead), today: dateToday() });
        if (!segments[1] && method === 'POST') {
          const lead = createLead(body);
          if (!lead.phone && !lead.link) throw new AppError('Add a phone number or link.');
          if (!(await store.addMany([lead])).length) throw new AppError('A lead with this link or source ID already exists.', 409);
          return json(publicLead(lead), 201);
        }
        const id = segments[1];
        if (segments[2] === 'draft' && method === 'POST') {
          const lead = (await store.read()).find((item: any) => item.id === id);
          if (!lead) throw new AppError('This lead no longer exists.', 404);
          const message = await draftMessage(lead);
          const saved = await store.update(id, (current: any) => { if (current.message !== lead.message) throw new AppError('The message changed on another device. Your edits were kept.', 409); return updateLead(current, { message }); });
          return json(publicLead(saved));
        }
        if (method === 'PATCH') return json(publicLead(await store.update(id, (lead: any) => updateLead(lead, body))));
        if (method === 'DELETE') { await store.remove(id); return json({ deleted: true }); }
      }
      if (segments[0] === 'search') {
        if (segments[1] === 'estimate' && method === 'POST') { const options = searchOptions(body); return json({ ...quotaEstimate(options), options }); }
        if (!segments[1] && method === 'GET') return json(await latestJob(database));
        if (!segments[1] && method === 'POST') return json(await startJob(database, body), 202);
        if (segments[1] && segments[2] === 'advance' && method === 'POST') return json(await advanceJob(database, store, segments[1]));
        if (segments[1] && method === 'GET') return json(await readJob(database, segments[1]));
      }
      throw new AppError('Unknown API route.', 404);
    });
  } catch (error) {
    return json({ error: error instanceof AppError ? error.message : 'Unable to complete this action. Your saved data is kept. Try again.' }, error instanceof AppError ? error.status : 500);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
