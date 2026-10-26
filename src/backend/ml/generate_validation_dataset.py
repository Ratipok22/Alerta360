"""Validacion independiente sintetica, sin solapamiento con el historico importado.

Usa una semilla distinta y las fechas anteriores al primer registro historico
que participa en el entrenamiento. No inserta estas filas de validacion en BD.
"""
import pathlib
from datetime import timedelta

import pandas as pd

from core.tiempo import hoy_chile

from .generate_dataset import DAYS_OF_HISTORY, generate

VALIDATION_DAYS = 120
VALIDATION_SEED = 2026


def generate_validation() -> pd.DataFrame:
    from database.database import obtener_conexion
    with obtener_conexion() as conexion, conexion.cursor() as cur:
        cur.execute('SELECT MIN(fecha) FROM emergencia.registro_historico')
        fila = cur.fetchone()
    if not fila or fila[0] is None:
        raise ValueError('Sin historico en PostgreSQL para definir periodo independiente de validacion')
    entrenamiento_inicio = fila[0]
    validacion_inicio = entrenamiento_inicio - timedelta(days=VALIDATION_DAYS)
    return generate(start=validacion_inicio, days=VALIDATION_DAYS, seed=VALIDATION_SEED)


if __name__ == "__main__":
    out = pathlib.Path(__file__).parent / "data" / "historico_validacion.csv"
    out.parent.mkdir(exist_ok=True)
    df = generate_validation()
    df.to_csv(out, index=False)
    print(f"Generados {len(df)} registros de VALIDACION -> {out}")
    print(f"Periodo: {df['fecha'].min()} a {df['fecha'].max()} (no se solapa con el de entrenamiento)")
