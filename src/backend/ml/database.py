"""Acceso PostgreSQL para entrenamiento y persistencia de predicciones ML.

Usa las tablas del esquema `emergencia`; el histórico de PostgreSQL es la
fuente de datos para entrenar, no el Excel local.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import pandas as pd
from psycopg.types.json import Jsonb

from database.database import obtener_conexion


def cargar_base_datos() -> pd.DataFrame:
    """Carga el histórico de PostgreSQL con los nombres esperados por features.py."""
    sql = """
        SELECT
            rh.fecha AS fecha,
            COALESCE(rh.dia_semana, (EXTRACT(ISODOW FROM rh.fecha)::int - 1)) AS dia_semana,
            COALESCE(rh.mes, EXTRACT(MONTH FROM rh.fecha)::int) AS mes,
            rh.bloque_horario AS bloque_hora,
            rh.id_zona AS zona_id,
            rh.codigo_emergencia AS tipo_emergencia,
            rh.cantidad_emergencias,
            COALESCE(rh.recursos_utilizados, 0) AS recursos_utilizados,
            COALESCE(rh.temperatura_c, 0.0) AS temperatura_c,
            COALESCE(rh.viento_kmh, 0.0) AS viento_kmh,
            COALESCE(rh.precipitacion_mm, 0.0) AS precipitacion_mm,
            COALESCE(
                rh.timestamp_registro,
                rh.fecha::timestamp + make_interval(hours => rh.bloque_horario)
            ) AS timestamp
        FROM emergencia.registro_historico rh
        ORDER BY rh.fecha, rh.bloque_horario, rh.id_zona, rh.codigo_emergencia
    """
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute(sql)
            filas = cursor.fetchall()
            columnas = [d.name for d in cursor.description]
        if not filas:
            raise ValueError(
                "emergencia.registro_historico está vacía. Agrega registros antes de entrenar."
            )
        df = pd.DataFrame(filas, columns=columnas)
    finally:
        conexion.close()

    df["fecha"] = pd.to_datetime(df["fecha"])
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["zona_id"] = df["zona_id"].astype(str)
    df["tipo_emergencia"] = df["tipo_emergencia"].astype(str)
    for col in ("dia_semana", "mes", "bloque_hora", "cantidad_emergencias", "recursos_utilizados"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    for col in ("temperatura_c", "viento_kmh", "precipitacion_mm"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    return df


def guardar_modelo(artefacto: dict, ruta_artefacto: str, n_registros: int,
                   datos_desde, datos_hasta) -> int:
    """Registra métricas y metadatos del modelo y lo marca como modelo activo."""
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute("UPDATE emergencia.modelo_demanda SET activo = FALSE WHERE activo = TRUE")
            cursor.execute(
                """
                INSERT INTO emergencia.modelo_demanda (
                    entrenado_en, mae, baseline_mae, modelo_ganador,
                    importancia_variables, comparacion_modelos, ruta_artefacto,
                    n_registros, datos_desde, datos_hasta, activo
                )
                VALUES (
                    CURRENT_TIMESTAMP, %s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE
                )
                RETURNING id_modelo
                """,
                (
                    float(artefacto["mae"]),
                    float(artefacto["baseline_mae"]),
                    str(artefacto["modelo_ganador"]),
                    Jsonb(artefacto.get("importancia_variables", {})),
                    Jsonb(artefacto.get("comparacion_modelos", {})),
                    str(ruta_artefacto),
                    int(n_registros),
                    pd.Timestamp(datos_desde).date(),
                    pd.Timestamp(datos_hasta).date(),
                ),
            )
            id_modelo = cursor.fetchone()[0]
        conexion.commit()
        return id_modelo
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


def _normalizar_nombre(valor: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(valor).lower())


def guardar_predicciones(resultado: dict) -> dict:
    """Persiste el desglose por zona y código de emergencia en prediccion.

    Relaciona zonas primero por ID y, si los IDs del modelo no existen en la
    tabla, intenta por nombre. Si no puede relacionar una zona, falla con un
    error explícito en vez de insertar una relación incorrecta.
    """
    conexion = obtener_conexion()
    insertadas = 0
    try:
        with conexion.cursor() as cursor:
            cursor.execute("""
                SELECT id_zona, nombre_zona
                FROM emergencia.zona
                WHERE actividad = TRUE
            """)
            zonas_db = cursor.fetchall()
            por_id = {int(z[0]): (int(z[0]), z[1]) for z in zonas_db}
            por_nombre = {_normalizar_nombre(z[1]): (int(z[0]), z[1]) for z in zonas_db}

            cursor.execute("""
                SELECT id_modelo
                FROM emergencia.modelo_demanda
                WHERE activo = TRUE
                ORDER BY entrenado_en DESC
                LIMIT 1
            """)
            modelo = cursor.fetchone()
            if not modelo:
                raise ValueError("No hay un modelo activo en emergencia.modelo_demanda.")
            id_modelo = modelo[0]

            generado_en = resultado.get("generado_en")
            if generado_en:
                generado_en = datetime.fromisoformat(generado_en.replace("Z", "+00:00")).replace(tzinfo=None)
            else:
                generado_en = datetime.now()

            periodos = resultado.get("periodos", [])
            periodos_inicio = [str(p["periodo_inicio"]) for p in periodos]
            if periodos_inicio:
                # GET puede llamarse repetidamente desde el frontend: reemplazar
                # esos mismos periodos evita duplicados en cada refresco.
                cursor.execute(
                    """
                    DELETE FROM emergencia.prediccion
                    WHERE id_modelo = %s AND periodo_inicio = ANY(%s)
                    """,
                    (id_modelo, periodos_inicio),
                )

            for periodo in periodos:
                periodo_inicio = str(periodo["periodo_inicio"])
                for zona in periodo.get("zonas", []):
                    zona_id_modelo = int(zona["zona_id"])
                    zona_db = por_nombre.get(_normalizar_nombre(zona.get("nombre", "")))
                    if not zona_db:
                        zona_db = por_id.get(zona_id_modelo)
                    if not zona_db:
                        raise ValueError(
                            f"No se pudo relacionar la zona del modelo "
                            f"(id={zona_id_modelo}, nombre={zona.get('nombre')!r}) "
                            "con emergencia.zona."
                        )
                    id_zona = zona_db[0]
                    for codigo, cantidad in zona.get("desglose", {}).items():
                        cursor.execute(
                            """
                            INSERT INTO emergencia.prediccion (
                                id_modelo, id_zona, codigo_emergencia,
                                periodo_inicio, generado_en, casos_esperados
                            )
                            VALUES (%s, %s, %s, %s, %s, %s)
                            """,
                            (
                                id_modelo, id_zona, str(codigo), periodo_inicio,
                                generado_en, max(0.0, float(cantidad)),
                            ),
                        )
                        insertadas += 1
        conexion.commit()
        return {"id_modelo": id_modelo, "predicciones_guardadas": insertadas}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


def ejemplo_consulta():
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute("SELECT 1")
            return cursor.fetchone()
    finally:
        conexion.close()