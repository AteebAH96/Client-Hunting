import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { chromium } from 'playwright-core';
import { createLead, publicLead } from '../lib/leads.mjs';
import { searchOptions, quotaEstimate } from '../lib/providers.mjs';
import { ROOT } from '../lib/config.mjs';

const site='https://boutique-fixture.pk/';
const lead=publicLead(createLead({type:'web',name:'Fixture Boutique',email:'hello@boutique-fixture.pk',phone:'+92 300 1234567',link:site,message:'Salam Fixture Boutique, website support par baat karna chahein ge?',source:JSON.stringify({provider:'gemini_web',id:'boutique-fixture.pk',pages:[site],evidence:{email:{value:'hello@boutique-fixture.pk',url:site,quote:'Email hello@boutique-fixture.pk'}}})}));
const widths=[320,360,390,414,768,1024,1440];
await fs.mkdir(path.join(ROOT,'.qa'),{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
let checked=0;
try {
  for(const folder of ['public','online/public']) {
    let submitted;
    const app=express();app.use(express.json());
    app.get('/api/config',(req,res)=>res.json({today:'2026-10-15',timezone:'Asia/Karachi',model:'gemini-3.5-flash-lite',keys:{GEMINI_API_KEY:true},hosted:folder.startsWith('online')}));
    app.get('/api/leads',(req,res)=>res.json({leads:[lead],today:'2026-10-15'}));
    app.get('/api/search',(req,res)=>res.json(null));
    app.post('/api/search/estimate',(req,res)=>{const options=searchOptions(req.body);res.json({...quotaEstimate(options),options});});
    const job={id:'research-fixture',status:'done',options:{webProvider:'gemini'},output:'Finished. 1 lead added.'};
    app.post('/api/search',(req,res)=>{submitted=req.body;res.json(job);});
    app.get('/api/search/:id',(req,res)=>res.json(job));
    app.post('/api/search/:id/advance',(req,res)=>res.json(job));
    app.use(express.static(path.join(ROOT,folder)));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.route('https://fonts.googleapis.com/**',route=>route.abort());
    await context.route('https://fonts.gstatic.com/**',route=>route.abort());
    const page=await context.newPage();page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForSelector('.lead-row');
      assert.equal(await page.locator('#website-links').isVisible(),true);
      assert.equal(await page.locator('#search-query').isVisible(),false);
      await page.fill('#website-links',`${site}\n${site}contact`);
      await page.uncheck('#search-draft');
      await page.click('#run-search');
      await page.waitForFunction(()=>document.getElementById('job-label').textContent==='SEARCH COMPLETE');
      assert.equal(submitted.webProvider,'gemini');assert.equal(submitted.urls,`${site}\n${site}contact`);
      assert.equal(submitted.draft,false);
      assert.match(await page.locator('#run-search').textContent(),/Research websites/);
      for(const width of widths) {
        await page.setViewportSize({width,height:900});
        for(const provider of ['gemini','places']) {
          await page.selectOption('#web-provider',provider);
          const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth}));
          assert.ok(overflow.page<=width && overflow.viewport===width,`${folder} ${width} ${provider}: ${JSON.stringify(overflow)}`);checked++;
        }
        await page.selectOption('#web-provider','gemini');
        await page.locator('.lead-row').click();
        assert.equal(await page.locator('#research-section').isVisible(),true);
        assert.match(await page.locator('#research-evidence').textContent(),/hello@boutique-fixture.pk/);
        assert.equal(await page.locator('#research-pages a').getAttribute('href'),site);
        const mail=await page.locator('#open-email').getAttribute('href');
        assert.ok(mail.startsWith('mailto:'));assert.ok(decodeURIComponent(mail).includes(lead.email));
        assert.ok(decodeURIComponent(mail).includes(lead.message));
        assert.equal(await page.locator('#detail-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);checked++;
        if(width===320 && folder.startsWith('online'))await page.screenshot({path:path.join(ROOT,'.qa/research-mobile-details.png')});
        await page.click('#detail-close');
      }
      await page.setViewportSize({width:390,height:844});
      await page.click('[data-mode=video]');assert.equal(await page.locator('#website-links').isVisible(),false);
      assert.equal(await page.locator('#search-query').isVisible(),true);
      await page.click('[data-mode=web]');
      if(folder.startsWith('online'))await page.screenshot({path:path.join(ROOT,'.qa/research-mobile-finder.png'),fullPage:true});
      assert.deepEqual(errors,[]);
    } finally {await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  console.log(`Website research browser checks passed: both app variants, submit payload, source quotes, email draft, tab switching and ${checked} responsive views. Mocked APIs only.`);
} finally {await browser.close();}
