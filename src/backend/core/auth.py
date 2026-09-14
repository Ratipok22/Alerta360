"""Autenticacion de operadores -- sin registro publico, solo los usuarios
de prueba definidos aca (nombre real del equipo, cuentas fijas). Las
contraseñas NUNCA se guardan en texto plano, ni siquiera para estos
usuarios de demo: se guarda el hash bcrypt de cada una, igual que se
haria con cuentas reales.

El login emite un JWT firmado con JWT_SECRET_KEY (variable de entorno, ver
.env.example en la raiz del repo) -- sin estado en el servidor, no hace
falta guardar sesiones en memoria ni en base de datos.
"""
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "clave-de-desarrollo-cambiar-en-produccion")
ALGORITHM = "HS256"
EXPIRACION_HORAS = 12


@dataclass(frozen=True)
class Usuario:
    email: str
    nombre: str
    password_hash: bytes


# Hash bcrypt de la contraseña compartida de estos 3 usuarios de prueba
# ("Bomberos.2026"). Se genera una sola vez y se guarda aca el resultado,
# no la contraseña -- ni leyendo el codigo fuente se ve la clave real.
_HASH_DEMO = b"$2b$12$GMWH1LEAzB8MQx0H.WD.v.F2vRz1YGqYGWgAowxcX2eu3kKnAvbWO"

# Los 3 unicos operadores habilitados (uno por integrante del equipo). No
# hay registro: si no esta en esta lista, no puede entrar.
USUARIOS: dict[str, Usuario] = {
    u.email: u for u in [
        Usuario("ben.saavedrab@bomberos.cl", "Benjamin Saavedra", _HASH_DEMO),
        Usuario("alex.aravena@bomberos.cl", "Alexsander Aravena", _HASH_DEMO),
        Usuario("bru.molina@bomberos.cl", "Bruno Molina", _HASH_DEMO),
    ]
}


def verificar_credenciales(email: str, password: str) -> Usuario | None:
    usuario = USUARIOS.get(email.strip().lower())
    if not usuario:
        return None
    if not bcrypt.checkpw(password.encode("utf-8"), usuario.password_hash):
        return None
    return usuario


def crear_token(usuario: Usuario) -> str:
    ahora = datetime.now(timezone.utc)
    payload = {
        "sub": usuario.email,
        "nombre": usuario.nombre,
        "iat": ahora,
        "exp": ahora + timedelta(hours=EXPIRACION_HORAS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verificar_token(token: str) -> Usuario | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    email = payload.get("sub")
    return USUARIOS.get(email) if email else None
