"""PF04/05/06/08 contra una API y BD de laboratorio exclusivamente locales.
No lee api.env, no usa Supabase y no publica credenciales en las evidencias.
"""
import sys,os,json,time,math,threading,statistics,datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import httpx,psycopg
sys.path.insert(0,str(Path(__file__).resolve().parent/'test-deps'))
import psutil
BASE='http://127.0.0.1:8011'
DB='postgresql://perf@127.0.0.1:55432/postgres'
WORK=Path(os.environ.get('PERF_WORK_DIR',Path(__file__).resolve().parent/'lab')).resolve()
OUT=WORK/'results'
EMAILS=['ben.saavedrab@bomberos.cl','alex.aravena@bomberos.cl','bru.molina@bomberos.cl','amolina@admin.alerta360.cl']
ROLES=['admin','admin','visualizador','soporte']
def client(): return httpx.Client(base_url=BASE,timeout=30,trust_env=False)
def pct(vals,p): return sorted(vals)[max(0,math.ceil(len(vals)*p/100)-1)] if vals else None
def metrics(rows):
 out={}
 for key in sorted({r['operation'] for r in rows}):
  rr=[r for r in rows if r['operation']==key]; ts=[r['ms'] for r in rr]
  out[key]={'n':len(rr),'errors':sum(not r['ok'] for r in rr),'p50_ms':pct(ts,50),'p95_ms':pct(ts,95),'max_ms':max(ts),'statuses':{str(s):sum(r['status']==s for r in rr) for s in set(r['status'] for r in rr)}}
 return out
