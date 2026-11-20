import sys,json
import psycopg,httpx
url='postgresql://perf@127.0.0.1:55432/planificadas17'
cmd=sys.argv[1]
with psycopg.connect(url) as db:
 if cmd=='reset':
  db.execute('truncate emergencia.asignacion,emergencia.emergencia,emergencia.registro_historico restart identity cascade')
  db.execute("update emergencia.recurso set estado_radio='6-0',latitud_recurso=-32.9315,longitud_recurso=-71.504")
  db.execute("update emergencia.compania set latitud_compania=-32.9315,longitud_compania=-71.504")
  cid=db.execute("select id_compania from emergencia.recurso where codigo_recurso='B-1'").fetchone()[0]
  db.execute("update emergencia.usuario set id_compania=%s where email_usuario='bru.molina@bomberos.cl'",(cid,))
 elif cmd=='state':
  print(json.dumps({'emergencias':db.execute('select id_emergencia,estado_emergencia from emergencia.emergencia order by 1').fetchall(),'asignaciones':db.execute('select id_emergencia,id_recurso,estado_asignacion,fecha_retorno from emergencia.asignacion order by id_asignacion').fetchall(),'historico':db.execute('select count(*) from emergencia.registro_historico').fetchone()[0],'recursos':db.execute("select codigo_recurso,estado_radio from emergencia.recurso where estado_radio <> '6-0'").fetchall()},default=str))
