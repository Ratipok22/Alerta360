"""Fixtures comunes. Ningun test se conecta a la base de datos real: toda
llamada a obtener_conexion() se reemplaza por una conexion falsa."""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parents[1]
for p in (str(BACKEND), str(ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import main  # noqa: E402
from core import auth  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

CLAVE_DEMO = "Bomberos.2026"
ADMIN = "alex.aravena@bomberos.cl"
VISUALIZADOR = "bru.molina@bomberos.cl"
SOPORTE = "amolina@admin.alerta360.cl"


class FakeCursor:
    """Cursor que registra cada consulta y responde con filas preparadas."""
    def __init__(self, filas=None):
        self.filas = list(filas or [])
        self.consultas = []

    def execute(self, sql, params=None):
        self.consultas.append((sql, params))

    def fetchone(self):
        return self.filas.pop(0) if self.filas else None

    def fetchall(self):
        return []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeConexion:
    def __init__(self, cursor=None):
        self.cursor_fake = cursor or FakeCursor()

    def cursor(self):
        return self.cursor_fake

    def commit(self): pass
    def rollback(self): pass
    def close(self): pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture(autouse=True)
def sin_base_de_datos(monkeypatch):
    def prohibida(*a, **k):
        raise AssertionError("Un test intento conectarse a la base de datos real")
    monkeypatch.setattr(main, "obtener_conexion", prohibida)


@pytest.fixture(autouse=True)
def limpiar_bloqueos():
    auth._intentos_fallidos.clear()
    auth._bloqueados_hasta.clear()
    main._limitador_prediccion._peticiones.clear()
    yield


@pytest.fixture
def client():
    return TestClient(main.app)


def token_de(email):
    return auth.crear_token(auth.USUARIOS[email])


def headers_de(email):
    return {"Authorization": f"Bearer {token_de(email)}"}
