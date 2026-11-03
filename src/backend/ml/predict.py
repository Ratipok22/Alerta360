"""Genera la prediccion de demanda por zona/periodo/tipo a partir del
modelo entrenado, para alimentar el mapa de calor y las alertas del
frontend.
"""
import pathlib
from datetime import datetime, timedelta

import joblib
import pandas as pd

from core.tiempo import ahora_chile, con_hora_chile


from . import entradas_prediccion_db

from .contratos import PERIOD_HOURS, Zone
from .db_catalog import obtener_zonas, obtener_tipos
from database.database import obtener_conexion

def _catalogo_db():
    zonas=[]
    for row in obtener_zonas():
        bounds=row['bounds']
        values=[bounds[k] for k in ('lat_min','lat_max','lng_min','lng_max')]
        if any(v is None for v in values):
            raise ValueError(f"La zona {row['zona_id']} no tiene límites completos.")
        zonas.append(Zone(row['zona_id'],row['nombre'],*map(float,values)))
    tipos=[t['codigo'] for t in obtener_tipos() if t['codigo'] != '10-12']
    if not zonas or not tipos:
        raise ValueError('Faltan zonas o tipos en PostgreSQL.')
    return zonas,tipos,{z.id:z.id for z in zonas}

ARTIFACT_PATH = pathlib.Path(__file__).parent / "artifacts" / "demand_model.joblib"

_artifact = None
_artifact_mtime_ns = None


def _load_artifact(modelo=None):
    global _artifact, _artifact_mtime_ns
    modelo = modelo or entradas_prediccion_db.modelo_activo()
    ruta = pathlib.Path(modelo['ruta_artefacto'])
    if not ruta.is_absolute():
        ruta = pathlib.Path(__file__).resolve().parents[1] / ruta
    if not ruta.is_file():
        raise RuntimeError('No existe el archivo indicado en modelo_demanda.ruta_artefacto.')
    sello = (modelo['id_modelo'],str(ruta.resolve()),ruta.stat().st_mtime_ns)
    if _artifact is None or _artifact_mtime_ns != sello:
        artifact = joblib.load(ruta)
        if int(artifact.get('id_modelo',-1)) != int(modelo['id_modelo']):
            raise RuntimeError('El archivo del modelo no coincide con el modelo activo de PostgreSQL.')
        _artifact, _artifact_mtime_ns = artifact, sello
    return _artifact


def _next_period_start(now: datetime) -> datetime:
    block = max(h for h in PERIOD_HOURS if h <= now.hour)
    return now.replace(minute=0, second=0, microsecond=0, hour=block)


def predict_demand(now: datetime | None = None, horizon: int = 4) -> dict:
    modelo = entradas_prediccion_db.modelo_activo()
    contexto = modelo["entradas"]
    artifact = _load_artifact(modelo)
    pipeline = artifact["pipeline"]
    last_features = entradas_prediccion_db.historico(contexto)
    now = con_hora_chile(now) if now else ahora_chile()
    period_start = _next_period_start(now)

    zonas_db, tipos_db, codigos_zonas = _catalogo_db()
    # Nunca predecir sectores/tipos sin registros de entrenamiento. La BD
    # puede contener zonas operativas adicionales sin historico propio.
    zonas_entrenadas = {z for z,t in last_features}
    tipos_entrenados = {t for z,t in last_features}
    zonas_db = [z for z in zonas_db if z.id in zonas_entrenadas]
    tipos_db = [t for t in tipos_db if t in tipos_entrenados]
    if not zonas_db or not tipos_db:
        raise ValueError('No hay zonas/tipos del modelo que coincidan con PostgreSQL; reentrena el modelo.')
    zonas_por_id = {z.id: z for z in zonas_db}
    rows = []
    for step in range(horizon):
        ts = period_start + timedelta(hours=3 * step)
        for zone in zonas_db:

            # Perfil climático del modelo leído de PostgreSQL, no de constantes locales.
            clima = entradas_prediccion_db.clima(contexto, zone.id, ts.month, ts.hour)

            for tipo in tipos_db:
                key = (str(zone.id), tipo)
                if key not in last_features:
                    continue
                freq_hist = float(last_features[key]["freq_hist_7d"])
                demanda_hist = float(last_features[key]["demanda_recursos_hist_7d"])
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
                "demanda_total": round(sum(desglose.values()), 2),
                "desglose": desglose,

                # Perfil climático calculado desde registro_historico.
                "fuente_clima": contexto.get("fuente_clima"),
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
        # Importancia registrada para el modelo activo en PostgreSQL.
        "importancia_variables": modelo.get("importancia_variables") or {},
        "contexto_huella": entradas_prediccion_db.huella(contexto),
        "fuente_clima": contexto.get("fuente_clima"),
    }
