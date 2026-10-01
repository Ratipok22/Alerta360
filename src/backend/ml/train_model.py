"""Entrena el modelo de prediccion de demanda por zona/periodo/tipo.

Ejecutar desde `backend/`:
    python -m ml.train_model

A diferencia de una version anterior mas simple (un solo RandomForest con
hiperparametros fijos), este script:

1. Prueba varias familias de modelo (RandomForest, ExtraTrees, Gradient
   Boosting y una regresion lineal Ridge como referencia/baseline).
2. Para cada familia, busca los mejores hiperparametros con
   RandomizedSearchCV + validacion cruzada (K-Fold), no un valor fijo
   elegido a mano.
3. Compara a todas las familias en un conjunto interno separado (que no
   participo ni en la busqueda de hiperparametros ni en el entrenamiento
   final) y se queda con la que tenga menor error real.
4. Vuelve a entrenar la familia ganadora usando TODOS los datos
   disponibles para el modelo que finalmente se guarda y sirve en
   produccion (practica estandar: la validacion cruzada sirve para elegir,
   el modelo final se entrena con todo el historico).
5. Calcula la importancia de cada variable de entrada con "permutation
   importance": mide cuanto empeora el error real del modelo al revolver
   (permutar) cada variable una por una. A diferencia de la impureza de un
   arbol (que sesga hacia variables con muchas categorias), este metodo
   funciona igual sin importar que familia de modelo haya ganado.
"""
import pathlib

import joblib
import numpy as np
import pandas as pd
from core.tiempo import ahora_chile
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import ExtraTreesRegressor, GradientBoostingRegressor, RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.model_selection import KFold, RandomizedSearchCV, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from .features import (
    FEATURE_COLUMNS,
    FEATURE_COLUMNS_CATEGORICAL,
    TARGET_COLUMN,
    add_rolling_features,
)
from .generate_dataset import generate

DATA_PATH = pathlib.Path(__file__).parent / "data" / "historico_emergencias.csv"
ARTIFACT_PATH = pathlib.Path(__file__).parent / "artifacts" / "demand_model.joblib"

RNG_SEED = 42
# La busqueda de hiperparametros corre sobre una muestra (no el historico
# completo) para que probar varias familias de modelo sea rapido; el modelo
# ganador igual se re-entrena al final con TODOS los datos disponibles.
SEARCH_SAMPLE_SIZE = 30_000
PERMUTATION_SAMPLE_SIZE = 6_000

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


def build_preprocessor() -> ColumnTransformer:
    return ColumnTransformer(
        [("cat", OneHotEncoder(handle_unknown="ignore"), FEATURE_COLUMNS_CATEGORICAL)],
        remainder="passthrough",
    )


# Candidatos a comparar: (nombre legible, estimador base, grilla de
# hiperparametros a explorar). Todas las familias de arbol/ensamble
# comparten el mismo preprocesador (one-hot + passthrough).
CANDIDATOS = {
    "RandomForest": (
        RandomForestRegressor(random_state=RNG_SEED, n_jobs=-1),
        {
            "model__n_estimators": [150, 250, 350],
            "model__max_depth": [8, 12, 16, None],
            "model__min_samples_leaf": [1, 2, 3, 5],
        },
    ),
    "ExtraTrees": (
        ExtraTreesRegressor(random_state=RNG_SEED, n_jobs=-1),
        {
            "model__n_estimators": [150, 250, 350],
            "model__max_depth": [8, 12, 16, None],
            "model__min_samples_leaf": [1, 2, 3, 5],
        },
    ),
    "GradientBoosting": (
        GradientBoostingRegressor(random_state=RNG_SEED),
        {
            "model__n_estimators": [100, 200, 300],
            "model__max_depth": [2, 3, 4],
            "model__learning_rate": [0.03, 0.05, 0.1],
        },
    ),
    "Ridge (referencia lineal)": (
        Ridge(random_state=RNG_SEED),
        {
            "model__alpha": [0.1, 1.0, 5.0, 10.0],
        },
    ),
}


def calcular_importancia_variables(pipeline: Pipeline, X_eval: pd.DataFrame, y_eval: pd.Series) -> dict:
    """Peso real de cada variable de entrada, medido con permutation
    importance sobre datos que el modelo no uso para entrenar: cuanto
    empeora su error al revolver cada variable, una por una. No depende de
    que familia de modelo haya ganado (a diferencia de leer directamente
    `feature_importances_`, que solo existe en modelos de arbol y que
    ademas sesga hacia variables con muchas categorias)."""
    n = min(PERMUTATION_SAMPLE_SIZE, len(X_eval))
    muestra = X_eval.sample(n=n, random_state=RNG_SEED)
    y_muestra = y_eval.loc[muestra.index]

    resultado = permutation_importance(
        pipeline, muestra, y_muestra,
        n_repeats=8, random_state=RNG_SEED, n_jobs=-1,
        scoring="neg_mean_absolute_error",
    )
    pesos = {col: max(float(val), 0.0) for col, val in zip(X_eval.columns, resultado.importances_mean)}
    total = sum(pesos.values()) or 1.0
    return {
        col: {"nombre": NOMBRE_VARIABLE.get(col, col), "peso_pct": round(valor / total * 100, 1)}
        for col, valor in sorted(pesos.items(), key=lambda kv: kv[1], reverse=True)
    }


def load_or_generate_dataset() -> pd.DataFrame:
    if DATA_PATH.exists():
        return pd.read_csv(DATA_PATH, parse_dates=["fecha", "timestamp"])
    df = generate()
    DATA_PATH.parent.mkdir(exist_ok=True)
    df.to_csv(DATA_PATH, index=False)
    return df


