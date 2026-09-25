"""Variables meteorológicas simuladas para el modelo de demanda.

No existe (para efectos del MVP) una integración con una API meteorológica
real ni un historial horario real de clima para Valparaíso/Viña del Mar, por
lo que la temperatura, el viento y la precipitación se generan de forma
sintética. A diferencia de un ruido aleatorio sin sentido, esta simulación
está anclada a normales climáticas públicas reales de la zona (patrón
mediterráneo costero: veranos secos y templados, inviernos lluviosos y más
fríos; ver `MONTHLY_TEMP_MEAN_C` y `MONTHLY_PRECIP_MM` más abajo para las
fuentes), con variación horaria (ciclo diurno de temperatura, viento más
fuerte en la tarde) y ruido diario acotado, de forma que el patrón agregado
mensual se parezca al real aunque el valor de un día puntual sea simulado.

Esto importa para el modelo porque el riesgo de incendio forestal (10-2) no
depende solo de la fecha calendario: depende de que además haga calor, haya
viento y no haya llovido hace poco (el patrón de "viento sur" cálido y seco
en primavera-verano que empuja los incendios de cerro en la región está
ampliamente documentado). De forma simétrica, el rescate vehicular (10-4)
aumenta con lluvia/viento fuerte (pistas resbaladizas, menor visibilidad).

Fuentes usadas para calibrar los promedios mensuales (normales públicas,
no un registro estación por estación): WeatherSpark, climate-data.org y
weather-and-climate.com para Valparaíso (consultado 2026-09). Los valores
son un promedio razonable entre esas fuentes, no una cifra oficial única.
"""
from __future__ import annotations

import numpy as np

# Temperatura media aproximada por mes (°C), patrón mediterráneo costero:
# maximo en verano (ene-feb, ~17-18°C de media diaria), minimo en invierno
# (jun-jul, ~11-12°C de media diaria).
MONTHLY_TEMP_MEAN_C = {
    1: 17.6, 2: 17.8, 3: 16.7, 4: 15.0, 5: 13.6, 6: 12.3,
    7: 11.7, 8: 11.9, 9: 12.6, 10: 13.6, 11: 15.0, 12: 16.6,
}
# Amplitud del ciclo diurno (°C entre el bloque mas frio ~06:00 y el mas
# calido ~15:00). Mayor en meses secos (mayor oscilacion termica diaria).
MONTHLY_DIURNAL_AMPLITUDE_C = {
    1: 6.5, 2: 6.5, 3: 6.0, 4: 5.0, 5: 4.0, 6: 3.5,
    7: 3.5, 8: 4.0, 9: 4.5, 10: 5.5, 11: 6.0, 12: 6.5,
}
# Precipitacion media mensual (mm/mes), minima en verano (~ene-feb, casi
# nula) y maxima en invierno (~jun-jul, temporada de frentes desde el
# Pacifico). Se reparte estocasticamente entre los bloques de 3h del mes.
MONTHLY_PRECIP_MM = {
    1: 3, 2: 3, 3: 8, 4: 20, 5: 55, 6: 100,
    7: 90, 8: 65, 9: 35, 10: 15, 11: 8, 12: 5,
}
# Viento medio (km/h) por bloque horario, mas fuerte en la tarde (brisa
# marina + "viento sur" costero tipico de la zona centro-sur de Chile) y
# algo mas intenso en primavera-verano.
HOUR_WIND_BASE_KMH = {0: 8, 3: 7, 6: 8, 9: 12, 12: 17, 15: 20, 18: 16, 21: 11}
MONTH_WIND_FACTOR = {m: (1.15 if m in (10, 11, 12, 1, 2, 3) else 0.9) for m in range(1, 13)}

# Exposicion al viento por sector, segun su geografia real: los sectores de
# cerro/ladera (Reñaca Alto, Rodelillo, Cerro Placeres, Forestal) quedan mas
# expuestos que los sectores de plan/costa (centros urbanos, Barrio Puerto).
WIND_EXPOSURE = {
    "VAL-CEN": 0.9, "VAL-ALE": 1.0, "VAL-PUE": 0.85, "VAL-ANC": 1.05,
    "VAL-PLA": 1.2, "VAL-ROD": 1.25, "VAL-PLC": 1.1,
    "VIN-CEN": 0.9, "VIN-FOR": 1.15, "VIN-MIR": 1.0,
    "VIN-REN": 1.05, "VIN-RAL": 1.3, "VIN-GOM": 1.1, "CON-CEN": 1.1,
}


