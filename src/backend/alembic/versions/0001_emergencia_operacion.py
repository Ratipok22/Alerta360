"""Tablas del modulo Emergencia y Operacion (persistencia real de lo que
hoy vive en memoria en main.py y de los catalogos de core/*.py).

Revision ID: 0001_emergencia_operacion
Revises:
Create Date: 2026-10-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_emergencia_operacion"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tipo_emergencia",
        sa.Column("codigo", sa.String(20), primary_key=True),
        sa.Column("nombre", sa.String(100), nullable=False),
        sa.Column("prioridad", sa.String(20), nullable=False),
        sa.Column("prioridad_nivel", sa.Integer, nullable=False),
        sa.Column("terreno", sa.String(20), nullable=False),
    )

    op.create_table(
        "tipo_carro",
        sa.Column("codigo", sa.String(10), primary_key=True),
        sa.Column("nombre", sa.String(100), nullable=False),
        sa.Column("terreno", sa.String(20), nullable=False),
    )

    op.create_table(
        "compania",
        sa.Column("id_compania", sa.String(20), primary_key=True),
        sa.Column("numero", sa.String(10), nullable=False),
        sa.Column("nombre", sa.String(150), nullable=False),
        sa.Column("cuerpo", sa.String(100), nullable=False),
        sa.Column("sector", sa.String(150)),
        sa.Column("latitud", sa.Float, nullable=False),
        sa.Column("longitud", sa.Float, nullable=False),
    )

    op.create_table(
        "requisito_unidad",
        sa.Column("id_requisito", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("clave_codigo", sa.String(20), sa.ForeignKey("tipo_emergencia.codigo"), nullable=False),
        sa.Column("tipos_alternativos", sa.String(50), nullable=False),
        sa.Column("cantidad", sa.Integer, nullable=False),
    )
    op.create_index("ix_requisito_unidad_clave_codigo", "requisito_unidad", ["clave_codigo"])

    op.create_table(
        "recurso",
        sa.Column("id_recurso", sa.String(20), primary_key=True),
        sa.Column("id_compania", sa.String(20), sa.ForeignKey("compania.id_compania"), nullable=False),
        sa.Column("tipo", sa.String(10), sa.ForeignKey("tipo_carro.codigo"), nullable=False),
        sa.Column("estado", sa.String(10), nullable=False, server_default="6-0"),
        sa.CheckConstraint("estado IN ('6-0','6-3','6-7','6-8','6-9')", name="recurso_estado_valido"),
    )
    op.create_index("ix_recurso_id_compania", "recurso", ["id_compania"])
    op.create_index("ix_recurso_tipo", "recurso", ["tipo"])

    op.create_table(
        "emergencia",
        sa.Column("id_emergencia", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("codigo", sa.String(20), sa.ForeignKey("tipo_emergencia.codigo"), nullable=False),
        sa.Column("direccion", sa.String(200)),
        sa.Column("latitud", sa.Float, nullable=False),
        sa.Column("longitud", sa.Float, nullable=False),
        sa.Column("prioridad", sa.String(20), nullable=False),
        sa.Column("estado", sa.String(20), nullable=False, server_default="activa"),
        sa.Column("fecha_creacion", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("fecha_cierre", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_emergencia_codigo", "emergencia", ["codigo"])
    op.create_index("ix_emergencia_estado", "emergencia", ["estado"])

    op.create_table(
        "asignacion",
        sa.Column("id_asignacion", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("id_emergencia", sa.BigInteger, sa.ForeignKey("emergencia.id_emergencia"), nullable=False),
        sa.Column("id_recurso", sa.String(20), sa.ForeignKey("recurso.id_recurso"), nullable=False),
        sa.Column("usuario_email", sa.String(320), nullable=False),
        sa.Column("score", sa.Float),
        sa.Column("distancia_km", sa.Float),
        sa.Column("eta_min", sa.Integer),
        sa.Column("fecha_asignacion", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("estado", sa.String(20), nullable=False, server_default="asignada"),
    )
    op.create_index("ix_asignacion_id_emergencia", "asignacion", ["id_emergencia"])
    op.create_index("ix_asignacion_id_recurso", "asignacion", ["id_recurso"])


def downgrade() -> None:
    op.drop_table("asignacion")
    op.drop_table("emergencia")
    op.drop_table("recurso")
    op.drop_table("requisito_unidad")
    op.drop_table("compania")
    op.drop_table("tipo_carro")
    op.drop_table("tipo_emergencia")
