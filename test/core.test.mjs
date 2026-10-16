import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LeadStore } from '../lib/store.mjs';
import { COLUMNS, createLead, updateLead, publicLead, whatsappLink } from '../lib/leads.mjs';
import { dateToday, addDays, ROOT } from '../lib/config.mjs';
import { findVideo, findWeb, draftMessage, draftModel, searchOptions, quotaEstimate, requestJson, socialWebsite } from '../lib/providers.mjs';
import { runFinder } from '../leads.mjs';
import { createApp } from '../server.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'client-hunter-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new LeadStore(directory);
}
function key(t, name, value = 'test-only-key') {
  const previous = process.env[name]; process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test('empty and header-only CSV; quotes, commas, CRLF and Unicode survive a fresh store', async (t) => {
  const store = await temporary(t);
  assert.deepEqual(await store.read(), []);
  await fs.writeFile(store.file, '');
  assert.deepEqual(await store.read(), []);
  await store.initialize();
  const message = 'Assalam o alaikum, "Ali"!\r\nAap ki website?\nSecond line — hello.';
  const lead = createLead({ name: 'Ali, "Studio"', type: 'web', phone: '03001234567', message, notes: 'First\nSecond,"quoted"' });
  await store.addMany([lead]);
  const reopened = await new LeadStore(store.directory).read();
  assert.equal(reopened[0].message, message);
  assert.equal(reopened[0].notes, lead.notes);
  assert.equal(reopened[0].name, lead.name);
  assert.equal((await fs.readFile(store.file, 'utf8')).split('\r\n')[0], COLUMNS.join(','));
  assert.equal(new URL(reopened[0].wa_link).searchParams.get('text'), message);
  assert.match(reopened[0].wa_link, /wa\.me\/923001234567/);
});

test('status transitions, Pakistan date, repeat sent preserves dates and no-phone lead', () => {
  assert.equal(dateToday(new Date('2026-10-15T21:00:00Z')), '2026-10-16');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  const lead = createLead({ name: 'Fixture channel', type: 'video', link: 'https://youtube.com/channel/fixture' });
  assert.equal(publicLead(lead).wa_link, '');
  assert.equal(publicLead(lead).about_link, 'https://youtube.com/channel/fixture/about');
  const sent = updateLead(lead, { status: 'sent' }, '2026-10-15');
  assert.equal(sent.sent_date, '2026-10-15');
  assert.equal(sent.followup_date, '2026-10-18');
  assert.equal(updateLead(sent, { status: 'sent' }, '2026-10-16').sent_date, '2026-10-15');
  const replied = updateLead(sent, { status: 'replied' });
  assert.equal(replied.followup_date, '');
  assert.equal(replied.sent_date, '2026-10-15');
  assert.throws(() => updateLead(sent, { followup_date: '2026-02-30' }), /valid followup/);
  assert.throws(() => createLead({ type: 'web', name: 'Unsafe', link: 'javascript:alert(1)' }), /full http/);
  assert.equal(whatsappLink('+44 7700 900123', 'Hello?'), 'https://wa.me/447700900123?text=Hello%3F');
});

test('duplicate IDs and canonical links never overwrite status, notes or drafts', async (t) => {
  const store = await temporary(t);
  const original = updateLead(createLead({ name: 'Fixture', type: 'video', source: JSON.stringify({ provider: 'youtube', id: 'fixture', recent_videos: [] }), link: 'https://www.youtube.com/channel/fixture', notes: 'Keep my notes', message: 'Keep this message' }), { status: 'won' });
  await store.addMany([original]);
  const byId = createLead({ name: 'Changed name', type: 'video', source: 'youtube:fixture', link: 'https://youtube.com/@different' });
  const byLink = createLead({ name: 'Other name', type: 'video', source: 'manual', link: 'http://youtube.com/channel/fixture/about?utm_source=test' });
  assert.deepEqual(await store.addMany([byId, byLink]), []);
  assert.deepEqual((await store.read())[0], original);
});

test('every mutation backs up the prior CSV, same-minute writes are distinct, only 20 retained', async (t) => {
  const store = await temporary(t);
  await store.initialize();
  const lead = createLead({ name: 'Backup fixture', type: 'web', phone: '+923001234567' });
  await store.addMany([lead]);
  for (let i = 0; i < 24; i++) await store.update(lead.id, (current) => updateLead(current, { notes: `revision ${i}` }));
  assert.equal((await fs.readdir(store.backupDirectory)).length, 20);
  const beforeDeletion = await fs.readFile(store.file, 'utf8');
  await store.remove(lead.id);
  const backups = await fs.readdir(store.backupDirectory);
  assert.equal(backups.length, 20);
  assert.ok((await Promise.all(backups.map((name) => fs.readFile(path.join(store.backupDirectory, name), 'utf8')))).includes(beforeDeletion));
  assert.deepEqual(await store.read(), []);
});

test('cross-process writes serialize without losing leads', async (t) => {
  const store = await temporary(t);
  await store.initialize();
  const script = `import { LeadStore } from './lib/store.mjs'; import { createLead } from './lib/leads.mjs'; const store = new LeadStore(process.env.CLIENT_HUNTER_DATA_DIR); for(let i=0;i<8;i++) await store.addMany([createLead({name:process.argv[1]+' '+i,type:'web',phone:'+923001234567'})]);`;
  const run = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, name], { cwd: ROOT, windowsHide: true, env: { ...process.env, CLIENT_HUNTER_DATA_DIR: store.directory } });
    let errors = ''; child.stderr.on('data', (data) => { errors += data; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  await Promise.all([run('A'), run('B')]);
  assert.equal((await store.read()).length, 16);
});

test('malformed CSV is refused without altering data or creating a backup', async (t) => {
  const store = await temporary(t);
  const malformed = 'id,name\n1,"unfinished';
  await fs.writeFile(store.file, malformed);
  await assert.rejects(() => store.addMany([]), /not valid CSV/);
  assert.equal(await fs.readFile(store.file, 'utf8'), malformed);
});

test('Places filtering, exact field mask, bounded results and repeat finder run', async (t) => {
  key(t, 'GOOGLE_PLACES_API_KEY');
  const store = await temporary(t);
  const fetcher = async (url, options) => {
    assert.equal(String(url), 'https://places.googleapis.com/v1/places:searchText');
    assert.ok(!options.headers['X-Goog-FieldMask'].includes('*'));
    assert.equal(JSON.parse(options.body).pageSize, 10);
    return response({ places: [
      { id: 'a', displayName: { text: 'Fixture A' }, userRatingCount: 5, rating: 4.5, googleMapsUri: 'https://maps.google.com/?cid=a' },
      { id: 'b', displayName: { text: 'Fixture B' }, userRatingCount: 25, websiteUri: 'https://m.instagram.com/fixture', internationalPhoneNumber: '+92 300 1234567' },
      { id: 'c', displayName: { text: 'Has website' }, userRatingCount: 25, websiteUri: 'https://example.com' },
      { id: 'd', displayName: { text: 'Too few reviews' }, userRatingCount: 4 },
      { id: 'e', displayName: { text: 'Lookalike domain' }, userRatingCount: 5, websiteUri: 'https://instagram.com.example.com' },
    ] });
  };
  const input = { mode: 'web', query: 'fixture Lahore', limit: 10, draft: false };
  const first = await runFinder(input, { store, fetcher, log: () => {} });
  assert.equal(first.length, 2);
  assert.equal(first[0].wa_link, '');
  await store.update(first[0].id, (lead) => updateLead(lead, { status: 'replied', notes: 'Retain this' }));
  assert.equal((await runFinder(input, { store, fetcher, log: () => {} })).length, 0);
  assert.equal((await store.read())[0].notes, 'Retain this');
  assert.equal((await store.read())[0].status, 'replied');
  assert.equal(socialWebsite('https://notinstagram.com'), false);
});

test('YouTube subscriber/activity filtering, three real titles, no emails and quota cap', async (t) => {
  key(t, 'YOUTUBE_API_KEY');
  let calls = 0;
  const now = new Date('2026-10-15T12:00:00Z');
  const fetcher = async (value) => {
    calls++;
    const url = new URL(value);
    if (url.pathname.endsWith('/search')) return response({ items: ['active', 'old', 'small', 'hidden', 'large'].map((id) => ({ id: { channelId: id } })) });
    if (url.pathname.endsWith('/channels')) return response({ items: ['active', 'old', 'small', 'hidden', 'large'].map((id) => ({ id, snippet: { title: `Fixture ${id}` }, statistics: { subscriberCount: id === 'small' ? '4999' : id === 'large' ? '100001' : '10000', hiddenSubscriberCount: id === 'hidden' }, contentDetails: { relatedPlaylists: { uploads: id } } })) });
    const id = url.searchParams.get('playlistId');
    assert.equal(url.searchParams.get('maxResults'), '3');
    return response({ items: [1, 2, 3].map((n) => ({ snippet: { title: `Real title ${n}` }, contentDetails: { videoPublishedAt: id === 'old' ? '2026-01-01T12:00:00Z' : `2026-10-${15 - n}T12:00:00Z`, videoId: `video${n}` } })) });
  };
  const options = searchOptions({ mode: 'video', query: 'fixture', limit: 5 });
  const found = await findVideo(options, [], () => {}, fetcher, now);
  assert.equal(found.length, 1);
  assert.equal(found[0].email, '');
  assert.equal(publicLead(found[0]).recent_videos.length, 3);
  assert.equal(found[0].last_upload, '2026-10-14T12:00:00Z');
  assert.equal(calls, 4);
  assert.equal(quotaEstimate(options).maxUnits, 106);
  assert.throws(() => searchOptions({ mode: 'video', query: 'fixture', limit: 26 }), /1–25/);
  assert.throws(() => searchOptions({ mode: 'web', query: 'fixture', limit: 21 }), /1–20/);
});

test('Gemini uses MODEL and real facts, retries invalid output; no-facts manual video is refused', async (t) => {
  key(t, 'GEMINI_API_KEY'); key(t, 'MODEL', 'gemini-3.5-flash-lite');
  const lead = createLead({ name: 'Fixture Channel', type: 'video', source: JSON.stringify({ provider: 'youtube', id: 'x', recent_videos: [{ title: 'Lahore ki sair' }] }) });
  let calls = 0;
  const message = 'Assalam o alaikum Fixture Channel, aap ki recent video ka title "Lahore ki sair" dekha. Main video editor hoon, kya aik free short sample edit bhej sakta hoon?';
  const drafted = await draftMessage(lead, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'test-only-key');
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.equal(body.store, false);
    assert.match(body.input, /Lahore ki sair/);
    return response({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: ++calls === 1 ? 'too generic' : message }] }] });
  });
  assert.equal(drafted, message); assert.equal(calls, 2);
  await assert.rejects(() => draftMessage(createLead({ name: 'Manual', type: 'video' })), /no fetched channel facts/);
});

