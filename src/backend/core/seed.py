"""Puebla los catalogos de Postgres a partir de los mismos datos Python que
ya estan verificados (companias reales, claves radiales, tipos de carro) --
asi no se re-tipean a mano y el dato sigue siendo trazable al codigo fuente.

Uso: python -m core.seed (requiere que las tablas ya existan, ver alembic/).
Es idempotente: se puede correr varias veces sin duplicar filas (upsert por
llave primaria).
"""
from __future__ import annotations

import re
import unicodedata

from sqlalchemy.dialects.postgresql import insert

from .companies import COMPANIAS
from .db import SessionLocal
from .models import Compania, Recurso, RequisitoUnidad, TipoCarro, TipoEmergencia
from .radio_codes import CLAVES_RADIALES
from .vehicle_types import TIPOS_CARRO


def _slug_cuerpo(cuerpo: str) -> str:
    """'CB Valparaíso' -> 'CBVALPARAISO' (sin tildes/espacios), para armar
    un id_compania legible y estable sin inventar un numero correlativo."""
    sin_tildes = unicodedata.normalize("NFKD", cuerpo).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z0-9]", "", sin_tildes.upper())


def _upsert(db, modelo, filas: list[dict], pk: str) -> int:
    if not filas:
        return 0
    stmt = insert(modelo).values(filas)
    actualizar = {c: stmt.excluded[c] for c in filas[0] if c != pk}
    stmt = stmt.on_conflict_do_update(index_elements=[pk], set_=actualizar)
    db.execute(stmt)
    return len(filas)


def seed() -> dict[str, int]:
    db = SessionLocal()
    resumen = {}
    try:
        resumen["tipo_emergencia"] = _upsert(db, TipoEmergencia, [
            {
                "codigo": cr.codigo,
                "nombre": cr.nombre,
                "prioridad": cr.prioridad.value,
                "prioridad_nivel": cr.prioridad_nivel,
                "terreno": cr.terreno,
            }
            for cr in CLAVES_RADIALES.values()
        ], pk="codigo")

        requisitos = []
        for cr in CLAVES_RADIALES.values():
            for req in cr.unidades_requeridas:
                requisitos.append({
                    "clave_codigo": cr.codigo,
                    "tipos_alternativos": ",".join(req.tipos_alternativos),
                    "cantidad": req.cantidad,
                })
        if requisitos:
            # No tiene un id natural (no viene de un dict con llave propia):
            # se borra e inserta de nuevo completo en cada corrida, en vez
            # de upsert por id, para no duplicar filas sin llave estable.
            db.query(RequisitoUnidad).delete()
            db.bulk_insert_mappings(RequisitoUnidad, requisitos)
        resumen["requisito_unidad"] = len(requisitos)

        resumen["tipo_carro"] = _upsert(db, TipoCarro, [
            {"codigo": tc.codigo, "nombre": tc.nombre, "terreno": tc.terreno}
            for tc in TIPOS_CARRO.values()
        ], pk="codigo")

        companias_filas = []
        recursos_filas = []
        for c in COMPANIAS:
            id_compania = f"{_slug_cuerpo(c.cuerpo)}-{c.numero}"
            companias_filas.append({
                "id_compania": id_compania,
                "numero": c.numero,
                "nombre": c.nombre,
                "cuerpo": c.cuerpo,
                "sector": c.sector,
                "latitud": c.lat,
                "longitud": c.lng,
            })
            for u in c.unidades:
                recursos_filas.append({
                    "id_recurso": u.id,
                    "id_compania": id_compania,
                    "tipo": u.tipo,
                    "estado": u.estado.value,
                })
        resumen["compania"] = _upsert(db, Compania, companias_filas, pk="id_compania")
        resumen["recurso"] = _upsert(db, Recurso, recursos_filas, pk="id_recurso")

        db.commit()
        return resumen
    finally:
        db.close()


if __name__ == "__main__":
    resultado = seed()
    for tabla, cantidad in resultado.items():
        print(f"{tabla}: {cantidad} filas")
