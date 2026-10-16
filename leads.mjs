import { pathToFileURL } from 'node:url';
import { LeadStore } from './lib/store.mjs';
import { identityKeys } from './lib/leads.mjs';
import { searchOptions, findWeb, findVideo, draftMessage } from './lib/providers.mjs';
import { inspectWebsite } from './lib/research.mjs';

export async function runFinder(input, { store = new LeadStore(), log = (line) => process.stdout.write(`${line}\n`), fetcher = fetch } = {}) {
  const options = searchOptions(input);
  await store.initialize();
  const existing = await store.read();
  let found;
  if (options.webProvider === 'gemini') {
    found = [];
    const known = new Set(existing.flatMap(identityKeys));
    log(`Reading ${options.websiteGroups.length} businesses with Gemini. No Google Search or Places calls; free-tier quota applies.`);
    for (const pages of options.websiteGroups) {
      const domain = new URL(pages[0]).hostname.toLowerCase().replace(/^www\./, '');
      if (known.has(`source:gemini_web:${domain}`) || identityKeys({link:pages[0]}).some(id => known.has(id))) { log(`Skipped existing website: ${domain}.`); continue; }
      try {
        const lead = await inspectWebsite(pages, fetcher);
        // Persist each site before moving on, so quota failures keep earlier results.
        const saved = await store.addMany([lead]);
        found.push(...saved);
        identityKeys(lead).forEach(id => known.add(id));
        if (saved.length) log(`Added ${lead.name.replace(/[\r\n]/g, ' ')}.`);
      } catch (error) {
        log(error.status ? error.message : 'Unable to read this website.');
        if (![422, 502].includes(error.status)) break;
      }
    }
  } else found = options.mode === 'web' ? await findWeb(options, log, fetcher) : await findVideo(options, existing, log, fetcher);
  const keys = new Set(existing.flatMap(identityKeys));
  const unseen = found.filter((lead) => {
    const identities = identityKeys(lead);
    if (identities.some((key) => keys.has(key))) return false;
    identities.forEach((key) => keys.add(key));
    return true;
  });
  log(`${found.length} qualifying leads; ${unseen.length} new.`);
  // Save findings first so a drafting failure or cancellation cannot discard them.
  const added = options.webProvider === 'gemini' ? found : await store.addMany(unseen);
  if (options.draft && added.length) {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      log('Missing GEMINI_API_KEY: leads saved without drafts. Add the key to .env to generate messages.');
    } else {
      for (const lead of added) {
        try {
          const message = await draftMessage(lead, fetcher);
          const { updateLead } = await import('./lib/leads.mjs');
          await store.update(lead.id, (current) => current.message ? current : updateLead(current, { message }));
          log(`Draft saved for ${lead.name.replace(/[\r\n]/g, ' ')}.`);
        } catch (error) {
          log(error.status ? error.message : 'Unable to save this draft. Check the CSV and backups.');
          log('Remaining leads are saved without drafts. You can draft individually from the dashboard.');
          break;
        }
      }
    }
  }
  log(`Finished. ${added.length} leads added. Existing status and notes preserved. Nothing was sent.`);
  return added;
}

function cliOptions(args) {
  if (args.includes('--help') || !args.length) return null;
  const [mode, query, ...flags] = args;
  const result = { mode, query };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--limit') result.limit = Number(flags[++i]);
    else if (flags[i] === '--min-reviews') result.minReviews = Number(flags[++i]);
    else if (flags[i] === '--no-draft') result.draft = false;
    else if (flags[i] === '--provider') result.webProvider = flags[++i];
    else if (flags[i] === '--urls') result.urls = flags[++i];
    else throw new Error(`Unknown option: ${flags[i]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = cliOptions(process.argv.slice(2));
    if (!options) process.stdout.write('Usage: node leads.mjs web "clothing store Lahore" --limit 10 --min-reviews 5\n       node leads.mjs video "urdu vlog" --limit 10 [--no-draft]\n');
    else await runFinder(options);
  } catch (error) {
    process.stderr.write(`${error.status ? error.message : 'Search failed. Check the query, data file and API settings.'}\n`);
    process.exitCode = 1;
  }
}
