"""Tipos y convención temporal del modelo; no contiene catálogos de zonas."""
from dataclasses import dataclass

PERIOD_HOURS = [0, 3, 6, 9, 12, 15, 18, 21]


@dataclass(frozen=True)
class Zone:
    id: str
    nombre: str
    lat_min: float
    lat_max: float
    lng_min: float
    lng_max: float

    @property
    def centroid(self):
        return ((self.lat_min+self.lat_max)/2, (self.lng_min+self.lng_max)/2)