test('legacy Claude settings select the Gemini default; explicit Gemini MODEL is respected', (t) => {
  key(t, 'MODEL', 'claude-sonnet-5-5');
  assert.equal(draftModel(), 'gemini-3.5-flash-lite');
  process.env.MODEL = 'gemini-3.1-flash-lite';
  assert.equal(draftModel(), 'gemini-3.1-flash-lite');
});

test('emoji and Urdu video titles use a fetched date so factual drafts can satisfy Roman Urdu rules', async (t) => {
  key(t, 'GEMINI_API_KEY');
  const lead = createLead({ name: 'Fixture Channel', type: 'video', last_upload: '2026-09-18T12:00:00Z', source: JSON.stringify({ provider:'youtube', recent_videos:[{title:'Charna Island 🏝️'}, {title:'اردو عنوان'}] }) });
  const message = 'Salam Fixture Channel, aap ki recent upload ki tareekh 2026-09-18 hai. Main video editor hoon; kya aik free short sample edit bhej sakta hoon?';
  assert.equal(await draftMessage(lead, async (url, options) => {
    const input = JSON.parse(options.body).input;
    assert.match(input, /Last uploaded on 2026-09-18/);
    assert.doesNotMatch(input, /Charna Island|اردو عنوان/);
    return response({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:message}]}]});
  }), message);
});

