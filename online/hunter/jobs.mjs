import { AppError, requireKey, runtimeValue } from './config.mjs';
import { createLead, identityKeys, updateLead } from './leads.mjs';
import { searchOptions, quotaEstimate, requestJson, findWeb, draftMessage } from './providers.mjs';
import { inspectWebsite } from './research.mjs';

const stripLines = (value) => String(value).replace(/[\r\n]/g, ' ');
function append(job, line) { job.output = (job.output + line + '\n').slice(-32000); }
function view(job) { const { channels, ids, addedIds, cursor, phase, sites, ...result } = job; return result; }
async function youtube(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  return requestJson(url, { headers: { 'X-Goog-Api-Key': requireKey('YOUTUBE_API_KEY') } }, 'YouTube');
}

export async function latestJob(db) {
  const row = await db.prepare('SELECT data FROM search_jobs ORDER BY active_slot DESC, created_at DESC LIMIT 1').first();
  return row ? view(JSON.parse(row.data)) : null;
}
export async function readJob(db, id) {
  const row = await db.prepare('SELECT data FROM search_jobs WHERE id = ?').bind(id).first();
  if (!row) throw new AppError('Search output is no longer available.', 404);
  return view(JSON.parse(row.data));
}
export async function startJob(db, input) {
  const options = searchOptions(input);
  requireKey(options.webProvider === 'gemini' ? 'GEMINI_API_KEY' : options.mode === 'web' ? 'GOOGLE_PLACES_API_KEY' : 'YOUTUBE_API_KEY');
  const job = { id: crypto.randomUUID(), options, status: 'running', output: '', started_at: new Date().toISOString(), phase: 'search', ids: [], channels: [], addedIds: [], cursor: 0 };
  if (options.mode === 'video') append(job, `YouTube budget: up to ${quotaEstimate(options).maxUnits} units using a conservative 100-unit search allowance. One search call; ${options.limit} channel cap.`);
  else if (options.webProvider === 'gemini') append(job, `Gemini website research: ${options.websiteGroups.length} businesses; up to ${quotaEstimate(options).modelCalls} model calls including drafts. No Google Search or Places calls. Free-tier quota applies.`);
  else append(job, `Searching Google Places; inspecting at most ${options.limit} businesses.`);
  try {
    await db.prepare('INSERT INTO search_jobs (id, data, active_slot, lease_until, created_at) VALUES (?, ?, 1, 0, ?)').bind(job.id, JSON.stringify(job), job.started_at).run();
  } catch { throw new AppError('A search is already running. Its progress resumes when this dashboard is open.', 409); }
  return view(job);
}

