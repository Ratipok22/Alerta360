"""Evalua el modelo entrenado contra el dataset de VALIDACION (datos que el
modelo nunca vio durante el entrenamiento), reportando el error de
prediccion y una 'exactitud de nivel de riesgo' facil de interpretar.

Ejecutar desde `backend/`:
    python -m ml.evaluate_model
"""
import pathlib

import joblib
import numpy as np
from sklearn.metrics import mean_absolute_error, mean_squared_error

from .features import FEATURE_COLUMNS, TARGET_COLUMN, add_rolling_features
from .generate_validation_dataset import generate_validation

ARTIFACT_PATH = pathlib.Path(__file__).parent / "artifacts" / "demand_model.joblib"

# Mismos umbrales usados para colorear el mapa de calor (verde/amarillo/rojo)
UMBRAL_MEDIA = 0.8
UMBRAL_ALTA = 1.8


def nivel(valor: float) -> str:
    if valor < UMBRAL_MEDIA:
        return "Baja"
    if valor < UMBRAL_ALTA:
        return "Media"
    return "Alta"


def evaluate() -> dict:
    if not ARTIFACT_PATH.exists():
        raise RuntimeError("No se encontro el modelo entrenado. Ejecuta 'python -m ml.train_model' primero.")
    artifact = joblib.load(ARTIFACT_PATH)
    pipeline = artifact["pipeline"]
    artefacto_id = artifact.get('id_modelo')

    if artifact.get("modelo_ganador"):
        print(f"Familia de modelo en produccion: {artifact['modelo_ganador']}")
        for nombre, info in artifact.get("comparacion_modelos", {}).items():
            marca = " <- elegido" if nombre == artifact["modelo_ganador"] else ""
            print(f"  {nombre}: MAE holdout interno {info['mae_holdout']}{marca}")
        print()

    df = generate_validation()
    # El Excel usa codigos VAL-CEN / VIN-REN; el modelo entrenado desde BD
    # usa los id_zona numericos. La validacion DEBE usar el mismo vocabulario.
    from database.database import obtener_conexion
    with obtener_conexion() as conexion, conexion.cursor() as cur:
        cur.execute('SELECT codigo_zona,id_zona FROM emergencia.zona WHERE codigo_zona IS NOT NULL')
        mapa_zonas = {str(codigo):str(id_zona) for codigo,id_zona in cur.fetchall()}
    if not set(df['zona_id']).issubset(mapa_zonas):
        raise ValueError('Hay zonas de validacion sin equivalencia en PostgreSQL')
    df['zona_id'] = df['zona_id'].map(mapa_zonas)
    df = add_rolling_features(df)

    X = df[FEATURE_COLUMNS]
    y_real = df[TARGET_COLUMN]
    y_pred = np.clip(pipeline.predict(X), 0, None)

    mae = mean_absolute_error(y_real, y_pred)
    rmse = mean_squared_error(y_real, y_pred) ** 0.5
    baseline_mae = mean_absolute_error(y_real, np.full(len(y_real), y_real.mean()))
    mejora_pct = (1 - mae / baseline_mae) * 100 if baseline_mae else 0.0

    # Exactitud de nivel de riesgo: se agrega por zona+periodo (sumando las
    # claves, igual que el mapa de calor) y se compara el nivel Baja/Media/Alta
    # real vs. el predicho -- es la version "legible" de que tan buena es la
    # prediccion, ya que es literalmente lo que el usuario ve en el mapa.
    df["y_real"] = y_real
    df["y_pred"] = y_pred
    agregado = (
        df.groupby(["zona_id", "timestamp"])
        .agg(demanda_real=("y_real", "sum"), demanda_pred=("y_pred", "sum"))
        .reset_index()
    )
    agregado["nivel_real"] = agregado["demanda_real"].apply(nivel)
    agregado["nivel_pred"] = agregado["demanda_pred"].apply(nivel)
    exactitud_nivel_pct = (agregado["nivel_real"] == agregado["nivel_pred"]).mean() * 100

    resultado = {
        "registros_validacion": len(df),
        "combinaciones_zona_periodo": len(agregado),
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "baseline_mae": round(baseline_mae, 4),
        "mejora_vs_baseline_pct": round(mejora_pct, 1),
        "exactitud_nivel_riesgo_pct": round(exactitud_nivel_pct, 1),
    }

    # Almacenar las metricas externas en PostgreSQL asociadas a ESTA version.
    from .persistencia_ml import guardar_validacion
    if not artefacto_id:
        raise RuntimeError('El artefacto no contiene id_modelo. Reentrena desde PostgreSQL.')
    guardar_validacion(artefacto_id, resultado)
    print(f"Evaluacion independiente guardada en PostgreSQL, id_modelo={artefacto_id}")

    print(f"Registros de validacion (zona x periodo x clave): {resultado['registros_validacion']}")
    print(f"Periodo de validacion: {df['fecha'].min()} a {df['fecha'].max()} (no visto en entrenamiento)")
    print(f"MAE modelo:         {resultado['mae']} emergencias/periodo")
    print(f"RMSE modelo:        {resultado['rmse']}")
    print(f"MAE baseline:       {resultado['baseline_mae']} (promedio historico global)")
    print(f"Mejora vs. baseline: {resultado['mejora_vs_baseline_pct']}%")
    print(
        f"Exactitud de nivel de riesgo (Baja/Media/Alta) por zona+periodo: "
        f"{resultado['exactitud_nivel_riesgo_pct']}% "
        f"(sobre {resultado['combinaciones_zona_periodo']} combinaciones zona-periodo)"
    )
    return resultado


if __name__ == "__main__":
    evaluate()
