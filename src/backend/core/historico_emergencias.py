"""Traspaso idempotente de emergencias cerradas a bloques de entrenamiento.

No borra emergencias. No reentrena ni modifica la inferencia ML.
"""
from datetime import datetime
import logging
import math
from zoneinfo import ZoneInfo

# Permite ejecutar python -m core.historico_emergencias desde src/backend.
import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from database.database import obtener_conexion
from core.clima_historico import DatosPendientes, obtener_clima

logger = logging.getLogger(__name__)
CERRADOS = ('FINALIZADA', 'FINALIZADO', 'CERRADA', 'CERRADO',
            'TERMINADA', 'TERMINADO', 'INACTIVA', 'INACTIVO')
CHILE = ZoneInfo('America/Santiago')


def cerrado(estado):
    return str(estado).strip().upper() in CERRADOS


def _leer(cursor, ident, bloquear=False):
    cursor.execute('''SELECT id_emergencia, codigo_emergencia, id_zona,
        fecha_creacion_emergencia, estado_emergencia, latitud_emergencia,
        longitud_emergencia, id_registro_historico
        FROM emergencia.emergencia WHERE id_emergencia=%s'''
        + (' FOR UPDATE' if bloquear else ''), (ident,))
    row = cursor.fetchone()
    if row is None:
        raise DatosPendientes('Emergencia inexistente.')
    return dict(zip(('id','codigo','zona','inicio','estado','lat','lng','historico'),row))


def _preparar(cursor, row):
    if not cerrado(row['estado']):
        raise DatosPendientes('La emergencia todavía no está cerrada.')
    if not isinstance(row['inicio'], datetime):
        raise DatosPendientes('Falta la fecha de ocurrencia de la emergencia.')
    fecha = row['inicio']
    if fecha.tzinfo is not None:
        fecha = fecha.astimezone(CHILE).replace(tzinfo=None)
    # No se sobrescriben zonas asignadas: comprobar coherencia antes de entrenar.
    from core.zonificacion import resolver_zona
    try:
        zona = resolver_zona(cursor, row['lat'], row['lng'], row['zona'])
    except ValueError as exc:
        raise DatosPendientes(str(exc)) from exc
    return fecha.date(), (fecha.hour // 3) * 3, zona


def _validar_clima(clima):
    for key in ('temperatura_c','viento_kmh','precipitacion_mm'):
        value = clima.get(key)
        if value is None or not math.isfinite(float(value)):
            raise DatosPendientes('Falta un valor climático válido: '+key)
    if clima['viento_kmh'] < 0 or clima['precipitacion_mm'] < 0 or not clima.get('fuente'):
        raise DatosPendientes('El clima debe indicar su fuente y valores válidos.')


def _punto_zona(cursor, zona):
    """Punto representativo del catálogo SQL, común a todos los tipos del bloque.

    Es una aproximación espacial por centro de límites, no un promedio
    meteorológico de toda la superficie del polígono.
    """
    cursor.execute('''SELECT latitud_minima,latitud_maxima,longitud_minima,longitud_maxima
        FROM emergencia.zona WHERE id_zona=%s''',(zona,))
    limites=cursor.fetchone()
    if limites is None or any(v is None or not math.isfinite(v) for v in limites):
        raise DatosPendientes('La zona no tiene límites completos para consultar su clima.')
    latmin,latmax,lngmin,lngmax=limites
    if not (-90 <= latmin <= latmax <= 90 and -180 <= lngmin <= lngmax <= 180):
        raise DatosPendientes('Los límites geográficos de la zona son inválidos.')
    return (latmin+latmax)/2,(lngmin+lngmax)/2


def archivar_en_transaccion(cursor, ident, clima, esperado=None):
    """La fila bloqueada y su vínculo hacen seguro repetir o concurrir cierres."""
    row = _leer(cursor, ident, bloquear=True)
    if row['historico'] is not None:
        return {'estado':'registrada','id_registro':row['historico'],'nueva':False}
    fecha, bloque, zona = _preparar(cursor, row)
    if esperado is not None and any(row[k] != esperado[k] for k in ('codigo','zona','inicio','lat','lng')):
        raise DatosPendientes('La emergencia cambió mientras se consultaba el clima; se reintentará.')
    _validar_clima(clima)
    # Serializa solo el mismo bloque. Evita contar dos veces con dos workers.
    key = f'{fecha}|{bloque}|{zona}|{row["codigo"]}'
    cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))',(key,))
    cursor.execute('''SELECT id_registro, cantidad_emergencias,
        recursos_utilizados, temperatura_c, viento_kmh, precipitacion_mm
        FROM emergencia.registro_historico
        WHERE fecha=%s AND bloque_horario=%s AND id_zona=%s AND codigo_emergencia=%s
        FOR UPDATE''',(fecha,bloque,zona,row['codigo']))
    previous = cursor.fetchone()
    if previous is not None:
        cursor.execute('SELECT EXISTS (SELECT 1 FROM emergencia.emergencia WHERE id_registro_historico=%s)', (previous[0],))
        if not cursor.fetchone()[0]:
            raise DatosPendientes('El bloque ya existe en el histórico importado sin emergencias vinculadas; revisar para evitar duplicados.')
        if any(v is None for v in previous[1:]):
            raise DatosPendientes('El bloque existente tiene datos incompletos.')
    cursor.execute('''SELECT COUNT(DISTINCT id_recurso) FROM emergencia.asignacion
        WHERE id_emergencia=%s AND UPPER(TRIM(estado_asignacion)) NOT IN
        ('CANCELADA','CANCELADO','ANULADA','ANULADO','RECHAZADA','RECHAZADO')''',(ident,))
    recursos = cursor.fetchone()[0]
    timestamp = datetime.combine(fecha,datetime.min.time()).replace(hour=bloque)
    if previous is None:
        cursor.execute('''INSERT INTO emergencia.registro_historico
            (id_zona,codigo_emergencia,timestamp_registro,fecha,dia_semana,mes,
             bloque_horario,cantidad_emergencias,recursos_utilizados,
             temperatura_c,viento_kmh,precipitacion_mm)
            VALUES (%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s)
            RETURNING id_registro''',
            (zona,row['codigo'],timestamp,fecha,fecha.weekday(),fecha.month,bloque,recursos,
             clima['temperatura_c'],clima['viento_kmh'],clima['precipitacion_mm']))
        historico = cursor.fetchone()[0]
    else:
        historico, n, recursos_prev, temp, viento, lluvia = previous
        # Clima representativo del bloque: promedio de las ubicaciones atendidas;
        # la lluvia no se suma entre emergencias (solo entre horas en el proveedor).
        cursor.execute('''UPDATE emergencia.registro_historico
            SET cantidad_emergencias=%s, recursos_utilizados=%s,
                temperatura_c=%s, viento_kmh=%s, precipitacion_mm=%s
            WHERE id_registro=%s''',
            (n+1,recursos_prev+recursos,(temp*n+clima['temperatura_c'])/(n+1),
             (viento*n+clima['viento_kmh'])/(n+1),(lluvia*n+clima['precipitacion_mm'])/(n+1),historico))
    cursor.execute('''UPDATE emergencia.emergencia
        SET id_registro_historico=%s, id_zona=%s
        WHERE id_emergencia=%s''',(historico,zona,ident))
    return {'estado':'registrada','id_registro':historico,'nueva':True}


