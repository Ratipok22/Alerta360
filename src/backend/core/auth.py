"""Autenticacion de operadores -- sin registro publico, solo los usuarios
de prueba definidos aca (nombre real del equipo, cuentas fijas). Las
contraseñas NUNCA se guardan en texto plano, ni siquiera para estos
usuarios de demo: se guarda el hash bcrypt de cada una, igual que se
haria con cuentas reales.

El login emite un JWT firmado con JWT_SECRET_KEY (variable de entorno, ver
.env.example en la raiz del repo) -- sin estado en el servidor, no hace
falta guardar sesiones en memoria ni en base de datos.
"""
import json
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal

import bcrypt
import jwt

SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "clave-de-desarrollo-cambiar-en-produccion")
ALGORITHM = "HS256"
EXPIRACION_HORAS = 12

Rol = Literal["admin", "visualizador", "soporte"]


@dataclass(frozen=True)
class Usuario:
    email: str
    nombre: str
    password_hash: bytes
    rol: Rol


# Hash bcrypt de la contraseña compartida de estos 3 usuarios de prueba
# ("Bomberos.2026"). Se genera una sola vez y se guarda aca el resultado,
# no la contraseña -- ni leyendo el codigo fuente se ve la clave real.
_HASH_DEMO = b"$2b$12$GMWH1LEAzB8MQx0H.WD.v.F2vRz1YGqYGWgAowxcX2eu3kKnAvbWO"

# Los 3 unicos operadores habilitados (uno por integrante del equipo). No
# hay registro: si no esta en esta lista, no puede entrar.
#
# Rol de cada operador (RBAC):
# - "admin": coordinacion/despacho -- puede asignar/rechazar unidades, usar
#   el filtro de cuartel y editar configuracion administrativa (ej. el
#   umbral de timeout de unidades).
# - "visualizador": solo lectura -- puede ver mapas, tableros y usar el
#   filtro de cuartel para consultar, pero no puede asignar ni editar nada
#   operacional. El backend nunca confia en un rol que venga del cliente:
#   siempre se resuelve aca, contra este mismo diccionario, sea cual sea el
#   contenido del JWT.
USUARIOS: dict[str, Usuario] = {
    u.email: u for u in [
        Usuario("ben.saavedrab@bomberos.cl", "Benjamin Saavedra", _HASH_DEMO, "admin"),
        Usuario("alex.aravena@bomberos.cl", "Alexsander Aravena", _HASH_DEMO, "admin"),
        Usuario("bru.molina@bomberos.cl", "Bruno Molina", _HASH_DEMO, "visualizador"),
        Usuario("amolina@admin.alerta360.cl", "Alexis Molina", _HASH_DEMO, "soporte"),
    ]
}


if os.getenv("APP_ENV") == "production":
    if len(os.environ.get("JWT_SECRET_KEY", "")) < 32:
        raise RuntimeError("Configura JWT_SECRET_KEY con al menos 32 caracteres.")
    # Solo habilita cuentas configuradas expresamente para el despliegue.
    hashes = json.loads(os.environ["OPERADORES_BCRYPT_JSON"])
    if not hashes or any(email not in USUARIOS for email in hashes):
        raise ValueError("Revisa las cuentas de OPERADORES_BCRYPT_JSON.")
    USUARIOS = {email: Usuario(email, USUARIOS[email].nombre, valor.encode("ascii"), USUARIOS[email].rol)
                for email, valor in hashes.items()}


# Limite de intentos de login por cuenta (ver DEF-01 en la matriz de
# pruebas de seguridad): sin esto, un ataque de fuerza bruta puede probar
# contraseñas sin ninguna friccion. En memoria del proceso alcanza porque
# son 4 cuentas fijas y un solo proceso de backend -- si se escala a mas
# de un worker/replica, esto deberia moverse a algo compartido (Redis).
_LIMITE_INTENTOS = 5
_VENTANA_SEGUNDOS = 60
_BLOQUEO_SEGUNDOS = 60

_intentos_fallidos: dict[str, list[float]] = {}
_bloqueados_hasta: dict[str, float] = {}
_lock_intentos = threading.Lock()


class CuentaBloqueada(Exception):
    """Se lanza cuando una cuenta supero el limite de intentos fallidos."""
    def __init__(self, segundos_restantes: int):
        self.segundos_restantes = segundos_restantes
        super().__init__(f"Cuenta bloqueada por {segundos_restantes}s tras demasiados intentos fallidos.")


def _segundos_bloqueo_restante(email: str) -> int | None:
    with _lock_intentos:
        hasta = _bloqueados_hasta.get(email)
        if hasta is None:
            return None
        restante = hasta - time.monotonic()
        if restante <= 0:
            _bloqueados_hasta.pop(email, None)
            _intentos_fallidos.pop(email, None)
            return None
        return int(restante) + 1


def _registrar_intento_fallido(email: str) -> None:
    ahora = time.monotonic()
    with _lock_intentos:
        intentos = [t for t in _intentos_fallidos.get(email, []) if ahora - t < _VENTANA_SEGUNDOS]
        intentos.append(ahora)
        if len(intentos) >= _LIMITE_INTENTOS:
            _bloqueados_hasta[email] = ahora + _BLOQUEO_SEGUNDOS
            intentos = []
        _intentos_fallidos[email] = intentos


def _limpiar_intentos(email: str) -> None:
    with _lock_intentos:
        _intentos_fallidos.pop(email, None)
        _bloqueados_hasta.pop(email, None)


def verificar_credenciales(email: str, password: str) -> Usuario | None:
    email = email.strip().lower()
    restante = _segundos_bloqueo_restante(email)
    if restante is not None:
        raise CuentaBloqueada(restante)

    usuario = USUARIOS.get(email)
    if not usuario or not bcrypt.checkpw(password.encode("utf-8"), usuario.password_hash):
        _registrar_intento_fallido(email)
        return None

    _limpiar_intentos(email)
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


class LimiteExcedido(Exception):
    """Se lanza cuando un cliente supero el limite de requests permitido."""
    def __init__(self, segundos_restantes: int):
        self.segundos_restantes = segundos_restantes
        super().__init__(f"Limite de requests excedido, reintentar en {segundos_restantes}s.")


class LimitadorTasa:
    """Limitador de tasa generico en memoria (ventana deslizante), para
    endpoints pesados que no tenian ningun control (ver DEF-05 en la
    matriz de pruebas de seguridad: 30 requests seguidas a
    /prediction/demand no encontraban ningun rechazo). Misma limitacion
    que el bloqueo de login de mas arriba: vive en memoria de un solo
    proceso, suficiente para este despliegue de demo -- si se escala a
    mas de un worker/replica, debería moverse a algo compartido (Redis)."""
    def __init__(self, limite: int, ventana_segundos: int):
        self.limite = limite
        self.ventana_segundos = ventana_segundos
        self._peticiones: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def verificar(self, clave: str) -> None:
        ahora = time.monotonic()
        with self._lock:
            historial = [t for t in self._peticiones.get(clave, []) if ahora - t < self.ventana_segundos]
            if len(historial) >= self.limite:
                mas_antigua = historial[0]
                restante = int(self.ventana_segundos - (ahora - mas_antigua)) + 1
                raise LimiteExcedido(max(restante, 1))
            historial.append(ahora)
            self._peticiones[clave] = historial
