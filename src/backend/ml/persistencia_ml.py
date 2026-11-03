"""Predicciones para el ER actual: IDs de zona y períodos de tipo texto.

Los límites y nombres se leen de zona; el clima usado en el cálculo se
calcula desde registro_historico en cada solicitud.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from core.tiempo import ahora_chile
from database.database import obtener_conexion
from .predict import predict_demand, _next_period_start, _catalogo_db
from . import entradas_prediccion_db

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


def _pares_esperados(contexto: dict) -> set[tuple[str, str]]:
    zonas, tipos, _ = _catalogo_db()
    zids = {z.id for z in zonas}
    tipos = set(tipos)
    return {(str(z), str(t)) for z, t in entradas_prediccion_db.historico(contexto)
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
    if not resultado.get('contexto_huella'):
        raise ValueError('Falta la huella del contexto utilizado para predecir.')
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
                clima = zona.get('clima_esperado')
                if not clima or any(not math.isfinite(float(clima[k])) for k in ('temperatura_c','viento_kmh','precipitacion_mm')):
                    raise ValueError('Falta el clima utilizado por la predicción.')
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
    # Sin guardar la procedencia climática no se puede certificar que una
    # predicción anterior corresponde al histórico actual. Recalcular siempre.
    return None


def obtener_o_generar(now: datetime | None = None, horizon: int = 4, recalcular: bool = False) -> dict:
    if not 1 <= horizon <= 8:
        raise ValueError('horizon debe estar entre 1 y 8 bloques (3 a 24 horas).')
    now = local_naive(now or ahora_chile()).replace(tzinfo=TZ)
    resultado = predict_demand(now=now, horizon=horizon)
    persistencia = guardar(resultado)
    with obtener_conexion() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(f'SELECT {MODELO_COLUMNS} FROM emergencia.modelo_demanda WHERE id_modelo=%s',
                    (resultado['id_modelo'],))
        modelo=cur.fetchone()
    if modelo is None:
        raise RuntimeError('No se encuentra el modelo de la predicción calculada.')
    resultado['modelo']=_modelo(modelo)
    resultado['persistencia']={**persistencia,'origen':'calculado_y_guardado_en_postgresql'}
    # El mapa recibe exactamente el clima usado, no uno reconstruido después.
    resultado.pop('contexto_huella',None)
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
