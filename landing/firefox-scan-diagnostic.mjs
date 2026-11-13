import { firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const b = await firefox.launch();
const c = await b.newContext({colorScheme:'dark',viewport:{width:1280,height:900},reducedMotion:'reduce'});
for(const [label, css, scope, method] of [
 ['baseline','','.demo-workspace','base'],
 ['native','select {appearance:auto!important}','.demo-workspace','base'],
 ['no select','','.demo-workspace','dropselect'],
 ['no defs','','.demo-workspace','dropicons'],
 ['no labels','','.demo-workspace','droptabs'],
 ['no chat','','.demo-workspace','dropchat'],
 ['no grid','.demo-workspace{display:block!important}','.demo-workspace','base'],
 ['no sticky','.site-header{position:relative!important}','.demo-workspace','base'],
 ['no clips','*{overflow:visible!important}','.demo-workspace','base'],
 ['no panels','','.demo-workspace','droppanel'],
 ['no nested sections','','.demo-workspace','sections'],
 ['no native autofocus','','.demo-workspace','noautofocus'],
 ['no top section','','.demo-workspace','droptop'],
 ['no contrast','','.demo-workspace','contrast'],
 ['no svg stroke','','.demo-workspace','nosvg'],
 ['no nested shadows','','.demo-chat','base'],
 ['no selected input','','.demo-workspace','noselectevent'],
]) {
 const page=await c.newPage();
 try {
  await page.goto('http://localhost:4173/demonstracao');
  if(method!=='noselectevent')await page.locator('#scenario-select').selectOption('financas');
  await page.locator('#demo-reply').waitFor();
  if(css) await page.addStyleTag({content:css});
  await page.evaluate(m=>{
    const selectors={dropselect:'select',dropicons:'svg',nosvg:'.demo-workspace svg',droptabs:'.dashboard-tabs',dropchat:'.demo-conversation',droppanel:'.demo-dashboard',noautofocus:'[autofocus]',droptop:'.scenario-choice,.demo-intro'};
    if(selectors[m]) document.querySelectorAll(selectors[m]).forEach(e=>e.remove());
    if(m==='sections') for(const el of document.querySelectorAll('.demo-workspace section')){const d=document.createElement('div'); d.className=el.className; d.append(...el.childNodes);el.replaceWith(d);}
  },method);
  let a=new AxeBuilder({page}).include(scope).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']); if(method==='contrast')a.disableRules('color-contrast');
  const res=await a.analyze();
  console.log('CASE',label,'PASSED',res.violations.map(x=>x.id));
 }catch(err){console.log('CASE',label,'FAILED',String(err).slice(0,90))}
 await page.close().catch(()=>{});
}
await b.close();
