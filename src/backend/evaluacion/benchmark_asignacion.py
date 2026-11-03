"""Benchmark de asignación sobre bloques históricos de PostgreSQL.

Se muestrean casos según cantidades existentes, sin fabricar riesgos.
Ubicación aproximada: centro del límite de zona. Tiempo: inicio del bloque.
La ocupación, tiempos de trabajo y puntuación siguen siendo una simulación;
no representan despachos medidos ni garantizan igualdad con el frontend.
No se escribe en la base de datos.
"""
import json
import pathlib
import sys
ROOT=pathlib.Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))
import random
import statistics
from dataclasses import dataclass, field

from ml.db_catalog import obtener_zonas, obtener_tipos, obtener_recursos
from ml.dataset_db import generate
from types import SimpleNamespace
from bisect import bisect_right
from itertools import accumulate
import copy
import math
from core.eta import calcular_eta
from core.vehicle_types import familia

RNG_SEED = 42
N_EMERGENCIAS = 1500
DIAS_SIMULADOS = 90

# --- Mismo modelo de puntaje que frontend/src/main.tsx (scoreDetalle) -----

FAMILIA_FUNCIONAL = {
    "B": "Bomberos", "BX": "Bomberos", "B-U": "Bomberos",
    "BF": "Forestal", "BR": "Forestal",
    "R": "Rescate", "RX": "Rescate",
    "Q": "Escala", "M": "Escala",
    "Z": "Cisterna",
    "H": "Hazmat",
}

CODIGO_TIPO_PREFERIDO = {
    "10-0": "Bomberos", "10-1": "Bomberos", "10-2": "Forestal",
    "10-3": "Rescate", "10-4": "Rescate", "10-5": "Hazmat",
}

IDONEIDAD_TIPO_CLAVE = {
    "10-0": {"Bomberos": 1.0, "Escala": 0.5, "Cisterna": 0.45, "Rescate": 0.2, "Hazmat": 0.2, "Forestal": 0.25},
    "10-1": {"Bomberos": 1.0, "Cisterna": 0.5, "Forestal": 0.3, "Rescate": 0.25, "Hazmat": 0.2, "Escala": 0.15},
    "10-2": {"Forestal": 1.0, "Cisterna": 0.6, "Bomberos": 0.4, "Rescate": 0.1, "Hazmat": 0.15, "Escala": 0.1},
    "10-3": {"Rescate": 1.0, "Bomberos": 0.5, "Escala": 0.4, "Hazmat": 0.2, "Cisterna": 0.1, "Forestal": 0.1},
    "10-4": {"Rescate": 1.0, "Bomberos": 0.5, "Escala": 0.2, "Hazmat": 0.2, "Cisterna": 0.1, "Forestal": 0.1},
    "10-5": {"Hazmat": 1.0, "Bomberos": 0.4, "Rescate": 0.3, "Cisterna": 0.2, "Escala": 0.1, "Forestal": 0.1},
}

# Dotacion tipica por familia de unidad (misma referencia usada al construir
# la flota simulada del frontend), usada para el factor de dotacion.
DOTACION_TIPICA = {"Bomberos": 5, "Forestal": 6, "Rescate": 4, "Escala": 4, "Cisterna": 3, "Hazmat": 4}

# Tiempo de trabajo en el lugar (minutos), segun severidad real de la clave
# (mismo criterio que TIEMPO_TRABAJO_MS del frontend, aqui en minutos y sin
# el factor de "demo comprimida").
TIEMPO_TRABAJO_MIN = {"10-0": 45, "10-1": 20, "10-2": 90, "10-3": 25, "10-4": 30, "10-5": 40}


def idoneidad_tipo(tipo_funcional: str, codigo_clave: str) -> float:
    return IDONEIDAD_TIPO_CLAVE.get(codigo_clave, {}).get(tipo_funcional, 0.15)