def registrar_emergencia(ident, proveedor=None):
    proveedor = proveedor or obtener_clima
    conn = obtener_conexion()
    try:
        # Ninguna petición HTTP mantiene bloqueada una fila de la base.
        with conn.cursor() as cursor:
            row = _leer(cursor,ident)
            if row['historico'] is not None:
                return {'estado':'registrada','id_registro':row['historico'],'nueva':False}
            fecha,bloque,zona = _preparar(cursor,row)
            lat,lng = _punto_zona(cursor,zona)
        conn.rollback()
        clima = proveedor(fecha,bloque,lat,lng)
        with conn.cursor() as cursor:
            result = archivar_en_transaccion(cursor,ident,clima,esperado=row)
        conn.commit()
        return result
    except DatosPendientes as exc:
        conn.rollback()
        logger.warning('Emergencia %s pendiente de histórico: %s', ident, exc)
        return {'estado':'pendiente','motivo':str(exc)}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def registrar_seguro(ident):
    try:
        return registrar_emergencia(ident)
    except Exception:
        logger.exception('No se pudo procesar el histórico de la emergencia %s',ident)
        return {'estado':'error','motivo':'Error de procesamiento; el cierre permanece confirmado y se reintentará.'}


def sincronizar_pendientes(limite=50, stop=None):
    with obtener_conexion() as conn, conn.cursor() as cursor:
        cursor.execute('''SELECT id_emergencia FROM emergencia.emergencia
            WHERE UPPER(TRIM(estado_emergencia))=ANY(%s)
              AND id_registro_historico IS NULL
            ORDER BY id_emergencia LIMIT %s''',
            (list(CERRADOS),max(1,min(int(limite),200))))
        ids=[row[0] for row in cursor.fetchall()]
    result=[]
    for ident in ids:
        if stop is not None and stop.is_set():break
        try:
            result.append({'id_emergencia':ident,**registrar_emergencia(ident)})
        except Exception:
            logger.exception('No se pudo pasar la emergencia %s al histórico',ident)
            result.append({'id_emergencia':ident,'estado':'error','motivo':'Error de base de datos; revisar registro del servidor.'})
    return result


def resumen():
    with obtener_conexion() as conn, conn.cursor() as cursor:
        cursor.execute('''SELECT COUNT(*) FILTER (WHERE id_registro_historico IS NOT NULL),
            COUNT(*) FILTER (WHERE id_registro_historico IS NULL)
            FROM emergencia.emergencia WHERE UPPER(TRIM(estado_emergencia))=ANY(%s)''',(list(CERRADOS),))
        registradas,pendientes=cursor.fetchone()
        cursor.execute('''SELECT id_emergencia
            FROM emergencia.emergencia WHERE UPPER(TRIM(estado_emergencia))=ANY(%s)
            AND id_registro_historico IS NULL ORDER BY id_emergencia LIMIT 100''',(list(CERRADOS),))
        detalle=[{'id_emergencia':row[0],'motivo':'Pendiente de procesar; consultar el registro del servidor.'} for row in cursor.fetchall()]
    return {'registradas':registradas,'pendientes':pendientes,'detalle':detalle}


def trabajador(stop):
    while not stop.is_set():
        try:
            sincronizar_pendientes(stop=stop)
        except Exception:
            logger.exception('Error al sincronizar históricos pendientes')
        stop.wait(3600)


if __name__ == '__main__':
    import argparse,json
    parser=argparse.ArgumentParser(description='Consulta o sincroniza emergencias cerradas con el histórico.')
    parser.add_argument('--sincronizar',action='store_true')
    parser.add_argument('--id',type=int)
    args=parser.parse_args()
    result = registrar_emergencia(args.id) if args.id is not None else sincronizar_pendientes() if args.sincronizar else resumen()
    print(json.dumps(result,ensure_ascii=False,default=str,indent=2))
