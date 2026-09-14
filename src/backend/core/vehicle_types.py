"""Nomenclatura oficial del material mayor de Bomberos de Chile usada en Alerta360."""
from dataclasses import dataclass


@dataclass(frozen=True)
class TipoCarro:
    codigo: str
    nombre: str
    terreno: str  # 'urbano' | 'forestal' | 'ambos'


TIPOS_CARRO: dict[str, TipoCarro] = {
    "B": TipoCarro("B", "Carro Bomba (Urbano/Agua)", "urbano"),
    "BX": TipoCarro("BX", "Carro Bomba (Urbano/Agua)", "urbano"),
    "B-U": TipoCarro("B-U", "Carro Bomba (Urbano/Agua)", "urbano"),
    "BF": TipoCarro("BF", "Carro Forestal (Tracción 4x4)", "forestal"),
    "BR": TipoCarro("BR", "Carro Forestal (Tracción 4x4)", "forestal"),
    "R": TipoCarro("R", "Carro de Rescate Vehicular/Técnico", "urbano"),
    "RX": TipoCarro("RX", "Carro de Rescate Vehicular/Técnico", "urbano"),
    "Q": TipoCarro("Q", "Carro Portaescalas / Escala Mecánica", "urbano"),
    "M": TipoCarro("M", "Carro Portaescalas / Escala Mecánica", "urbano"),
    "Z": TipoCarro("Z", "Carro Cisterna / Aljibe", "ambos"),
    "H": TipoCarro("H", "Carro HazMat", "urbano"),
}


def familia(codigo_unidad: str) -> str:
    """Extrae el codigo de tipo desde un id de unidad, p.ej. 'B-1' -> 'B', 'BF-10' -> 'BF'."""
    return codigo_unidad.split("-")[0]


def tipo_de(codigo_unidad: str) -> TipoCarro | None:
    return TIPOS_CARRO.get(familia(codigo_unidad))
