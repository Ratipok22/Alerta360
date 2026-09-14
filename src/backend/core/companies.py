"""Companias reales de Bomberos en la Region de Valparaiso.

Datos de las 16 companias del Cuerpo de Bomberos de Valparaiso (CBV,
fundado 30-06-1851) y 10 companias confirmadas del Cuerpo de Bomberos de
Vina del Mar, verificados cruzando dos fuentes independientes:
- Wikipedia (nombre y sector historico de cada compania).
- OpenStreetMap/Overpass (2026-09-09): cuarteles etiquetados directamente
  como `amenity=fire_station` con el nombre de cada compania — esta es la
  fuente mas confiable porque son puntos reales mapeados, no un sector
  aproximado ni una direccion de texto sin verificar.

Cuando ambas fuentes coincidian se uso el punto de OSM. Cuando un tercer
listado (entregado por el usuario, con direcciones especificas) entraba en
conflicto con OSM, se preferio el dato de OSM por ser directamente
verificable (ver el commit/conversacion del 2026-09-09 para el detalle de
los conflictos encontrados, p.ej. la 13a y 15a companias aparecian con los
sectores Placilla/Rodelillo invertidos en esa tercera lista).

Lo que SI esta verificado: nombre, sector y coordenada de cada compania
(cruzado con OSM). Lo que NO esta verificado: el tipo de material mayor
asignado a cada compania (B/BF/R/Q/Z/H) — eso no es informacion publica.
El estado de cada unidad (disponible/en servicio) es siempre simulado.

Pendiente para "a futuro todo Chile": agregar el resto de los Cuerpos de
la region (Concon, Quilpue, Villa Alemana...) y del pais. La estructura
(campo `cuerpo`) ya esta pensada para eso.
"""
from dataclasses import dataclass, field

from .radio_states import EstadoRadial


@dataclass
class Unidad:
    id: str
    tipo: str  # codigo de core.vehicle_types.TIPOS_CARRO (B, R, BF, Z, Q, H...)
    estado: EstadoRadial = EstadoRadial.DISPONIBLE


@dataclass(frozen=True)
class Compania:
    cuerpo: str          # Cuerpo de Bomberos al que pertenece
    numero: str          # numero/orden dentro de su cuerpo (como identificador, ej. "1", "V2")
    nombre: str          # nombre real de la compania
    sector: str          # sector/direccion real donde esta ubicada
    lat: float           # cuartel real (verificado via OSM donde fue posible)
    lng: float
    unidades: tuple[Unidad, ...] = field(default_factory=tuple)