def _dia_del_anio(fecha) -> int:
    return fecha.timetuple().tm_yday


def clima_esperado(mes: int, hora: int, zona_id: str) -> dict:
    """Valor climatologico esperado (sin ruido) para un mes/hora/zona dado.

    Se usa tanto para generar el historico simulado (sumandole ruido diario)
    como para las predicciones futuras del modelo: al no existir pronostico
    meteorologico real integrado, el modelo asume el clima "normal" de esa
    epoca del anio en vez de adivinar condiciones puntuales futuras. Esto se
    documenta como limitacion conocida (ver README).
    """
    temp_media = MONTHLY_TEMP_MEAN_C[mes]
    amplitud = MONTHLY_DIURNAL_AMPLITUDE_C[mes]
    # Ciclo diurno: minimo ~06:00, maximo ~15:00 (coseno desfasado).
    fase = ((hora - 15) / 24) * 2 * np.pi
    temperatura_c = temp_media + (amplitud / 2) * np.cos(fase)

    exposicion = WIND_EXPOSURE.get(zona_id, 1.0)
    viento_kmh = HOUR_WIND_BASE_KMH[hora] * MONTH_WIND_FACTOR[mes] * exposicion

    dias_del_mes = 30.4
    bloques_por_dia = 8
    precip_media_bloque = MONTHLY_PRECIP_MM[mes] / (dias_del_mes * bloques_por_dia)

    return {
        "temperatura_c": round(float(temperatura_c), 1),
        "viento_kmh": round(float(viento_kmh), 1),
        "precipitacion_mm": round(float(precip_media_bloque), 2),
    }


def simular_clima_dia(mes: int, hora: int, zona_id: str, rng: np.random.Generator) -> dict:
    """Version con ruido diario acotado, para el historico simulado (no
    para la prediccion futura, que usa el valor esperado sin ruido: ver
    `clima_esperado`)."""
    base = clima_esperado(mes, hora, zona_id)
    temperatura_c = base["temperatura_c"] + rng.normal(0, 1.8)
    viento_kmh = max(0.0, base["viento_kmh"] + rng.normal(0, 4.0))
    # La lluvia no se reparte suave: la mayoria de los bloques no llueve y,
    # cuando llueve, cae mas de lo que el promedio sugeriria (modelo
    # simplificado tipo "cascada" de probabilidad + intensidad condicional).
    prob_lluvia = min(0.9, base["precipitacion_mm"] / 1.5)
    llueve = rng.random() < prob_lluvia
    precipitacion_mm = float(rng.exponential(base["precipitacion_mm"] * 3)) if llueve else 0.0
    return {
        "temperatura_c": round(float(temperatura_c), 1),
        "viento_kmh": round(float(viento_kmh), 1),
        "precipitacion_mm": round(precipitacion_mm, 2),
    }


def factor_incendio_forestal(temperatura_c: float, viento_kmh: float, precipitacion_mm: float) -> float:
    """Multiplicador de riesgo de incendio forestal/pastizales (10-2) segun
    condiciones del dia: sube con calor y viento, cae fuerte si llovio (piso
    humedo). Centrado para promediar ~1.0 a lo largo del anio, de forma que
    la calibracion anual contra la cifra de CONAF (ver generate_dataset.py)
    se mantenga aproximadamente valida."""
    factor_temp = np.exp((temperatura_c - 14.5) * 0.045)
    factor_viento = np.exp((viento_kmh - 13.0) * 0.02)
    factor_lluvia = np.exp(-precipitacion_mm * 0.35)
    return float(np.clip(factor_temp * factor_viento * factor_lluvia, 0.15, 5.0))


def factor_rescate_vehicular(viento_kmh: float, precipitacion_mm: float) -> float:
    """Multiplicador de riesgo de rescate vehicular (10-4): sube con
    lluvia (pistas resbaladizas) y viento fuerte (visibilidad, objetos en
    la via). Centrado en ~1.0."""
    factor_lluvia = 1.0 + min(precipitacion_mm, 15.0) * 0.03
    factor_viento = 1.0 + max(0.0, viento_kmh - 20.0) * 0.01
    return float(np.clip(factor_lluvia * factor_viento, 0.7, 2.5))
