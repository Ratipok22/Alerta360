"""Predicciones para el ER actual: IDs de zona y períodos de tipo texto.

No requiere tablas ni columnas adicionales. Los límites y nombres se leen
de zona; el fin del bloque y el clima estimado se reconstruyen en la API.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from core.tiempo import ahora_chile
from database.database import obtener_conexion
from .predict import predict_demand, _next_period_start, _load_artifact, _catalogo_db
from .weather import clima_esperado

TZ = ZoneInfo('America/Santiago')
VALIDACION_KEY = '_evaluacion_independiente'
MODELO_COLUMNS = '''id_modelo, entrenado_en, modelo_ganador, mae,
    baseline_mae, n_registros, datos_desde, datos_hasta, activo,
    comparacion_modelos, importancia_variables'''


def local_naive(valor: str | datetime) -> datetime:
    dt = datetime.fromisoformat(valor.replace('Z', '+00:00')) if isinstance(valor, str) else valor
    return dt.astimezone(TZ).replace(tzinfo=None) if dt.tzinfo else dt


def periodo_texto(valor: str | datetime) -> str:
    """Formato canónico para la columna VARCHAR(50), con offset de Chile."""
    return local_naive(valor).replace(tzinfo=TZ).isoformat(timespec='seconds')


def _intervalos(now: datetime, horizon: int) -> list[datetime]:
    base = _next_period_start(now)
    return [local_naive(base + timedelta(hours=3 * step)) for step in range(horizon)]


def _modelo(row: dict) -> dict:
    resultado = dict(row)
    for campo in ('entrenado_en', 'datos_desde', 'datos_hasta'):
        resultado[campo] = row[campo].isoformat() if row[campo] else None
    comparacion = dict(row['comparacion_modelos'] or {})
    resultado['evaluacion_independiente'] = comparacion.pop(VALIDACION_KEY, None)
    resultado['comparacion_modelos'] = comparacion
    resultado['importancia_variables'] = row['importancia_variables'] or {}
    return resultado


def _pares_esperados(artefacto: dict) -> set[tuple[str, str]]:
    zonas, tipos, _ = _catalogo_db()
    zids = {z.id for z in zonas}
    tipos = set(tipos)
    return {(str(z), str(t)) for z, t in artefacto['last_features'].index
            if str(z) in zids and str(t) in tipos}


def guardar(resultado: dict) -> dict:
    # El ID viaja con el resultado para no atribuir a otro modelo un cálculo
    # que estaba en curso durante un reentrenamiento.
    id_modelo = int(resultado['id_modelo'])
    periodos = resultado.get('periodos', [])
    if not periodos:
        raise ValueError('No hay períodos que guardar.')
    inicios = [periodo_texto(p['periodo_inicio']) for p in periodos]
    if len(set(inicios)) != len(inicios):
        raise ValueError('Hay períodos duplicados en la predicción.')
    generado = local_naive(ahora_chile())
    filas = []
    claves = set()
    for periodo, inicio in zip(periodos, inicios):
        for zona in periodo['zonas']:
            zid = str(zona['zona_id'])
            for tipo, cantidad in zona['desglose'].items():
                casos = float(cantidad)
                if not math.isfinite(casos) or casos < 0:
                    raise ValueError('La demanda debe ser finita y no negativa.')
                clave = (inicio, zid, str(tipo))
                if clave in claves:
                    raise ValueError('Hay zonas/tipos duplicados en la predicción.')
                claves.add(clave)
                filas.append((id_modelo, zid, str(tipo), inicio, generado, casos))
    if not filas:
        raise ValueError('No hay predicciones que guardar.')
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cur:
            cur.execute('SELECT pg_advisory_xact_lock(735360, %s)', (id_modelo,))
            cur.execute('''SELECT id_modelo FROM emergencia.modelo_demanda
                           WHERE activo=TRUE ORDER BY entrenado_en DESC, id_modelo DESC
                           LIMIT 1 FOR SHARE''')
            activo = cur.fetchone()
            if not activo or int(activo[0]) != id_modelo:
                raise RuntimeError('El modelo activo cambió. Vuelve a solicitar la predicción.')
            cur.execute('''DELETE FROM emergencia.prediccion
                           WHERE id_modelo=%s AND periodo_inicio=ANY(%s::varchar[])''',
                        (id_modelo, inicios))
            cur.executemany('''INSERT INTO emergencia.prediccion
                (id_modelo,id_zona,codigo_emergencia,periodo_inicio,generado_en,casos_esperados)
                VALUES (%s,%s,%s,%s,%s,%s)''', filas)
        conexion.commit()
        return {'id_modelo': id_modelo, 'predicciones_guardadas': len(filas)}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


def leer(inicios: list[datetime], max_edad_min: int = 30) -> dict | None:
    if not inicios:
        return None
    artefacto = _load_artifact()
    esperados = _pares_esperados(artefacto)
    if not esperados:
        raise ValueError('No hay zonas/tipos entrenados que coincidan con PostgreSQL.')
    conexion = obtener_conexion()
    try:
        with conexion.cursor(row_factory=dict_row) as cur:
            cur.execute(f'''SELECT {MODELO_COLUMNS} FROM emergencia.modelo_demanda
                WHERE activo=TRUE ORDER BY entrenado_en DESC, id_modelo DESC LIMIT 1''')
            modelo = cur.fetchone()
            if modelo is None:
                raise ValueError('No hay modelo activo; ejecuta python -m ml.train_model.')
            if int(artefacto.get('id_modelo', -1)) != modelo['id_modelo']:
                raise RuntimeError('El archivo joblib no coincide con el modelo activo de PostgreSQL.')
            cur.execute('''SELECT p.periodo_inicio,p.generado_en,z.id_zona,z.nombre_zona,
                z.latitud_minima,z.latitud_maxima,z.longitud_minima,z.longitud_maxima,
                p.codigo_emergencia,p.casos_esperados
                FROM emergencia.prediccion p
                JOIN emergencia.zona z ON z.id_zona=p.id_zona
                WHERE p.id_modelo=%s AND p.periodo_inicio=ANY(%s::varchar[])
                ORDER BY p.periodo_inicio,z.id_zona,p.codigo_emergencia''',
                (modelo['id_modelo'], [periodo_texto(i) for i in inicios]))
            filas = cur.fetchall()
    finally:
        conexion.close()
    if not filas:
        return None
    grupos = {}
    pares = {}
    fechas = []
    for fila in filas:
        inicio = local_naive(fila['periodo_inicio'])
        zid, tipo = str(fila['id_zona']), str(fila['codigo_emergencia'])
        vistos = pares.setdefault(inicio, set())
        if (zid, tipo) in vistos:
            return None
        vistos.add((zid, tipo))
        casos = fila['casos_esperados']
        if casos is None or not math.isfinite(casos) or casos < 0 or fila['generado_en'] is None:
            return None
        fechas.append(local_naive(fila['generado_en']))
        zonas = grupos.setdefault(inicio, {})
        if zid not in zonas:
            latmin, latmax = float(fila['latitud_minima']), float(fila['latitud_maxima'])
            lngmin, lngmax = float(fila['longitud_minima']), float(fila['longitud_maxima'])
            zonas[zid] = {
                'zona_id': zid, 'nombre': fila['nombre_zona'],
                'bounds': {'lat_min':latmin,'lat_max':latmax,'lng_min':lngmin,'lng_max':lngmax},
                'centroid': {'lat':(latmin+latmax)/2,'lng':(lngmin+lngmax)/2},
                'demanda_total':0.0, 'desglose':{},
                'clima_esperado':clima_esperado(inicio.month, inicio.hour, zid),
            }
        zonas[zid]['desglose'][tipo] = round(float(casos), 2)
        zonas[zid]['demanda_total'] += float(casos)
    if set(grupos) != {local_naive(i) for i in inicios} or any(p != esperados for p in pares.values()):
        return None
    ahora = local_naive(ahora_chile())
    if any(not 0 <= (ahora - f).total_seconds() <= max_edad_min * 60 for f in fechas):
        return None
    periodos = []
    for inicio in sorted(grupos):
        zonas = list(grupos[inicio].values())
        for zona in zonas:
            zona['demanda_total'] = round(zona['demanda_total'], 2)
        zonas.sort(key=lambda z:z['demanda_total'], reverse=True)
        periodos.append({'periodo_inicio':periodo_texto(inicio),
                         'periodo_fin':periodo_texto(inicio + timedelta(hours=3)),
                         'zonas':zonas})
    return {'generado_en':periodo_texto(max(fechas)), 'periodos':periodos,
            'importancia_variables':modelo['importancia_variables'] or {},
            'modelo':_modelo(modelo),
            'persistencia':{'id_modelo':modelo['id_modelo'], 'origen':'postgresql'}}


def obtener_o_generar(now: datetime | None = None, horizon: int = 4, recalcular: bool = False) -> dict:
    if not 1 <= horizon <= 8:
        raise ValueError('horizon debe estar entre 1 y 8 bloques (3 a 24 horas).')
    now = local_naive(now or ahora_chile()).replace(tzinfo=TZ)
    inicios = _intervalos(now, horizon)
    if not recalcular:
        resultado = leer(inicios)
        if resultado is not None:
            return resultado
    persistencia = guardar(predict_demand(now=now, horizon=horizon))
    resultado = leer(inicios, max_edad_min=60)
    if resultado is None:
        raise RuntimeError('No se pudo recuperar una predicción completa de PostgreSQL.')
    resultado['persistencia'].update(persistencia)
    resultado['persistencia']['origen'] = 'calculado_y_guardado_en_postgresql'
    return resultado


def listado_modelos(limite: int = 10) -> list[dict]:
    conexion = obtener_conexion()
    try:
        with conexion.cursor(row_factory=dict_row) as cur:
            cur.execute(f'''SELECT {MODELO_COLUMNS} FROM emergencia.modelo_demanda
                ORDER BY entrenado_en DESC, id_modelo DESC LIMIT %s''',
                (max(1, min(int(limite), 50)),))
            return [_modelo(row) for row in cur.fetchall()]
    finally:
        conexion.close()


def guardar_validacion(id_modelo: int, resultado: dict):
    """Usa el JSONB existente; no agrega una columna al ER."""
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cur:
            cur.execute('''UPDATE emergencia.modelo_demanda
                SET comparacion_modelos=COALESCE(comparacion_modelos,'{}'::jsonb) || %s
                WHERE id_modelo=%s''', (Jsonb({VALIDACION_KEY:resultado}), id_modelo))
            if cur.rowcount != 1:
                raise ValueError(f'No existe modelo_demanda #{id_modelo}')
        conexion.commit()
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()
