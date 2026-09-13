"""Maquina de estados de transmision radial (claves 6-X) para cada unidad."""
from enum import Enum


class EstadoRadial(str, Enum):
    DISPONIBLE = "6-0"
    EN_TRAYECTO = "6-3"
    EN_EMERGENCIA = "6-7"
    REGRESANDO = "6-8"
    FUERA_DE_SERVICIO = "6-9"


ESTADO_DESCRIPCION: dict[EstadoRadial, str] = {
    EstadoRadial.DISPONIBLE: "En Cuartel / Disponible",
    EstadoRadial.EN_TRAYECTO: "En Trayecto a Emergencia",
    EstadoRadial.EN_EMERGENCIA: "En la Emergencia / Trabajando",
    EstadoRadial.REGRESANDO: "Disponible Regresando a Cuartel",
    EstadoRadial.FUERA_DE_SERVICIO: "Fuera de Servicio / Mantenimiento",
}

# Transiciones validas de la maquina de estados, usadas para validar cambios de estado.
TRANSICIONES_VALIDAS: dict[EstadoRadial, set[EstadoRadial]] = {
    EstadoRadial.DISPONIBLE: {EstadoRadial.EN_TRAYECTO, EstadoRadial.FUERA_DE_SERVICIO},
    EstadoRadial.EN_TRAYECTO: {EstadoRadial.EN_EMERGENCIA, EstadoRadial.DISPONIBLE},
    EstadoRadial.EN_EMERGENCIA: {EstadoRadial.REGRESANDO},
    EstadoRadial.REGRESANDO: {EstadoRadial.DISPONIBLE, EstadoRadial.FUERA_DE_SERVICIO},
    EstadoRadial.FUERA_DE_SERVICIO: {EstadoRadial.DISPONIBLE},
}


def es_disponible(estado: EstadoRadial) -> bool:
    return estado == EstadoRadial.DISPONIBLE


def transicion_valida(actual: EstadoRadial, siguiente: EstadoRadial) -> bool:
    return siguiente in TRANSICIONES_VALIDAS.get(actual, set())
