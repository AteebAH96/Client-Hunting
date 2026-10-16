import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,export const env = {};' };
  return next(specifier, context);
} });
const { withRuntimeSettings } = await import('./hunter/config.mjs');
const { LeadStore } = await import('./hunter/store.mjs');
const { startJob, advanceJob, readJob } = await import('./hunter/jobs.mjs');
const { publicLead, updateLead } = await import('./hunter/leads.mjs');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('drizzle/0000_glossy_emma_frost.sql', 'utf8'));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.args).changes) } }; }
}
const db = { prepare: (sql) => new Statement(sql), async batch(statements) {
  sqlite.exec('BEGIN');
  try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
} };
const store = new LeadStore(db);
const calls = [];
const realFetch = globalThis.fetch;
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status });
globalThis.fetch = async (value) => {
  const url = new URL(value); calls.push(url.pathname);
  if (url.pathname.endsWith('/search')) return respond({ items: ['active', 'old', 'small'].map((id) => ({ id: { channelId: id } })) });
  if (url.pathname.endsWith('/channels')) return respond({ items: ['active', 'old', 'small'].map((id) => ({ id, snippet: { title: `Fixture ${id}` }, statistics: { subscriberCount: id === 'small' ? '4999' : '15000' }, contentDetails: { relatedPlaylists: { uploads: id } } })) });
  if (url.pathname.endsWith('/playlistItems')) return respond({ items: [1, 2, 3].map((n) => ({ snippet: { title: `Verified title ${n}` }, contentDetails: { videoId: `v${n}`, videoPublishedAt: url.searchParams.get('playlistId') === 'old' ? '2020-01-01T00:00:00Z' : new Date(Date.now() - n * 86400000).toISOString() } })) });
  throw new Error('Unexpected fixture API');
};
try {
  await withRuntimeSettings({ YOUTUBE_API_KEY: 'fixture-key', GEMINI_API_KEY: '' }, async () => {
    const options = { mode: 'video', query: 'fixture niche', limit: 5, draft: false };
    const job = await startJob(db, options);
    await assert.rejects(() => startJob(db, options), /already running/);
    let current = await advanceJob(db, store, job.id);
    assert.equal(current.status, 'running');
    assert.equal(calls.length, 1);
    assert.ok(!Object.hasOwn(current, 'ids'));
    assert.equal((await readJob(db, job.id)).status, 'running');
    for (let i = 0; i < 15 && current.status === 'running'; i++) current = await advanceJob(db, new LeadStore(db), job.id);
    assert.equal(current.status, 'done');
    const leads = await store.read();
    assert.equal(leads.length, 1);
    assert.equal(leads[0].email, '');
    assert.equal(publicLead(leads[0]).recent_videos.length, 3);
    await store.update(leads[0].id, (lead) => updateLead(lead, { status: 'won', notes: 'Keep this note' }));
    const second = await startJob(db, options);
    current = second;
    for (let i = 0; i < 15 && current.status === 'running'; i++) current = await advanceJob(db, store, second.id);
    assert.equal(current.status, 'done');
    assert.equal((await store.read()).length, 1);
    assert.equal((await store.read())[0].notes, 'Keep this note');
    assert.equal((await store.read())[0].status, 'won');
    const failed = await startJob(db, options);
    globalThis.fetch = async () => respond({ error: { details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }, 403);
    const stopped = await advanceJob(db, store, failed.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.output, /API restrictions, allow YouTube Data API v3/);
    assert.ok(!stopped.output.includes('fixture-key'));
  });
  await withRuntimeSettings({ GEMINI_API_KEY:'fixture-key' }, async()=>{
    let requests=0;
    globalThis.fetch=async(url,options)=>{
      requests++;
      assert.equal(String(url),'https://generativelanguage.googleapis.com/v1/interactions');
      assert.deepEqual(JSON.parse(options.body).tools,[{type:'url_context'}]);
      if(requests===2)return respond({error:{status:'RESOURCE_EXHAUSTED',message:'fixture-key'}},429);
      return respond({status:'completed',steps:[{type:'url_context_result',result:[{url:'https://fixture-shop.pk/',status:'success'}]}, {type:'model_output',content:[{type:'text',text:JSON.stringify({is_business:true,business_name:'Fixture Shop',email:{value:'shop@fixture-shop.pk',source_url:'https://fixture-shop.pk/',quote:'Email shop@fixture-shop.pk'}})}]}]});
    };
    const job=await startJob(db,{mode:'web',webProvider:'gemini',urls:['https://fixture-shop.pk/','https://other-shop.pk/'],draft:false});
    let current=await advanceJob(db,store,job.id);
    assert.equal(requests,0);
    current=await advanceJob(db,new LeadStore(db),job.id);
    assert.equal(requests,1);
    const researched=(await store.read()).find(lead=>lead.name==='Fixture Shop');
    assert.equal(researched.email,'shop@fixture-shop.pk');
    await store.update(researched.id,lead=>updateLead(lead,{status:'replied',notes:'Preserve website notes'}));
    current=await advanceJob(db,new LeadStore(db),job.id);
    assert.equal(current.status,'failed');assert.equal(requests,2);
    assert.ok(!current.output.includes('fixture-key'));
    assert.equal((await store.read()).find(lead=>lead.id===researched.id).email,'shop@fixture-shop.pk');
    const repeat=await startJob(db,{mode:'web',webProvider:'gemini',urls:'https://www.fixture-shop.pk/contact',draft:false});
    current=repeat;
    for(let i=0;i<5 && current.status==='running';i++)current=await advanceJob(db,store,repeat.id);
    assert.equal(current.status,'done');assert.equal(requests,2);
    assert.equal((await store.read()).find(lead=>lead.id===researched.id).notes,'Preserve website notes');
  });
  process.stdout.write('Hosted search jobs passed: persisted phases, candidate/activity filters, factual metadata, single active job, duplicate reruns preserving notes/status, and safe API errors. Mocked providers only.\n');
} finally { globalThis.fetch = realFetch; sqlite.close(); }
