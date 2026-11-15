from pathlib import Path
from collections import defaultdict
import json,sys,os,hashlib,psycopg
ROOT=Path(__file__).resolve().parents[3]
WORK=Path(os.environ.get('PERF_WORK_DIR',Path(__file__).resolve().parent/'lab')).resolve()
LOCAL='postgresql://perf@127.0.0.1:55432/postgres'
meta=json.loads((WORK/'perf-estructura.json').read_text())
q=lambda s:'"'+s.replace('"','""')+'"'
tables=defaultdict(list)
for table,name,typ,nn,default,ident,generated in meta['columns']:
 col=q(name)+' '+typ
 if ident: col+=' GENERATED '+('ALWAYS' if ident=='a' else 'BY DEFAULT')+' AS IDENTITY'
 elif generated: col+=' GENERATED ALWAYS AS ('+default+') STORED'
 elif default: col+=' DEFAULT '+default
 if nn: col+=' NOT NULL'
 tables[table].append(col)
with psycopg.connect(LOCAL) as db:
 if db.execute("SELECT 1 FROM pg_namespace WHERE nspname='emergencia'").fetchone(): raise RuntimeError('La base de prueba ya tiene esquema: no sobrescribir')
 db.execute('CREATE SCHEMA emergencia')
 for t,cols in tables.items(): db.execute('CREATE TABLE emergencia.'+q(t)+' ('+', '.join(cols)+')')
 for t,name,kind,definition in meta['constraints']: db.execute('ALTER TABLE emergencia.'+q(t)+' ADD CONSTRAINT '+q(name)+' '+definition)
 for (index,) in meta['indexes']: db.execute(index)
 db.execute("SET timezone='America/Santiago'")
 db.execute("INSERT INTO emergencia.compania(nombre_compania,latitud_compania,longitud_compania) VALUES ('COMPANIA SINTETICA',-33.0391,-71.6240)")
 db.execute("INSERT INTO emergencia.tipo_emergencia VALUES ('10-0','INCENDIO SINTETICO',1,'ALTA','urbano')")
 # Solo catálogo geográfico público ya incluido en el código local.
 geo=json.loads((ROOT/'src/backend/core/data/zonas_valparaiso.geojson').read_text(encoding='utf-8'))
 for f in geo['features']:
  p=f['properties']; xmin,ymin,xmax,ymax=p['bounds']
  db.execute('INSERT INTO emergencia.zona VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(p['id_zona'],'ZONA SINTETICA '+p['id_zona'],ymin,xmin,ymax,xmax))
 emails=['ben.saavedrab@bomberos.cl','alex.aravena@bomberos.cl','bru.molina@bomberos.cl','amolina@admin.alerta360.cl']
 roles=['admin','admin','visualizador','soporte']
 for i,(email,role) in enumerate(zip(emails,roles)):
  db.execute("INSERT INTO emergencia.usuario(email_usuario,nombre_completo,password_hash,rol_usuario,id_compania) VALUES (%s,%s,'SINTETICO_NO_USADO',%s,1)",(email,'Cuenta de prueba '+str(i+1),role))
 for i in range(100):
  db.execute("INSERT INTO emergencia.recurso(id_compania,tipo_recurso,estado_radio,dotacion_recurso,latitud_recurso,longitud_recurso,codigo_recurso,nombre_recurso) VALUES (1,'B','6-0',6,-33.0391,-71.6240,%s,'RECURSO SINTETICO')",('PERF-'+str(i+1),))
 db.execute("INSERT INTO emergencia.tipo_ticket(nombre_tipo) VALUES ('Prueba sintetica')")
 db.execute("INSERT INTO emergencia.apartado_ticket(nombre_apartado) VALUES ('Prueba sintetica')")
 db.commit()
 print('Tablas locales creadas:',len(tables),'Registros remotos copiados: 0')
 counts={t:db.execute('SELECT count(*) FROM emergencia.'+q(t)).fetchone()[0] for t in tables}
out=(WORK/'results'); out.mkdir(exist_ok=True,parents=True)
(out/'ambiente_local.json').write_text(json.dumps({'source':str(ROOT),'api_url':'http://127.0.0.1:8011','database':'PostgreSQL 16.15 local, puerto 55432','schema_source':'Solo metadatos PostgreSQL 17.11 Supabase; 118 columnas,42 restricciones,6 indices adicionales','remote_rows_copied':0,'seed_counts':counts,'accounts':4,'authentication':'Catalogo de 4 cuentas del codigo; filas locales sinteticas; contrasena demo del codigo','limitations':['No es una medicion Docker/Supabase ni de red publica','No se altera el codigo del producto','No se mide prediccion PF03 ni se reentrena el modelo']},indent=2),encoding='utf-8')
