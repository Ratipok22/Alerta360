"""Catálogos operativos desde PostgreSQL (sin datos de demostración)."""
from database.database import obtener_conexion
from core.eta import calcular_eta

REF_LAT, REF_LNG = -32.9968, -71.4884

def obtener_zonas():
    with obtener_conexion() as conn, conn.cursor() as cur:
        cur.execute("""SELECT id_zona, nombre_zona, latitud_minima, latitud_maxima,
                       longitud_minima, longitud_maxima FROM emergencia.zona
                       ORDER BY id_zona""")
        filas = cur.fetchall()
    salida = []
    for ident, nombre, latmin, latmax, lngmin, lngmax in filas:
        centro = {"lat": (latmin+latmax)/2 if latmin is not None and latmax is not None else None,
                  "lng": (lngmin+lngmax)/2 if lngmin is not None and lngmax is not None else None}
        salida.append({"zona_id": str(ident), "nombre": nombre,
            "bounds": {"lat_min": latmin, "lat_max": latmax, "lng_min": lngmin, "lng_max": lngmax},
            "centroid": centro})
    return salida

def obtener_tipos():
    with obtener_conexion() as conn, conn.cursor() as cur:
        cur.execute("""SELECT codigo_emergencia, nombre_emergencia, prioridad_emergencia,
                        prioridad_nivel_emergencia, terreno_emergencia
                        FROM emergencia.tipo_emergencia ORDER BY codigo_emergencia""")
        filas = cur.fetchall()
    return [{"codigo": c, "nombre": n, "prioridad": p, "prioridad_nivel": pn, "terreno": t}
            for c,n,p,pn,t in filas]

def obtener_recursos():
    with obtener_conexion() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                r.id_recurso,
                r.codigo_recurso,
                r.nombre_recurso,
                r.tipo_recurso,
                r.estado_radio,
                r.capacitacion_recurso,
                r.dotacion_recurso,
                r.latitud_recurso,
                r.longitud_recurso,
                c.id_compania,
                c.nombre_compania,
                c.cuerpo_compania,
                c.sector_compania,
                c.latitud_compania,
                c.longitud_compania
            FROM emergencia.recurso r
            INNER JOIN emergencia.compania c
                ON c.id_compania = r.id_compania
            ORDER BY r.id_recurso
        """)

        filas = cur.fetchall()

    salida = []

    for (
        id_recurso,
        codigo,
        nombre,
        tipo,
        estado,
        capacitacion,
        dotacion,
        lat_recurso,
        lng_recurso,
        id_compania,
        compania,
        cuerpo,
        sector,
        lat_compania,
        lng_compania
    ) in filas:

        # Si aún no se ha registrado una posición del vehículo,
        # usar la ubicación de su compañía.
        if lat_recurso is None or lng_recurso is None:
            lat = lat_compania
            lng = lng_compania
        else:
            lat = lat_recurso
            lng = lng_recurso

        salida.append({
            "id": str(id_recurso),
            "id_recurso": id_recurso,
            "codigo": codigo,
            "nombre": nombre,
            "tipo": tipo,
            "capacidad": tipo,
            "estado": estado,
            "disponible": estado in ("6-0", "Disponible"),
            "compania": compania,
            "id_compania": id_compania,
            "cuerpo": cuerpo,
            "sector": sector,
            "lat": float(lat) if lat is not None else None,
            "lng": float(lng) if lng is not None else None,
            "lat_compania": (
                float(lat_compania)
                if lat_compania is not None else None
            ),
            "lng_compania": (
                float(lng_compania)
                if lng_compania is not None else None
            ),
            "eta": None,
            "distance": None,
            "dotacion": dotacion,
            "capacitacion": capacitacion
        })

    return salida