def _buscar_mejor_config(nombre: str, estimador, grilla: dict, X_search: pd.DataFrame, y_search: pd.Series) -> dict:
    """RandomizedSearchCV + K-Fold sobre una muestra del historico, para
    encontrar buenos hiperparametros de esta familia de modelo sin tener
    que probar la grilla completa a mano ni sobre el dataset entero."""
    pipeline = Pipeline([("prep", build_preprocessor()), ("model", estimador)])
    n_iter = min(8, int(np.prod([len(v) for v in grilla.values()])))
    busqueda = RandomizedSearchCV(
        pipeline, param_distributions=grilla, n_iter=n_iter,
        cv=KFold(n_splits=3, shuffle=True, random_state=RNG_SEED),
        scoring="neg_mean_absolute_error", random_state=RNG_SEED, n_jobs=-1,
    )
    busqueda.fit(X_search, y_search)
    print(f"  [{nombre}] mejores hiperparametros: {busqueda.best_params_} "
          f"(MAE CV: {-busqueda.best_score_:.4f})")
    return busqueda.best_params_


def train() -> None:
    df = load_or_generate_dataset()
    df = add_rolling_features(df)

    X = df[FEATURE_COLUMNS]
    y = df[TARGET_COLUMN]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=RNG_SEED)

    n_search = min(SEARCH_SAMPLE_SIZE, len(X_train))
    X_search = X_train.sample(n=n_search, random_state=RNG_SEED)
    y_search = y_train.loc[X_search.index]

    print(f"Comparando {len(CANDIDATOS)} familias de modelo "
          f"(busqueda de hiperparametros sobre una muestra de {n_search} registros)...")

    resultados_por_familia = {}
    for nombre, (estimador, grilla) in CANDIDATOS.items():
        mejores_parametros = _buscar_mejor_config(nombre, estimador, grilla, X_search, y_search)

        # Re-entrena esta familia (con sus mejores hiperparametros) usando
        # TODO el set de entrenamiento, y se evalua contra el holdout interno
        # (X_test) que ninguna familia vio durante la busqueda ni el ajuste.
        pipeline = Pipeline([("prep", build_preprocessor()), ("model", clone(estimador))])
        pipeline.set_params(**mejores_parametros)
        pipeline.fit(X_train, y_train)

        pred = pipeline.predict(X_test)
        mae = mean_absolute_error(y_test, pred)
        rmse = mean_squared_error(y_test, pred) ** 0.5
        resultados_por_familia[nombre] = {
            "mae_holdout": round(float(mae), 4),
            "rmse_holdout": round(float(rmse), 4),
            "mejores_parametros": mejores_parametros,
        }
        print(f"  [{nombre}] MAE holdout interno: {mae:.4f} · RMSE: {rmse:.4f}")

    mejor_nombre = min(resultados_por_familia, key=lambda n: resultados_por_familia[n]["mae_holdout"])
    print(f"\nModelo ganador: {mejor_nombre} "
          f"(MAE holdout: {resultados_por_familia[mejor_nombre]['mae_holdout']})")

    estimador_base, _ = CANDIDATOS[mejor_nombre]
    mejores_parametros = resultados_por_familia[mejor_nombre]["mejores_parametros"]

    # Pipeline "de evaluacion": entrenado solo con X_train, para medir un MAE
    # honesto y calcular la importancia de variables sobre datos no vistos.
    pipeline_eval = Pipeline([("prep", build_preprocessor()), ("model", clone(estimador_base))])
    pipeline_eval.set_params(**mejores_parametros)
    pipeline_eval.fit(X_train, y_train)

    pred = pipeline_eval.predict(X_test)
    mae = mean_absolute_error(y_test, pred)
    baseline_mae = mean_absolute_error(y_test, [y_train.mean()] * len(y_test))
    print(f"\nMAE modelo ganador (holdout interno): {mae:.4f} emergencias/periodo")
    print(f"MAE baseline (promedio historico global): {baseline_mae:.4f}")

    importancia_variables = calcular_importancia_variables(pipeline_eval, X_test, y_test)
    print("Importancia real de cada variable (permutation importance sobre datos no vistos):")
    for col, info in importancia_variables.items():
        print(f"  {info['nombre']}: {info['peso_pct']}%")

    # Modelo final: misma familia e hiperparametros ganadores, pero
    # reentrenado con TODO el historico disponible (train + holdout interno)
    # para aprovechar al maximo los datos en el modelo que queda en produccion.
    pipeline_final = Pipeline([("prep", build_preprocessor()), ("model", clone(estimador_base))])
    pipeline_final.set_params(**mejores_parametros)
    pipeline_final.fit(X, y)

    last_features = (
        df.sort_values("timestamp")
        .groupby(["zona_id", "tipo_emergencia"])[["freq_hist_7d", "demanda_recursos_hist_7d"]]
        .last()
    )

    ARTIFACT_PATH.parent.mkdir(exist_ok=True)
    joblib.dump({
        "pipeline": pipeline_final,
        "last_features": last_features,
        "mae": mae,
        "baseline_mae": baseline_mae,
        "importancia_variables": importancia_variables,
        "modelo_ganador": mejor_nombre,
        "comparacion_modelos": resultados_por_familia,
        "trained_at": ahora_chile().isoformat(),
    }, ARTIFACT_PATH)
    print(f"\nModelo guardado en {ARTIFACT_PATH}")


if __name__ == "__main__":
    train()
