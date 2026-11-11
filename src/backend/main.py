#-------------------------------NUeva para la base de datos

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

#-------------------------------

import base64
import binascii
import os
import threading
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import Body, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Carga variables desde .env (JWT_SECRET_KEY, etc.) cuando se corre
# directo con uvicorn; docker-compose ya las inyecta por su cuenta, pero
# esto no interfiere en ese caso (load_dotenv no sobreescribe variables
# que ya vengan puestas por el entorno).
load_dotenv()

from core.auth import CuentaBloqueada, LimiteExcedido, LimitadorTasa, Usuario, crear_token, verificar_credenciales, verificar_token
from core.companies import todas_las_unidades
from core.eta import calcular_eta
from core.radio_codes import CLAVES_RADIALES
from core.vehicle_types import TIPOS_CARRO

from database.database import obtener_conexion


def fecha_emergencia_api(fecha):
    """Las fechas operacionales sin zona se almacenan en hora civil de Chile."""
    if fecha is None:
        return None
    chile = ZoneInfo("America/Santiago")
    return fecha.replace(tzinfo=chile) if fecha.tzinfo is None else fecha.astimezone(chile)

from ml.persistencia_ml import obtener_o_generar, listado_modelos
from ml.db_catalog import obtener_zonas, obtener_tipos, obtener_recursos





# Punto de referencia solo para ilustrar distancia/ETA en /resources (no hay
# una emergencia real fija): Reñaca Alto, Viña del Mar.
_REF_LAT, _REF_LNG = -32.9968, -71.4884

# Motor de rutas local (OSRM, ver routing/) sobre calles reales de la
# region  no una API paga ni un servicio externo. Se genero una vez con
# datos reales de OpenStreetMap/Overpass y corre 100% local en Docker.
# OSRM_URL es configurable por si se levanta con otro nombre/puerto (p.ej.
# dentro de docker-compose, donde el nombre de servicio "osrm" resuelve por
# DNS interno de Docker en vez de localhost).
OSRM_URL = os.environ.get("OSRM_URL", "http://localhost:5001")

