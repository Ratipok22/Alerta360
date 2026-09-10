"""Entrena el modelo de prediccion de demanda por zona/periodo/tipo.

Ejecutar desde `backend/`:
    python -m ml.train_model

Genera (si no existe) el dataset historico simulado, entrena un
RandomForestRegressor simple sobre las variables de entrada definidas
(fecha/hora/dia/mes/zona/tipo + historial reciente) y guarda el pipeline
entrenado junto con las ultimas variables de historial conocidas por
zona/tipo, necesarias para predecir periodos futuros cercanos.
"""
import pathlib

import joblib
import pandas as pd
from core.tiempo import ahora_chile
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from .features import (
    FEATURE_COLUMNS,
    FEATURE_COLUMNS_CATEGORICAL,
    FEATURE_COLUMNS_NUMERIC,
    TARGET_COLUMN,
    add_rolling_features,
)
from .generate_dataset import generate

DATA_PATH = pathlib.Path(__file__).parent / "data" / "historico_emergencias.csv"
ARTIFACT_PATH = pathlib.Path(__file__).parent / "artifacts" / "demand_model.joblib"

# Nombres legibles de cada variable de entrada, para mostrar el razonamiento
# real del modelo (no un texto inventado) en el frontend.
NOMBRE_VARIABLE = {
    "dia_semana": "Día de la semana",
    "mes": "Mes del año",
    "bloque_hora": "Hora del día",
    "zona_id": "Zona geográfica",
    "tipo_emergencia": "Clave radial",
    "freq_hist_7d": "Frecuencia histórica reciente (7 días)",
    "demanda_recursos_hist_7d": "Demanda histórica de recursos (7 días)",
}


def calcular_importancia_variables(pipeline: Pipeline) -> dict:
    """Extrae, del propio RandomForest ya entrenado, cuanto pesa realmente
    cada variable de entrada en sus predicciones (no es un supuesto: se lee
    directo de `feature_importances_`, agregando las columnas one-hot de
    vuelta a su variable original)."""
    modelo = pipeline.named_steps["model"]
    prep = pipeline.named_steps["prep"]
    nombres_transformados = prep.get_feature_names_out()
    importancias = modelo.feature_importances_

    acumulado = {col: 0.0 for col in FEATURE_COLUMNS_CATEGORICAL + FEATURE_COLUMNS_NUMERIC}
    for nombre, valor in zip(nombres_transformados, importancias):
        limpio = nombre.split("__", 1)[1] if "__" in nombre else nombre
        for col in acumulado:
            if limpio == col or limpio.startswith(col + "_"):
                acumulado[col] += float(valor)
                break

    total = sum(acumulado.values()) or 1.0
    return {
        col: {"nombre": NOMBRE_VARIABLE.get(col, col), "peso_pct": round(valor / total * 100, 1)}
        for col, valor in sorted(acumulado.items(), key=lambda kv: kv[1], reverse=True)
    }


def load_or_generate_dataset() -> pd.DataFrame:
    if DATA_PATH.exists():
        return pd.read_csv(DATA_PATH, parse_dates=["fecha", "timestamp"])
    df = generate()
    DATA_PATH.parent.mkdir(exist_ok=True)
    df.to_csv(DATA_PATH, index=False)
    return df


def train() -> None:
    df = load_or_generate_dataset()
    df = add_rolling_features(df)

    X = df[FEATURE_COLUMNS]
    y = df[TARGET_COLUMN]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    preprocessor = ColumnTransformer(
        [("cat", OneHotEncoder(handle_unknown="ignore"), FEATURE_COLUMNS_CATEGORICAL)],
        remainder="passthrough",
    )
    pipeline = Pipeline([
        ("prep", preprocessor),
        ("model", RandomForestRegressor(
            n_estimators=200, max_depth=10, min_samples_leaf=3,
            random_state=42, n_jobs=-1,
        )),
    ])
    pipeline.fit(X_train, y_train)

    pred = pipeline.predict(X_test)
    mae = mean_absolute_error(y_test, pred)
    baseline_mae = mean_absolute_error(y_test, [y_train.mean()] * len(y_test))
    print(f"MAE modelo:   {mae:.4f} emergencias/periodo")
    print(f"MAE baseline: {baseline_mae:.4f} (promedio historico global)")

    importancia_variables = calcular_importancia_variables(pipeline)
    print("Importancia real de cada variable (segun el modelo entrenado):")
    for col, info in importancia_variables.items():
        print(f"  {info['nombre']}: {info['peso_pct']}%")

    last_features = (
        df.sort_values("timestamp")
        .groupby(["zona_id", "tipo_emergencia"])[["freq_hist_7d", "demanda_recursos_hist_7d"]]
        .last()
    )

    ARTIFACT_PATH.parent.mkdir(exist_ok=True)
    joblib.dump({
        "pipeline": pipeline,
        "last_features": last_features,
        "mae": mae,
        "baseline_mae": baseline_mae,
        "importancia_variables": importancia_variables,
        "trained_at": ahora_chile().isoformat(),
    }, ARTIFACT_PATH)
    print(f"Modelo guardado en {ARTIFACT_PATH}")


if __name__ == "__main__":
    train()
