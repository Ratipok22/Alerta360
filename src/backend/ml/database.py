"""Base de datos "historica" del proyecto: un archivo Excel (.xlsx) que se
genera UNA SOLA VEZ (dataset sintetico, calibrado con la cifra real de
CONAF y el clima real de Valparaiso/Vina del Mar -- ver
`ml/generate_dataset.py` y `ml/weather.py`) y despues queda fijo en disco
como la fuente de verdad para el entrenamiento. Entrenar el modelo
(`ml/train_model.py`) ya NO vuelve a generar datos aleatorios nuevos cada
vez: siempre lee este mismo archivo.

Esto resuelve dos cosas que no tenia la version anterior (un CSV
regenerado en memoria si no existia en disco):

1. **Se puede visualizar directamente**: abriendo
   `ml/data/historico_emergencias.xlsx` en Excel, LibreOffice o Google
   Sheets se ve exactamente la tabla con la que esta trabajando el
   modelo (dos hojas: `historico` con los registros, `info` con un
   resumen de cuantos hay y cuando se escribio por ultima vez).
2. **Se le pueden agregar registros con el tiempo**: `agregar_registros()`
   (usada por el endpoint `POST /historico/registrar` y por el script
   `python -m ml.agregar_registro`) hace un append sobre el archivo
   existente en vez de sobreescribirlo, simulando que la base de datos
   crece con despachos reales a medida que pasa el tiempo. La proxima vez
   que se corra `python -m ml.train_model`, el modelo entrena con el
   historico sintetico original MAS todo lo que se haya agregado desde
   entonces.
"""
from __future__ import annotations

import pathlib

import pandas as pd

from .generate_dataset import RECURSOS_POR_CASO, generate
from .weather import clima_esperado

DB_PATH = pathlib.Path(__file__).parent / "data" / "historico_emergencias.xlsx"
SHEET_DATOS = "historico"
SHEET_INFO = "info"

COLUMNAS_BASE = [
    "fecha", "dia_semana", "mes", "bloque_hora", "zona_id", "tipo_emergencia",
    "cantidad_emergencias", "recursos_utilizados",
    "temperatura_c", "viento_kmh", "precipitacion_mm", "timestamp",
]
# Columnas climaticas (ver ml/weather.py): si un archivo viejo en disco no
# las tiene, se regenera. OJO: no se usa FEATURE_COLUMNS_NUMERIC completo
# aca porque ese incluye freq_hist_7d/demanda_recursos_hist_7d, que son
# calculadas en el entrenamiento (add_rolling_features) y nunca se guardan
# como columnas crudas en la base de datos.
COLUMNAS_CLIMA = ["temperatura_c", "viento_kmh", "precipitacion_mm"]


def _escribir(df: pd.DataFrame, nota: str) -> None:
    DB_PATH.parent.mkdir(exist_ok=True)
    info = pd.DataFrame([{
        "registros": len(df),
        "ultima_escritura": pd.Timestamp.now().isoformat(timespec="seconds"),
        "nota": nota,
    }])
    with pd.ExcelWriter(DB_PATH, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name=SHEET_DATOS, index=False)
        info.to_excel(writer, sheet_name=SHEET_INFO, index=False)


def crear_base_datos_si_no_existe() -> pd.DataFrame:
    """Genera la base de datos UNA SOLA VEZ y la deja guardada como Excel.
    Si el archivo ya existe, NO lo regenera (para no perder registros
    agregados a mano con `agregar_registros`) -- simplemente lo devuelve."""
    if DB_PATH.exists():
        return cargar_base_datos()
    df = generate()
    _escribir(df, nota="Generacion inicial: dataset sintetico calibrado con CONAF y clima real")
    print(f"Base de datos creada: {DB_PATH} ({len(df)} registros)")
    return df