app = FastAPI(title="Emergency Resource Intelligence API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip().rstrip("/") for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if origin.strip()],
    # Permite tambien acceder desde un dev tunnel (VS Code Ports / *.devtunnels.ms)
    # cuando se comparte el avance para revision, ademas de localhost.
    allow_origin_regex=None if os.getenv("APP_ENV") == "production" else r"https://.*\.devtunnels\.ms",
    # Con credenciales habilitadas, el navegador puede enviar la cookie de
    # consentimiento del propio tunel en las llamadas fetch() en segundo
    # plano; sin esto, el tunel del backend puede seguir interceptandolas
    # con su pantalla de aviso aunque ya se haya aceptado navegando directo.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Emergency(BaseModel):
    type: str
    priority: Literal["ALTA","MEDIA","BAJA"]
    lat: float
    lng: float


def usuario_actual(authorization: str | None = Header(default=None)) -> Usuario:
    """Dependencia de FastAPI: exige un JWT valido en el header
    Authorization: Bearer <token> para acceder a los endpoints reales de
    datos -- ver core/auth.py."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="No autenticado")
    usuario = verificar_token(authorization.split(" ", 1)[1])
    if not usuario:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada, inicia sesión de nuevo")
    return usuario

def requiere_admin(usuario: Usuario = Depends(usuario_actual)) -> Usuario:
    """Dependencia de FastAPI para RBAC: exige ademas que el operador
    autenticado tenga rol "admin" (coordinacion/despacho). El rol se lee
    siempre desde core.auth.USUARIOS (la fuente de verdad del servidor),
    nunca de un dato que venga del cliente -- asi que no se puede escalar
    privilegios manipulando el token ni la app."""
    if usuario.rol != "admin":
        raise HTTPException(status_code=403, detail="Tu cuenta no tiene permiso para realizar esta acción (rol de solo lectura)")
    return usuario

def requiere_admin_o_visualizador(usuario: Usuario = Depends(usuario_actual)) -> Usuario:
    """Igual que requiere_admin pero tambien deja pasar al rol
    "visualizador" -- usado solo para la accion puntual de marcar un
    recurso Fuera de servicio/Disponible (ver PATCH /resources/{..}/estado),
    que el equipo decidio abrir a visualizador aunque el resto del
    despacho/asignacion se mantiene exclusivo de admin."""
    if usuario.rol not in ("admin", "visualizador"):
        raise HTTPException(status_code=403, detail="Tu cuenta no tiene permiso para realizar esta acción")
    return usuario


#-------------------------------NUeva para la base de datos
class EmergencyCreate(BaseModel):
    codigo_emergencia: str
    direccion_emergencia: str
    latitud_emergencia: float
    longitud_emergencia: float
    prioridad_emergencia: int
    # str, no int: zona.id_zona ahora son codigos INE reales
    # (ej. "INE24-05101-01"), no numeros correlativos -- ver
    # migracion_segundo_mapa.sql.
    id_zona: str | None = None
    # estado_emergencia NO viene del cliente: el formulario de ingreso
    # rapido (CAD) solo crea emergencias nuevas, siempre "Activa" -- se
    # fuerza server-side en vez de confiar en lo que mande el frontend.

    # Tipo de estructura/lugar donde ocurre el incidente (emergencia.emergencia.
    # tipo_estructura_emergencia) -- NO reemplaza terreno_emergencia (urbano/
    # forestal, usado para la velocidad del ETA): esto describe el INMUEBLE
    # puntual de este incidente, variable caso a caso (el mismo 10-0 puede
    # ocurrir en una casa o en un edificio), por eso vive en la emergencia y
    # no en el catalogo de claves (tipo_emergencia). Opcional: solo se pide
    # en el formulario para claves cuyo criterio de despacho incluye una
    # Escala Mecanica (hoy, solo 10-0) -- ver unidadesRequeridasEfectivas en
    # el frontend.
    tipo_estructura_emergencia: Literal[
        "vivienda", "edificio_residencial", "equipamiento",
        "industrial", "espacio_publico", "vegetacion", "vehiculo",
    ] | None = None
    # Piso donde ocurre el incidente (emergencia.emergencia.piso_emergencia).
    # Solo es relevante para tipo_estructura_emergencia in
    # (edificio_residencial, equipamiento): un incendio en el 1er piso de un
    # edificio no necesita Escala Mecanica igual que uno en el 5to piso.
    # None (sin especificar) se trata del lado conservador en el frontend
    # (se asume que si podria necesitarla).
    piso_emergencia: int | None = None

#-------------------------------


class LoginRequest(BaseModel):
    email: str
    password: str

class LoginResponse(BaseModel):
    token: str
    nombre: str
    email: str
    rol: str

@app.get("/health")
def health():
    return {"status":"ok","service":"emergency-resource-api"}


#NUEVA PARA LA BASE DE DATOS -------------------------------
@app.post("/emergencies")
def crear_emergencia(datos: EmergencyCreate, usuario: Usuario = Depends(requiere_admin)):
    """Ingreso rapido de emergencias (CAD) -- solo admin (ver requiere_admin).
    El codigo debe existir en el catalogo real (emergencia.tipo_emergencia,
    el mismo que expone GET /catalog/claves) para no insertar una clave
    inventada que despues rompa el JOIN de GET /emergencies. El estado
    siempre se fuerza a 'Activa': este endpoint solo sirve para reportar
    una emergencia nueva, nunca para crear una ya cerrada.

    La validacion es contra emergencia.tipo_emergencia (obtener_tipos()),
    NO contra CLAVES_RADIALES -- ese dict en core/radio_codes.py es un
    subconjunto mas chico (solo los codigos con requisitos de unidades ya
    modelados para el algoritmo de asignacion) y quedaria desactualizado
    cada vez que se agrega un codigo nuevo solo al catalogo de la base."""
    codigos_validos = {t["codigo"] for t in obtener_tipos()}
    if datos.codigo_emergencia not in codigos_validos:
        raise HTTPException(
            status_code=404,
            detail=f"Código de emergencia '{datos.codigo_emergencia}' no existe en el catálogo.",
        )

    conexion = None

    try:
        conexion = obtener_conexion()

        with conexion.cursor() as cursor:
            # El formulario de ingreso rapido nunca manda id_zona -- se
            # resuelve sola a partir de lat/lng con los poligonos reales de
            # zonificacion (core/zonificacion.py, INE 2024 + sectores),
            # necesaria para que esa emergencia entre en el mapa de calor
            # de demanda ML (emergencia.prediccion/registro_historico).
            from core.zonificacion import resolver_zona
            try:
                id_zona = resolver_zona(cursor, datos.latitud_emergencia,
                                       datos.longitud_emergencia, datos.id_zona)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            cursor.execute(
                """
                INSERT INTO emergencia.emergencia (
                    codigo_emergencia,
                    direccion_emergencia,
                    latitud_emergencia,
                    longitud_emergencia,
                    prioridad_emergencia,
                    estado_emergencia, id_zona,
                    tipo_estructura_emergencia, piso_emergencia, fecha_creacion_emergencia
                )
                VALUES (%s, %s, %s, %s, %s, 'Activa', %s, %s, %s,
                        CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')
                RETURNING id_emergencia,
                          codigo_emergencia,
                          direccion_emergencia,
                          latitud_emergencia,
                          longitud_emergencia,
                          prioridad_emergencia,
                          estado_emergencia,
                          fecha_creacion_emergencia, id_zona,
                          tipo_estructura_emergencia, piso_emergencia;
                """,
                (
                    datos.codigo_emergencia,
                    datos.direccion_emergencia,
                    datos.latitud_emergencia,
                    datos.longitud_emergencia,
                    datos.prioridad_emergencia,
                    id_zona,
                    datos.tipo_estructura_emergencia,
                    datos.piso_emergencia,
                ),
            )

            emergencia = cursor.fetchone()

        conexion.commit()

        return {
            "id_emergencia": emergencia[0],
            "codigo_emergencia": emergencia[1],
            "direccion_emergencia": emergencia[2],
            "latitud_emergencia": emergencia[3],
            "longitud_emergencia": emergencia[4],
            "prioridad_emergencia": emergencia[5],
            "estado_emergencia": emergencia[6],
            "fecha_creacion_emergencia": fecha_emergencia_api(emergencia[7]),
            "id_zona": emergencia[8],
            "tipo_estructura_emergencia": emergencia[9],
            "piso_emergencia": emergencia[10],
        }

    except HTTPException:
        if conexion:
            conexion.rollback()
        raise

    except Exception as e:
        if conexion:
            conexion.rollback()

        raise HTTPException(
            status_code=500,
            detail=f"Error al crear la emergencia: {str(e)}"
        )

    finally:
        if conexion:
            conexion.close()


@app.get("/emergencies")
def obtener_emergencias(usuario: Usuario = Depends(usuario_actual)):
    # DEF-02 (ver matriz de pruebas de seguridad): este endpoint no exigia
    # sesion, a diferencia de todos sus pares -- exponia direccion,
    # coordenadas y estado de cada emergencia a cualquiera sin login.
    conexion = None

    try:
        conexion = obtener_conexion()

        with conexion.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    e.id_emergencia,
                    e.codigo_emergencia,
                    t.nombre_emergencia,
                    e.direccion_emergencia,
                    e.latitud_emergencia,
                    e.longitud_emergencia,
                    e.prioridad_emergencia,
                    e.estado_emergencia,
                    e.fecha_creacion_emergencia,
                    e.fecha_cierre_emergencia,
                    e.id_zona,
                    e.tipo_estructura_emergencia,
                    e.piso_emergencia
                FROM emergencia.emergencia e
                INNER JOIN emergencia.tipo_emergencia t
                    ON e.codigo_emergencia = t.codigo_emergencia
                ORDER BY e.fecha_creacion_emergencia DESC;
                """
            )

            filas = cursor.fetchall()

        return {
            "emergencies": [
                {
                    "id_emergencia": fila[0],
                    "codigo_emergencia": fila[1],
                    "nombre_emergencia": fila[2],
                    "direccion_emergencia": fila[3],
                    "latitud_emergencia": fila[4],
                    "longitud_emergencia": fila[5],
                    "prioridad_emergencia": fila[6],
                    "estado_emergencia": fila[7],
                    "fecha_creacion_emergencia": fecha_emergencia_api(fila[8]),
                    "fecha_cierre_emergencia": fecha_emergencia_api(fila[9]),
                    "id_zona": fila[10],
                    "tipo_estructura_emergencia": fila[11],
                    "piso_emergencia": fila[12],
                }
                for fila in filas
            ]
        }

    except Exception as e:
        # DEF-03 (ver matriz de pruebas de seguridad): antes se reenviaba
        # str(e) tal cual al cliente -- un error de conexion a Postgres
        # exponia usuario de BD, hosts y puerto en la respuesta HTTP. El
        # detalle real queda solo en este log del servidor.
        print(f"[/emergencies] Error al obtener emergencias: {e}")
        raise HTTPException(
            status_code=500,
            detail="No se pudo obtener las emergencias."
        )

    finally:
        if conexion:
            conexion.close()
#-------------------------------


def _marcar_estado_usuario(email: str, estado: str) -> None:
    """Refleja en emergencia.usuario si esta cuenta esta efectivamente
    logueada en la app ahora mismo (estado_usuario = 'activo'/'inactivo').
    No todas las cuentas de core/auth.py tienen fila en emergencia.usuario
    (ver _resolver_id_usuario): si no existe, simplemente no hay nada que
    marcar -- el login/logout no debe fallar por esto."""
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        cursor.execute(
            "UPDATE emergencia.usuario SET estado_usuario = %s WHERE email_usuario = %s",
            (estado, email),
        )
        conexion.commit()


@app.post("/auth/login", response_model=LoginResponse)
def login(datos: LoginRequest):
    """Login sin registro: solo los 3 operadores fijos definidos en
    core/auth.py pueden entrar. Las contraseñas se verifican contra su
    hash bcrypt, nunca en texto plano."""
    try:
        usuario = verificar_credenciales(datos.email, datos.password)
    except CuentaBloqueada as exc:
        # DEF-01 (ver matriz de pruebas de seguridad): demasiados intentos
        # fallidos seguidos para esta cuenta -- 429 con cuanto falta para
        # poder reintentar, en vez de seguir aceptando intentos ilimitados.
        raise HTTPException(
            status_code=429,
            detail=f"Demasiados intentos fallidos. Intenta de nuevo en {exc.segundos_restantes} segundos.",
            headers={"Retry-After": str(exc.segundos_restantes)},
        )
    if not usuario:
        raise HTTPException(status_code=401, detail="Correo o contraseña incorrectos")
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        # Solo un operador usa la app a la vez en este despliegue de demo (no
        # hay sesiones concurrentes reales que trackear): al loguearse, esa
        # es la unica cuenta "activa" -- el resto queda inactiva aunque se
        # haya quedado pegada en "activo" por un cierre de pestaña anterior
        # sin logout explicito.
        cursor.execute("UPDATE emergencia.usuario SET estado_usuario = 'inactivo' WHERE email_usuario != %s", (usuario.email,))
        cursor.execute("UPDATE emergencia.usuario SET estado_usuario = 'activo' WHERE email_usuario = %s", (usuario.email,))
        conexion.commit()
    return LoginResponse(token=crear_token(usuario), nombre=usuario.nombre, email=usuario.email, rol=usuario.rol)


@app.post("/auth/logout")
def logout(usuario: Usuario = Depends(usuario_actual)):
    """Marca la cuenta como inactiva en emergencia.usuario al cerrar
    sesion, para que el indicador "Activo" del resto de vistas refleje la
    realidad y no quede pegado en verde con la sesion ya cerrada."""
    _marcar_estado_usuario(usuario.email, "inactivo")
    return {"ok": True}


# usuario_actual y requiere_admin se definen mas arriba, antes de
# EmergencyCreate/crear_emergencia (que ahora los necesita para exigir rol
# admin al crear una emergencia manualmente).

@app.get("/auth/me")
def auth_me(usuario: Usuario = Depends(usuario_actual)):
    """Permite al frontend validar si el token guardado localmente sigue
    siendo valido (p.ej. al recargar la pagina) sin pedir login de nuevo
    si no hace falta. Tambien devuelve el estado_usuario real de Postgres
    (activo/fuera de servicio) para el badge del header -- SOLO lectura:
    el estado lo cambia el operador a mano desde ese badge (ver
    PATCH /auth/estado) o el login/logout, nunca este endpoint. Incluye
    ademas la compania a la que esta designado (emergencia.usuario.id_compania,
    ver docker/migracion_usuario_compania.sql), si tiene una asignada."""
    activo = False
    compania = None
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        cursor.execute(
            """
            SELECT u.estado_usuario, c.nombre_compania
            FROM emergencia.usuario u
            LEFT JOIN emergencia.compania c ON c.id_compania = u.id_compania
            WHERE u.email_usuario = %s
            """,
            (usuario.email,),
        )
        fila = cursor.fetchone()
        if fila is not None:
            activo = str(fila[0]).lower() == "activo"
            compania = fila[1]
    return {"email": usuario.email, "nombre": usuario.nombre, "rol": usuario.rol, "activo": activo, "compania": compania}


class CambioEstadoUsuario(BaseModel):
    activo: bool


@app.patch("/auth/estado")
def cambiar_estado_usuario(datos: CambioEstadoUsuario, usuario: Usuario = Depends(usuario_actual)):
    """Permite al operador marcarse manualmente "Activo" o "Fuera de
    servicio" desde el badge del header -- es una decision explicita suya,
    no algo que el sistema deba inferir ni sobreescribir solo."""
    _marcar_estado_usuario(usuario.email, "activo" if datos.activo else "inactivo")
    return {"activo": datos.activo}

class CambioEstadoEmergencia(BaseModel):
    estado: Literal["ASIGNADA", "EN_ATENCION", "FINALIZADA"]


@app.patch("/emergencies/{id_emergencia}/status")
def cambiar_estado_emergencia(
    id_emergencia: int,
    datos: CambioEstadoEmergencia,
    usuario: Usuario = Depends(requiere_admin),
):
    """Actualiza el ciclo de vida de una emergencia real en PostgreSQL."""
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                SELECT estado_emergencia
                FROM emergencia.emergencia
                WHERE id_emergencia = %s
                FOR UPDATE
                """,
                (id_emergencia,),
            )
            actual = cursor.fetchone()
            if actual is None:
                raise HTTPException(status_code=404, detail="Emergencia inexistente")
            estado_actual = str(actual[0]).upper()
            permitidos = {
                "ACTIVA": {"ASIGNADA"},
                "ASIGNADA": {"EN_ATENCION"},
                "EN_ATENCION": {"FINALIZADA"},
            }
            if estado_actual == datos.estado:
                conexion.commit()
                return {"ok": True, "estado": datos.estado}
            if datos.estado not in permitidos.get(estado_actual, set()):
                raise HTTPException(
                    status_code=409,
                    detail=f"Transición inválida: {estado_actual} -> {datos.estado}",
                )
            cursor.execute(
                """
                UPDATE emergencia.emergencia
                SET estado_emergencia = %s,
                    fecha_cierre_emergencia = CASE
                        WHEN %s = 'FINALIZADA' THEN CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago'
                        ELSE fecha_cierre_emergencia
                    END
                WHERE id_emergencia = %s
                """,
                (datos.estado, datos.estado, id_emergencia),
            )
        conexion.commit()

        # Traspaso al historico de entrenamiento ML (ver core/historico_emergencias.py,
        # integrado desde la rama develop de Alexsander) -- solo al cerrar de
        # verdad la emergencia. Es aditivo: busca el clima real (Open-Meteo) y
        # fusiona el conteo en el bloque de emergencia.registro_historico que
        # ya exista para esa zona/fecha/bloque/clave, o crea uno nuevo. Nunca
        # bloquea ni revierte el cierre si falla (ver registrar_seguro) -- la
        # emergencia ya quedo FINALIZADA de todas formas, esto solo enriquece
        # el dataset para el modelo de demanda.
        if datos.estado == "FINALIZADA":
            try:
                from core.historico_emergencias import registrar_seguro
                registrar_seguro(id_emergencia)
            except Exception as exc:
                print(f"[historico_emergencias] No se pudo procesar la emergencia {id_emergencia}: {exc}")

        return {"ok": True, "estado": datos.estado}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


def _resolver_id_compania_usuario(email: str) -> int | None:
    """Compania asignada a esta cuenta (emergencia.usuario.id_compania),
    o None si no tiene una asignada. Ver PER05 en la matriz de pruebas de
    seguridad -- antes un visualizador veia los recursos de las 26
    companias; ahora esto se usa para que solo vea/administre la suya."""
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        cursor.execute(
            "SELECT id_compania FROM emergencia.usuario WHERE email_usuario = %s",
            (email,),
        )
        fila = cursor.fetchone()
    return fila[0] if fila else None


@app.get("/resources")
def resources(usuario: Usuario = Depends(usuario_actual)):
    try:
        # admin y soporte necesitan ver todo el sistema para coordinar y
        # atender tickets; visualizador solo ve su propia compania.
        id_compania_filtro = None
        if usuario.rol == "visualizador":
            id_compania_filtro = _resolver_id_compania_usuario(usuario.email)
        return {"resources": obtener_recursos(id_compania_filtro)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron consultar los recursos: {exc}")

class PosicionRecurso(BaseModel):
    lat: float
    lng: float
    estado: Literal["6-0", "6-3", "6-7", "6-8", "6-9"]

@app.patch("/resources/{codigo_recurso}/position")
def actualizar_posicion_recurso(
    codigo_recurso: str,
    datos: PosicionRecurso,
    usuario: Usuario = Depends(requiere_admin),
):
    if not (-90 <= datos.lat <= 90 and -180 <= datos.lng <= 180):
        raise HTTPException(
            status_code=422,
            detail="Coordenadas fuera de rango",
        )

    conexion = obtener_conexion()

    try:
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                UPDATE emergencia.recurso
                SET
                    latitud_recurso = %s,
                    longitud_recurso = %s,
                    estado_radio = %s
                WHERE codigo_recurso = %s
                RETURNING
                    id_recurso,
                    codigo_recurso,
                    latitud_recurso,
                    longitud_recurso,
                    estado_radio
                """,
                (
                    datos.lat,
                    datos.lng,
                    datos.estado,
                    codigo_recurso,
                ),
            )

            fila = cursor.fetchone()

            if fila is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"No existe el recurso {codigo_recurso}",
                )

        conexion.commit()

        return {
            "ok": True,
            "id_recurso": fila[0],
            "codigo_recurso": fila[1],
            "lat": float(fila[2]),
            "lng": float(fila[3]),
            "estado": fila[4],
        }

    except Exception:
        conexion.rollback()
        raise

    finally:
        conexion.close()

