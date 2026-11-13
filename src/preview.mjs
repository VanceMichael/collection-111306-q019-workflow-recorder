import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {startSource} from './source.mjs';
import {CaptureStore} from './store.mjs';
import {preview} from './domain.mjs';
const source=await startSource();let browser;
try{
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);
 const observed=await page.evaluate(()=>({fields:[...document.querySelectorAll('input')].map(element=>({name:element.name,value:element.value})),derived:document.querySelector('#amount').textContent}));
 await context.close();
 const path=resolve(process.env.CAPTURE_PATH??'var/captures.json');const store=new CaptureStore(path);
 const receipt=await store.append({kind:"workflow-recorder",observed,at:new Date().toISOString()});
 console.log(JSON.stringify({资料源:source.url,接收文件:path,已存记录:receipt.revision,本次预览:observed},null,2));
}finally{if(browser)await browser.close();await source.close();}
