"""Acceso PostgreSQL para entrenamiento y persistencia de predicciones ML.

Usa las tablas del esquema `emergencia`; el histórico de PostgreSQL es la
fuente de datos para entrenar, no el Excel local.
"""
from __future__ import annotations

import json
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


def guardar_predicciones(resultado: dict) -> dict:
    """Compatibilidad: todas las escrituras usan la misma implementación."""
    from .persistencia_ml import guardar
    return guardar(resultado)


def ejemplo_consulta():
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute("SELECT 1")
            return cursor.fetchone()
    finally:
        conexion.close()