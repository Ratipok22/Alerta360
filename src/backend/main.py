import os
from datetime import datetime
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
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
from ml.zones import ZONES

# Punto de referencia solo para ilustrar distancia/ETA en /resources (no hay
# una emergencia real fija): Reñaca Alto, Viña del Mar.
_REF_LAT, _REF_LNG = -32.9968, -71.4884

# Motor de rutas local (OSRM, ver routing/) sobre calles reales de la
# region -- no una API paga ni un servicio externo. Se genero una vez con
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

class LoginRequest(BaseModel):
    email: str
    password: str

class LoginResponse(BaseModel):
    token: str
    nombre: str
    email: str

@app.get("/health")
def health():
    return {"status":"ok","service":"emergency-resource-api"}

@app.post("/auth/login", response_model=LoginResponse)
def login(datos: LoginRequest):
    """Login sin registro: solo los 3 operadores fijos definidos en
    core/auth.py pueden entrar. Las contraseñas se verifican contra su
    hash bcrypt, nunca en texto plano."""
    usuario = verificar_credenciales(datos.email, datos.password)
    if not usuario:
        raise HTTPException(status_code=401, detail="Correo o contraseña incorrectos")
    return LoginResponse(token=crear_token(usuario), nombre=usuario.nombre, email=usuario.email)

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

@app.get("/auth/me")
def auth_me(usuario: Usuario = Depends(usuario_actual)):
    """Permite al frontend validar si el token guardado localmente sigue
    siendo valido (p.ej. al recargar la pagina) sin pedir login de nuevo
    si no hace falta."""
    return {"email": usuario.email, "nombre": usuario.nombre}

@app.get("/resources")
def resources(usuario: Usuario = Depends(usuario_actual)):
    """Flota real: companias de Bomberos de Valparaiso y Vina del Mar
    (ver core/companies.py para el detalle de que esta verificado)."""
    out = []
    for unidad, compania in todas_las_unidades():
        tipo = TIPOS_CARRO.get(unidad.tipo)
        eta = calcular_eta(compania.lat, compania.lng, _REF_LAT, _REF_LNG, terreno="urbano")
        out.append({
            "id": unidad.id,
            "tipo": unidad.tipo,
            "capacidad": tipo.nombre if tipo else unidad.tipo,
            "estado": unidad.estado.value,
            "compania": compania.nombre,
            "cuerpo": compania.cuerpo,
            "sector": compania.sector,
            "eta": eta["eta_min"],
            "distance": eta["distancia_km"],
        })
    return {"resources": out}

@app.get("/catalog/claves")
def catalog_claves(usuario: Usuario = Depends(usuario_actual)):
    """Catalogo de claves radiales 10-X (nombre, prioridad, terreno) para uso del frontend."""
    return {"claves": [
        {
            "codigo": codigo,
            "nombre": cr.nombre,
            "prioridad": cr.prioridad.value,
            "prioridad_nivel": cr.prioridad_nivel,
            "terreno": cr.terreno,
        } for codigo, cr in CLAVES_RADIALES.items()
    ]}

@app.get("/zones")
def zones(usuario: Usuario = Depends(usuario_actual)):
    return {"zones": [
        {
            "zona_id": z.id,
            "nombre": z.nombre,
            "bounds": {"lat_min": z.lat_min, "lat_max": z.lat_max, "lng_min": z.lng_min, "lng_max": z.lng_max},
            "centroid": {"lat": z.centroid[0], "lng": z.centroid[1]},
        } for z in ZONES
    ]}

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
        return predict_demand(now=now, horizon=horizon)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

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
            return fallback
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
        return fallback


@app.post("/assignment/recommend")
def recommend(emergency: Emergency):
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
