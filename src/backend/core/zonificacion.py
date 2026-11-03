"""Asignación territorial local, sin servicios externos ni cambios de ER.

La geometría conserva el orden del catálogo: sectores anteriores primero,
seguidos de distritos INE recortados. En un borde compartido gana el primero.
Las cajas de zona son solo envolventes: la pertenencia usa el polígono real.
"""
from functools import lru_cache
import json
import math
from pathlib import Path

CATALOGO = Path(__file__).parent / 'data' / 'zonas_valparaiso.geojson'


@lru_cache(maxsize=1)
def _zonas():
    with CATALOGO.open(encoding='utf-8') as archivo:
        return json.load(archivo)['features']


def _anillo(x, y, ring):
    """0: fuera; 1: dentro; 2: sobre un borde."""
    dentro = False
    x0, y0 = ring[-1][:2]
    for punto in ring:
        x1, y1 = punto[:2]
        dx, dy = x1-x0, y1-y0
        cruz = (x-x0)*dy - (y-y0)*dx
        escala = abs(dx) + abs(dy)
        if (abs(cruz) <= 1e-12 * escala and
            min(x0,x1)-1e-12 <= x <= max(x0,x1)+1e-12 and
            min(y0,y1)-1e-12 <= y <= max(y0,y1)+1e-12):
            return 2
        if (y1 > y) != (y0 > y) and x < (x0-x1)*(y-y1)/(y0-y1)+x1:
            dentro = not dentro
        x0,y0 = x1,y1
    return int(dentro)


def _poligono(x, y, rings):
    exterior = _anillo(x,y,rings[0])
    if exterior == 0:
        return False
    if exterior == 2:
        return True
    for hole in rings[1:]:
        estado = _anillo(x,y,hole)
        if estado == 2:
            return True
        if estado == 1:
            return False
    return True


def localizar_zona(latitud: float, longitud: float) -> str | None:
    if not (math.isfinite(latitud) and math.isfinite(longitud)
            and -90 <= latitud <= 90 and -180 <= longitud <= 180):
        raise ValueError('Coordenadas geográficas inválidas.')
    x,y = longitud,latitud
    for feature in _zonas():
        xmin,ymin,xmax,ymax = feature['properties']['bounds']
        if not xmin-1e-12 <= x <= xmax+1e-12 or not ymin-1e-12 <= y <= ymax+1e-12:
            continue
        geom = feature['geometry']
        polygons = [geom['coordinates']] if geom['type']=='Polygon' else geom['coordinates']
        if any(_poligono(x,y,poly) for poly in polygons):
            return feature['properties']['id_zona']
    return None


def resolver_zona(cursor, latitud, longitud, id_zona=None):
    """Resuelve la zona y verifica que ya exista en PostgreSQL."""
    if (latitud is None) != (longitud is None):
        raise ValueError('Debes proporcionar latitud y longitud juntas.')
    if latitud is not None:
        calculada = localizar_zona(latitud,longitud)
        if calculada is None:
            raise ValueError('La ubicación no pertenece a la cobertura territorial de Valparaíso.')
        if id_zona is not None and id_zona != calculada:
            raise ValueError(f'La ubicación pertenece a la zona {calculada}, no a {id_zona}.')
        id_zona = calculada
    if not id_zona:
        raise ValueError('Indica una ubicación o un id_zona válido para registrar la emergencia.')
    cursor.execute('SELECT 1 FROM emergencia.zona WHERE id_zona=%s',(id_zona,))
    if cursor.fetchone() is None:
        raise ValueError(f'La zona {id_zona} no está registrada en PostgreSQL.')
    return id_zona
