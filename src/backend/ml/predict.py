"""Genera la prediccion de demanda por zona/periodo/tipo a partir del
modelo entrenado, para alimentar el mapa de calor y las alertas del
frontend.
"""
import pathlib
from datetime import datetime, timedelta

import joblib
import pandas as pd

from core.tiempo import ahora_chile, con_hora_chile


from .weather import clima_esperado

from .zones import PERIOD_HOURS, Zone
from database.database import obtener_conexion

def _catalogo_db():
    with obtener_conexion() as conn, conn.cursor() as cur:
        cur.execute("""SELECT id_zona, nombre_zona,
                       latitud_minima, latitud_maxima,
                       longitud_minima, longitud_maxima FROM emergencia.zona
                       ORDER BY id_zona""")
        zonas = []
        codigos = {}
        for ident, nombre, latmin, latmax, lngmin, lngmax in cur.fetchall():
            codigos[str(ident)] = str(ident)
            if None in (latmin, latmax, lngmin, lngmax):
                raise ValueError(f"La zona {ident} ({nombre}) no tiene límites geográficos completos.")
            zonas.append(Zone(str(ident), nombre, float(latmin), float(latmax),
                              float(lngmin), float(lngmax), 1.0, {}))
        cur.execute("SELECT codigo_emergencia FROM emergencia.tipo_emergencia ORDER BY codigo_emergencia")
        tipos = [row[0] for row in cur.fetchall() if row[0] != "10-12"]
    if not zonas or not tipos:
        raise ValueError("Se necesitan zonas con coordenadas y tipos de emergencia en PostgreSQL.")
    return zonas, tipos, codigos

ARTIFACT_PATH = pathlib.Path(__file__).parent / "artifacts" / "demand_model.joblib"

_artifact = None
_artifact_mtime_ns = None


def _load_artifact():
    global _artifact, _artifact_mtime_ns
    if not ARTIFACT_PATH.exists():
        raise RuntimeError(
            "No se encontro el modelo entrenado. Ejecuta 'python -m ml.train_model' "
            "dentro de backend/ antes de iniciar la API."
        )
    # Un entrenamiento nuevo cambia la version del modelo activo en BD.
    # Recargar el .joblib sin requerir reiniciar la API.
    sello = ARTIFACT_PATH.stat().st_mtime_ns
    if _artifact is None or sello != _artifact_mtime_ns:
        _artifact = joblib.load(ARTIFACT_PATH)
        _artifact_mtime_ns = sello
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

    zonas_db, tipos_db, codigos_zonas = _catalogo_db()
    # Nunca predecir sectores/tipos sin registros de entrenamiento. La BD
    # puede contener zonas operativas adicionales sin historico propio.
    zonas_entrenadas = set(last_features.index.get_level_values('zona_id').astype(str))
    tipos_entrenados = set(last_features.index.get_level_values('tipo_emergencia').astype(str))
    zonas_db = [z for z in zonas_db if z.id in zonas_entrenadas]
    tipos_db = [t for t in tipos_db if t in tipos_entrenados]
    if not zonas_db or not tipos_db:
        raise ValueError('No hay zonas/tipos del modelo que coincidan con PostgreSQL; reentrena el modelo.')
    zonas_por_id = {z.id: z for z in zonas_db}
    rows = []
    for step in range(horizon):
        ts = period_start + timedelta(hours=3 * step)
        for zone in zonas_db:

            # Sin pronostico meteorologico real integrado, se asume el clima
            # "normal" esperado para esa epoca del anio y bloque horario en
            # esa zona (normal climatica, sin ruido diario): ver ml/weather.py.
            clima = clima_esperado(ts.month, ts.hour, codigos_zonas[zone.id])

            for tipo in tipos_db:
                key = (str(zone.id), tipo)
                if key not in last_features.index:
                    continue
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

                    "temperatura_c": clima["temperatura_c"],
                    "viento_kmh": clima["viento_kmh"],
                    "precipitacion_mm": clima["precipitacion_mm"],

                })

    X = pd.DataFrame(rows)
    # En entrenamiento, zona_id se normaliza como texto desde PostgreSQL.
    # Mantener el mismo tipo evita incompatibilidades con OneHotEncoder.
    X["zona_id"] = X["zona_id"].astype(str)
    feature_cols = ["dia_semana", "mes", "bloque_hora", "zona_id", "tipo_emergencia",

                     "freq_hist_7d", "demanda_recursos_hist_7d",
                     "temperatura_c", "viento_kmh", "precipitacion_mm"]

    X["demanda_esperada"] = pipeline.predict(X[feature_cols]).clip(min=0)

    periodos = []
    for ts, group in X.groupby("timestamp"):
        zonas = []
        for zona_id, zgroup in group.groupby("zona_id"):
            zone = zonas_por_id[zona_id]
            lat_c, lng_c = zone.centroid
            desglose = {row.tipo_emergencia: round(float(row.demanda_esperada), 2) for row in zgroup.itertuples()}

            primera_fila = zgroup.iloc[0]

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

                # Clima esperado (normal climatica del mes/hora, sin
                # pronostico real -- ver ml/weather.py) usado como input del
                # modelo para esta zona y periodo.
                "clima_esperado": {
                    "temperatura_c": float(primera_fila["temperatura_c"]),
                    "viento_kmh": float(primera_fila["viento_kmh"]),
                    "precipitacion_mm": float(primera_fila["precipitacion_mm"]),
                },

            })
        zonas.sort(key=lambda z: z["demanda_total"], reverse=True)
        periodos.append({
            "periodo_inicio": ts.isoformat(),
            "periodo_fin": (ts + timedelta(hours=3)).isoformat(),
            "zonas": zonas,
        })

    return {
        "id_modelo": int(artifact["id_modelo"]),
        "generado_en": now.isoformat(),
        "periodos": periodos,
        # Peso real de cada variable segun el RandomForest ya entrenado
        # (feature_importances_), no un supuesto: ver ml/train_model.py.
        "importancia_variables": artifact.get("importancia_variables", {}),
    }