def save(name,obj):
 OUT.mkdir(parents=True,exist_ok=True)
 obj={'case':name,'timestamp_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'base_url':BASE,**obj}
 (OUT/(name+'.json')).write_text(json.dumps(obj,indent=2,ensure_ascii=False,default=str),encoding='utf-8')
 print(name,json.dumps({k:v for k,v in obj.items() if k not in ('samples','telemetry','batches')},ensure_ascii=True),flush=True)
def call(c,rows,op,method,path,expected=(200,),**kwargs):
 t=time.perf_counter(); status=None; error=None; data={}
 try:
  r=c.request(method,path,**kwargs); status=r.status_code
  try: data=r.json()
  except ValueError: pass
  if status not in expected: error='http_'+str(status)
 except httpx.HTTPError as e: error=type(e).__name__
 rows.append({'operation':op,'status':status,'ms':round((time.perf_counter()-t)*1000,3),'ok':error is None,'error':error})
 return data,status
def login(c,idx,rows=None):
 rows=[] if rows is None else rows
 data,status=call(c,rows,'login','POST','/auth/login',json={'email':EMAILS[idx],'password':'Bomberos.2026'})
 if status==200 and data.get('token'): c.headers['Authorization']='Bearer '+data['token']
 return status==200
def create_em(c,rows,tag):
 d,s=call(c,rows,'emergency_create','POST','/emergencies',json={'codigo_emergencia':'10-0','direccion_emergencia':'PRUEBA SINTETICA '+tag,'latitud_emergencia':-32.9305,'longitud_emergencia':-71.503,'prioridad_emergencia':1})
 return d.get('id_emergencia') or d.get('emergencia',{}).get('id_emergencia')
def pf04():
 batches=[]
 # Credenciales independientes por rol; los workers comparten cuenta cuando hay >4.
 clients=[]
 for i in range(4):
  c=client(); assert login(c,i); clients.append(c)
 for users in (5,10):
  with psycopg.connect(DB) as db:
   db.execute("UPDATE emergencia.recurso SET estado_radio='6-0'")
   before={t:db.execute('SELECT count(*) FROM emergencia.'+t).fetchone()[0] for t in ('emergencia','asignacion','ticket','respuesta_ticket')}
  def worker(i):
   rows=[]; completed=0
   with client() as c,client() as support:
    c.headers.update(clients[i%3].headers); support.headers.update(clients[3].headers)
    for j in range(5):
     tag=f'PF04-{users}-{i}-{j}'
     # Operaciones de despacho bajo cuenta admin, tickets bajo los tres roles.
     with client() as admin:
      admin.headers.update(clients[i%2].headers)
      eid=create_em(admin,rows,tag)
      if eid:
       rid=i*5+j+1
       call(admin,rows,'assignment_create','POST','/assignments',params={'id_emergencia':eid,'id_recurso':rid})
       for state in ('ASIGNADA','EN_ATENCION','FINALIZADA'):
        call(admin,rows,'emergency_'+state,'PATCH',f'/emergencies/{eid}/status',json={'estado':state})
     d,s=call(c,rows,'ticket_create','POST','/tickets',json={'id_tipo':1,'id_apartado':1,'titulo_ticket':tag,'descripcion':'Registro sintetico de rendimiento'})
     if s==200:
      call(support,rows,'ticket_reply','POST',f"/tickets/{d['id_ticket']}/respuestas",json={'mensaje':'Respuesta sintetica','tipo_respuesta':'Respuesta'})
      completed+=1
   return rows,completed
  start=time.perf_counter()
  with ThreadPoolExecutor(max_workers=users) as pool: result=list(pool.map(worker,range(users)))
  rows=[r for rr,_ in result for r in rr]
  with psycopg.connect(DB) as db:
   after={t:db.execute('SELECT count(*) FROM emergencia.'+t).fetchone()[0] for t in before}
   pending=db.execute("SELECT count(*) FROM emergencia.emergencia WHERE estado_emergencia!='FINALIZADA'").fetchone()[0]
   duplicate=db.execute('SELECT count(*)-count(distinct codigo_ticket) FROM emergencia.ticket').fetchone()[0]
  checks={'expected_each':users*5,'deltas':{t:after[t]-before[t] for t in before},'not_closed':pending,'duplicate_ticket_codes':duplicate}
  batches.append({'users':users,'seconds':time.perf_counter()-start,'metrics':metrics(rows),'checks':checks,'samples':rows})
 # Contención sobre una misma emergencia/recurso: una sola asignación.
 rows=[]; eid=create_em(clients[0],rows,'RACE')
 with psycopg.connect(DB) as db: db.execute("UPDATE emergencia.recurso SET estado_radio='6-0' WHERE id_recurso=100")
 barrier=threading.Barrier(10)
 def race(i):
  rr=[]
  with client() as c:
   c.headers.update(clients[i%2].headers);barrier.wait()
   call(c,rr,'assignment_race','POST','/assignments',expected=(200,400,409),params={'id_emergencia':eid,'id_recurso':100})
  return rr
 with ThreadPoolExecutor(max_workers=10) as pool: race_rows=[r for rr in pool.map(race,range(10)) for r in rr]
 with psycopg.connect(DB) as db: count=db.execute('SELECT count(*) FROM emergencia.asignacion WHERE id_emergencia=%s',(eid,)).fetchone()[0]
 passed=all(all(m['errors']==0 for m in b['metrics'].values()) and all(v==b['checks']['expected_each'] for v in b['checks']['deltas'].values()) and b['checks']['not_closed']==0 and b['checks']['duplicate_ticket_codes']==0 for b in batches) and count==1
 save('PF04',{'status':'APROBADO_FUNCIONAL' if passed else 'FALLIDO','batches':batches,'race_metrics':metrics(race_rows),'race_assignment_rows':count,'race_samples':race_rows,'scope':'Creacion/asignacion/cierre y tickets/respuestas reales contra BD local; clima externo deshabilitado por proxy local no disponible. No acredita enriquecimiento meteorologico ni latencia con proveedor externo. No hay SLA de escritura aprobado.'})
 for c in clients:c.close()
def seed_volume(n):
 with psycopg.connect(DB) as db:
  db.execute('TRUNCATE emergencia.respuesta_ticket,emergencia.ticket RESTART IDENTITY')
  db.execute("INSERT INTO emergencia.ticket(id_usuario,id_tipo,id_apartado,codigo_ticket,titulo_ticket,descripcion) SELECT mod(g-1,4)+1,1,1,'SYN-'||g,'Caso sintetico '||g,repeat('Dato sintetico. ',16) FROM generate_series(1,%s) g",(n,))
  db.execute("INSERT INTO emergencia.respuesta_ticket(id_ticket,id_usuario,mensaje) SELECT id_ticket,4,'Respuesta sintetica' FROM emergencia.ticket")
  db.execute("SELECT setval('emergencia.ticket_id_ticket_seq',%s)",(n,))
  db.execute('UPDATE emergencia.emergencia SET id_registro_historico=NULL')
  db.execute('DELETE FROM emergencia.registro_historico')
  db.execute("INSERT INTO emergencia.registro_historico(id_zona,codigo_emergencia,fecha,dia_semana,mes,bloque_horario,cantidad_emergencias,recursos_utilizados,temperatura_c,viento_kmh,precipitacion_mm) SELECT (SELECT id_zona FROM emergencia.zona ORDER BY id_zona LIMIT 1),'10-0',DATE '2020-01-01'+(g/8),mod(g,7),mod(g,12)+1,mod(g,8)*3,1,1,15,10,0 FROM generate_series(0,%s-1) g",(n,))
  db.execute('ANALYZE emergencia.ticket');db.execute('ANALYZE emergencia.respuesta_ticket');db.execute('ANALYZE emergencia.registro_historico')
 (WORK/'perf-historial.json').write_text(json.dumps([{'id':i+1,'ts':1700000000000+i*1000,'tipo':'PRUEBA','texto':'Evento sintetico '+str(i)} for i in range(n)]))
def pf05():
 batches=[]
 for n in (100,1000,10000):
  seed_volume(n)
  for users in (5,10):
   sessions=[]
   for i in range(4):
    c=client();assert login(c,i);sessions.append(dict(c.headers));c.close()
   def worker(i):
    rows=[]
    with client() as c:
     c.headers.update(sessions[i%4])
     for j in range(20):
      path='/tickets' if j%2==0 else '/historial'
      data,status=call(c,rows,ROLES[i%4]+path,'GET',path)
      key='tickets' if path=='/tickets' else 'historial';expected=n if path=='/historial' or i%4==3 else n//4
      if status==200 and len(data.get(key,[]))!=expected: rows[-1].update(ok=False,error='conteo_incorrecto')
      time.sleep(.05)
    return rows
   start=time.perf_counter()
   with ThreadPoolExecutor(max_workers=users) as pool: rows=[r for rr in pool.map(worker,range(users)) for r in rr]
   batches.append({'dataset_rows':n,'users':users,'seconds':time.perf_counter()-start,'metrics':metrics(rows),'samples':rows})
  timings=[]
  with psycopg.connect(DB) as db:
   for _ in range(30):
    start=time.perf_counter();rr=db.execute('SELECT id_zona,codigo_emergencia,fecha,bloque_horario,cantidad_emergencias FROM emergencia.registro_historico ORDER BY fecha,bloque_horario').fetchall();timings.append((time.perf_counter()-start)*1000)
   assert len(rr)==n
  batches.append({'dataset_rows':n,'historical_sql_n':30,'historical_sql_p95_ms':pct(timings,95)})
 save('PF05',{'status':'EJECUTADO_SIN_SLA' if all(m['errors']==0 for b in batches for m in b.get('metrics',{}).values()) else 'FALLIDO','batches':batches,'scope':'100/1000/10000 tickets con una respuesta cada uno, eventos de historial JSON y filas de historico SQL. Mismo cliente y distribucion por rol en cada volumen. Historico SQL separado de /historial. Payloads sin adjuntos. Sin SLA de latencia acordado.'})
def pf08():
 # Sembrar un ticket por cuenta permite comprobar aislamiento al navegar.
 seed_volume(100)
 barrier=threading.Barrier(4)
 def worker(i):
  rows=[];checks=[]
  with client() as c:
   for j in range(25):
    barrier.wait()
    if not login(c,i,rows): continue
    d,s=call(c,rows,'me','GET','/auth/me');checks.append(s==200 and d.get('email')==EMAILS[i] and d.get('rol')==ROLES[i])
    d,s=call(c,rows,'tickets','GET','/tickets')
    checks.append(s==200 and len(d.get('tickets',[]))==(100 if i==3 else 25) and (i==3 or all(t.get('creado_por_email')==EMAILS[i] for t in d.get('tickets',[]))))
  return rows,checks
 start=time.perf_counter()
 with ThreadPoolExecutor(max_workers=4) as pool: result=list(pool.map(worker,range(4)))
 rows=[r for rr,_ in result for r in rr]; checks=[c for _,cc in result for c in cc]
 with psycopg.connect(DB) as db: active=db.execute("SELECT count(*) FROM emergencia.usuario WHERE estado_usuario='activo'").fetchone()[0]
 save('PF08',{'status':'APROBADO' if all(checks) and all(r['ok'] for r in rows) and len(checks)==200 else 'FALLIDO','independent_accounts':4,'login_rounds_per_account':25,'seconds':time.perf_counter()-start,'metrics':metrics(rows),'identity_and_ticket_checks':len(checks),'failed_checks':sum(not x for x in checks),'active_accounts_after':active,'samples':rows,'scope':'Login HTTP con bcrypt real, JWT devuelto por cada login y BD local. Catalogo actual admite cuatro cuentas. Indicador activo mantiene solo una cuenta por diseno de demo; no acredita presencia simultanea de cuatro operadores.'})
def pf06():
 seed_volume(1000)
 headers=[]
 for i in range(4):
  c=client(); assert login(c,i); headers.append(dict(c.headers)); c.close()
 pid=json.loads((WORK/'perf-api-pid.json').read_text())['pid'];proc=psutil.Process(pid)
 phases=[('baseline',2,120),('carga5',5,600),('carga10',10,1200),('estres20',20,600),('estres40',40,600),('recuperacion',2,480)]
 telemetry=[];batches=[];stop_monitor=threading.Event();start=time.monotonic();proc.cpu_percent()
 def monitor():
  with psycopg.connect(DB,autocommit=True) as db:
   while not stop_monitor.is_set():
    try:
     connections=db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND pid!=pg_backend_pid()").fetchone()[0]
     telemetry.append({'elapsed_s':round(time.monotonic()-start,2),'api_rss_mb':proc.memory_info().rss/1048576,'api_cpu_percent_one_core':proc.cpu_percent(),'host_cpu_percent':psutil.cpu_percent(),'host_available_mb':psutil.virtual_memory().available/1048576,'db_connections':connections,'api_threads':proc.num_threads(),'api_handles':proc.num_handles()})
     (OUT/'PF06-progreso.json').write_text(json.dumps({'elapsed_s':round(time.monotonic()-start),'planned_s':3600,'completed_phases':[b['name'] for b in batches],'last_telemetry':telemetry[-1]}),encoding='utf-8')
    except Exception as e: telemetry.append({'elapsed_s':time.monotonic()-start,'error':type(e).__name__})
    stop_monitor.wait(10)
 thread=threading.Thread(target=monitor,daemon=True);thread.start()
 try:
  for name,users,duration in phases:
   print('PF06 PHASE',name,users,duration,flush=True); phase_start=time.monotonic();deadline=phase_start+duration;abort=threading.Event();totals=[0,0];lock=threading.Lock()
   def worker(i):
    rr=[];j=0
    with client() as c:
     c.headers.update(headers[i%4])
     paths=['/auth/me','/tickets','/tickets/catalogos','/resources','/historial','/emergencies']
     while time.monotonic()<deadline and not abort.is_set():
      path=paths[j%len(paths)];d,s=call(c,rr,ROLES[i%4]+path,'GET',path);j+=1
      if s==200 and not isinstance(d,dict): rr[-1].update(ok=False,error='json_invalido')
      with lock:
       totals[0]+=1;totals[1]+=not rr[-1]['ok']
       if totals[0]>=100 and totals[1]/totals[0]>.1: abort.set()
      remaining=deadline-time.monotonic()
      if remaining>0: time.sleep(min(1,remaining))
    return rr
   with ThreadPoolExecutor(max_workers=users) as pool: rows=[r for rr in pool.map(worker,range(users)) for r in rr]
   batch={'name':name,'users':users,'requested_seconds':duration,'actual_seconds':time.monotonic()-phase_start,'aborted':abort.is_set(),'metrics':metrics(rows),'requests':len(rows),'errors':sum(not r['ok'] for r in rows)}
   batches.append(batch)
   save('PF06-'+name,{**batch,'samples':rows})
   if abort.is_set():break
 finally: stop_monitor.set();thread.join()
 save('PF06',{'status':'EJECUTADO_REQUIERE_ANALISIS','actual_seconds':time.monotonic()-start,'planned_seconds':3600,'batches':batches,'telemetry':telemetry,'scope':'Carga cerrada, pausa 1s por worker, consultas por cuatro cuentas con JWT obtenidos via login. No incluye prediccion ni OSRM. CPU/RAM del proceso API y conexiones de BD; limite de carga ensayado no equivale a capacidad maxima.'})
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 {'PF04':pf04,'PF05':pf05,'PF06':pf06,'PF08':pf08}[sys.argv[1]]()
