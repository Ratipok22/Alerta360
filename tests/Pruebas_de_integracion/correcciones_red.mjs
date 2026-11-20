import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import {out, fixturePath} from '../soporte_funcionales/config.mjs';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const results=[];
async function login(ctx,email){const p=await ctx.newPage();p.setDefaultTimeout(10000);await p.goto('http://127.0.0.1:5173');await p.locator('input[type=email]').fill(email);await p.locator('input[type=password]').fill('Bomberos.2026');await p.getByRole('button',{name:'Ingresar',exact:true}).click();await p.locator('.sidebar').waitFor();return p;}
const nav=async(p,name)=>{await p.locator('.sidebar').getByRole('button',{name,exact:true}).click();await p.waitForTimeout(300);};
for(const [role,email] of [['admin','alex.aravena@bomberos.cl'],['visualizador','bru.molina@bomberos.cl'],['soporte','amolina@admin.alerta360.cl']]){
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
 await ctx.route('**/resources',r=>r.fulfill({json:{resources:[]}}));await ctx.route('**/emergencies',r=>r.fulfill({json:{emergencies:[]}}));await ctx.route('**/assignments/activas',r=>r.fulfill({json:{asignaciones:[]}}));await ctx.route('**/state',r=>r.fulfill({json:{publicado:false}}));
 const p=await login(ctx,email);const dialogs=[];p.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss();});let mode='normal',submitted=0;
 await ctx.route('**/tickets',async r=>{if(r.request().method()==='POST'){submitted++;if(mode==='offline')return r.abort('internetdisconnected');if(mode==='timeout')return r.abort('timedout');if(mode==='slow'){await new Promise(resolve=>setTimeout(resolve,3000));return r.fulfill({status:503,json:{detail:'Indisponibilidad controlada de pruebas'}});}}return r.continue();});
 try{
 await nav(p,role==='soporte'?'Tickets':'Soporte');const checks=[];
 if(role!=='soporte'){
 await p.getByLabel('Título del reporte').fill('UI05 conservación');await p.getByPlaceholder('Describe detalladamente el problema o propuesta...').fill('Datos sintéticos que deben conservarse al fallar la conexión.');
 for(mode of ['offline','timeout','slow']){const before=submitted;await p.getByRole('button',{name:'Generar ticket',exact:true}).click();await p.waitForTimeout(300);const loading=await p.getByRole('button',{name:'Generando…',exact:true}).count();await p.waitForTimeout(mode==='slow'?3500:800);checks.push({mode,attempted:submitted>before,loading,title:await p.getByLabel('Título del reporte').inputValue(),description:await p.getByPlaceholder('Describe detalladamente el problema o propuesta...').inputValue(),text:await p.locator('body').innerText(),dialogs:[...dialogs]});}
 results.push({id:'UI05',role,status:checks.every(x=>x.attempted&&x.title==='UI05 conservación'&&x.dialogs.length>0&&!x.dialogs.some(t=>t.includes('creado correctamente')))&&checks.find(x=>x.mode==='slow').loading===1?'APROBADO':'FALLIDO',checks,tipo:'Fallas y latencia controladas de transporte en creación de ticket; sin escritura real.'});
 }else{await ctx.setOffline(true);await nav(p,'Configuración');await nav(p,'Tickets');await p.waitForTimeout(1200);results.push({id:'UI05',role,status:'PARCIAL',text:await p.locator('body').innerText(),observacion:'Recarga sin red; no formulario de creación para soporte.'});}
 await p.screenshot({path:out+'/UI05-red-'+role+'.png'});
 }catch(e){results.push({id:'UI05',role,status:'NO CONCLUIDO',error:String(e)});}
 await fs.writeFile(out+'/red_ui.json',JSON.stringify(results,null,2));await ctx.close();
}
await browser.close();console.log(JSON.stringify(results));
