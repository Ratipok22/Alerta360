"""Genera un dataset historico simulado de emergencias atendidas por Bomberos.

No existe (para efectos del MVP) un dataset real disponible, por lo que se
generan conteos sinteticos via un proceso de Poisson cuya tasa depende de
la zona, la clave radial (10-X), la hora del dia, el dia de la semana y el
mes (estacionalidad), buscando patrones realistas: por ejemplo, mas
incendios forestales (10-2) en verano y mas rescates vehiculares (10-4)
en horas punta.
"""
import pathlib
from datetime import date, timedelta

import numpy as np
import pandas as pd

from core.tiempo import hoy_chile

from .zones import ZONES, EMERGENCY_TYPES, PERIOD_HOURS

RNG_SEED = 42
DAYS_OF_HISTORY = 365

# Claves: 10-0 Incendio estructural, 10-1 Incendio de vehiculo, 10-2 Incendio
# forestal/pastizales, 10-3 Salvamento/personas encerradas, 10-4 Rescate
# vehicular, 10-5 Materiales peligrosos/HazMat.
HOUR_FACTOR = {
    "10-0": {0: 0.9, 3: 0.7, 6: 0.8, 9: 1.0, 12: 1.3, 15: 1.2, 18: 1.2, 21: 1.1},
    "10-1": {0: 0.6, 3: 0.4, 6: 1.1, 9: 1.3, 12: 1.0, 15: 1.1, 18: 1.4, 21: 1.0},
    "10-2": {0: 0.3, 3: 0.2, 6: 0.5, 9: 1.1, 12: 1.6, 15: 1.8, 18: 1.4, 21: 0.6},
    "10-3": {0: 1.0, 3: 0.9, 6: 0.9, 9: 1.1, 12: 1.1, 15: 1.1, 18: 1.1, 21: 1.0},
    "10-4": {0: 0.5, 3: 0.3, 6: 1.3, 9: 1.6, 12: 1.1, 15: 1.2, 18: 1.7, 21: 1.2},
    "10-5": {0: 0.5, 3: 0.4, 6: 0.9, 9: 1.3, 12: 1.3, 15: 1.2, 18: 1.0, 21: 0.7},
}
DOW_FACTOR = {  # indice 0 = lunes ... 6 = domingo
    "10-0": [1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1],
    "10-1": [1.0, 1.0, 1.0, 1.0, 1.1, 1.2, 1.1],
    "10-2": [1.0, 1.0, 1.0, 1.1, 1.2, 1.4, 1.4],
    "10-3": [1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1],
    "10-4": [0.9, 0.9, 1.0, 1.0, 1.2, 1.6, 1.4],
    "10-5": [1.1, 1.1, 1.1, 1.1, 1.0, 0.8, 0.7],
}
MONTH_FACTOR = {
    "10-0": {m: (1.3 if m in (6, 7, 8) else 1.0) for m in range(1, 13)},
    "10-1": {m: 1.0 for m in range(1, 13)},
    # temporada de incendios forestales en Chile central: dic-mar (epoca seca/calor)
    "10-2": {m: (2.4 if m in (12, 1, 2, 3) else (1.3 if m in (11, 4) else 0.5)) for m in range(1, 13)},
    "10-3": {m: 1.0 for m in range(1, 13)},
    "10-4": {m: (1.2 if m in (5, 6, 7, 8) else 1.0) for m in range(1, 13)},
    "10-5": {m: 1.0 for m in range(1, 13)},
}
BASE_RATE = {  # promedio de casos por zona y bloque de 3h en condiciones neutras
    "10-0": 0.05,
    "10-1": 0.04,
    # 10-2 calibrado para que el TOTAL anual simulado en la region coincida con
    # la cifra real reportada por CONAF: 575 incendios forestales en la Region
    # de Valparaiso durante la temporada 2025-2026 (conaf.cl). El resto del
    # patron (estacionalidad, distribucion horaria/por zona) sigue siendo un
    # supuesto razonado, no viene de CONAF.
    "10-2": 0.0113,
    "10-3": 0.04,
    "10-4": 0.10,
    "10-5": 0.02,
}
RECURSOS_POR_CASO = {  # unidades despachadas promedio por caso, segun requisitos minimos
    "10-0": 3.0,
    "10-1": 1.2,
    "10-2": 2.0,
    "10-3": 1.1,
    "10-4": 2.0,
    "10-5": 2.0,
}


def generate(start: date | None = None, days: int = DAYS_OF_HISTORY, seed: int = RNG_SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    if start is None:
        start = hoy_chile() - timedelta(days=days)
    rows = []
    for d in range(days):
        current_date = start + timedelta(days=d)
        dow = current_date.weekday()
        month = current_date.month
        for hour in PERIOD_HOURS:
            for zone in ZONES:
                for tipo in EMERGENCY_TYPES:
                    lam = (
                        BASE_RATE[tipo]
                        * zone.activity
                        * zone.type_factor[tipo]
                        * HOUR_FACTOR[tipo][hour]
                        * DOW_FACTOR[tipo][dow]
                        * MONTH_FACTOR[tipo][month]
                    )
                    count = int(rng.poisson(lam))
                    recursos = int(rng.poisson(count * RECURSOS_POR_CASO[tipo])) if count else 0
                    rows.append({
                        "fecha": current_date.isoformat(),
                        "dia_semana": dow,
                        "mes": month,
                        "bloque_hora": hour,
                        "zona_id": zone.id,
                        "tipo_emergencia": tipo,
                        "cantidad_emergencias": count,
                        "recursos_utilizados": recursos,
                    })
    df = pd.DataFrame(rows)
    df["timestamp"] = pd.to_datetime(df["fecha"]) + pd.to_timedelta(df["bloque_hora"], unit="h")
    return df.sort_values(["zona_id", "tipo_emergencia", "timestamp"]).reset_index(drop=True)


if __name__ == "__main__":
    out = pathlib.Path(__file__).parent / "data" / "historico_emergencias.csv"
    out.parent.mkdir(exist_ok=True)
    df = generate()
    df.to_csv(out, index=False)
    print(f"Generados {len(df)} registros -> {out}")
