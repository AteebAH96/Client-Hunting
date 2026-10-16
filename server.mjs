import express from 'express';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LeadStore } from './lib/store.mjs';
import { AppError, ROOT, dateToday, TIMEZONE } from './lib/config.mjs';
import { createLead, updateLead, publicLead } from './lib/leads.mjs';
import { draftMessage, draftModel, searchOptions, quotaEstimate } from './lib/providers.mjs';

export function createApp({ store = new LeadStore(), fetcher = fetch } = {}) {
  const app = express();
  const jobs = new Map();
  let activeJob = null;
  const drafting = new Set();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: 'Use the local 127.0.0.1 address.' });
    const origin = req.headers.origin;
    if (origin && ![`http://${host}`, `http://127.0.0.1${req.socket.localPort === 80 ? '' : `:${req.socket.localPort}`}`, `http://localhost${req.socket.localPort === 80 ? '' : `:${req.socket.localPort}`}`].includes(origin)) {
      return res.status(403).json({ error: 'Requests must come from the local dashboard.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ error: 'Use application/json for changes.' });
    }
    next();
  });
  app.use(express.json({ limit: '96kb' }));

  app.get('/api/config', (req, res) => res.json({
    today: dateToday(), timezone: TIMEZONE, model: draftModel(),
    keys: Object.fromEntries(['GOOGLE_PLACES_API_KEY', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY'].map((name) => [name, Boolean(process.env[name]?.trim())])),
  }));
  app.get('/api/leads', async (req, res) => res.json({ leads: (await store.read()).map(publicLead), today: dateToday() }));
  app.post('/api/leads', async (req, res) => {
    const lead = createLead(req.body);
    if (!lead.phone && !lead.link) throw new AppError('Add a phone number or link.');
    const added = await store.addMany([lead]);
    if (!added.length) throw new AppError('A lead with this link or source ID already exists.', 409);
    res.status(201).json(publicLead(lead));
  });
  app.patch('/api/leads/:id', async (req, res) => res.json(publicLead(await store.update(req.params.id, (lead) => updateLead(lead, req.body)))));
  app.delete('/api/leads/:id', async (req, res) => { await store.remove(req.params.id); res.json({ deleted: true }); });
  app.post('/api/leads/:id/draft', async (req, res) => {
    const id = req.params.id;
    if (drafting.has(id)) throw new AppError('A draft is already being generated for this lead.', 409);
    const lead = (await store.read()).find((item) => item.id === id);
    if (!lead) throw new AppError('This lead no longer exists.', 404);
    drafting.add(id);
    try {
      const message = await draftMessage(lead, fetcher);
      const saved = await store.update(id, (current) => {
        if (current.message !== lead.message) throw new AppError('The message changed while Gemini was drafting. Your edits were kept; try again.', 409);
        return updateLead(current, { message });
      });
      res.json(publicLead(saved));
    } finally { drafting.delete(id); }
  });
  app.post('/api/search/estimate', (req, res) => {
    const options = searchOptions(req.body);
    res.json({ ...quotaEstimate(options), options });
  });
  app.get('/api/search', (req, res) => res.json(activeJob ? jobs.get(activeJob) : [...jobs.values()].at(-1) || null));
  app.post('/api/search', (req, res) => {
    if (activeJob) throw new AppError('A search is already running. Wait for it to finish.', 409);
    const options = searchOptions(req.body);
    const needed = options.webProvider === 'gemini' ? 'GEMINI_API_KEY' : options.mode === 'web' ? 'GOOGLE_PLACES_API_KEY' : 'YOUTUBE_API_KEY';
    if (!process.env[needed]?.trim()) throw new AppError(`Missing ${needed}. Add it to .env and restart the server.`);
    const id = globalThis.crypto.randomUUID();
    const job = { id, status: 'running', output: '', started_at: new Date().toISOString(), options };
    jobs.set(id, job);
    activeJob = id;
    const args = [path.join(ROOT, 'leads.mjs'), options.mode, options.query, '--limit', String(options.limit), '--min-reviews', String(options.minReviews)];
    if (options.webProvider === 'gemini') args.push('--provider', 'gemini', '--urls', options.websiteGroups.flat().join('\n'));
    if (!options.draft) args.push('--no-draft');
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, CLIENT_HUNTER_DATA_DIR: store.directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk) => {
      let line = chunk.toString();
      for (const key of ['GOOGLE_PLACES_API_KEY', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY']) {
        if (process.env[key]) line = line.split(process.env[key]).join('[redacted]');
      }
      job.output = (job.output + line).slice(-32000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => { append('Search timed out after 15 minutes. Saved leads are kept.\n'); child.kill(); }, 15 * 60 * 1000);
    const finish = (code) => {
      clearTimeout(timeout);
      job.status = code === 0 ? 'done' : 'failed';
      job.finished_at = new Date().toISOString();
      activeJob = null;
      while (jobs.size > 10) jobs.delete(jobs.keys().next().value);
    };
    child.once('error', () => { append('Unable to start the finder process. Check your Node installation.\n'); finish(1); });
    child.once('close', (code) => finish(code));
    res.status(202).json(job);
  });
  app.get('/api/search/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) throw new AppError('Search output is no longer available.', 404);
    res.json(job);
  });
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    const message = error.type === 'entity.parse.failed' ? 'Request contains invalid JSON.' : error.type === 'entity.too.large' ? 'This change is too large to save.' : error instanceof AppError ? error.message : 'Unable to complete this action. Check file permissions and available disk space, then try again.';
    res.status(status).json({ error: message });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const store = new LeadStore();
    await store.initialize();
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('PORT must be a number from 1 to 65535.');
    const server = createApp({ store }).listen(port, '127.0.0.1', () => process.stdout.write(`Client Hunter · http://127.0.0.1:${port}\n`));
    server.on('error', (error) => {
      process.stderr.write(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set a different PORT in .env.\n` : 'Unable to start the local server. Check your network settings.\n');
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${error instanceof AppError ? error.message : 'Unable to open leads.csv. Check file permissions.'}\n`);
    process.exitCode = 1;
  }
}
