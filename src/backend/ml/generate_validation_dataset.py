"""Genera un dataset historico simulado de VALIDACION, independiente del
usado para entrenar (la base de datos persistente en
`ml/data/historico_emergencias.xlsx`, ver `ml/database.py`): cubre un
periodo calendario distinto (inmediatamente anterior al de entrenamiento)
y usa una semilla aleatoria distinta, para poder verificar honestamente
que el modelo predice bien sobre datos que nunca vio durante el
entrenamiento. A diferencia del historico de entrenamiento, este dataset
de validacion NO se persiste como base de datos (no tiene sentido que
crezca con el tiempo, es solo para medir el error del modelo) -- se
genera en memoria cada vez que se corre `python -m ml.evaluate_model`.
"""
import pathlib
from datetime import timedelta

import pandas as pd

from core.tiempo import hoy_chile

from .generate_dataset import DAYS_OF_HISTORY, generate

VALIDATION_DAYS = 120
VALIDATION_SEED = 2026


def generate_validation() -> pd.DataFrame:
    entrenamiento_inicio = hoy_chile() - timedelta(days=DAYS_OF_HISTORY)
    validacion_inicio = entrenamiento_inicio - timedelta(days=VALIDATION_DAYS)
    return generate(start=validacion_inicio, days=VALIDATION_DAYS, seed=VALIDATION_SEED)


if __name__ == "__main__":
    out = pathlib.Path(__file__).parent / "data" / "historico_validacion.csv"
    out.parent.mkdir(exist_ok=True)
    df = generate_validation()
    df.to_csv(out, index=False)
    print(f"Generados {len(df)} registros de VALIDACION -> {out}")
    print(f"Periodo: {df['fecha'].min()} a {df['fecha'].max()} (no se solapa con el de entrenamiento)")