def score_multicriterio(tipo_funcional: str, crew: int, contexto_clave: dict, prioridad_nivel: int,
                         distancia_km: float, eta_min: float) -> float:
    es_critica = prioridad_nivel <= 2
    idoneidad = idoneidad_tipo(tipo_funcional, contexto_clave["codigo"])
    idoneidad_bonus = round(idoneidad * 45)

    coincide_terreno = (contexto_clave["terreno"] == "forestal") == (tipo_funcional == "Forestal")
    terreno_bonus = 6 if coincide_terreno else -6

    dotacion_bonus = min(crew, 6) * (1.4 if es_critica else 0.8)

    peso_velocidad = 1.2 if es_critica else 0.85
    penalizacion = (eta_min * 1.5 + distancia_km * 2) * peso_velocidad

    return 25 + idoneidad_bonus + terreno_bonus + dotacion_bonus - penalizacion


# --- Escenarios basados en cantidades históricas de PostgreSQL ------------

@dataclass
class Escenario:
    minuto: float  # minuto simulado desde el inicio (cronologico)
    zona_id: str
    lat: float
    lng: float
    codigo_clave: str


def generar_escenarios(n: int, dias: int, seed: int) -> list[Escenario]:
    if n <= 0 or dias <= 0:
        raise ValueError('n y dias deben ser positivos.')
    df=generate(days=dias)
    df=df.loc[df.cantidad_emergencias>0].sort_values(['timestamp','zona_id','tipo_emergencia'])
    zonas={z['zona_id']:z for z in obtener_zonas()}
    tipos={t['codigo'] for t in obtener_tipos()}
    records=list(df.itertuples())
    if not records:raise ValueError('No hay casos históricos positivos para el benchmark.')
    for r in records:
        if r.tipo_emergencia not in tipos or r.tipo_emergencia not in TIEMPO_TRABAJO_MIN:
            raise ValueError(f'Falta configurar la simulación de trabajo para {r.tipo_emergencia}; no se omite silenciosamente.')
        if r.zona_id not in zonas:raise ValueError(f'Zona no encontrada: {r.zona_id}')
        if r.cantidad_emergencias != int(r.cantidad_emergencias):raise ValueError('Conteo histórico no entero.')
    cumulative=list(accumulate(int(r.cantidad_emergencias) for r in records))
    selected=random.Random(seed).sample(range(cumulative[-1]),min(n,cumulative[-1]))
    inicio=df.timestamp.min()
    salida=[]
    for index in selected:
        r=records[bisect_right(cumulative,index)]
        centro=zonas[r.zona_id]['centroid']
        lat,lng=centro['lat'],centro['lng']
        if lat is None or lng is None or not all(math.isfinite(float(v)) for v in (lat,lng)):
            raise ValueError(f'Zona {r.zona_id} sin ubicación válida en PostgreSQL.')
        salida.append(Escenario((r.timestamp-inicio).total_seconds()/60,r.zona_id,float(lat),float(lng),r.tipo_emergencia))
    return sorted(salida,key=lambda e:e.minuto)


# --- Simulacion de flota con ocupacion en el tiempo ------------------------

@dataclass
class EstadoUnidad:
    id: str
    lat: float
    lng: float
    tipo_funcional: str
    crew: int
    libre_desde: float = 0.0  # minuto simulado en que vuelve a estar disponible


def construir_flota() -> list[EstadoUnidad]:
    flota=[]
    for u in obtener_recursos():
        if not u['disponible']:continue
        if u['lat'] is None or u['lng'] is None or u['dotacion'] is None:
            raise ValueError(f'Recurso {u["codigo"]} sin ubicación/dotación en PostgreSQL.')
        tipo=u['tipo']
        funcional=tipo if tipo in DOTACION_TIPICA else FAMILIA_FUNCIONAL.get(tipo)
        if funcional is None:raise ValueError(f'Tipo de recurso no soportado por la puntuación: {tipo}')
        flota.append(EstadoUnidad(u['codigo'],u['lat'],u['lng'],funcional,int(u['dotacion'])))
    if not flota:raise ValueError('No hay recursos disponibles en PostgreSQL para el benchmark.')
    return flota


