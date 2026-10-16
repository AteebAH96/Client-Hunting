import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { researchUrl, websiteGroups, inspectWebsite } from '../lib/research.mjs';
import { searchOptions, quotaEstimate } from '../lib/providers.mjs';
import { publicLead, updateLead } from '../lib/leads.mjs';
import { LeadStore } from '../lib/store.mjs';
import { runFinder } from '../leads.mjs';

const site = 'https://boutique-fixture.pk/';
const contact = site + 'contact';
function response(details = {}, retrieved = [{url:site,status:'success'}]) {
  return new Response(JSON.stringify({status:'completed',steps:[
    {type:'url_context_result',result:retrieved},
    {type:'model_output',content:[{type:'text',text:JSON.stringify({is_business:true,business_name:'Fixture Boutique',phone:{value:'+92 300 1234567',source_url:site,quote:'Call +92 300 1234567'},email:{value:'hello@boutique-fixture.pk',source_url:site,quote:'Email hello@boutique-fixture.pk'},...details})}]},
  ]}),{status:200});
}
function apiKey(t) {
  const previous=process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY='fixture-secret';
  t.after(()=>{ if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous; });
}

test('website research validates public URLs, groups pages, rejects social/private URLs and never estimates Search calls',()=>{
  for(const url of ['http://127.0.0.1','http://2130706433','http://[::1]','https://user:password@business.pk/','http://metadata.google.internal','https://facebook.com/business','javascript:alert(1)','https://business.local/','https://business.pk:9000/'])assert.equal(researchUrl(url),'');
  assert.deepEqual(websiteGroups(`${site}\n${contact}\n${site}`),[[site,contact]]);
  assert.equal(researchUrl(' boutique-fixture.pk/contact '),contact);
  assert.equal(researchUrl('www.boutique-fixture.pk'), 'https://www.boutique-fixture.pk/');
  assert.equal(researchUrl('//boutique-fixture.pk/contact'),contact);
  assert.equal(researchUrl(`<${site}>`),site);
  assert.equal(researchUrl('instagram.com/business'),'');
  assert.equal(researchUrl('127.0.0.1'),'');
  assert.equal(researchUrl('clothing store Lahore'),'');
  assert.throws(()=>websiteGroups(''),/at least one/);
  assert.throws(()=>websiteGroups([site,'https://other-fixture.pk'],1),/Increase Candidates/);
  assert.throws(()=>websiteGroups([site,contact,site+'about',site+'extra']),/at most 3 pages/);
  const options=searchOptions({mode:'web',webProvider:'gemini',urls:site,limit:5,draft:false});
  assert.equal(options.query,'Website research');
  assert.deepEqual(quotaEstimate(options),{searchCalls:0,modelCalls:1,candidateCap:1});
});

test('website research only exposes cited business contacts from successfully retrieved supplied pages',async(t)=>{
  apiKey(t);
  const lead=await inspectWebsite([site,contact],async(url,options)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1/interactions');
    assert.equal(options.headers['x-goog-api-key'],'fixture-secret');
    const body=JSON.parse(options.body);
    assert.deepEqual(body.tools,[{type:'url_context'}]);
    assert.equal(body.store,false);
    assert.ok(!body.input.includes('fixture-secret'));
    return response();
  });
  assert.equal(lead.email,'hello@boutique-fixture.pk');
  assert.match(lead.wa_link,/wa.me\/923001234567/);
  assert.equal(publicLead(lead).source_label,'Gemini website research');
  assert.equal(publicLead(lead).research.evidence.email.url,site);
  assert.equal(lead.rating,'');assert.equal(lead.reviews,'');
  const unsafe=await inspectWebsite([site],async()=>response({
    phone:{value:'+92 300 1234567',source_url:contact,quote:'Call +92 300 1234567'},
    email:{value:'guessed@boutique-fixture.pk',source_url:site,quote:'Contact us'},
  }));
  assert.equal(unsafe.phone,'');assert.equal(unsafe.email,'');
  await assert.rejects(()=>inspectWebsite([site],async()=>response({},[{url:site,status:'paywall'}])),/could not read/);
  await assert.rejects(()=>inspectWebsite([site],async()=>response({is_business:false})),/No identifiable business/);
});

test('quota never triggers another model, and partial research results persist with duplicate notes preserved',async(t)=>{
  apiKey(t);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'client-hunter-research-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=new LeadStore(directory);
  let calls=0;
  const log=[];
  const input={mode:'web',webProvider:'gemini',urls:[site,'https://another-fixture.pk/'],draft:false};
  await runFinder(input,{store,log:line=>log.push(line),fetcher:async()=>++calls===1?response():new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'fixture-secret'}}),{status:429})});
  assert.equal(calls,2);assert.equal((await store.read()).length,1);
  const lead=(await store.read())[0];
  await store.update(lead.id,current=>updateLead(current,{status:'won',notes:'Keep my notes',message:'My own draft?'}));
  calls=0;
  await runFinder({...input,urls:[contact]},{store,log:()=>{},fetcher:async()=>{calls++;throw new Error('Duplicate should not use quota');}});
  assert.equal(calls,0);
  assert.equal((await store.read())[0].notes,'Keep my notes');
  assert.equal((await store.read())[0].message,'My own draft?');
  assert.ok(log.some(line=>line.includes('No paid fallback')));
  assert.ok(!log.some(line=>line.includes('fixture-secret')));
});
