"""Ingenieria de variables compartida entre entrenamiento e inferencia."""
import pandas as pd

from .zones import PERIOD_HOURS

WINDOW_PERIODS = 7 * len(PERIOD_HOURS)  # 7 dias de historial (8 bloques/dia)

FEATURE_COLUMNS_CATEGORICAL = ["dia_semana", "mes", "bloque_hora", "zona_id", "tipo_emergencia"]
# temperatura_c/viento_kmh/precipitacion_mm: condiciones climaticas del
# bloque (ver ml/weather.py) -- afectan directamente el riesgo de incendio
# forestal (10-2) y rescate vehicular (10-4), asi que se agregan como
# variables de entrada ademas de usarse para generar la tasa simulada.
FEATURE_COLUMNS_NUMERIC = [
    "freq_hist_7d", "demanda_recursos_hist_7d",
    "temperatura_c", "viento_kmh", "precipitacion_mm",
]
FEATURE_COLUMNS = FEATURE_COLUMNS_CATEGORICAL + FEATURE_COLUMNS_NUMERIC
TARGET_COLUMN = "cantidad_emergencias"


def add_rolling_features(df: pd.DataFrame) -> pd.DataFrame:
    """Agrega variables de historial reciente, sin usar informacion futura.

    - freq_hist_7d: frecuencia de emergencias del mismo tipo en la misma zona
      durante los 7 dias previos (variable "frecuencia historica de emergencias").
    - demanda_recursos_hist_7d: promedio de recursos utilizados en la zona
      (todos los tipos) durante los 7 dias previos ("demanda historica de recursos").
    """
    df = df.sort_values(["zona_id", "tipo_emergencia", "timestamp"]).copy()
    df["freq_hist_7d"] = (
        df.groupby(["zona_id", "tipo_emergencia"])["cantidad_emergencias"]
        .transform(lambda s: s.rolling(WINDOW_PERIODS, min_periods=1).sum().shift(1))
        .fillna(0)
    )

    zona_totals = (
        df.groupby(["zona_id", "timestamp"])["recursos_utilizados"].sum().reset_index()
        .sort_values(["zona_id", "timestamp"])
    )
    zona_totals["demanda_recursos_hist_7d"] = (
        zona_totals.groupby("zona_id")["recursos_utilizados"]
        .transform(lambda s: s.rolling(WINDOW_PERIODS, min_periods=1).mean().shift(1))
        .fillna(0)
    )
    df = df.merge(
        zona_totals[["zona_id", "timestamp", "demanda_recursos_hist_7d"]],
        on=["zona_id", "timestamp"], how="left",
    )
    return df