def catalogo_claves():
    return {t['codigo']:SimpleNamespace(terreno=str(t['terreno']).lower(),prioridad_nivel=int(t['prioridad'])) for t in obtener_tipos()}


@dataclass
class ResultadoAsignacion:
    atendida: bool
    distancia_km: float = 0.0
    eta_min: float = 0.0
    idoneidad: float = 0.0
    unidad_id: str = ""


def elegir_baseline(flota: list[EstadoUnidad], e: Escenario) -> EstadoUnidad | None:
    disponibles = [u for u in flota if u.libre_desde <= e.minuto]
    if not disponibles:
        return None
    return min(disponibles, key=lambda u: calcular_eta(u.lat, u.lng, e.lat, e.lng)["distancia_km"])


def elegir_multicriterio(flota: list[EstadoUnidad], e: Escenario, claves=None) -> EstadoUnidad | None:
    disponibles = [u for u in flota if u.libre_desde <= e.minuto]
    if not disponibles:
        return None
    clave = (claves or catalogo_claves())[e.codigo_clave]
    contexto_clave = {"codigo": e.codigo_clave, "terreno": clave.terreno}
    mejor, mejor_score = None, float("-inf")
    for u in disponibles:
        r = calcular_eta(u.lat, u.lng, e.lat, e.lng, terreno=clave.terreno)
        s = score_multicriterio(u.tipo_funcional, u.crew, contexto_clave, clave.prioridad_nivel,
                                 r["distancia_km"], r["eta_min"])
        if s > mejor_score:
            mejor, mejor_score = u, s
    return mejor


def simular(escenarios: list[Escenario], elegir, flota=None, claves=None):
    flota = copy.deepcopy(flota if flota is not None else construir_flota())
    claves = claves or catalogo_claves()
    resultados = []
    conteo_por_unidad: dict[str, int] = {u.id: 0 for u in flota}
    for e in escenarios:
        elegida = elegir(flota, e, claves=claves) if elegir is elegir_multicriterio else elegir(flota,e)
        clave = (claves or catalogo_claves())[e.codigo_clave]
        if elegida is None:
            resultados.append(ResultadoAsignacion(atendida=False))
            continue
        r = calcular_eta(elegida.lat, elegida.lng, e.lat, e.lng, terreno=clave.terreno)
        idoneidad = idoneidad_tipo(elegida.tipo_funcional, e.codigo_clave)
        resultados.append(ResultadoAsignacion(
            atendida=True, distancia_km=r["distancia_km"], eta_min=r["eta_min"],
            idoneidad=idoneidad, unidad_id=elegida.id,
        ))
        conteo_por_unidad[elegida.id] += 1
        tiempo_ocupada = r["eta_min"] + TIEMPO_TRABAJO_MIN[e.codigo_clave] + r["eta_min"]  # ida + trabajo + vuelta
        elegida.libre_desde = e.minuto + tiempo_ocupada
    return resultados, conteo_por_unidad


