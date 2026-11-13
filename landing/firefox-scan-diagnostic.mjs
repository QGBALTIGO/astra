import { firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const b = await firefox.launch();
for(const filter of ['exact','skip-select','scoped','no-home','no-locale','no-timezone','native','blur','no-scroll','rm-select','rm-svg','rm-dashboard','rm-chat','rm-header','rm-css','no-contrast']){
 const c = await b.newContext({colorScheme:'dark',viewport:{width:1280,height:900},reducedMotion:'reduce',locale:filter==='no-locale'?'en-US':'pt-BR',timezoneId: filter==='no-timezone'?'UTC':'America/Campo_Grande'});
 const page=await c.newPage();
 try {
 if(filter!=='no-home'){await page.goto('http://localhost:4173/');await page.evaluate(()=>document.fonts.ready);}
 await page.goto('http://localhost:4173/demonstracao');
 if(filter!=='no-scroll')await page.locator('.demo-workspace').scrollIntoViewIfNeeded();
 if(filter!=='skip-select')await page.getByLabel('Escolha um exemplo').selectOption('financas');
 const rm={'rm-select':'select','rm-svg':'svg','rm-dashboard':'.demo-dashboard','rm-chat':'.demo-conversation','rm-header':'.site-header','rm-css':'link[rel=stylesheet]'}[filter];
 if(rm)await page.locator(rm).evaluateAll(els=>els.forEach(el=>el.remove()));
 if(filter==='native')await page.addStyleTag({content:'select{appearance:auto!important}'});
 if(filter==='blur')await page.evaluate(()=>document.activeElement.blur());
 let a=new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']);
 if(filter==='scoped')a.include('.demo-workspace');
 if(filter==='no-contrast')a.disableRules('color-contrast');
 const r=await a.analyze();console.log('CASE',filter,'PASS',r.violations.map(x=>x.id));
 }catch(e){console.log('CASE',filter,'FAIL',String(e).slice(0,90))}
 await c.close().catch(()=>{});
}
await b.close();
