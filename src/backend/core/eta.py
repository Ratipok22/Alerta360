"""Calculo de distancia y tiempo estimado de llegada (ETA).

Distancia via formula de Haversine; tiempo ajustado por velocidad promedio
segun el terreno de la emergencia (urbano vs. forestal).
"""
import math

RADIO_TIERRA_KM = 6371.0
VELOCIDAD_URBANA_KMH = 35.0
VELOCIDAD_FORESTAL_KMH = 50.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * RADIO_TIERRA_KM * math.asin(math.sqrt(a))


def velocidad_kmh(terreno: str) -> float:
    return VELOCIDAD_FORESTAL_KMH if terreno == "forestal" else VELOCIDAD_URBANA_KMH


def eta_minutos(distancia_km: float, terreno: str = "urbano") -> float:
    horas = distancia_km / velocidad_kmh(terreno)
    return round(horas * 60, 1)


def calcular_eta(lat_origen: float, lng_origen: float, lat_destino: float, lng_destino: float,
                  terreno: str = "urbano") -> dict:
    distancia = haversine_km(lat_origen, lng_origen, lat_destino, lng_destino)
    return {
        "distancia_km": round(distancia, 2),
        "eta_min": eta_minutos(distancia, terreno),
    }
