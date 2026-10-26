"""CLI para agregar un registro real a la base de datos historica
(ml/data/historico_emergencias.xlsx), sin tener que editar el Excel a mano
ni levantar la API.

Ejemplo:
    python -m ml.agregar_registro --fecha 2026-09-10 --hora 15 \\
        --zona VAL-CEN --clave 10-0 --cantidad 1 --recursos 3

Ver IDs de zona validos con: python -c "from ml.zones import ZONES; [print(z.id) for z in ZONES]"
Ver claves radiales validas con: python -c "from core.radio_codes import CLAVES_RADIALES; print(list(CLAVES_RADIALES))"
"""
import argparse

import pandas as pd

from . import database


def main() -> None:
    parser = argparse.ArgumentParser(description="Agrega un registro real al historico de emergencias (Excel)")
    parser.add_argument("--fecha", required=True, help="Fecha del despacho, formato YYYY-MM-DD")
    parser.add_argument("--hora", required=True, type=int, choices=[0, 3, 6, 9, 12, 15, 18, 21],
                         help="Bloque de 3 horas al que pertenece: 0, 3, 6, 9, 12, 15, 18 o 21")
    parser.add_argument("--zona", required=True, help="ID de la zona, ej. VAL-CEN (ver GET /zones)")
    parser.add_argument("--clave", required=True, help="Clave radial, ej. 10-0 (ver GET /catalog/claves)")
    parser.add_argument("--cantidad", type=int, default=1, help="Cantidad de emergencias de ese tipo en ese bloque (default: 1)")
    parser.add_argument("--recursos", type=int, default=None, help="Unidades despachadas (si se omite, se estima automaticamente)")
    parser.add_argument("--temperatura", type=float, default=None, help="Temperatura en C (si se omite, se usa la normal climatica)")
    parser.add_argument("--viento", type=float, default=None, help="Viento en km/h (si se omite, se usa la normal climatica)")
    parser.add_argument("--precipitacion", type=float, default=None, help="Precipitacion en mm (si se omite, se usa la normal climatica)")
    args = parser.parse_args()

    fila = database.construir_registro(
        fecha=args.fecha,
        bloque_hora=args.hora,
        zona_id=args.zona,
        tipo_emergencia=args.clave,
        cantidad_emergencias=args.cantidad,
        recursos_utilizados=args.recursos,
        temperatura_c=args.temperatura,
        viento_kmh=args.viento,
        precipitacion_mm=args.precipitacion,
    )
    database.agregar_registros(pd.DataFrame([fila]), nota="Agregado via CLI (python -m ml.agregar_registro)")
    print("Registro agregado a la base de datos:")
    for clave, valor in fila.items():
        print(f"  {clave}: {valor}")
    print("\nRecuerda correr 'python -m ml.train_model' de nuevo para que el modelo aprenda de este registro.")


if __name__ == "__main__":
    main()