class EstadoRecursoUpdate(BaseModel):
    estado: Literal["6-0", "6-9"]

@app.patch("/resources/{codigo_recurso}/estado")
def cambiar_estado_recurso(
    codigo_recurso: str,
    datos: EstadoRecursoUpdate,
    usuario: Usuario = Depends(requiere_admin_o_visualizador),
):
    """Marcar Fuera de servicio (6-9) / Disponible (6-0) -- a diferencia de
    PATCH /resources/{..}/position (que tambien mueve el vehiculo durante
    el despacho y sigue siendo solo-admin), este endpoint NO toca
    latitud/longitud y por eso puede abrirse tambien a visualizador sin
    permitirle mover ni asignar unidades.

    Un visualizador solo puede dar de baja/reactivar recursos de SU PROPIA
    compania (ver PER05 en la matriz de pruebas de seguridad) -- admin
    sigue sin restriccion, porque coordina toda la flota."""
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            if usuario.rol == "visualizador":
                id_compania_usuario = _resolver_id_compania_usuario(usuario.email)
                cursor.execute(
                    "SELECT id_compania FROM emergencia.recurso WHERE codigo_recurso = %s",
                    (codigo_recurso,),
                )
                fila_compania = cursor.fetchone()
                if fila_compania is None:
                    raise HTTPException(status_code=404, detail=f"No existe el recurso {codigo_recurso}")
                if id_compania_usuario is None or fila_compania[0] != id_compania_usuario:
                    raise HTTPException(status_code=403, detail="Solo puedes dar de baja recursos de tu propia compañía")
            cursor.execute(
                """
                UPDATE emergencia.recurso
                SET estado_radio = %s
                WHERE codigo_recurso = %s
                RETURNING id_recurso, codigo_recurso, estado_radio
                """,
                (datos.estado, codigo_recurso),
            )
            fila = cursor.fetchone()
            if fila is None:
                raise HTTPException(status_code=404, detail=f"No existe el recurso {codigo_recurso}")
        conexion.commit()
        return {"ok": True, "id_recurso": fila[0], "codigo_recurso": fila[1], "estado": fila[2]}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()

# Prefijo real de la unidad (ver core/vehicle_types.py y core/radio_codes.py)
# -> categoria generica de ResourceType que ya usa el frontend (main.tsx,
# tipoRecursoBD). Permite traducir los requisitos de CLAVES_RADIALES (que
# hablan en terminos de prefijos reales: B, BF, Q, etc.) al mismo vocabulario
# con el que el frontend ya filtra/cuenta recursos, sin duplicar la lista en
# los dos lados.
_PREFIJO_A_TIPO_RECURSO = {
    "BF": "Forestal", "BR": "Forestal",
    "R": "Rescate", "RX": "Rescate",
    "H": "Hazmat",
    "Q": "Escala", "M": "Escala",
    "Z": "Cisterna",
    "B": "Bomberos", "BX": "Bomberos", "B-U": "Bomberos",
}


def _unidades_requeridas_para(codigo: str) -> list[dict] | None:
    """Cuantas unidades de que tipo exige una clave para considerarse
    cubierta (ver CLAVES_RADIALES, core/radio_codes.py -- ese diccionario ya
    traia esta informacion desde que se definio el estandar de claves
    radiales, pero nunca se habia conectado a ningun endpoint). Devuelve
    None para una clave sin este criterio ya modelado (ver el comentario en
    POST /emergencies: CLAVES_RADIALES es un subconjunto mas chico que
    emergencia.tipo_emergencia) -- el frontend interpreta None como "sin
    requisito de cantidad conocido" y mantiene el comportamiento de una sola
    unidad por emergencia para esos casos, en vez de inventar una cifra."""
    clave = CLAVES_RADIALES.get(codigo)
    if not clave:
        return None
    return [
        {
            "tipos": sorted({_PREFIJO_A_TIPO_RECURSO.get(p, "Bomberos") for p in req.tipos_alternativos}),
            "cantidad": req.cantidad,
        }
        for req in clave.unidades_requeridas
    ]