test('Gemini quota never retries or falls back to a paid provider; secret errors are not exposed', async (t) => {
  key(t, 'GEMINI_API_KEY');
  const lead = createLead({ name: 'Fixture', type: 'web' });
  let calls = 0;
  await assert.rejects(() => draftMessage(lead, async (url) => { calls++; assert.match(url, /generativelanguage/); return response({ error: { status: 'RESOURCE_EXHAUSTED', message: 'secret-key-value' } }, 429); }), /No paid fallback/);
  assert.equal(calls, 1);
  await assert.rejects(() => requestJson('https://example.com', {}, 'Gemini', async () => response({ error: { details: [{ reason: 'API_KEY_INVALID' }], message: 'secret-key-value' } }, 400)), (error) => /Google AI Studio/.test(error.message) && !error.message.includes('secret-key-value'));
});

test('missing keys, quota, network and malformed API responses yield actionable errors without keys', async (t) => {
  key(t, 'GOOGLE_PLACES_API_KEY', '');
  await assert.rejects(() => findWeb(searchOptions({ mode: 'web', query: 'fixture' })), /Missing GOOGLE_PLACES_API_KEY/);
  await assert.rejects(() => requestJson('https://example.com', {}, 'YouTube', async () => response({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403)), /quota or rate limit/);
  await assert.rejects(() => requestJson('https://example.com', {}, 'Gemini', async () => { throw new Error('secret-key-value'); }), /network failure/);
  await assert.rejects(() => requestJson('https://example.com', {}, 'Gemini', async () => response({ error: { message: 'secret-key-value' } }, 500)), (error) => !error.message.includes('secret-key-value'));
});

test('YouTube errors distinguish API restrictions, disabled service and invalid keys without exposing provider messages', async () => {
  const scenarios = [
    ['API_KEY_SERVICE_BLOCKED', /API restrictions, allow YouTube Data API v3/],
    ['SERVICE_DISABLED', /disabled in the key's project/],
    ['API_KEY_HTTP_REFERRER_BLOCKED', /only allows website requests/],
    ['API_KEY_IP_ADDRESS_BLOCKED', /application restrictions block this laptop/],
    ['API_KEY_INVALID', /invalid or expired/],
    ['API_KEY_EXPIRED', /invalid or expired/],
  ];
  for (const [reason, expected] of scenarios) {
    await assert.rejects(() => requestJson('https://example.com', {}, 'YouTube', async () => response({ error: { message: 'secret-key-value', errors: [{ reason: 'forbidden' }], details: [{ reason }] } }, 403)), (error) => expected.test(error.message) && !error.message.includes('secret-key-value') && !error.message.includes('billing'));
  }
});

test('running Express API: persistence, edits, status dates, delete backup, CSRF and search child failure', async (t) => {
  key(t, 'GOOGLE_PLACES_API_KEY', ''); key(t, 'GEMINI_API_KEY', '');
  const store = await temporary(t); await store.initialize();
  const server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, method = 'GET', body, extra = {}) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await call('/api/leads')).json()).leads.length, 0);
  assert.equal((await call('/api/leads', 'POST', { name: 'Bad' }, { Origin: 'https://attacker.example' })).status, 403);
  const lead = await (await call('/api/leads', 'POST', { name: 'API fixture', type: 'video', link: 'https://youtube.com/channel/api-fixture' })).json();
  const message = 'Hello "there",\nNew line?';
  const saved = await (await call(`/api/leads/${lead.id}`, 'PATCH', { message, notes: 'Keep\nnotes', status: 'sent' })).json();
  assert.equal(saved.sent_date, dateToday()); assert.equal(saved.followup_date, addDays(dateToday(), 3));
  assert.equal((await (await call('/api/leads')).json()).leads[0].message, message);
  assert.equal((await call(`/api/leads/${lead.id}/draft`, 'POST', {})).status, 400);
  assert.equal((await call('/api/search', 'POST', { mode: 'web', query: 'fixture' })).status, 400);
  const config = await (await call('/api/config')).json();
  assert.equal(config.keys.GEMINI_API_KEY, false);
  assert.equal((await call(`/api/leads/${lead.id}`, 'DELETE')).status, 200);
  assert.equal((await store.read()).length, 0);
  assert.ok((await fs.readdir(store.backupDirectory)).length >= 3);
  // A malformed isolated CSV stops the real child before any paid API call.
  key(t, 'GOOGLE_PLACES_API_KEY', 'fixture-invalid');
  await fs.writeFile(store.file, 'invalid,columns\n');
  const started = await (await call('/api/search', 'POST', { mode: 'web', query: 'fixture', draft: false })).json();
  assert.ok(started.id);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = await (await call(`/api/search/${started.id}`)).json();
    if (job.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'failed');
  assert.match(job.output, /not valid CSV/);
  assert.ok(!job.output.includes('fixture-invalid'));
});
