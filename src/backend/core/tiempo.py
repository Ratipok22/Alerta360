"""Fecha/hora ancladas a la hora local de Valparaiso, Chile, sin depender de
la zona horaria configurada en el sistema operativo donde corra el backend.

Esto importa porque el modelo de ML aprende patrones horarios/estacionales
(hora punta, temporada de incendios forestales, etc.) que solo tienen
sentido en hora de Chile: si el servidor corriera con otra zona horaria,
"ahora" quedaria desalineado con esos patrones.
"""
from datetime import date, datetime
from zoneinfo import ZoneInfo

CHILE_TZ = ZoneInfo("America/Santiago")


def ahora_chile() -> datetime:
    return datetime.now(CHILE_TZ)


def hoy_chile() -> date:
    return ahora_chile().date()


def con_hora_chile(momento: datetime) -> datetime:
    """Si `momento` no tiene zona horaria, se asume que ya representa hora
    de Chile (p.ej. una fecha ingresada manualmente) y se marca como tal."""
    return momento if momento.tzinfo else momento.replace(tzinfo=CHILE_TZ)
