import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
test('真实浏览器呈现及操作保留源端特殊情形',{timeout:20000},async()=>{
 const source=await startSource();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const action=async action=>{const response=await fetch(source.url+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();};
 try{await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);await page.locator('[name=order]').fill('order-104');await page.locator('[name=quantity]').fill('3');assert.equal(await page.locator('#amount').textContent(),'30');
await page.locator('[name=contact]').fill('王工');await page.click('#review');assert.equal(await page.locator('dialog').isVisible(),true);await page.click('#confirm');await page.waitForFunction(()=>document.querySelector('#receipt').textContent.length>0);
assert.equal(JSON.parse(await page.locator('#receipt').textContent()).order,'order-104');await action('ambiguous');await page.reload();await page.waitForFunction(()=>window.portalReady);assert.equal(await page.getByLabel('名称',{exact:true}).count(),2);}
 finally{await browser.close();await source.close();}
});