def cargar_base_datos() -> pd.DataFrame:
    """Lee la base de datos desde disco. Si no existe, la crea. Si existe
    pero le faltan columnas (version vieja, sin clima por ejemplo), se
    regenera desde cero en vez de fallar mas adelante en el entrenamiento."""
    if not DB_PATH.exists():
        return crear_base_datos_si_no_existe()
    df = pd.read_excel(DB_PATH, sheet_name=SHEET_DATOS)
    if not set(COLUMNAS_CLIMA).issubset(df.columns):
        df = generate()
        _escribir(df, nota="Regenerada: el archivo anterior no tenia todas las columnas necesarias")
        return df
    df["fecha"] = pd.to_datetime(df["fecha"])
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def construir_registro(
    fecha: str,
    bloque_hora: int,
    zona_id: str,
    tipo_emergencia: str,
    cantidad_emergencias: int,
    recursos_utilizados: int | None = None,
    temperatura_c: float | None = None,
    viento_kmh: float | None = None,
    precipitacion_mm: float | None = None,
) -> dict:
    """Arma una fila valida para agregar a la base de datos. Si no se
    indica el clima del dia, se usa la normal climatica esperada para ese
    mes/hora/zona (ver `ml/weather.py`) en vez de dejarlo vacio -- mismo
    criterio que usa `ml/predict.py` para periodos futuros."""
    ts = pd.Timestamp(fecha) + pd.Timedelta(hours=bloque_hora)
    if temperatura_c is None or viento_kmh is None or precipitacion_mm is None:
        clima = clima_esperado(ts.month, bloque_hora, zona_id)
    if recursos_utilizados is None:
        factor = RECURSOS_POR_CASO.get(tipo_emergencia, 1.5)
        recursos_utilizados = round(cantidad_emergencias * factor)
    return {
        "fecha": ts.date().isoformat(),
        "dia_semana": ts.weekday(),
        "mes": ts.month,
        "bloque_hora": bloque_hora,
        "zona_id": zona_id,
        "tipo_emergencia": tipo_emergencia,
        "cantidad_emergencias": cantidad_emergencias,
        "recursos_utilizados": recursos_utilizados,
        "temperatura_c": temperatura_c if temperatura_c is not None else clima["temperatura_c"],
        "viento_kmh": viento_kmh if viento_kmh is not None else clima["viento_kmh"],
        "precipitacion_mm": precipitacion_mm if precipitacion_mm is not None else clima["precipitacion_mm"],
        "timestamp": ts,
    }


def agregar_registros(nuevos: pd.DataFrame, nota: str = "Registros agregados manualmente") -> pd.DataFrame:
    """Hace un append de `nuevos` sobre la base de datos existente (la crea
    primero si todavia no existe) y vuelve a guardar el Excel completo."""
    faltantes = set(COLUMNAS_BASE) - set(nuevos.columns)
    if faltantes:
        raise ValueError(f"Faltan columnas en los registros nuevos: {sorted(faltantes)}")
    actual = crear_base_datos_si_no_existe()
    combinado = pd.concat([actual, nuevos[COLUMNAS_BASE]], ignore_index=True)
    combinado["timestamp"] = pd.to_datetime(combinado["timestamp"])
    combinado = combinado.sort_values(["zona_id", "tipo_emergencia", "timestamp"]).reset_index(drop=True)
    _escribir(combinado, nota=f"{nota} (+{len(nuevos)} registros, {pd.Timestamp.now().date().isoformat()})")
    return combinado


def resumen() -> dict:
    """Estadisticas rapidas de la base de datos, para el endpoint
    `GET /historico/resumen` -- una forma de "ver" que datos esta usando
    el modelo sin tener que abrir el Excel."""
    df = cargar_base_datos()
    return {
        "ruta": str(DB_PATH),
        "registros": len(df),
        "desde": df["fecha"].min().date().isoformat(),
        "hasta": df["fecha"].max().date().isoformat(),
        "total_emergencias": int(df["cantidad_emergencias"].sum()),
        "zonas": int(df["zona_id"].nunique()),
        "claves": int(df["tipo_emergencia"].nunique()),
    }


if __name__ == "__main__":
    df = crear_base_datos_si_no_existe()
    print(f"Base de datos lista: {DB_PATH} ({len(df)} registros)")