@app.get("/catalog/claves")
def catalog_claves(usuario: Usuario = Depends(usuario_actual)):
    try:
        tipos = obtener_tipos()
        for t in tipos:
            t["unidades_requeridas"] = _unidades_requeridas_para(t["codigo"])
        return {"claves": tipos}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron consultar las claves: {exc}")

@app.get("/zones")
def zones(usuario: Usuario = Depends(usuario_actual)):
    try:
        return {"zones": obtener_zonas()}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron consultar las zonas: {exc}")


@app.get("/companies/personal-activo")
def personal_activo_por_compania(usuario: Usuario = Depends(usuario_actual)):
    """Cuenta de operadores marcados 'activo' (ver PATCH /auth/estado) por
    compania, segun emergencia.usuario.id_compania. Es una base simple:
    hoy solo hay 4 cuentas de sistema (no un bombero por cada persona real
    del cuartel), asi que el conteo real por compania sera 0 o 1 mientras
    no se agreguen mas cuentas -- pero la logica ya queda lista para crecer
    sin cambios cuando eso pase. NO devuelve nombre ni correo, solo el
    conteo, a proposito."""
    try:
        with obtener_conexion() as conexion, conexion.cursor() as cursor:
            cursor.execute("""
                SELECT c.nombre_compania,
                       COUNT(u.id_usuario) FILTER (WHERE u.estado_usuario = 'activo')
                FROM emergencia.compania c
                LEFT JOIN emergencia.usuario u ON u.id_compania = c.id_compania
                GROUP BY c.id_compania, c.nombre_compania
            """)
            filas = cursor.fetchall()
        return {"personal_activo": {nombre: activos for nombre, activos in filas}}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudo consultar el personal activo: {exc}")

# DEF-05 (ver matriz de pruebas de seguridad): 30 requests seguidas a este
# endpoint no encontraban ningun rechazo. 20 por minuto alcanza de sobra
# para el polling normal del frontend (cada 10s, ver main.tsx) sin dejar
# la puerta abierta a repetirlo sin limite.
_limitador_prediccion = LimitadorTasa(limite=20, ventana_segundos=60)


@app.get("/prediction/demand")
def prediction_demand(horizon: int = 4, fecha: str | None = None, recalcular: bool = False, usuario: Usuario = Depends(usuario_actual)):
    """Prediccion de demanda esperada por zona/periodo/tipo (modelo ML).

    `fecha` (opcional) permite simular una fecha/hora distinta a la actual,
    en formato ISO (p.ej. '2026-01-15T15:00:00'), util para verificar que el
    modelo captura patrones estacionales/horarios (p.ej. mas incendios
    forestales en enero que en junio) sin tener que esperar a esa fecha real.

    Cachea el resultado en PostgreSQL (emergencia.prediccion): si ya hay una
    prediccion reciente (<60 min) para el mismo bloque horario no se
    recalcula en cada GET -- `recalcular=true` fuerza un calculo nuevo.
    """
    try:
        _limitador_prediccion.verificar(usuario.email)
    except LimiteExcedido as exc:
        raise HTTPException(
            status_code=429,
            detail=f"Demasiadas solicitudes. Intenta de nuevo en {exc.segundos_restantes} segundos.",
            headers={"Retry-After": str(exc.segundos_restantes)},
        )
    now = None
    if fecha:
        try:
            now = datetime.fromisoformat(fecha)
        except ValueError:
            raise HTTPException(status_code=400, detail="fecha invalida, usa formato ISO: 2026-01-15T15:00:00")
    try:
        return obtener_o_generar(now=now, horizon=horizon, recalcular=recalcular)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo guardar la predicción en PostgreSQL: {e}",
        )