export async function advanceJob(db, store, id) {
  const claimed = await db.prepare('UPDATE search_jobs SET lease_until = ? WHERE id = ? AND active_slot = 1 AND lease_until < ?').bind(Date.now() + 120000, id, Date.now()).run();
  if (!claimed.meta.changes) return readJob(db, id);
  const row = await db.prepare('SELECT data FROM search_jobs WHERE id = ?').bind(id).first();
  const job = JSON.parse(row.data);
  const options = job.options;
  const addFound = async (found) => {
    const added = await store.addMany(found);
    job.addedIds.push(...added.map((lead) => lead.id));
    added.forEach((lead) => append(job, `Added ${stripLines(lead.name)}.`));
  };
  try {
    if (job.phase === 'search' && options.webProvider === 'gemini') {
      const known = new Set((await store.read()).flatMap(identityKeys));
      job.sites = options.websiteGroups.filter(pages => {
        const domain = new URL(pages[0]).hostname.toLowerCase().replace(/^www\./, '');
        return !known.has(`source:gemini_web:${domain}`) && !identityKeys({ link: pages[0] }).some(key => known.has(key));
      });
      append(job, `${job.sites.length} unseen websites to read. Existing leads are kept.`);
      job.cursor = 0; job.phase = job.sites.length ? 'websites' : 'drafts';
    } else if (job.phase === 'websites') {
      const pages = job.sites[job.cursor];
      try {
        const lead = await inspectWebsite(pages);
        await addFound([lead]);
        append(job, `${stripLines(lead.name)}: ${lead.email ? 'email found' : 'no sourced email'}, ${lead.phone ? 'phone found' : 'no sourced phone'}. Review the source pages before outreach.`);
      } catch (error) {
        if (!(error instanceof AppError) || ![422, 502].includes(error.status)) throw error;
        append(job, `Skipped ${new URL(pages[0]).hostname}: ${error.message}`);
      }
      job.cursor++;
      if (job.cursor >= job.sites.length) { job.phase = 'drafts'; job.cursor = 0; }
    } else if (job.phase === 'search' && options.mode === 'web') {
      const found = await findWeb(options);
      await addFound(found);
      append(job, `${found.length} qualifying businesses; ${job.addedIds.length} new.`);
      job.phase = 'drafts'; job.cursor = 0;
    } else if (job.phase === 'search') {
      const result = await youtube('search', { part: 'snippet', type: 'channel', q: options.query, maxResults: options.limit });
      const known = new Set((await store.read()).flatMap(identityKeys));
      job.ids = [...new Set((result.items || []).map((item) => item.id?.channelId).filter(Boolean))].slice(0, options.limit).filter((channel) => !known.has(`source:youtube:${channel}`) && !known.has(`link:youtube.com/channel/${channel}`));
      append(job, `${job.ids.length} unseen channels to check.`);
      job.phase = job.ids.length ? 'stats' : 'drafts';
    } else if (job.phase === 'stats') {
      const data = await youtube('channels', { part: 'snippet,statistics,contentDetails', id: job.ids.join(','), maxResults: job.ids.length });
      job.channels = (data.items || []).filter((channel) => !channel.statistics?.hiddenSubscriberCount && Number(channel.statistics?.subscriberCount) >= 5000 && Number(channel.statistics?.subscriberCount) <= 100000 && channel.contentDetails?.relatedPlaylists?.uploads).slice(0, options.limit);
      append(job, `${job.channels.length} channels have 5k–100k subscribers. Checking recent uploads.`);
      job.cursor = 0; job.phase = job.channels.length ? 'uploads' : 'drafts';
    } else if (job.phase === 'uploads') {
      const channel = job.channels[job.cursor];
      const uploads = await youtube('playlistItems', { part: 'snippet,contentDetails', playlistId: channel.contentDetails.relatedPlaylists.uploads, maxResults: 3 });
      const now = Date.now();
      const videos = (uploads.items || []).map((item) => ({ title: item.snippet?.title || '', published_at: item.contentDetails?.videoPublishedAt || '', id: item.contentDetails?.videoId || '' })).filter((video) => video.title && Number.isFinite(Date.parse(video.published_at)) && Date.parse(video.published_at) <= now).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
      if (videos.length && Date.parse(videos[0].published_at) >= now - 60 * 86400000) {
        await addFound([createLead({ type: 'video', name: channel.snippet.title, source: JSON.stringify({ provider: 'youtube', id: channel.id, recent_videos: videos }), link: `https://www.youtube.com/channel/${channel.id}`, subscribers: String(channel.statistics.subscriberCount), last_upload: videos[0].published_at })]);
      } else append(job, `Skipped ${stripLines(channel.snippet.title)}: no public upload in the last 60 days.`);
      job.cursor++;
      if (job.cursor >= job.channels.length) { job.phase = 'drafts'; job.cursor = 0; }
    } else if (job.phase === 'drafts') {
      if (options.draft && job.cursor < job.addedIds.length) {
        if (!runtimeValue('GEMINI_API_KEY').trim()) {
          append(job, 'Missing GEMINI_API_KEY: leads saved without drafts. Write a message manually or add a Gemini key in API setup.');
          job.phase = 'finish';
        } else {
          const lead = (await store.read()).find((item) => item.id === job.addedIds[job.cursor]);
          if (lead && !lead.message) {
            try {
              const message = await draftMessage(lead);
              await store.update(lead.id, (current) => current.message ? current : updateLead(current, { message }));
              append(job, `Draft saved for ${stripLines(lead.name)}.`);
            } catch (error) {
              append(job, error instanceof AppError ? error.message : 'Unable to save draft. Findings are saved.');
              job.phase = 'finish';
            }
          }
          job.cursor++;
        }
      } else job.phase = 'finish';
    }
    if (job.phase === 'finish') {
      job.status = 'done'; job.finished_at = new Date().toISOString();
      append(job, `Finished. ${job.addedIds.length} leads added. Existing status and notes preserved. Nothing was sent.`);
    }
  } catch (error) {
    job.status = 'failed'; job.finished_at = new Date().toISOString();
    append(job, error instanceof AppError ? error.message : 'Search stopped. Saved leads are kept. Try again.');
  }
  // Redact known credentials even if a provider includes one in a returned name.
  for (const key of ['GOOGLE_PLACES_API_KEY', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY']) {
    const value = runtimeValue(key); if (value) job.output = job.output.split(value).join('[redacted]');
  }
  await db.prepare('UPDATE search_jobs SET data = ?, lease_until = 0, active_slot = ? WHERE id = ?').bind(JSON.stringify(job), job.status === 'running' ? 1 : null, id).run();
  return view(job);
}
