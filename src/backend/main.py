#-------------------------------NUeva para la base de datos

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

#-------------------------------

import os
import threading
from datetime import datetime, timezone
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

from core.auth import Usuario, crear_token, verificar_credenciales, verificar_token
from core.companies import todas_las_unidades
from core.eta import calcular_eta
from core.radio_codes import CLAVES_RADIALES
from core.vehicle_types import TIPOS_CARRO
from ml.predict import predict_demand

from database.database import obtener_conexion
from ml.database import guardar_predicciones
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
    allow_origins=["http://localhost:5173"],
    # Permite tambien acceder desde un dev tunnel (VS Code Ports / *.devtunnels.ms)
    # cuando se comparte el avance para revision, ademas de localhost.
    allow_origin_regex=r"https://.*\.devtunnels\.ms",
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


#-------------------------------NUeva para la base de datos
class EmergencyCreate(BaseModel):
    codigo_emergencia: str
    direccion_emergencia: str | None = None
    latitud_emergencia: float | None = None
    longitud_emergencia: float | None = None
    prioridad_emergencia: int
    estado_emergencia: str
    id_zona: int | None = None

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
def crear_emergencia(datos: EmergencyCreate):
    conexion = None

    try:
        conexion = obtener_conexion()

        with conexion.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO emergencia.emergencia (
                    codigo_emergencia,
                    direccion_emergencia,
                    latitud_emergencia,
                    longitud_emergencia,
                    prioridad_emergencia,
                    estado_emergencia, id_zona
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id_emergencia,
                          codigo_emergencia,
                          direccion_emergencia,
                          latitud_emergencia,
                          longitud_emergencia,
                          prioridad_emergencia,
                          estado_emergencia,
                          fecha_creacion_emergencia, id_zona;
                """,
                (
                    datos.codigo_emergencia,
                    datos.direccion_emergencia,
                    datos.latitud_emergencia,
                    datos.longitud_emergencia,
                    datos.prioridad_emergencia,
                    datos.estado_emergencia,
                    datos.id_zona,
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
            "fecha_creacion_emergencia": emergencia[7],
            "id_zona": emergencia[8],
        }

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
def obtener_emergencias():
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
                    e.id_zona
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
                    "fecha_creacion_emergencia": fila[8],
                    "fecha_cierre_emergencia": fila[9],
                    "id_zona": fila[10],
                }
                for fila in filas
            ]
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error al obtener emergencias: {str(e)}"
        )

    finally:
        if conexion:
            conexion.close()
#-------------------------------


@app.post("/auth/login", response_model=LoginResponse)
def login(datos: LoginRequest):
    """Login sin registro: solo los 3 operadores fijos definidos en
    core/auth.py pueden entrar. Las contraseñas se verifican contra su
    hash bcrypt, nunca en texto plano."""
    usuario = verificar_credenciales(datos.email, datos.password)
    if not usuario:
        raise HTTPException(status_code=401, detail="Correo o contraseña incorrectos")
    return LoginResponse(token=crear_token(usuario), nombre=usuario.nombre, email=usuario.email, rol=usuario.rol)

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

@app.get("/auth/me")
def auth_me(usuario: Usuario = Depends(usuario_actual)):
    """Permite al frontend validar si el token guardado localmente sigue
    siendo valido (p.ej. al recargar la pagina) sin pedir login de nuevo
    si no hace falta."""
    return {"email": usuario.email, "nombre": usuario.nombre, "rol": usuario.rol}

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
                        WHEN %s = 'FINALIZADA' THEN CURRENT_TIMESTAMP
                        ELSE fecha_cierre_emergencia
                    END
                WHERE id_emergencia = %s
                """,
                (datos.estado, datos.estado, id_emergencia),
            )
        conexion.commit()
        return {"ok": True, "estado": datos.estado}
    except Exception:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@app.get("/resources")
def resources(usuario: Usuario = Depends(usuario_actual)):
    try:
        return {"resources": obtener_recursos()}
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

@app.get("/catalog/claves")
def catalog_claves(usuario: Usuario = Depends(usuario_actual)):
    try:
        return {"claves": obtener_tipos()}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron consultar las claves: {exc}")

@app.get("/zones")
def zones(usuario: Usuario = Depends(usuario_actual)):
    try:
        return {"zones": obtener_zonas()}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No se pudieron consultar las zonas: {exc}")