@app.get("/prediction/models")
def prediction_models(limite: int = 10, usuario: Usuario = Depends(usuario_actual)):
    """Consulta modelos y metricas entrenadas almacenadas en PostgreSQL."""
    try:
        return {"modelos": listado_modelos(limite)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron leer los modelos: {exc}")

@app.get("/route")
def route(origen_lat: float, origen_lng: float, destino_lat: float, destino_lng: float, usuario: Usuario = Depends(usuario_actual)):
    """Ruta real siguiendo calles (no una linea recta), calculada por el
    motor de ruteo local OSRM sobre datos reales de OpenStreetMap de la
    Region de Valparaiso (ver routing/README.md). Si el servicio OSRM no
    esta disponible (p.ej. no se levanto el contenedor), devuelve una
    linea recta de dos puntos como respaldo, para que el mapa no se rompa
    aunque no siga calles reales en ese caso."""
    fallback = {
        "puntos": [
            {"lat": origen_lat, "lng": origen_lng},
            {"lat": destino_lat, "lng": destino_lng},
        ],
        "distancia_km": None,
        "duracion_min": None,
        "fuente": "linea_recta_fallback",
    }
    try:
        resp = httpx.get(
            f"{OSRM_URL}/route/v1/driving/{origen_lng},{origen_lat};{destino_lng},{destino_lat}",
            params={"overview": "full", "geometries": "geojson"},
            timeout=4.0,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            raise HTTPException(
                status_code=503,
                detail="OSRM no pudo calcular la ruta."
            )
        ruta = data["routes"][0]
        puntos = [{"lat": c[1], "lng": c[0]} for c in ruta["geometry"]["coordinates"]]
        if len(puntos) < 2:
            return fallback
        return {
            "puntos": puntos,
            "distancia_km": round(ruta["distance"] / 1000, 2),
            "duracion_min": round(ruta["duration"] / 60, 1),
            "fuente": "osrm_local",
        }
    except (httpx.HTTPError, KeyError, ValueError, IndexError):
        raise HTTPException(
            status_code=503,
            detail="El servicio OSRM Docker no está disponible."
        )


# Historial de acciones (asignacion, llegada, finalizacion, regreso, etc.)
# persistido en un archivo local -- NO en Postgres (regla explicita del
# equipo: la base de datos la administra Alexsander, no se toca para nada
# que no sea estrictamente necesario). Antes vivia solo en memoria del
# navegador y se perdia con cada F5; con esto sobrevive a recargas y se ve
# igual desde cualquier cuenta (admin o visualizador).
HISTORIAL_PATH = Path(os.getenv("HISTORIAL_PATH", Path(__file__).resolve().parent / "historial_acciones.json"))
HISTORIAL_MAX = 300
_historial_lock = threading.Lock()


def _leer_historial() -> list[dict[str, Any]]:
    if not HISTORIAL_PATH.exists():
        return []
    try:
        import json
        with HISTORIAL_PATH.open("r", encoding="utf-8") as f:
            datos = json.load(f)
        return datos if isinstance(datos, list) else []
    except (OSError, ValueError):
        return []


def _escribir_historial(entradas: list[dict[str, Any]]) -> None:
    import json
    try:
        with HISTORIAL_PATH.open("w", encoding="utf-8") as f:
            json.dump(entradas, f, ensure_ascii=False)
    except OSError as exc:
        print(f"[historial] No se pudo guardar historial_acciones.json: {exc}")


class HistorialCreate(BaseModel):
    tipo: str
    texto: str


@app.post("/historial")
def registrar_evento_historial(datos: HistorialCreate, usuario: Usuario = Depends(usuario_actual)):
    with _historial_lock:
        entradas = _leer_historial()
        entradas.insert(0, {
            "id": (entradas[0]["id"] + 1) if entradas else 1,
            "ts": int(datetime.now(timezone.utc).timestamp() * 1000),
            "tipo": datos.tipo,
            "texto": datos.texto,
        })
        entradas = entradas[:HISTORIAL_MAX]
        _escribir_historial(entradas)
    return {"ok": True}


@app.get("/historial")
def obtener_historial_persistido(usuario: Usuario = Depends(usuario_actual)):
    with _historial_lock:
        return {"historial": _leer_historial()}


# Estado compartido de la simulacion en curso (recursos, cola de
# emergencias, historial, metricas), publicado por el navegador del
# operador admin que esta manejando el despacho y consultado por las
# demas cuentas (rol visualizador) para ver lo mismo en vivo, en vez de
# simular cada una por su cuenta con datos que irian divergiendo.
#
# Guardado 100% en memoria (no en base de datos): un reinicio del backend
# lo borra por completo, tal como se pidio -- cada sesion vuelve a
# arrancar desde el estado inicial simulado.
_estado_compartido: dict[str, Any] | None = None
_estado_lock = threading.Lock()

@app.post("/state")
def publicar_estado(payload: dict[str, Any] = Body(...), usuario: Usuario = Depends(requiere_admin)):
    """El operador admin que esta manejando el despacho publica aca su
    estado actual (recursos, cola, historial, metricas) cada pocos
    segundos. No se valida el contenido a detalle (es un espejo de lo que
    ya calculo y valido el propio frontend del admin) -- este endpoint
    solo lo guarda y le agrega quien y cuando lo publico."""
    global _estado_compartido
    with _estado_lock:
        _estado_compartido = {
            **payload,
            "publicadoPor": usuario.nombre,
            "publicadoEn": datetime.now(timezone.utc).isoformat(),
        }
    return {"ok": True}

@app.get("/state")
def obtener_estado(usuario: Usuario = Depends(usuario_actual)):
    """Cualquier cuenta autenticada (admin o visualizador) puede leer el
    ultimo estado publicado. Si nadie ha publicado aun (recien reiniciado
    el backend, o el admin todavia no abre su sesion), devuelve
    publicado=False para que el frontend sepa que no hay datos en vivo
    todavia y no lo confunda con una cola de emergencias vacia real."""
    with _estado_lock:
        if _estado_compartido is None:
            return {"publicado": False}
        return {"publicado": True, **_estado_compartido}

# Tipos de recurso compatibles con cada clave radial (10-X), segun el
# equipamiento real que exige cada tipo de emergencia.
TIPOS_COMPATIBLES = {
    "10-0": {"Bomberos", "Escala", "Cisterna"},
    "10-1": {"Bomberos", "Cisterna"},
    "10-2": {"Forestal", "Cisterna"},
    "10-3": {"Rescate", "Escala"},
    "10-4": {"Rescate"},
    "10-5": {"Hazmat"},
    "10-12": {"Bomberos", "Rescate", "Forestal", "Hazmat", "Cisterna", "Escala"},
}


@app.post("/assignment/recommend")
def recommend(emergency: Emergency, usuario: Usuario = Depends(requiere_admin)):
    """Recomendacion multicriterio real: entre los recursos disponibles
    (6-0) y compatibles con la clave radial de la emergencia, se elige el
    de mejor puntaje combinando distancia real (Haversine), ETA y dotacion."""
    tipos_info = {t["codigo"]: t for t in obtener_tipos()}
    terreno = tipos_info.get(emergency.type, {}).get("terreno", "urbano")
    compatibles = TIPOS_COMPATIBLES.get(emergency.type, set())

    candidatos = []
    for r in obtener_recursos():
        if not r["disponible"] or r["lat"] is None or r["lng"] is None:
            continue
        if r["tipo"] not in compatibles:
            continue
        eta_info = calcular_eta(r["lat"], r["lng"], emergency.lat, emergency.lng, terreno)
        candidatos.append({**r, **eta_info})

    if not candidatos:
        raise HTTPException(status_code=404, detail="No hay recursos disponibles y compatibles para esta emergencia")

    def score(r):
        dotacion = r["dotacion"] or 0
        valor = 100 - min(r["distancia_km"] * 3, 40) - min(r["eta_min"] * 1.5, 30) + min(dotacion * 2, 20)
        return round(max(0, min(100, valor)), 1)

    mejor = max(candidatos, key=score)
    return {
        "recommended_resource": mejor["codigo"],
        "id_recurso": mejor["id_recurso"],
        "score": score(mejor),
        "distancia_km": mejor["distancia_km"],
        "eta_min": mejor["eta_min"],
        "compania": mejor["compania"],
        "criteria": ["priority", "type", "compatibility", "availability", "distance", "eta", "capacity"],
    }



@app.get("/emergencies/{id_emergencia}/eta")
def eta_por_emergencia(id_emergencia: int, usuario: Usuario = Depends(usuario_actual)):
    """Distancia/ETA de TODOS los recursos hacia una emergencia, calculados
    aca con la posicion que cada recurso tiene guardada en Postgres en este
    momento (ver core/eta.py). Reemplaza el calculo que antes hacia el
    frontend en JavaScript (Haversine + velocidad fija, duplicado de este
    mismo codigo) -- ahora el navegador solo consulta este endpoint (ver
    pollEtaPorEmergencia en main.tsx) y usa la respuesta tal cual, sin
    recalcular nada por su cuenta. La posicion de cada recurso en Postgres
    se actualiza cada ~2s durante un despacho (PATCH /resources/{..}/position),
    asi que estos numeros se refrescan al mismo ritmo -- el vehiculo se
    sigue viendo moverse fluido en el mapa porque esa animacion es aparte
    (interpolacion visual en el navegador sobre la ruta real de OSRM), solo
    la cifra de distancia/ETA mostrada en pantalla sigue ese ritmo de ~2s."""
    try:
        with obtener_conexion() as conexion, conexion.cursor() as cursor:
            cursor.execute(
                """
                SELECT e.latitud_emergencia, e.longitud_emergencia, t.terreno_emergencia
                FROM emergencia.emergencia e
                JOIN emergencia.tipo_emergencia t ON t.codigo_emergencia = e.codigo_emergencia
                WHERE e.id_emergencia = %s
                """,
                (id_emergencia,),
            )
            fila = cursor.fetchone()

            if fila is None:
                raise HTTPException(status_code=404, detail="La emergencia no existe")

            lat_emergencia, lng_emergencia, terreno = fila[0], fila[1], fila[2] or "urbano"

            if lat_emergencia is None or lng_emergencia is None:
                return {"eta": []}

            cursor.execute(
                """
                SELECT id_recurso, latitud_recurso, longitud_recurso
                FROM emergencia.recurso
                WHERE latitud_recurso IS NOT NULL AND longitud_recurso IS NOT NULL
                """
            )
            recursos = cursor.fetchall()

        resultado = [
            {
                "id_recurso": id_recurso,
                **calcular_eta(lat_recurso, lng_recurso, lat_emergencia, lng_emergencia, terreno),
            }
            for id_recurso, lat_recurso, lng_recurso in recursos
        ]
        return {"eta": resultado}

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudo calcular el ETA: {exc}")


@app.get("/assignments/activas")
def asignaciones_activas(usuario: Usuario = Depends(usuario_actual)):
    """Asignaciones ASIGNADO sin retorno registrado (ver fecha_retorno),
    es decir recursos que a esta hora deberian seguir en camino/en escena
    de alguna emergencia. El frontend la usa SOLO al cargar la pagina para
    reconstruir el campo `destino` de cada recurso (ver cargarRecursos en
    main.tsx) -- ese campo es la unica forma que tiene el cliente de saber
    que unidad cubre que emergencia, y hoy vive solo en memoria del
    navegador. Sin este endpoint, cualquier recarga de pagina mientras hay
    despachos en curso pierde esa informacion: el recurso sigue mostrando
    su estado radial real (6-3/6-7/6-8, eso si viene de Postgres), pero el
    sistema ya no sabe a que emergencia pertenece, asi que nunca detecta
    que esa emergencia ya tiene todas sus unidades y la deja trabada en
    EN_ATENCION para siempre."""
    try:
        with obtener_conexion() as conexion, conexion.cursor() as cursor:
            cursor.execute(
                """
                SELECT id_recurso, id_emergencia
                FROM emergencia.asignacion
                WHERE estado_asignacion = 'ASIGNADO' AND fecha_retorno IS NULL
                """
            )
            filas = cursor.fetchall()
        return {"asignaciones": [{"id_recurso": r[0], "id_emergencia": r[1]} for r in filas]}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron leer las asignaciones activas: {exc}")


@app.post("/assignments")
def asignar_recurso(
    id_emergencia: int,
    id_recurso: int,
    tipo_asignacion: str = "Automatica",
    puntaje_asignacion: float | None = None,
    distancia_km: float | None = None,
    eta_minutos: int | None = None,
    estado_asignacion: Literal["ASIGNADO", "RECHAZADO"] = "ASIGNADO",
    usuario: Usuario = Depends(requiere_admin),
):
    """Deja el registro historico real del despacho (ver emergencia.asignacion):
    quien lo hizo, a que distancia/ETA estaba el recurso en ese momento, y con
    que puntaje. El frontend (despacharUnidad en main.tsx) ya calculaba esos
    numeros para la animacion, pero nunca los persistia aca -- la tabla
    quedaba vacia pese a que el endpoint ya existia.

    estado_asignacion='RECHAZADO' deja registrada tambien cada vez que el
    operador rechaza la recomendacion automatica (ver handleRechazar en
    main.tsx) -- mismo recurso/distancia/ETA/puntaje que se le mostraron en
    pantalla al rechazarla, pero sin tocar el estado real del recurso (sigue
    disponible, nunca se le despacho de verdad).

    distancia_km/eta_minutos que mande el cliente NUNCA se guardan tal cual:
    son solo una referencia para detectar discrepancias grandes (ver log mas
    abajo). El valor que queda en Postgres SIEMPRE se recalcula aca, con las
    coordenadas reales de recurso.emergencia leidas en este mismo instante
    (misma formula de core/eta.py que ya se usaba para /route) -- asi la
    tabla asignacion queda con una unica fuente de verdad del lado servidor,
    en vez de confiar en un numero que el navegador pudo calcular con datos
    desactualizados (o, en teoria, inventados)."""
    conexion = None

    try:
        # id_usuario SIEMPRE se resuelve en el servidor a partir del JWT, nunca
        # se confia en un valor que mande el cliente (quien hizo la asignacion
        # es quien esta autenticado en esta misma request, no un dato que el
        # navegador pueda inventar).
        id_usuario = _resolver_id_usuario(usuario.email)
        conexion = obtener_conexion()

        with conexion.cursor() as cursor:

            # 1. Verificar que la emergencia esté activa y traer sus
            # coordenadas + el terreno de su tipo (ver tipo_emergencia.
            # terreno_emergencia) para poder recalcular el ETA real.
            # FOR UPDATE: bloquea la fila hasta el commit/rollback de esta
            # transaccion, para que dos despachos casi simultaneos a la misma
            # emergencia (ej. la recomendacion automatica y un clic manual)
            # no pasen ambos la validacion antes de que ninguno haya
            # insertado todavia.
            cursor.execute(
                """
                SELECT e.estado_emergencia, e.latitud_emergencia, e.longitud_emergencia,
                       t.terreno_emergencia
                FROM emergencia.emergencia e
                JOIN emergencia.tipo_emergencia t ON t.codigo_emergencia = e.codigo_emergencia
                WHERE e.id_emergencia = %s
                FOR UPDATE OF e
                """,
                (id_emergencia,)
            )

            emergencia = cursor.fetchone()

            if not emergencia:
                raise HTTPException(
                    status_code=404,
                    detail="La emergencia no existe"
                )

            # No solo "Activa": una clave con varias unidades requeridas (ver
            # unidades_requeridas) sigue despachando la 2da/3ra unidad aunque
            # la emergencia ya haya avanzado a ASIGNADA/EN_ATENCION con la
            # primera -- exigir "Activa" aca rechazaba esos despachos
            # posteriores con 400, justo lo contrario de la funcionalidad
            # multi-unidad que se agrego esta misma sesion. estado_emergencia
            # siempre se guarda en mayusculas salvo "Activa" (ver INSERT en
            # /emergencies y el Literal de PATCH .../estado).
            if emergencia[0] not in ("Activa", "ASIGNADA", "EN_ATENCION"):
                raise HTTPException(
                    status_code=400,
                    detail="La emergencia no está activa"
                )

            # Limite server-side de unidades por emergencia (espejo de
            # LIMITE_UNIDADES_POR_EMERGENCIA en el frontend, main.tsx): sin
            # esto, ampliar la condicion de arriba para soportar despachos
            # multi-unidad tambien habilitaba despachar un numero ilimitado
            # de unidades a una misma emergencia desde una llamada directa a
            # la API (la unica limitacion antes era del lado del cliente).
            if estado_asignacion == "ASIGNADO":
                cursor.execute(
                    """
                    SELECT count(*) FROM emergencia.asignacion
                    WHERE id_emergencia = %s AND estado_asignacion = 'ASIGNADO'
                    """,
                    (id_emergencia,)
                )
                if cursor.fetchone()[0] >= 3:
                    raise HTTPException(
                        status_code=400,
                        detail="Esta emergencia ya alcanzó el máximo de unidades asignadas"
                    )

            lat_emergencia, lng_emergencia, terreno = emergencia[1], emergencia[2], emergencia[3] or "urbano"

            # 2. Verificar que el recurso esté disponible y traer su posición
            # actual. FOR UPDATE por la misma razon que la emergencia arriba
            # -- evita que dos requests concurrentes despachen la MISMA
            # unidad a dos emergencias distintas.
            cursor.execute(
                """
                SELECT estado_radio, latitud_recurso, longitud_recurso
                FROM emergencia.recurso
                WHERE id_recurso = %s
                FOR UPDATE
                """,
                (id_recurso,)
            )

            recurso = cursor.fetchone()

            if not recurso:
                raise HTTPException(
                    status_code=404,
                    detail="El recurso no existe"
                )

            # Solo se exige disponibilidad cuando de verdad se va a despachar.
            # Un RECHAZADO es solo una decision registrada -- el recurso nunca
            # se mueve, asi que no tiene sentido bloquear el registro si por
            # cualquier razon ya no figura como disponible en ese instante.
            # "6-8" (regresando) tambien es un estado valido para asignar:
            # esDisponible() en el frontend ya trata una unidad regresando
            # como redirigible a una nueva emergencia (panel de recomendacion
            # la muestra como "Regresando (redirigida a esta emergencia)"),
            # pero aca se rechazaba con 400 igual.
            if estado_asignacion == "ASIGNADO" and recurso[0] not in ("6-0", "Disponible", "6-8"):
                raise HTTPException(
                    status_code=400,
                    detail="El recurso no está disponible"
                )

            lat_recurso, lng_recurso = recurso[1], recurso[2]

            # Recalculo server-side: es la unica fuente de verdad que se
            # persiste. Si por algun motivo el recurso o la emergencia no
            # tienen coordenadas cargadas, se cae de vuelta a lo que mando
            # el cliente antes que guardar un NULL.
            if lat_recurso is not None and lng_recurso is not None and \
               lat_emergencia is not None and lng_emergencia is not None:
                eta_info = calcular_eta(lat_recurso, lng_recurso, lat_emergencia, lng_emergencia, terreno)
                distancia_real_km = eta_info["distancia_km"]
                # eta_minutos es columna integer en Postgres (ver emergencia.asignacion)
                eta_real_min = round(eta_info["eta_min"])

                # No bloquea nada -- solo deja constancia en los logs si el
                # numero que mostraba la pantalla se alejo mucho del real
                # (por ejemplo, si el recurso se movio entre que se calculo
                # la recomendacion y se confirmo el despacho).
                if distancia_km is not None and abs(distancia_km - distancia_real_km) > 1:
                    print(
                        f"[assignments] distancia_km del cliente ({distancia_km}) difiere de la "
                        f"recalculada en servidor ({distancia_real_km}) para recurso {id_recurso}"
                    )
            else:
                distancia_real_km, eta_real_min = distancia_km, eta_minutos

            # 3. Crear la asignación (o el rechazo, ver estado_asignacion)
            cursor.execute(
                """
                INSERT INTO emergencia.asignacion (
                    id_emergencia,
                    id_recurso,
                    id_usuario,
                    tipo_asignacion,
                    puntaje_asignacion,
                    distancia_km,
                    eta_minutos,
                    fecha_asignacion,
                    estado_asignacion
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s,
                    CURRENT_TIMESTAMP,
                    %s
                )
                RETURNING id_asignacion
                """,
                (
                    id_emergencia,
                    id_recurso,
                    id_usuario,
                    tipo_asignacion,
                    puntaje_asignacion,
                    distancia_real_km,
                    eta_real_min,
                    estado_asignacion,
                )
            )

            id_asignacion = cursor.fetchone()[0]

            # 4. Cambiar recurso a EN TRAYECTO (6-3) -- recien se esta
            # despachando hacia la emergencia, todavia no esta "regresando"
            # (6-8, que es el estado al terminar). El ciclo completo de
            # radioState lo sigue manejando el frontend via
            # PATCH /resources/{codigo}/position cada 2s. Si es un rechazo,
            # el recurso nunca se despacho -- no se toca su estado.
            if estado_asignacion == "ASIGNADO":
                cursor.execute(
                """
                UPDATE emergencia.recurso
                SET estado_radio = '6-3'
                WHERE id_recurso = %s
                """,
                (id_recurso,)
            )

        conexion.commit()

        return {
            "mensaje": "Recurso asignado correctamente" if estado_asignacion == "ASIGNADO" else "Rechazo registrado",
            "id_asignacion": id_asignacion,
            "estado_emergencia": "Activa",
            "estado_recurso": "En trayecto" if estado_asignacion == "ASIGNADO" else recurso[0],
            "estado_asignacion": estado_asignacion,
        }

    except HTTPException:
        if conexion:
            conexion.rollback()
        raise

    except Exception as e:
        if conexion:
            conexion.rollback()

        raise HTTPException(
            status_code=500,
            detail=f"Error al asignar recurso: {str(e)}"
        )

    finally:
        if conexion:
            conexion.close()


@app.patch("/assignments/retorno")
def marcar_retorno_asignacion(
    id_emergencia: int,
    id_recurso: int,
    usuario: Usuario = Depends(requiere_admin),
):
    """Registra fecha_retorno en emergencia.asignacion apenas el recurso
    termina de atender y comienza a volver a su cuartel (radioState pasa a
    6-8 en main.tsx, tanto en el ciclo normal como al retomar un despacho
    tras un F5). Hasta ahora esa columna quedaba siempre en NULL porque
    nada la llenaba. Se actualiza la asignacion ASIGNADO mas reciente de
    ese recurso para esa emergencia que todavia no tenga retorno -- evita
    pisar fecha_retorno si por algun motivo se llama dos veces."""
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                UPDATE emergencia.asignacion
                SET fecha_retorno = CURRENT_TIMESTAMP
                WHERE id_asignacion = (
                    SELECT id_asignacion
                    FROM emergencia.asignacion
                    WHERE id_emergencia = %s
                      AND id_recurso = %s
                      AND estado_asignacion = 'ASIGNADO'
                      AND fecha_retorno IS NULL
                    ORDER BY fecha_asignacion DESC
                    LIMIT 1
                )
                RETURNING id_asignacion, fecha_retorno
                """,
                (id_emergencia, id_recurso),
            )
            fila = cursor.fetchone()
        conexion.commit()

        if fila is None:
            # No bloquea el regreso del vehiculo por esto: puede pasar si
            # la asignacion se hizo antes de esta funcionalidad, o si ya
            # se habia registrado el retorno.
            return {"ok": False, "mensaje": "No se encontró una asignación pendiente de retorno"}

        return {"ok": True, "id_asignacion": fila[0], "fecha_retorno": fila[1].isoformat()}

    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=f"Error al registrar el retorno: {str(e)}")

    finally:
        if conexion:
            conexion.close()


# --- Soporte / Tickets ---------------------------------------------------
# Integra el apartado de Soporte contra las tablas YA existentes en Postgres
# (ticket, respuesta_ticket, tipo_ticket, apartado_ticket, usuario) -- no se
# crea ninguna tabla ni columna nueva, solo se usan las que ya diseno el
# equipo. Antes esto vivia 100% en memoria del navegador (useState local),
# se perdia con cada F5 y nunca llegaba a la base real.

def _resolver_id_usuario(email: str) -> int:
    """Traduce el email del JWT (ver core/auth.py) al id_usuario real de
    Postgres. Si la cuenta todavia no tiene fila en emergencia.usuario (y no
    puede crear/responder tickets hasta que se agregue), se informa con un
    error claro en vez de uno generico de FK."""
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        cursor.execute(
            "SELECT id_usuario FROM emergencia.usuario WHERE email_usuario = %s",
            (email,),
        )
        fila = cursor.fetchone()
    if not fila:
        raise HTTPException(
            status_code=404,
            detail=f"La cuenta {email} todavia no tiene una fila en emergencia.usuario -- no puede crear ni responder tickets hasta que se agregue.",
        )
    return fila[0]


@app.get("/tickets/catalogos")
def catalogos_tickets(usuario: Usuario = Depends(usuario_actual)):
    """Tipos y apartados reales para los selects del formulario -- ya
    existen en la base (tipo_ticket, apartado_ticket), no se inventan aca."""
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        cursor.execute(
            "SELECT id_tipo, nombre_tipo FROM emergencia.tipo_ticket WHERE estado_tipo = 'Activo' ORDER BY id_tipo"
        )
        tipos = [{"id_tipo": r[0], "nombre_tipo": r[1]} for r in cursor.fetchall()]
        cursor.execute(
            "SELECT id_apartado, nombre_apartado FROM emergencia.apartado_ticket WHERE estado_apartado = 'Activo' ORDER BY id_apartado"
        )
        apartados = [{"id_apartado": r[0], "nombre_apartado": r[1]} for r in cursor.fetchall()]
    return {"tipos": tipos, "apartados": apartados}


class TicketCreate(BaseModel):
    id_tipo: int
    id_apartado: int | None = None
    titulo_ticket: str
    descripcion: str
    archivo_url: str | None = None
    # Quien reporta el problema NO decide la prioridad -- por eso no hay
    # campo "prioridad" aca. Todo ticket nuevo entra como "Sin asignar" y
    # soporte la fija despues desde PATCH /tickets/{id}/prioridad (ver
    # TicketPrioridadUpdate), al revisar el caso.


# Tickets viejos guardan ahi un link externo (http/https); el formulario
# ahora manda la imagen ya codificada como "data:image/<tipo>;base64,<...>"
# (ver seleccionarArchivo en el frontend). 4 MB en base64 ~= 3 MB reales,
# el mismo limite que valida el frontend antes de codificar.
_TIPOS_IMAGEN_PERMITIDOS = ("image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp")
_LIMITE_ADJUNTO_BASE64 = 4 * 1024 * 1024

# DEF-04 (ver matriz de pruebas de seguridad): antes solo se validaba el
# tipo MIME declarado en el encabezado "data:" -- un base64 corrupto o con
# contenido arbitrario, pero con un MIME permitido, pasaba igual. Esto
# verifica la firma real de bytes de cada formato (magic numbers), para
# que el contenido coincida con lo que dice ser.
def _firma_valida(tipo_mime: str, datos: bytes) -> bool:
    if tipo_mime in ("image/png",):
        return datos.startswith(b"\x89PNG\r\n\x1a\n")
    if tipo_mime in ("image/jpeg", "image/jpg"):
        return datos.startswith(b"\xff\xd8\xff")
    if tipo_mime == "image/gif":
        return datos.startswith(b"GIF87a") or datos.startswith(b"GIF89a")
    if tipo_mime == "image/webp":
        return datos.startswith(b"RIFF") and datos[8:12] == b"WEBP"
    return False


def _validar_archivo_adjunto(archivo_url: str | None) -> None:
    if not archivo_url:
        return
    if archivo_url.startswith("http://") or archivo_url.startswith("https://"):
        return
    if archivo_url.startswith("data:"):
        encabezado, _, datos_base64 = archivo_url.partition(",")
        tipo_mime = encabezado[len("data:"):].split(";")[0]
        if tipo_mime not in _TIPOS_IMAGEN_PERMITIDOS:
            raise HTTPException(status_code=400, detail=f"Tipo de imagen no permitido: {tipo_mime}")
        if len(datos_base64) > _LIMITE_ADJUNTO_BASE64:
            raise HTTPException(status_code=400, detail="La imagen adjunta pesa demasiado (máximo 3 MB).")
        try:
            datos_crudos = base64.b64decode(datos_base64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="El contenido de la imagen no es un base64 válido.")
        if not _firma_valida(tipo_mime, datos_crudos):
            raise HTTPException(status_code=400, detail="El contenido del archivo no coincide con el tipo de imagen declarado.")
        return
    raise HTTPException(status_code=400, detail="Archivo adjunto inválido: debe ser una URL http(s) o una imagen.")


@app.post("/tickets")
def crear_ticket(datos: TicketCreate, usuario: Usuario = Depends(usuario_actual)):
    _validar_archivo_adjunto(datos.archivo_url)
    id_usuario = _resolver_id_usuario(usuario.email)
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            # Ademas de id_tipo (la relacion real con tipo_ticket), la tabla
            # tiene una columna de texto suelta "tipo_ticket" -- se guarda el
            # nombre del tipo ahi tambien para que quede consistente con lo
            # que ya espera el resto del equipo.
            cursor.execute(
                "SELECT nombre_tipo FROM emergencia.tipo_ticket WHERE id_tipo = %s",
                (datos.id_tipo,),
            )
            fila_tipo = cursor.fetchone()
            if not fila_tipo:
                raise HTTPException(status_code=404, detail=f"id_tipo {datos.id_tipo} no existe en tipo_ticket")
            nombre_tipo = fila_tipo[0]

            # codigo_ticket es UNIQUE y NOT NULL -- se inserta un valor
            # temporal y se actualiza ya con el id real asignado (evita
            # depender de secuencias externas a la tabla).
            cursor.execute(
                """
                INSERT INTO emergencia.ticket
                    (id_usuario, id_tipo, id_apartado, codigo_ticket, titulo_ticket, descripcion, tipo_ticket, archivo_url, prioridad)
                VALUES (%s, %s, %s, 'TEMP', %s, %s, %s, %s, 'Sin asignar')
                RETURNING id_ticket
                """,
                (id_usuario, datos.id_tipo, datos.id_apartado, datos.titulo_ticket, datos.descripcion, nombre_tipo, datos.archivo_url),
            )
            id_ticket = cursor.fetchone()[0]
            codigo = f"SOP-{id_ticket:04d}"
            cursor.execute(
                "UPDATE emergencia.ticket SET codigo_ticket = %s WHERE id_ticket = %s RETURNING estado_ticket, fecha_creacion",
                (codigo, id_ticket),
            )
            estado, fecha_creacion = cursor.fetchone()
        conexion.commit()
        return {
            "id_ticket": id_ticket,
            "codigo_ticket": codigo,
            "estado_ticket": estado,
            "fecha_creacion": fecha_creacion.isoformat(),
        }
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@app.get("/tickets")
def listar_tickets(usuario: Usuario = Depends(usuario_actual)):
    """Todos los tickets (con tipo/apartado/autor ya resueltos por nombre)
    mas sus respuestas, para que el frontend no tenga que pedirlas aparte
    ticket por ticket.

    El apartado de Tickets es individual por cuenta: cada quien ve y da
    seguimiento SOLO a los tickets que el mismo creo (Benjamin no puede ver
    ni responder los de Bruno, ni viceversa). La unica excepcion es la
    cuenta de soporte, que necesita ver todos para poder atenderlos."""
    with obtener_conexion() as conexion, conexion.cursor() as cursor:
        if usuario.rol == "soporte":
            cursor.execute(
                """
                SELECT t.id_ticket, t.codigo_ticket, t.titulo_ticket, t.descripcion,
                       t.estado_ticket, t.archivo_url, t.fecha_creacion, t.fecha_actualizacion,
                       tt.nombre_tipo, COALESCE(ap.nombre_apartado, 'General'), u.nombre_completo, u.email_usuario,
                       t.prioridad
                FROM emergencia.ticket t
                JOIN emergencia.tipo_ticket tt ON tt.id_tipo = t.id_tipo
                LEFT JOIN emergencia.apartado_ticket ap ON ap.id_apartado = t.id_apartado
                JOIN emergencia.usuario u ON u.id_usuario = t.id_usuario
                ORDER BY t.fecha_creacion DESC
                """
            )
        else:
            id_usuario_actual = _resolver_id_usuario(usuario.email)
            cursor.execute(
                """
                SELECT t.id_ticket, t.codigo_ticket, t.titulo_ticket, t.descripcion,
                       t.estado_ticket, t.archivo_url, t.fecha_creacion, t.fecha_actualizacion,
                       tt.nombre_tipo, COALESCE(ap.nombre_apartado, 'General'), u.nombre_completo, u.email_usuario,
                       t.prioridad
                FROM emergencia.ticket t
                JOIN emergencia.tipo_ticket tt ON tt.id_tipo = t.id_tipo
                LEFT JOIN emergencia.apartado_ticket ap ON ap.id_apartado = t.id_apartado
                JOIN emergencia.usuario u ON u.id_usuario = t.id_usuario
                WHERE t.id_usuario = %s
                ORDER BY t.fecha_creacion DESC
                """,
                (id_usuario_actual,),
            )
        filas_tickets = cursor.fetchall()
        cursor.execute(
            """
            SELECT r.id_ticket, r.mensaje, r.tipo_respuesta, r.fecha_respuesta, u.nombre_completo
            FROM emergencia.respuesta_ticket r
            JOIN emergencia.usuario u ON u.id_usuario = r.id_usuario
            ORDER BY r.fecha_respuesta ASC
            """
        )
        filas_respuestas = cursor.fetchall()

    respuestas_por_ticket: dict[int, list[dict[str, Any]]] = {}
    for id_ticket, mensaje, tipo_respuesta, fecha_respuesta, autor in filas_respuestas:
        respuestas_por_ticket.setdefault(id_ticket, []).append({
            "mensaje": mensaje,
            "tipo_respuesta": tipo_respuesta,
            "fecha_respuesta": fecha_respuesta.isoformat(),
            "autor": autor,
        })

    tickets = []
    for (id_ticket, codigo, titulo, descripcion, estado, archivo_url,
         fecha_creacion, fecha_actualizacion, nombre_tipo, nombre_apartado, autor, email_autor,
         prioridad) in filas_tickets:
        tickets.append({
            "id_ticket": id_ticket,
            "codigo_ticket": codigo,
            "titulo_ticket": titulo,
            "descripcion": descripcion,
            "estado_ticket": estado,
            "archivo_url": archivo_url,
            "fecha_creacion": fecha_creacion.isoformat(),
            "fecha_actualizacion": fecha_actualizacion.isoformat(),
            "tipo": nombre_tipo,
            "apartado": nombre_apartado,
            "creado_por": autor,
            "creado_por_email": email_autor,
            "prioridad": prioridad,
            "respuestas": respuestas_por_ticket.get(id_ticket, []),
        })
    return {"tickets": tickets}


def requiere_soporte(usuario: Usuario = Depends(usuario_actual)) -> Usuario:
    """Dependencia de RBAC para el apartado de Tickets: solo la cuenta con
    rol 'soporte' (ver core/auth.py) puede responder o cerrar solicitudes --
    el resto solo puede crearlas desde el formulario de Soporte."""
    if usuario.rol != "soporte":
        raise HTTPException(status_code=403, detail="Solo la cuenta de soporte puede administrar tickets")
    return usuario


class RespuestaCreate(BaseModel):
    mensaje: str
    tipo_respuesta: Literal["Respuesta", "Usuario"] = "Respuesta"


@app.post("/tickets/{id_ticket}/respuestas")
def responder_ticket(id_ticket: int, datos: RespuestaCreate, usuario: Usuario = Depends(usuario_actual)):
    """Cualquier cuenta autenticada puede agregar su propia respuesta de
    seguimiento (tipo_respuesta='Usuario'); solo soporte puede responder
    oficialmente (tipo_respuesta='Respuesta', ver requiere_soporte abajo)."""
    if datos.tipo_respuesta == "Respuesta" and usuario.rol != "soporte":
        raise HTTPException(status_code=403, detail="Solo la cuenta de soporte puede responder oficialmente un ticket")
    id_usuario = _resolver_id_usuario(usuario.email)
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            # Un ticket "Resuelto" queda cerrado: el usuario que lo creo ya
            # no puede seguir agregando seguimiento (si de verdad sigue sin
            # resolverse, le corresponde abrir un ticket nuevo). Soporte si
            # puede seguir escribiendo (p.ej. para aclarar algo despues de
            # cerrarlo), por eso el check es solo para tipo_respuesta='Usuario'.
            if datos.tipo_respuesta == "Usuario":
                cursor.execute("SELECT estado_ticket, id_usuario FROM emergencia.ticket WHERE id_ticket = %s", (id_ticket,))
                fila_ticket = cursor.fetchone()
                if not fila_ticket:
                    raise HTTPException(status_code=404, detail="Ticket no encontrado")
                estado_actual, id_usuario_creador = fila_ticket
                if estado_actual == "Resuelto":
                    raise HTTPException(status_code=409, detail="Este ticket ya fue marcado como Resuelto, no se pueden agregar más respuestas.")
                # El apartado de Tickets es individual: solo quien creo el
                # ticket puede darle seguimiento, nunca otra cuenta.
                if id_usuario_creador != id_usuario:
                    raise HTTPException(status_code=403, detail="Solo la cuenta que creó este ticket puede responderlo")
            cursor.execute(
                """
                INSERT INTO emergencia.respuesta_ticket (id_ticket, id_usuario, mensaje, tipo_respuesta)
                VALUES (%s, %s, %s, %s)
                RETURNING id_respuesta, fecha_respuesta
                """,
                (id_ticket, id_usuario, datos.mensaje, datos.tipo_respuesta),
            )
            id_respuesta, fecha_respuesta = cursor.fetchone()
            if datos.tipo_respuesta == "Respuesta":
                cursor.execute(
                    """
                    UPDATE emergencia.ticket
                    SET estado_ticket = CASE WHEN estado_ticket = 'Abierto' THEN 'En proceso' ELSE estado_ticket END,
                        fecha_actualizacion = CURRENT_TIMESTAMP
                    WHERE id_ticket = %s
                    """,
                    (id_ticket,),
                )
        conexion.commit()
        return {"id_respuesta": id_respuesta, "fecha_respuesta": fecha_respuesta.isoformat()}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


class TicketEstadoUpdate(BaseModel):
    estado: Literal["Abierto", "En proceso", "Resuelto"]


@app.patch("/tickets/{id_ticket}/estado")
def cambiar_estado_ticket(id_ticket: int, datos: TicketEstadoUpdate, usuario: Usuario = Depends(requiere_soporte)):
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute(
                "UPDATE emergencia.ticket SET estado_ticket = %s, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id_ticket = %s",
                (datos.estado, id_ticket),
            )
        conexion.commit()
        return {"ok": True, "estado": datos.estado}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


class TicketPrioridadUpdate(BaseModel):
    prioridad: Literal["Baja", "Media", "Alta"]


@app.patch("/tickets/{id_ticket}/prioridad")
def cambiar_prioridad_ticket(id_ticket: int, datos: TicketPrioridadUpdate, usuario: Usuario = Depends(requiere_soporte)):
    """Quien reporta el problema NO decide que tan urgente es -- eso lo
    evalua soporte al revisar el ticket, por eso este endpoint (a
    diferencia de la creacion del ticket) exige rol soporte."""
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cursor:
            cursor.execute(
                "UPDATE emergencia.ticket SET prioridad = %s, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id_ticket = %s",
                (datos.prioridad, id_ticket),
            )
        conexion.commit()
        return {"ok": True, "prioridad": datos.prioridad}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()