def resumir(nombre: str, resultados: list[ResultadoAsignacion], conteo_por_unidad: dict[str, int]) -> dict:
    atendidas = [r for r in resultados if r.atendida]
    n_total = len(resultados)
    n_sin_unidad = n_total - len(atendidas)

    etas = [r.eta_min for r in atendidas]
    distancias = [r.distancia_km for r in atendidas]
    idoneidades = [r.idoneidad for r in atendidas]
    cobertura_adecuada = sum(1 for i in idoneidades if i >= 0.5) / len(idoneidades) * 100 if idoneidades else 0.0

    asignaciones = sorted(conteo_por_unidad.values(), reverse=True)
    total_asignaciones = sum(asignaciones) or 1
    top5_pct = sum(asignaciones[:5]) / total_asignaciones * 100
    unidades_usadas = sum(1 for v in conteo_por_unidad.values() if v > 0)

    resumen = {
        "estrategia": nombre,
        "emergencias_totales": n_total,
        "sin_unidad_disponible_pct": round(n_sin_unidad / n_total * 100, 2),
        "tiempo_respuesta_prom_min": round(statistics.mean(etas), 2) if etas else None,
        "tiempo_respuesta_mediana_min": round(statistics.median(etas), 2) if etas else None,
        "distancia_prom_km": round(statistics.mean(distancias), 2) if distancias else None,
        "cobertura_tipo_adecuado_pct": round(cobertura_adecuada, 2),
        "unidades_distintas_usadas": unidades_usadas,
        "concentracion_top5_pct": round(top5_pct, 2),
    }
    return resumen


def imprimir_comparacion(base: dict, prop: dict) -> None:
    filas = [
        ("Emergencias sin unidad disponible", "sin_unidad_disponible_pct", "%", True),
        ("Tiempo de respuesta promedio", "tiempo_respuesta_prom_min", "min", True),
        ("Tiempo de respuesta mediana", "tiempo_respuesta_mediana_min", "min", True),
        ("Distancia recorrida promedio", "distancia_prom_km", "km", True),
        ("Cobertura con tipo de unidad adecuado", "cobertura_tipo_adecuado_pct", "%", False),
        ("Unidades distintas utilizadas", "unidades_distintas_usadas", "", False),
        ("Concentracion en las 5 unidades mas usadas", "concentracion_top5_pct", "%", True),
    ]
    print(f"\n{'Metrica':<42}{'Baseline':>14}{'Multicriterio':>16}{'Mejora':>12}")
    print("-" * 84)
    for etiqueta, clave, unidad, menor_es_mejor in filas:
        vb, vp = base[clave], prop[clave]
        if vb is None or vp is None:
            continue
        if menor_es_mejor:
            mejora = (1 - vp / vb) * 100 if vb else 0.0
        else:
            mejora = (vp / vb - 1) * 100 if vb else 0.0
        signo = "+" if mejora >= 0 else ""
        print(f"{etiqueta:<42}{vb:>11.2f}{unidad:<3}{vp:>13.2f}{unidad:<3}{signo}{mejora:>7.1f}%")


def ejecutar_benchmark() -> dict:
    escenarios = generar_escenarios(N_EMERGENCIAS, DIAS_SIMULADOS, RNG_SEED)
    print(f"Simulando {len(escenarios)} emergencias sobre {DIAS_SIMULADOS} dias, "
          f"sobre la flota real de {len(construir_flota())} unidades...")

    flota=construir_flota()
    claves=catalogo_claves()
    res_base, conteo_base = simular(escenarios, elegir_baseline,flota,claves)
    res_prop, conteo_prop = simular(escenarios, elegir_multicriterio,flota,claves)

    resumen_base = resumir("Baseline (mas cercano)", res_base, conteo_base)
    resumen_prop = resumir("Multicriterio (propuesto)", res_prop, conteo_prop)

    imprimir_comparacion(resumen_base, resumen_prop)
    resultado = {"baseline": resumen_base, "propuesto": resumen_prop, "n_escenarios": len(escenarios),
                 "dias_historico_consultados": DIAS_SIMULADOS, "seed": RNG_SEED,
                 "origen": "PostgreSQL: registro_historico, zona, tipo_emergencia, recurso y compania",
                 "metodo": "Muestreo sin reemplazo de casos agregados; centroides y tiempos de trabajo aproximados"}

    salida = pathlib.Path(__file__).parent / "resultados_benchmark.json"
    salida.write_text(json.dumps(resultado, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nResultados guardados en {salida} (evidencia para el informe de evaluacion del algoritmo).")
    return resultado


if __name__ == "__main__":
    ejecutar_benchmark()