@app.get("/prediction/demand")
def prediction_demand(horizon: int = 4, fecha: str | None = None, usuario: Usuario = Depends(usuario_actual)):
    """Prediccion de demanda esperada por zona/periodo/tipo (modelo ML).

    `fecha` (opcional) permite simular una fecha/hora distinta a la actual,
    en formato ISO (p.ej. '2026-01-15T15:00:00'), util para verificar que el
    modelo captura patrones estacionales/horarios (p.ej. mas incendios
    forestales en enero que en junio) sin tener que esperar a esa fecha real.
    """
    now = None
    if fecha:
        try:
            now = datetime.fromisoformat(fecha)
        except ValueError:
            raise HTTPException(status_code=400, detail="fecha invalida, usa formato ISO: 2026-01-15T15:00:00")
    try:
        resultado = predict_demand(now=now, horizon=horizon)
        resultado["persistencia"] = guardar_predicciones(resultado)
        return resultado
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo guardar la predicción en PostgreSQL: {e}",
        )

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

@app.post("/assignment/recommend")
def recommend(emergency: Emergency, usuario: Usuario = Depends(requiere_admin)):
    # MVP: asignación multicriterio. En la versión final, pesos/configuración pueden vivir en BD.
    candidates = [
        {"id":"B-01","type":"Bomberos","available":True,"eta":5,"distance":2.1,"compatible":True,"capacity":True},
        {"id":"R-01","type":"Rescate","available":True,"eta":8,"distance":4.7,"compatible":True,"capacity":True},
        {"id":"H-01","type":"Hazmat","available":True,"eta":9,"distance":6.2,"compatible":False,"capacity":False},
    ]
    def score(r):
        if not r["available"] or not r["compatible"]: return -1
        return round(35 + 25 + 15 + (20 if r["capacity"] else 0) - min(r["eta"]*2,25) - min(r["distance"]*2,18), 2)
    best=max(candidates,key=score)
    return {"recommended_resource":best["id"],"score":score(best),"criteria":["priority","type","compatibility","availability","distance","eta","capacity"]}



@app.post("/assignments")
def asignar_recurso(
    id_emergencia: int,
    id_recurso: int,
    id_usuario: int,
    tipo_asignacion: str = "Automatica",
    puntaje_asignacion: float | None = None,
    distancia_km: float | None = None,
    eta_minutos: int | None = None,
    usuario: Usuario = Depends(requiere_admin),
):
    conexion = None

    try:
        conexion = obtener_conexion()

        with conexion.cursor() as cursor:

            # 1. Verificar que la emergencia esté activa
            cursor.execute(
                """
                SELECT estado_emergencia
                FROM emergencia.emergencia
                WHERE id_emergencia = %s
                """,
                (id_emergencia,)
            )

            emergencia = cursor.fetchone()

            if not emergencia:
                raise HTTPException(
                    status_code=404,
                    detail="La emergencia no existe"
                )

            if emergencia[0] != "Activa":
                raise HTTPException(
                    status_code=400,
                    detail="La emergencia no está activa"
                )

            # 2. Verificar que el recurso esté disponible
            cursor.execute(
                """
                SELECT estado_radio
                FROM emergencia.recurso
                WHERE id_recurso = %s
                """,
                (id_recurso,)
            )

            recurso = cursor.fetchone()

            if not recurso:
                raise HTTPException(
                    status_code=404,
                    detail="El recurso no existe"
                )

            if recurso[0] not in ("6-0", "Disponible"):
                raise HTTPException(
                    status_code=400,
                    detail="El recurso no está disponible"
                )

            # 3. Crear la asignación
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
                    'ASIGNADO'
                )
                RETURNING id_asignacion
                """,
                (
                    id_emergencia,
                    id_recurso,
                    id_usuario,
                    tipo_asignacion,
                    puntaje_asignacion,
                    distancia_km,
                    eta_minutos,
                )
            )

            id_asignacion = cursor.fetchone()[0]

            # 4. Cambiar recurso a EN SERVICIO
            cursor.execute(
                """
                UPDATE emergencia.recurso
                SET estado_radio = '6-8'
                WHERE id_recurso = %s
                """,
                (id_recurso,)
            )

        conexion.commit()

        return {
            "mensaje": "Recurso asignado correctamente",
            "id_asignacion": id_asignacion,
            "estado_emergencia": "Activa",
            "estado_recurso": "En servicio",
            "estado_asignacion": "ASIGNADO"
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
