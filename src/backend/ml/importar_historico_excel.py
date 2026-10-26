"""Importa historico_emergencias.xlsx a PostgreSQL, sin cambiar datos operativos.

Ejecutar desde src/backend, DESPUES de aplicar sql/01_prediccion_postgresql.sql:
    python -m ml.importar_historico_excel --archivo /ruta/historico_emergencias.xlsx --solo-validar
    python -m ml.importar_historico_excel --archivo /ruta/historico_emergencias.xlsx

El archivo original contiene 245.280 filas sinteticas calibradas; NO son
emergencias reales. Una segunda importacion NO duplica las filas.
La lectura XLSX se hace en streaming, sin cargar 245 mil filas en RAM.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

# importar_historico_excel.py está en Alerta360/src/backend/ml.
# parents[3] corresponde a la raíz Alerta360.
PROJECT_ROOT = Path(__file__).resolve().parents[3]

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from .zones import EMERGENCY_TYPES

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
COLUMNAS = [
    'fecha', 'dia_semana', 'mes', 'bloque_hora', 'zona_id',
    'tipo_emergencia', 'cantidad_emergencias', 'recursos_utilizados',
    'temperatura_c', 'viento_kmh', 'precipitacion_mm', 'timestamp'
]


def filas_xlsx(ruta: Path):
    """Lee la hoja 'historico' (primera hoja) sin pandas ni openpyxl."""
    with ZipFile(ruta) as archivo:
        with archivo.open('xl/worksheets/sheet1.xml') as entrada:
            for _, elemento in ET.iterparse(entrada, events=('end',)):
                if elemento.tag != NS + 'row':
                    continue
                columnas = []
                for celda in elemento.findall(NS + 'c'):
                    v = celda.find(NS + 'v')
                    t = celda.find(NS + 'is/' + NS + 't')
                    columnas.append(v.text if v is not None else (t.text if t is not None else ''))
                indice = int(elemento.attrib.get('r', '0'))
                elemento.clear()
                if indice == 1:
                    if columnas != COLUMNAS:
                        raise ValueError(f'Columnas XLSX no reconocidas: {columnas!r}')
                    continue
                if len(columnas) != len(COLUMNAS):
                    raise ValueError(f'Fila {indice}: se esperaban {len(COLUMNAS)} columnas')
                yield indice, columnas


def validar_fila(n: int, row: list[str]):
    fecha, dia, mes, bloque, zona, tipo, cantidad, recursos, temp, viento, lluvia, _timestamp = row
    try:
        d = date.fromisoformat(fecha)
        dia = int(dia)
        mes = int(mes)
        bloque = int(bloque)
        cantidad = int(cantidad)
        recursos = int(recursos)
        temp = float(temp)
        viento = float(viento)
        lluvia = float(lluvia)
    except (ValueError, TypeError) as exc:
        raise ValueError(f'Fila {n}: campo invalido: {exc}') from exc
    if dia != d.weekday() or mes != d.month or bloque not in (0, 3, 6, 9, 12, 15, 18, 21):
        raise ValueError(f'Fila {n}: fecha, dia, mes o bloque incoherentes')
    if not zona or len(zona) > 20:
        raise ValueError(
            f'Fila {n}: código de zona inválido: {zona!r}')
    if tipo not in EMERGENCY_TYPES:
        raise ValueError(f'Fila {n}: tipo desconocido: {tipo}')
    if cantidad < 0 or recursos < 0 or viento < 0 or lluvia < 0:
        raise ValueError(f'Fila {n}: conteos / clima no pueden ser negativos')
    return (d, dia, mes, bloque, zona, tipo, cantidad, recursos, temp, viento, lluvia)


def sha256_archivo(ruta: Path) -> str:
    h = hashlib.sha256()
    with ruta.open('rb') as entrada:
        for bloque in iter(lambda: entrada.read(1024 * 1024), b''):
            h.update(bloque)
    return h.hexdigest()



def verificar_catalogos(cur, codigos_zona, codigos_tipo):
    """Comprueba que las zonas y tipos del histórico existan en PostgreSQL."""

    cur.execute("""
        SELECT id_zona
        FROM emergencia.zona
    """)
    zonas_db = {str(fila[0]) for fila in cur.fetchall()}

    faltantes_zonas = set(codigos_zona) - zonas_db

    if faltantes_zonas:
        raise ValueError(
            "Faltan zonas en emergencia.zona: "
            + ", ".join(sorted(faltantes_zonas))
        )

    cur.execute("""
        SELECT codigo_emergencia
        FROM emergencia.tipo_emergencia
    """)
    tipos_db = {str(fila[0]) for fila in cur.fetchall()}

    faltantes_tipos = set(codigos_tipo) - tipos_db

    if faltantes_tipos:
        raise ValueError(
            "Faltan tipos de emergencia en PostgreSQL: "
            + ", ".join(sorted(faltantes_tipos))
        )



def importar(ruta: Path, solo_validar: bool = False):
    if not ruta.exists():
        raise FileNotFoundError(str(ruta))
    contador_zonas, contador_tipos = Counter(), Counter()
    filas = 0
    n_casos = 0
    fecha_min, fecha_max = None, None

    # Para --solo-validar no se necesita conectar a PostgreSQL.
    if solo_validar:
        for n, row in filas_xlsx(ruta):
            fecha, _, _, _, zona, tipo, cantidad, *_ = validar_fila(n, row)
            contador_zonas[zona] += 1
            contador_tipos[tipo] += 1
            n_casos += cantidad
            fecha_min = min(fecha_min or fecha, fecha)
            fecha_max = max(fecha_max or fecha, fecha)
            filas += 1
        print(f'VALIDADO: {filas:,} filas, {len(contador_zonas)} zonas, '
              f'{len(contador_tipos)} tipos, {n_casos:,} casos sinteticos, '
              f'del {fecha_min} al {fecha_max}.')
        return

    # Solo importar la dependencia de DB cuando se realiza la carga.
    
    from database.database import obtener_conexion
    conexion = obtener_conexion()
    try:
        with conexion.cursor() as cur:

            # Primera importación: protegemos la tabla para
            # evitar que otra ejecución inserte simultáneamente.
            cur.execute("""
                LOCK TABLE emergencia.registro_historico
                IN EXCLUSIVE MODE
            """)

            cur.execute("""
                SELECT COUNT(*)
                FROM emergencia.registro_historico
            """)

            if cur.fetchone()[0] != 0:
                raise ValueError(
                    "La tabla registro_historico ya contiene datos. "
                    "La carga inicial se ha cancelado para evitar "
                    "duplicaciones o mezclar datos históricos."
                )

            # Tabla temporal únicamente para transportar
            # las filas del Excel dentro de esta transacción.
            cur.execute("""
                CREATE TEMP TABLE a360_hist_staging (
                    fecha DATE,
                    dia_semana INTEGER,
                    mes INTEGER,
                    bloque_horario INTEGER,
                    id_zona VARCHAR(20),
                    codigo_emergencia VARCHAR(20),
                    cantidad_emergencias INTEGER,
                    recursos_utilizados INTEGER,
                    temperatura_c DOUBLE PRECISION,
                    viento_kmh DOUBLE PRECISION,
                    precipitacion_mm DOUBLE PRECISION
                ) ON COMMIT DROP
            """)

            with cur.copy("""
                COPY a360_hist_staging (
                    fecha,
                    dia_semana,
                    mes,
                    bloque_horario,
                    id_zona,
                    codigo_emergencia,
                    cantidad_emergencias,
                    recursos_utilizados,
                    temperatura_c,
                    viento_kmh,
                    precipitacion_mm
                ) FROM STDIN
            """) as copia:

                for n, row in filas_xlsx(ruta):
                    datos = validar_fila(n, row)
                    copia.write_row(datos)

                    contador_zonas[datos[4]] += 1
                    contador_tipos[datos[5]] += 1
                    n_casos += datos[6]

                    fecha_min = min(fecha_min or datos[0], datos[0])
                    fecha_max = max(fecha_max or datos[0], datos[0])

                    filas += 1

            # Comprobar códigos contra las tablas reales.
            verificar_catalogos(
                cur,
                contador_zonas.keys(),
                contador_tipos.keys()
            )

            # No permitir observaciones repetidas
            # dentro del archivo importado.
            cur.execute("""
                SELECT
                    fecha,
                    bloque_horario,
                    id_zona,
                    codigo_emergencia,
                    COUNT(*)
                FROM a360_hist_staging
                GROUP BY
                    fecha,
                    bloque_horario,
                    id_zona,
                    codigo_emergencia
                HAVING COUNT(*) > 1
                LIMIT 1
            """)

            if cur.fetchone():
                raise ValueError(
                    "El archivo contiene observaciones duplicadas."
                )

            cur.execute("""
                INSERT INTO emergencia.registro_historico (
                    fecha,
                    dia_semana,
                    mes,
                    bloque_horario,
                    id_zona,
                    codigo_emergencia,
                    cantidad_emergencias,
                    recursos_utilizados,
                    temperatura_c,
                    viento_kmh,
                    precipitacion_mm,
                    timestamp_registro
                )
                SELECT
                    fecha,
                    dia_semana,
                    mes,
                    bloque_horario,
                    id_zona,
                    codigo_emergencia,
                    cantidad_emergencias,
                    recursos_utilizados,
                    temperatura_c,
                    viento_kmh,
                    precipitacion_mm,
                    fecha::timestamp
                        + make_interval(hours => bloque_horario)
                FROM a360_hist_staging
            """)

            insertadas = cur.rowcount

            if insertadas != filas:
                raise ValueError(
                    f"Se procesaron {filas} filas, "
                    f"pero se insertaron {insertadas}."
                )

        conexion.commit()

        print(
            f"IMPORTACIÓN COMPLETADA: {insertadas:,} "
            f"registros sintéticos."
        )
        print(
            f"Zonas: {len(contador_zonas)} | "
            f"Tipos: {len(contador_tipos)} | "
            f"Casos: {n_casos:,} | "
            f"Período: {fecha_min} a {fecha_max}"
        )

    except Exception:
        conexion.rollback()
        raise

    finally:
        conexion.close()



def main():
    parser = argparse.ArgumentParser(description='Importar historico sintetico XLSX a PostgreSQL')
    parser.add_argument('--archivo', required=True, type=Path)
    parser.add_argument('--solo-validar', action='store_true', help='No conecta a PostgreSQL')
    a = parser.parse_args()
    importar(a.archivo, solo_validar=a.solo_validar)


if __name__ == '__main__':
    main()
