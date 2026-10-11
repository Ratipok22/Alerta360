"""Tablas de Postgres para el modulo de Emergencia y Operacion, verificadas
contra las estructuras Python reales que ya existian (core/radio_codes.py,
core/vehicle_types.py, core/companies.py) antes de persistirlas.

"usuario" NO es una tabla aca a proposito: sigue siendo el diccionario fijo
de core/auth.py (RBAC en memoria). asignacion.usuario_email se guarda como
texto plano, sin llave foranea real, hasta que ese modulo tambien se migre.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, CheckConstraint, Column, DateTime, Float, ForeignKey, Integer, String, func,
)

from .db import Base


class TipoEmergencia(Base):
    """Espejo de core.radio_codes.CLAVES_RADIALES (claves 10-X)."""
    __tablename__ = "tipo_emergencia"

    codigo = Column(String(20), primary_key=True)
    nombre = Column(String(100), nullable=False)
    prioridad = Column(String(20), nullable=False)
    prioridad_nivel = Column(Integer, nullable=False)
    terreno = Column(String(20), nullable=False)


class RequisitoUnidad(Base):
    """Espejo de ClaveRadial.unidades_requeridas (hoy una tupla anidada en
    Python, no una tabla). tipos_alternativos queda como texto separado por
    comas (ej. "B,BX,B-U") en vez de una tabla N:M aparte, para no sobre-
    normalizar algo que en el codigo real es solo una lista corta."""
    __tablename__ = "requisito_unidad"

    id_requisito = Column(Integer, primary_key=True, autoincrement=True)
    clave_codigo = Column(String(20), ForeignKey("tipo_emergencia.codigo"), nullable=False)
    tipos_alternativos = Column(String(50), nullable=False)
    cantidad = Column(Integer, nullable=False)


class TipoCarro(Base):
    """Espejo de core.vehicle_types.TIPOS_CARRO."""
    __tablename__ = "tipo_carro"

    codigo = Column(String(10), primary_key=True)
    nombre = Column(String(100), nullable=False)
    terreno = Column(String(20), nullable=False)


class Compania(Base):
    """Espejo de core.companies.COMPANIAS (companias reales de Valparaiso/Viña del Mar)."""
    __tablename__ = "compania"

    id_compania = Column(String(20), primary_key=True)
    numero = Column(String(10), nullable=False)
    nombre = Column(String(150), nullable=False)
    cuerpo = Column(String(100), nullable=False)
    sector = Column(String(150))
    latitud = Column(Float, nullable=False)
    longitud = Column(Float, nullable=False)


class Recurso(Base):
    """Espejo de core.companies.Unidad. Sin latitud/longitud propia: una
    unidad usa la ubicacion de su compania (asi lo hace /resources hoy)."""
    __tablename__ = "recurso"

    id_recurso = Column(String(20), primary_key=True)
    id_compania = Column(String(20), ForeignKey("compania.id_compania"), nullable=False)
    tipo = Column(String(10), ForeignKey("tipo_carro.codigo"), nullable=False)
    estado = Column(String(10), nullable=False, default="6-0")

    __table_args__ = (
        # Mismos 5 valores que core.radio_states.EstadoRadial -- si el
        # codigo cambia esa clave radial, hay que actualizar esto tambien.
        CheckConstraint(
            "estado IN ('6-0','6-3','6-7','6-8','6-9')", name="recurso_estado_valido"
        ),
    )


class Emergencia(Base):
    """Persistencia real de lo que hoy es el modelo Pydantic `Emergency` en
    main.py (type, priority, lat, lng) mas los campos de ciclo de vida que
    ese modelo todavia no tiene (estado, fechas)."""
    __tablename__ = "emergencia"

    id_emergencia = Column(BigInteger, primary_key=True, autoincrement=True)
    codigo = Column(String(20), ForeignKey("tipo_emergencia.codigo"), nullable=False)
    direccion = Column(String(200))
    latitud = Column(Float, nullable=False)
    longitud = Column(Float, nullable=False)
    # OJO: el Pydantic Emergency de main.py usa Literal["ALTA","MEDIA","BAJA"]
    # (sin "CRITICA"), mientras que core.radio_codes.Prioridad SI tiene
    # CRITICA -- inconsistencia ya presente en el codigo real, no se fuerza
    # un CHECK aca para no bloquear altas validas segun cualquiera de los dos.
    prioridad = Column(String(20), nullable=False)
    estado = Column(String(20), nullable=False, default="activa")
    fecha_creacion = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    fecha_cierre = Column(DateTime(timezone=True), nullable=True)


class Asignacion(Base):
    """Persistencia real de lo que hoy devuelve /assignment/recommend sin
    guardarlo en ningun lado (candidatos hardcodeados en main.py)."""
    __tablename__ = "asignacion"

    id_asignacion = Column(BigInteger, primary_key=True, autoincrement=True)
    id_emergencia = Column(BigInteger, ForeignKey("emergencia.id_emergencia"), nullable=False)
    id_recurso = Column(String(20), ForeignKey("recurso.id_recurso"), nullable=False)
    # Sin ForeignKey: "usuario" todavia no es tabla (ver core/auth.py).
    usuario_email = Column(String(320), nullable=False)
    score = Column(Float)
    distancia_km = Column(Float)
    eta_min = Column(Integer)
    fecha_asignacion = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    estado = Column(String(20), nullable=False, default="asignada")
