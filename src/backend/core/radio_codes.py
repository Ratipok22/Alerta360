"""Claves radiales de emergencia (10-X) segun el estandar operativo de Bomberos
de Chile adoptado para Alerta360 (Ley 20.564 / JNBC / SIDEM)."""
from dataclasses import dataclass
from enum import Enum


class Prioridad(str, Enum):
    CRITICA = "Crítica"
    ALTA = "Alta"
    MEDIA = "Media"
    BAJA = "Baja"


@dataclass(frozen=True)
class RequisitoUnidad:
    """Se cumple con `cantidad` unidades de cualquiera de `tipos_alternativos`."""
    tipos_alternativos: tuple[str, ...]
    cantidad: int


@dataclass(frozen=True)
class ClaveRadial:
    codigo: str
    nombre: str
    prioridad: Prioridad
    prioridad_nivel: int  # 1 = mas critico ... 4 = mas bajo
    unidades_requeridas: tuple[RequisitoUnidad, ...]
    terreno: str  # 'urbano' | 'forestal'


CLAVES_RADIALES: dict[str, ClaveRadial] = {
    "10-0": ClaveRadial(
        "10-0", "Incendio Estructural", Prioridad.CRITICA, 1,
        (RequisitoUnidad(("B", "BX", "B-U"), 2), RequisitoUnidad(("Q", "M"), 1)),
        "urbano",
    ),
    "10-1": ClaveRadial(
        "10-1", "Incendio de Vehículo", Prioridad.MEDIA, 3,
        (RequisitoUnidad(("B", "BX", "B-U"), 1),),
        "urbano",
    ),
    "10-2": ClaveRadial(
        "10-2", "Incendio Forestal / Pastizales", Prioridad.ALTA, 2,
        (RequisitoUnidad(("BF", "BR"), 1), RequisitoUnidad(("Z",), 1)),
        "forestal",
    ),
    "10-3": ClaveRadial(
        "10-3", "Salvamento / Personas Encerradas", Prioridad.MEDIA, 3,
        (RequisitoUnidad(("R", "RX", "B", "BX", "B-U"), 1),),
        "urbano",
    ),
    "10-4": ClaveRadial(
        "10-4", "Rescate Vehicular", Prioridad.CRITICA, 1,
        (RequisitoUnidad(("R", "RX"), 1), RequisitoUnidad(("B", "BX", "B-U"), 1)),
        "urbano",
    ),
    "10-5": ClaveRadial(
        "10-5", "Materiales Peligrosos / HazMat", Prioridad.ALTA, 2,
        (RequisitoUnidad(("H",), 1), RequisitoUnidad(("B", "BX", "B-U"), 1)),
        "urbano",
    ),
    "10-12": ClaveRadial(
        "10-12", "Apoyo / Preposicionamiento Preventivo", Prioridad.BAJA, 4,
        (),
        "urbano",
    ),
}
