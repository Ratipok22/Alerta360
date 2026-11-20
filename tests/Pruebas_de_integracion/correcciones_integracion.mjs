import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {out, python, controlPath} from '../soporte_funcionales/config.mjs';
const control=(cmd)=>execFileSync(python,[controlPath,cmd],{encoding:'utf8'});
if (!process.argv.slice(2).length) throw new Error('Indica AS11, AS09 o AS12 como argumento');
const state=()=>JSON.parse(control('state'));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
async function login(ctx,email){const p=await ctx.newPage();p.setDefaultTimeout(15000);await p.goto('http://127.0.0.1:5173');await p.locator('input[type=email]').fill(email);await p.locator('input[type=password]').fill('Bomberos.2026');await p.getByRole('button',{name:'Ingresar',exact:true}).click();await p.locator('.sidebar').waitFor();return p;}
const authOf=p=>p.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.token));
for(const id of process.argv.slice(2)){
 control('reset');const ctx=await browser.newContext({viewport:{width:1440,height:1000}});let p=await login(ctx,'alex.aravena@bomberos.cl');const auth=await authOf(p);const h={Authorization:'Bearer '+auth.token};
 const timeline=[],calls=[];let ctx2=null,blocked=0,offline=false;
 await ctx.route('**/emergencies/*/status',async route=>{const req=route.request();if(req.method()==='PATCH'&&req.postDataJSON()?.estado==='FINALIZADA'){calls.push({time:Date.now(),estado:'FINALIZADA'});if(id==='AS10'&&blocked===0){blocked++;timeline.push({event:'fallo_red_cierre',state:state()});return route.abort('connectionfailed');}}return route.continue();});
 const stamp=event=>{const s={event,time:Date.now(),state:state()};timeline.push(s);console.log(id,JSON.stringify(s));return s.state;};
 try{
  const r=await ctx.request.post('http://127.0.0.1:8011/emergencies',{headers:h,data:{codigo_emergencia:'10-0',direccion_emergencia:id+'-PLANIFICADA',latitud_emergencia:-32.9305,longitud_emergencia:-71.503,prioridad_emergencia:1,tipo_estructura_emergencia:'edificio_residencial',piso_emergencia:5}});if(r.status()!==200)throw Error(await r.text());
  await p.reload();await p.locator('.sidebar').getByRole('button',{name:'Dashboard',exact:true}).click();await p.waitForTimeout(1500);
  // Orden inverso al ensayo previo: escala, primera bomba, segunda bomba.
  for(const index of [7,1,2]){await p.getByLabel('Filtrar por cuartel').selectOption({index});await p.waitForTimeout(300);await p.getByRole('button',{name:'ASIGNAR',exact:true}).click();await p.waitForTimeout(1800);stamp('despacho');}
  if(state().asignaciones.length!==3)throw Error('No se confirmaron los tres despachos');
  if(id==='AS09'){await p.reload();await p.locator('.sidebar').waitFor();stamp('recarga_en_trayecto');}
  if(id==='AS12'){ctx2=await browser.newContext();await login(ctx2,'ben.saavedrab@bomberos.cl');stamp('segundo_administrador_conectado');}
  let scene=false,returning=false;
  for(let tick=0;tick<75;tick++){
   await p.waitForTimeout(2000);let s=state();
   if(!scene&&s.recursos.filter(r=>r[1]==='6-7').length===3){scene=true;stamp('cobertura_completa_en_escena');
    if(id==='AS09'){await p.close();p=await ctx.newPage();await p.goto('http://127.0.0.1:5173');await p.locator('.sidebar').waitFor();stamp('cerrar_y_reabrir_en_escena');}
    if(id==='AS11'){const resp=await ctx.request.patch('http://127.0.0.1:8011/resources/Q-7/position',{headers:h,data:{lat:-32.9305,lng:-71.503,estado:'6-9'}});timeline.push({event:'retirar_escala',http:resp.status()});stamp('sin_cobertura');}
   }
   if(id==='AS09'&&!returning&&s.recursos.some(r=>r[1]==='6-8')){returning=true;await p.reload();await p.locator('.sidebar').waitFor();stamp('recarga_en_regreso');}
   if(tick%10===0)stamp('observacion_'+tick*2+'s');
   await fs.writeFile(out+'/'+id+'-progreso.json',JSON.stringify({id,timeline,calls},null,2));
   if(id==='AS11'&&scene&&tick>45)break;
   if(s.emergencias[0]?.[1]==='FINALIZADA'&&s.recursos.length===0)break;
  }
  const final=stamp('final');const passed=id==='AS11'?scene&&final.emergencias[0]?.[1]!=='FINALIZADA'&&final.historico===0:final.emergencias[0]?.[1]==='FINALIZADA'&&final.historico===1&&final.asignaciones.length===3&&final.asignaciones.every(a=>a[3])&&final.recursos.length===0;
  await p.screenshot({path:out+'/'+id+'-final.png'});await fs.writeFile(out+'/'+id+'-final.json',JSON.stringify({id,status:passed?'APROBADO':'FALLIDO',scene,returning,blocked,timeline,calls},null,2));console.log(id,'RESULTADO',passed);
 }catch(e){await fs.writeFile(out+'/'+id+'-final.json',JSON.stringify({id,status:'NO CONCLUIDO',error:String(e),timeline,calls,text:await p.locator('body').innerText()},null,2));console.log(id,'ERROR',String(e));}
 await ctx2?.close();await ctx.close();
}
await browser.close();