COMPANIAS: tuple[Compania, ...] = (
    # --- Cuerpo de Bomberos de Valparaiso (CBV) — las 16 companias reales ---
    Compania("CB Valparaíso", "1", 'Primera Compañía "Bomba Americana"', "Cochrane 625 / Plaza Sotomayor",
             -33.0388, -71.6286, (Unidad("B-1", "B"),)),
    Compania("CB Valparaíso", "2", 'Segunda Compañía "Bomba Germania"', "Blanco 630",
             -33.0388, -71.6284, (Unidad("B-2", "B"),)),
    Compania("CB Valparaíso", "3", 'Tercera Compañía "Cousiño y A. Edwards"', "Sector Almendral / Pedro Montt",
             -33.0474, -71.6152, (Unidad("B-3", "B"),)),
    Compania("CB Valparaíso", "4", 'Cuarta Compañía "Almirante Blanco Encalada"', "Freire, Almendral",
             -33.0445, -71.6144, (Unidad("B-4", "B"),)),
    Compania("CB Valparaíso", "5", 'Quinta Compañía "Pompe France"', "Blanco, Almendral",
             -33.0443, -71.6143, (Unidad("R-5", "R"),)),
    Compania("CB Valparaíso", "6", 'Sexta Compañía "Cristoforo Colombo"', "General Cruz 630",
             -33.0487, -71.6139, (Unidad("B-6", "B"),)),
    Compania("CB Valparaíso", "7", 'Séptima Compañía "Bomba España"', "Sector Almendral / Pedro Montt",
             -33.0470, -71.6123, (Unidad("Q-7", "Q"),)),
    Compania("CB Valparaíso", "8", 'Octava Compañía "Zapadores Franco Chilenos"', "Blanco Sur",
             -33.0427, -71.6239, (Unidad("H-8", "H"),)),
    Compania("CB Valparaíso", "9", 'Novena Compañía "Zapadores Freire"', "Freire, Almendral",
             -33.0447, -71.6143, (Unidad("B-9", "B"),)),
    Compania("CB Valparaíso", "10", 'Décima Compañía "Bomba Chileno Árabe"', "Sector Almendral / Parque Italia",
             -33.0486, -71.6139, (Unidad("B-10", "B"),)),
    Compania("CB Valparaíso", "11", 'Undécima Compañía "George Garland"', "Melgarejo 147, Barrio Puerto",
             -33.0428, -71.6240, (Unidad("R-11", "R"),)),
    Compania("CB Valparaíso", "12", 'Duodécima Compañía "Luis Bravo Osses - Bomba Suiza"', "Cerro Playa Ancha",
             -33.0387, -71.6458, (Unidad("B-12", "B"),)),
    Compania("CB Valparaíso", "13", 'Decimotercera Compañía "George Mustakis Dragonas"', "Av. Cardenal Samoré 930, Placilla",
             -33.1186, -71.5742, (Unidad("BF-13", "BF"), Unidad("Z-13", "Z"))),
    Compania("CB Valparaíso", "14", 'Decimocuarta Compañía "Reino de Bélgica"', "Av. Manuel Antonio Matta 2503, Placeres Alto",
             -33.0495, -71.5747, (Unidad("BF-14", "BF"),)),
    Compania("CB Valparaíso", "15", 'Decimoquinta Compañía "Bomba Israel"', "Av. Rodelillo",
             -33.0582, -71.5767, (Unidad("BF-15", "BF"),)),
    Compania("CB Valparaíso", "16", 'Decimosexta Compañía "Libertador Bernardo O\'Higgins"', "Laguna Verde",
             -33.1076, -71.6692, (Unidad("BF-16", "BF"),)),

    # --- Cuerpo de Bomberos de Viña del Mar — companias confirmadas (OSM/Overpass, 2026-09-09) ---
    Compania("CB Viña del Mar", "V1", "Primera Compañía", "Álvarez 562, Viña del Mar",
             -33.0263, -71.5549, (Unidad("B-V1", "B"),)),
    Compania("CB Viña del Mar", "V2", "Segunda Compañía", "Avenida Valparaíso 791, Viña del Mar",
             -33.0251, -71.5500, (Unidad("B-V2", "B"),)),
    Compania("CB Viña del Mar", "V3", "Tercera Compañía", "Limache 3001, Viña del Mar",
             -33.0361, -71.5266, (Unidad("R-V3", "R"),)),
    Compania("CB Viña del Mar", "V4", "Cuarta Compañía", "12 Norte, Viña del Mar",
             -33.0127, -71.5417, (Unidad("R-V4", "R"),)),
    Compania("CB Viña del Mar", "V5", "Quinta Compañía", "Pacífico 5215, Viña del Mar",
             -32.9979, -71.5181, (Unidad("BF-V5", "BF"),)),
    Compania("CB Viña del Mar", "V6", "Sexta Compañía", "Vergara 1115, Viña del Mar",
             -32.9262, -71.5122, (Unidad("B-V6", "B"),)),
    Compania("CB Viña del Mar", "V7", "Séptima Compañía", "Logroño 1298, Viña del Mar",
             -33.0336, -71.5551, (Unidad("H-V7", "H"),)),
    Compania("CB Viña del Mar", "V8", "Octava Compañía", "Av. José Manuel Balmaceda 601, Viña del Mar",
             -32.9722, -71.5376, (Unidad("Q-V8", "Q"),)),
    Compania("CB Viña del Mar", "V9", "Novena Compañía (Brigada Reñaca Alto)", "Altamira, Reñaca Alto",
             -32.9996, -71.4882, (Unidad("BF-V9", "BF"),)),
    Compania("CB Viña del Mar", "V10", "Décima Compañía", "Av. Presidente Eduardo Frei Montalva 4350, Viña del Mar",
             -33.0225, -71.5040, (Unidad("BF-V10", "BF"),)),
)

COMPANIAS_POR_NUMERO: dict[str, Compania] = {c.numero: c for c in COMPANIAS}


def todas_las_unidades() -> list[tuple[Unidad, Compania]]:
    """Aplana companias -> lista de (unidad, compania), para busqueda y asignacion."""
    return [(u, c) for c in COMPANIAS for u in c.unidades]


def unidad_por_id(unidad_id: str) -> tuple[Unidad, Compania] | None:
    for unidad, compania in todas_las_unidades():
        if unidad.id == unidad_id:
            return unidad, compania
    return None
