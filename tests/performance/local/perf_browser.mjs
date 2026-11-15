// Copia de la corrida de navegador. Ejecutar desde el workspace documentado.
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const out='outputs/evidencias_rendimiento_pendientes';
const vitals=await fs.readFile('work/perf-browser/node_modules/web-vitals/dist/web-vitals.iife.js','utf8');
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking']});
const rows=[];
const accounts=[['admin','alex.aravena@bomberos.cl'],['visualizador','bru.molina@bomberos.cl'],['soporte','amolina@admin.alerta360.cl']];
for(const [role,email] of accounts){
 for(let repeat=0;repeat<5;repeat++){
  const context=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1});
  const page=await context.newPage();const errors=[],requests=[],measures={};
  await page.exposeFunction('reportVital',m=>{measures[m.name]={value:m.value,rating:m.rating,delta:m.delta};});
  await page.addInitScript({content:vitals+`;webVitals.onLCP(m=>window.reportVital({name:m.name,value:m.value,rating:m.rating,delta:m.delta}),{reportAllChanges:true});webVitals.onCLS(m=>window.reportVital({name:m.name,value:m.value,rating:m.rating,delta:m.delta}),{reportAllChanges:true});webVitals.onINP(m=>window.reportVital({name:m.name,value:m.value,rating:m.rating,delta:m.delta}),{reportAllChanges:true});`});
  // Ninguna credencial sale del laboratorio. Las teselas externas no forman parte del ensayo local.
  await context.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?route.continue():route.abort();});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.url().startsWith('http://127.0.0.1:8011'))requests.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.goto('http://127.0.0.1:5173',{waitUntil:'networkidle'});
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill('Bomberos.2026');
  const t=performance.now();await page.getByRole('button',{name:'Ingresar',exact:true}).click();
  await page.locator('.sidebar').waitFor({timeout:30000});
  const loginToShellMs=performance.now()-t;
  await page.waitForTimeout(1500);
  const mapCount=await page.locator('.leaflet-container').count();
  const mapSizes=await page.locator('.leaflet-container').evaluateAll(els=>els.map(e=>({width:e.clientWidth,height:e.clientHeight,markers:e.querySelectorAll('.leaflet-marker-icon').length,tiles:e.querySelectorAll('.leaflet-tile-loaded').length})));
  const actions=[];
  for(const name of role==='soporte'?['Configuración','Tickets']:['Soporte','Historial','Dashboard']){
   const btn=page.locator('nav').getByRole('button',{name,exact:true});
   if(await btn.count()){
    const start=performance.now();await btn.click();await page.waitForTimeout(350);actions.push({name,elapsed_including_wait_ms:performance.now()-start});
   }
  }
  await page.waitForTimeout(1000);
  if(repeat===0)await page.screenshot({path:`${out}/PF07-${role}.png`,fullPage:true});
  const navigation=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {domContentLoaded:n.domContentLoadedEventEnd,load:n.loadEventEnd,transferSize:n.transferSize};});
  // Ocultar el documento finaliza LCP/CLS/INP; exposeFunction conserva los valores.
  await page.goto('about:blank');await page.waitForTimeout(100);
  rows.push({role,repeat,metrics:measures,loginToShellMs,mapCount,mapSizes,navigation,actions,errors,api_errors:requests.filter(r=>r.status>=400)});
  await context.close();
  await fs.writeFile(`${out}/PF07-browser-progreso.json`,JSON.stringify(rows,null,2));
 }
}
await browser.close();
await fs.writeFile(`${out}/PF07-browser.json`,JSON.stringify({case:'PF07',status:'PARCIAL',browser:'Google Chrome headless',viewport:'1366x768',iterations:rows.length,scope:'Build de produccion servido localmente. web-vitals en laboratorio, sin throttling; contexto nuevo por repeticion. LCP corresponde al documento de login; INP/CLS incluyen login y navegacion SPA. Teselas y proveedores externos bloqueados: no acredita mapas completos ni rendimiento de Internet. SLA UI no acordado.',samples:rows},null,2));
console.log('PF07 navegador terminado',rows.length);
