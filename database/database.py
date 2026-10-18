import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv


# Ubicación de la raíz del proyecto Alerta360
BASE_DIR = Path(__file__).resolve().parent.parent

# Cargar .env desde la raíz del proyecto
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE)


def obtener_conexion():
    return psycopg.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        dbname=os.getenv("POSTGRES_DB", "alerta360"),
        user=os.getenv("POSTGRES_USER", "postgres"),
        password=os.getenv("POSTGRES_PASSWORD"),
    )


if __name__ == "__main__":
    try:
        print("Archivo .env:", ENV_FILE)
        print("Host:", os.getenv("POSTGRES_HOST"))
        print("Puerto:", os.getenv("POSTGRES_PORT"))
        print("Base de datos:", os.getenv("POSTGRES_DB"))
        print("Usuario:", os.getenv("POSTGRES_USER"))

        # No mostramos la contraseña por seguridad
        print(
            "Contraseña cargada:",
            "SI" if os.getenv("POSTGRES_PASSWORD") else "NO"
        )

        conexion = obtener_conexion()

        print("\nConexión a PostgreSQL exitosa.")

        conexion.close()

    except Exception as e:
        print("\nError al conectar con PostgreSQL:")
        print(e)