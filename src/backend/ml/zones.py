"""Zonas geograficas usadas por el modelo de demanda.

Antes esto era una grilla rectangular de lat/lng: como la costa de
Valparaiso-Vina del Mar-Concon corre en diagonal (noroeste-sureste), una
grilla rectangular deja celdas completas cayendo en el mar, generando
predicciones sin sentido (p.ej. "alta probabilidad de rescate vehicular"
en pleno oceano). Para evitar eso, las zonas ahora son sectores reales
con nombre, ubicados a mano sobre tierra, cada uno con un perfil de riesgo
por clave basado en la geografia real del sector (no aleatorio): p.ej.
Renaca Alto (cerros con vegetacion) concentra el riesgo de incendio
forestal, Concon (donde esta la refineria ENAP) concentra el riesgo de
materiales peligrosos, Placilla (zona industrial + aeropuerto + rutas)
concentra rescate vehicular y hazmat, etc.
"""
from dataclasses import dataclass

from core.radio_codes import CLAVES_RADIALES

# Claves radiales predecibles (se excluye 10-12, que es una decision de mando
# de preposicionamiento y no un evento estocastico a modelar).
EMERGENCY_TYPES = [codigo for codigo in CLAVES_RADIALES if codigo != "10-12"]

PERIOD_HOURS = [0, 3, 6, 9, 12, 15, 18, 21]  # hora de inicio de cada bloque de 3h

# Medio-ancho de cada zona en grados (~350 m), acorde al tamano real de un
# sector/barrio. Antes era mas grande (~800 m) y se solapaba entre sectores
# vecinos (p.ej. Valparaiso Centro y Cerro Alegre estan a ~400 m entre si).
HALF_SIZE = 0.0032


@dataclass
class Zone:
    id: str
    nombre: str
    lat_min: float
    lat_max: float
    lng_min: float
    lng_max: float
    activity: float
    type_factor: dict

    @property
    def centroid(self):
        return ((self.lat_min + self.lat_max) / 2, (self.lng_min + self.lng_max) / 2)


# (id, nombre, lat, lng, activity, {codigo_clave: factor})
# activity: nivel de actividad general del sector (densidad/poblacion).
# type_factor: cuanto mas riesgoso es ese sector para cada clave especifica,
# respecto del promedio (1.0), segun su geografia/uso de suelo real.
# Coordenadas geocodificadas via Nominatim/OpenStreetMap (2026-09-09) -- las
# anteriores eran aproximaciones a mano y algunas quedaban mal ubicadas
# (demasiado cerca del mar/puerto en vez del sector real, p.ej. Cerro Placeres
# y Cerro Alegre/Concepcion).
_ZONE_SEEDS = [
    ("VAL-CEN", "Valparaíso Centro", -33.0499, -71.6031, 1.7,
     {"10-0": 1.4, "10-1": 1.2, "10-2": 0.3, "10-3": 1.0, "10-4": 1.1, "10-5": 0.6}),
    ("VAL-ALE", "Cerro Alegre / Concepción", -33.0423, -71.6265, 1.3,
     {"10-0": 1.7, "10-1": 0.7, "10-2": 0.4, "10-3": 1.3, "10-4": 0.6, "10-5": 0.4}),
    ("VAL-PUE", "Barrio Puerto", -33.0383, -71.6284, 1.2,
     {"10-0": 1.3, "10-1": 0.9, "10-2": 0.3, "10-3": 0.8, "10-4": 0.9, "10-5": 1.9}),
    ("VAL-ANC", "Playa Ancha", -33.0284, -71.6379, 1.1,
     {"10-0": 1.1, "10-1": 0.8, "10-2": 0.6, "10-3": 1.1, "10-4": 0.8, "10-5": 0.5}),
    ("VAL-PLA", "Cerro Placeres", -33.0366, -71.5952, 1.0,
     {"10-0": 1.2, "10-1": 0.7, "10-2": 1.3, "10-3": 0.9, "10-4": 0.6, "10-5": 0.4}),
    ("VAL-ROD", "Rodelillo", -33.0577, -71.5764, 0.7,
     {"10-0": 0.7, "10-1": 0.5, "10-2": 1.8, "10-3": 1.2, "10-4": 0.5, "10-5": 0.3}),
    ("VAL-PLC", "Placilla", -33.1149, -71.5680, 0.9,
     {"10-0": 0.8, "10-1": 1.5, "10-2": 0.9, "10-3": 0.7, "10-4": 1.7, "10-5": 1.8}),
    ("VIN-CEN", "Viña del Mar Centro", -33.0245, -71.5518, 1.6,
     {"10-0": 1.2, "10-1": 1.6, "10-2": 0.3, "10-3": 0.9, "10-4": 1.6, "10-5": 0.6}),
    ("VIN-FOR", "Forestal / Nueva Aurora", -33.0386, -71.5428, 1.0,
     {"10-0": 1.0, "10-1": 0.9, "10-2": 1.2, "10-3": 0.9, "10-4": 0.9, "10-5": 0.4}),
    ("VIN-MIR", "Miraflores", -33.0263, -71.5202, 1.1,
     {"10-0": 1.0, "10-1": 1.0, "10-2": 0.6, "10-3": 1.0, "10-4": 1.0, "10-5": 0.4}),
    ("VIN-REN", "Reñaca", -32.9730, -71.5266, 1.3,
     {"10-0": 0.9, "10-1": 1.4, "10-2": 0.7, "10-3": 1.3, "10-4": 1.5, "10-5": 0.4}),
    ("VIN-RAL", "Reñaca Alto / Cerros", -32.9968, -71.4884, 0.8,
     {"10-0": 0.6, "10-1": 0.6, "10-2": 2.2, "10-3": 0.8, "10-4": 0.6, "10-5": 0.3}),
    ("VIN-GOM", "Gómez Carreño", -32.9921, -71.5224, 0.9,
     {"10-0": 0.8, "10-1": 0.7, "10-2": 1.5, "10-3": 0.8, "10-4": 0.6, "10-5": 0.3}),
    # Centrada en la refineria ENAP real (Concon), que justifica el alto
    # riesgo de materiales peligrosos (10-5) asignado a esta zona.
    ("CON-CEN", "Concón", -32.9305, -71.5030, 1.0,
     {"10-0": 0.9, "10-1": 1.2, "10-2": 0.8, "10-3": 0.9, "10-4": 1.0, "10-5": 2.1}),
]


def _build_zones() -> list[Zone]:
    zones = []
    for zid, nombre, lat, lng, activity, type_factor in _ZONE_SEEDS:
        zones.append(Zone(
            id=zid, nombre=nombre,
            lat_min=lat - HALF_SIZE, lat_max=lat + HALF_SIZE,
            lng_min=lng - HALF_SIZE, lng_max=lng + HALF_SIZE,
            activity=activity, type_factor=type_factor,
        ))
    return zones


ZONES = _build_zones()
ZONES_BY_ID = {z.id: z for z in ZONES}
