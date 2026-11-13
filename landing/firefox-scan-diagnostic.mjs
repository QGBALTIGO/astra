import { firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const b=await firefox.launch();
for(const mode of ['pause','no-url','fragment','skip-duplicate','no-aria-live','no-replace-rerender','no-browser-tz','default']) {
const c=await b.newContext({viewport:{width:1280,height:900},colorScheme:'dark',reducedMotion:'reduce',locale:'pt-BR',...(mode==='no-browser-tz'?{}:{timezoneId:'America/Campo_Grande'})});
const p=await c.newPage();
try{
await p.route('**/assets/app-*.js',async route=>{const res=await route.fetch();let s=await res.text();const re=/history\.replaceState\(null,"","#"\+([a-zA-Z]+)\.id\)/;if(mode==='no-url')s=s.replace(re,'void 0');if(mode==='fragment')s=s.replace(re,'location.hash=$1.id');await route.fulfill({response:res,body:s});});
await p.goto('http://localhost:4173/demonstracao');
if(mode==='no-aria-live')await p.locator('#demo-status').evaluate(el=>el.removeAttribute('role'));
for(const id of ['financas','agenda','notas','tarefas']){
if(mode==='skip-duplicate' && await p.locator('#scenario-select').inputValue()===id){}else if(mode==='no-replace-rerender'){await p.goto('http://localhost:4173/demonstracao#'+id);await p.locator('#demo-reply').waitFor();}else{await p.locator('#scenario-select').selectOption(id);}
if(mode==='pause')await p.waitForTimeout(350);
await new AxeBuilder({page:p}).include('.demo-workspace').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
console.log('CASE',mode,id,'PASS');
}
}catch(e){console.log('CASE',mode,'FAIL',String(e).slice(0,75))}
await c.close().catch(()=>{});
}await b.close();