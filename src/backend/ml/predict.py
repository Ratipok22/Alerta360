"""Genera la prediccion de demanda por zona/periodo/tipo a partir del
modelo entrenado, para alimentar el mapa de calor y las alertas del
frontend.
"""
import pathlib
from datetime import datetime, timedelta

import joblib
import pandas as pd

from core.tiempo import ahora_chile, con_hora_chile

from .zones import EMERGENCY_TYPES, PERIOD_HOURS, ZONES, ZONES_BY_ID

ARTIFACT_PATH = pathlib.Path(__file__).parent / "artifacts" / "demand_model.joblib"

_artifact = None


def _load_artifact():
    global _artifact
    if _artifact is None:
        if not ARTIFACT_PATH.exists():
            raise RuntimeError(
                "No se encontro el modelo entrenado. Ejecuta 'python -m ml.train_model' "
                "dentro de backend/ antes de iniciar la API."
            )
        _artifact = joblib.load(ARTIFACT_PATH)
    return _artifact


def _next_period_start(now: datetime) -> datetime:
    block = max(h for h in PERIOD_HOURS if h <= now.hour)
    return now.replace(minute=0, second=0, microsecond=0, hour=block)


def predict_demand(now: datetime | None = None, horizon: int = 4) -> dict:
    artifact = _load_artifact()
    pipeline = artifact["pipeline"]
    last_features = artifact["last_features"]
    now = con_hora_chile(now) if now else ahora_chile()
    period_start = _next_period_start(now)

    rows = []
    for step in range(horizon):
        ts = period_start + timedelta(hours=3 * step)
        for zone in ZONES:
            for tipo in EMERGENCY_TYPES:
                key = (zone.id, tipo)
                if key in last_features.index:
                    freq_hist = float(last_features.loc[key, "freq_hist_7d"])
                    demanda_hist = float(last_features.loc[key, "demanda_recursos_hist_7d"])
                else:
                    freq_hist, demanda_hist = 0.0, 0.0
                rows.append({
                    "timestamp": ts,
                    "dia_semana": ts.weekday(),
                    "mes": ts.month,
                    "bloque_hora": ts.hour,
                    "zona_id": zone.id,
                    "tipo_emergencia": tipo,
                    "freq_hist_7d": freq_hist,
                    "demanda_recursos_hist_7d": demanda_hist,
                })

    X = pd.DataFrame(rows)
    feature_cols = ["dia_semana", "mes", "bloque_hora", "zona_id", "tipo_emergencia",
                     "freq_hist_7d", "demanda_recursos_hist_7d"]
    X["demanda_esperada"] = pipeline.predict(X[feature_cols]).clip(min=0)

    periodos = []
    for ts, group in X.groupby("timestamp"):
        zonas = []
        for zona_id, zgroup in group.groupby("zona_id"):
            zone = ZONES_BY_ID[zona_id]
            lat_c, lng_c = zone.centroid
            desglose = {row.tipo_emergencia: round(float(row.demanda_esperada), 2) for row in zgroup.itertuples()}
            zonas.append({
                "zona_id": zona_id,
                "nombre": zone.nombre,
                "bounds": {
                    "lat_min": zone.lat_min, "lat_max": zone.lat_max,
                    "lng_min": zone.lng_min, "lng_max": zone.lng_max,
                },
                "centroid": {"lat": lat_c, "lng": lng_c},
                "demanda_total": round(float(zgroup["demanda_esperada"].sum()), 2),
                "desglose": desglose,
            })
        zonas.sort(key=lambda z: z["demanda_total"], reverse=True)
        periodos.append({
            "periodo_inicio": ts.isoformat(),
            "periodo_fin": (ts + timedelta(hours=3)).isoformat(),
            "zonas": zonas,
        })

    return {
        "generado_en": now.isoformat(),
        "periodos": periodos,
        # Peso real de cada variable segun el RandomForest ya entrenado
        # (feature_importances_), no un supuesto: ver ml/train_model.py.
        "importancia_variables": artifact.get("importancia_variables", {}),
    }
