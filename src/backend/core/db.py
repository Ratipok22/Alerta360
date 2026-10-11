"""Conexion a Postgres (SQLAlchemy). Antes de esto, "emergencia" y
"asignacion" solo existian como el JSON en memoria de /state (main.py) y
se perdian cada vez que se reiniciaba el backend -- este modulo es la base
para que esos datos sobrevivan a un reinicio.

DATABASE_URL viene del entorno (ver .env.example): docker-compose ya la
arma sola desde docker/.env: postgresql://usuario:password@db:5432/bd.
"""
import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

# main.py ya llama load_dotenv() al arrancar la API, pero alembic y
# core.seed se corren sueltos (sin pasar por main.py) -- sin esto, DATABASE_URL
# nunca se leeria del .env en esos dos casos.
load_dotenv()

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://emergency:emergency@localhost:5432/emergency"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """Dependencia de FastAPI: abre una sesion por request y la cierra sola,
    incluso si el endpoint lanza una excepcion (ver core/models.py para las
    tablas y ml/... para el resto del proyecto, que no usa Postgres)."""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
