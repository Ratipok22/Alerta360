import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import {out, fixturePath} from '../soporte_funcionales/config.mjs';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const results=[];
async function login(ctx,email){const p=await ctx.newPage();p.setDefaultTimeout(10000);await p.goto('http://127.0.0.1:5173');await p.locator('input[type=email]').fill(email);await p.locator('input[type=password]').fill('Bomberos.2026');await p.getByRole('button',{name:'Ingresar',exact:true}).click();await p.locator('.sidebar').waitFor();return p;}
const nav=async(p,name)=>{await p.locator('.sidebar').getByRole('button',{name,exact:true}).click();await p.waitForTimeout(300);};
for(const min of [1,5,15]){
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const r=JSON.parse(await fs.readFile(fixturePath,'utf8')).resources[0];r.estado='6-7';r.disponible=false;
 await ctx.route('**/resources',x=>x.fulfill({json:{resources:[r]}}));await ctx.route('**/emergencies',x=>x.fulfill({json:{emergencies:[]}}));await ctx.route('**/assignments/activas',x=>x.fulfill({json:{asignaciones:[]}}));await ctx.route('**/state',x=>x.fulfill({json:{publicado:false}}));
 const p=await login(ctx,'alex.aravena@bomberos.cl');await p.clock.install();await nav(p,'Configuración');await p.getByLabel('Alertar si una unidad despachada no transmite estado en').selectOption(String(min));await nav(p,'Recursos');await p.clock.fastForward((min*60+12)*1000);await p.waitForTimeout(500);const badges=await p.locator('.timeoutBadge').count();results.push({id:'RE04',min,status:badges>0?'APROBADO':'FALLIDO',badges,text:await p.locator('main').innerText(),tipo:'Recurso 6-7 cargado al iniciar, sin nuevas transmisiones, reloj virtual; API de recursos controlada.'});await p.screenshot({path:out+'/RE04-'+min+'.png'});await fs.writeFile(out+'/red_ui.json',JSON.stringify(results,null,2));await ctx.close();
}
await browser.close();console.log(JSON.stringify(results.map(({id,role,min,status,error})=>({id,role,min,status,error}))));


