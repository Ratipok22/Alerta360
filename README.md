# Alerta360

**Sistema de apoyo a la decisión para el despacho de recursos de Bomberos en la Región de Valparaíso.**

Proyecto APT de la asignatura Capstone (APT122, sección 002D) — Ingeniería en Informática, Duoc UC, sede Valparaíso.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Vite-3178C6?logo=typescript&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-Python-009688?logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![scikit-learn](https://img.shields.io/badge/Machine%20Learning-scikit--learn-F7931E?logo=scikitlearn&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

**Versión publicada:** https://alerta360-zeta.vercel.app/

> Prototipo académico. No está integrado con instituciones reales (Bomberos, SAMU, SENAPRED) y utiliza datos simulados y públicos.

## Contenido

1. [Descripción](#descripción)
2. [Funcionalidades por rol](#funcionalidades-por-rol)
3. [Arquitectura](#arquitectura)
4. [Stack tecnológico](#stack-tecnológico)
5. [Estructura del repositorio](#estructura-del-repositorio)
6. [Instalación local](#instalación-local)
7. [Despliegue web](#despliegue-web)
8. [Pruebas y evaluación](#pruebas-y-evaluación)
9. [Marco normativo (Bomberos de Chile)](#marco-normativo-bomberos-de-chile)
10. [Predicción de demanda (Machine Learning)](#predicción-de-demanda-machine-learning)
11. [Fuentes de datos](#fuentes-de-datos)
12. [Documentación del proyecto](#documentación-del-proyecto)
13. [Metodología y retrospectiva](#metodología-y-retrospectiva)
14. [Estado actual del avance](#estado-actual-del-avance)
15. [Trabajo futuro](#trabajo-futuro)
16. [Equipo](#equipo)

## Descripción

Alerta360 centraliza la información operacional de emergencias y recursos de Bomberos, visualiza su ubicación en un mapa y apoya al operador en dos decisiones clave:

- **Qué recurso despachar:** un algoritmo multicriterio recomienda la unidad más adecuada considerando disponibilidad, compatibilidad con el tipo de emergencia, distancia, tiempo estimado de llegada, capacidad y dotación. La decisión final siempre queda en manos del operador.
- **Dónde se espera mayor demanda:** un modelo de Machine Learning estima la cantidad de emergencias esperadas por zona, tipo de emergencia y bloque horario, y la muestra como mapa de calor.

El sistema cubre 281 zonas de la Región de Valparaíso, basadas en la cartografía del Censo 2024 del INE, y está ambientado exclusivamente a Bomberos y sus especialidades: incendio estructural, incendio forestal, rescate vehicular y materiales peligrosos (HazMat). No cubre atención médica ni ambulancias.

## Funcionalidades por rol

| Rol | Puede |
|---|---|
| **Administrador** (operador de central) | Registrar emergencias, recibir recomendaciones de asignación, despachar o rechazar unidades, actualizar estados y consultar el mapa de calor de demanda e historial. |
| **Visualizador** | Ver en tiempo real lo que gestiona el operador (solo lectura) y marcar como disponible (6-0) o fuera de servicio (6-9) los recursos de su propia compañía. |
| **Soporte** | Gestionar los tickets de soporte: responder, cambiar su estado y asignar su prioridad. |

Todos los usuarios pueden crear tickets de soporte y dar seguimiento a sus propias solicitudes.

## Arquitectura

```
Navegador
   |
Frontend (React + TypeScript + Vite)                        -> Vercel
   |  API REST (HTTPS)
Túnel HTTPS (ngrok)
   |
Backend / API (FastAPI, JWT + Bcrypt, control de acceso por roles)   -> Docker
   |-- Emergencias, recursos y asignación multicriterio
   |-- Predicción de demanda (Machine Learning)
   |-- Soporte / Tickets
   |-- Sincronización en vivo del rol visualizador (/state)
   |
   |-- OSRM: rutas por calles de la Región de Valparaíso    -> Docker
   |-- Open-Meteo: clima histórico y pronóstico
   |
PostgreSQL 16, esquema emergencia                           -> Supabase (local: Docker)
```

El navegador nunca se conecta directamente a la base de datos: todo acceso pasa por la API. La API se documenta automáticamente con Swagger UI en `/docs`.

Diagramas detallados (arquitectura, modelo entidad-relación, flujo general y algoritmo de asignación) en [`Evidencias de documentación/Diagramas`](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20documentaci%C3%B3n/Diagramas).

## Stack tecnológico

| Capa | Tecnologías |
|---|---|
| Frontend | React 19, TypeScript, Vite, Leaflet |
| Backend / API | Python, FastAPI, Uvicorn, Pydantic, PyJWT, Bcrypt |
| Base de datos | PostgreSQL 16 (Docker en local, Supabase en la versión publicada), `psycopg` 3 |
| Mapas, rutas y clima | OpenStreetMap, Nominatim (búsqueda de direcciones), OSRM, Open-Meteo |
| Machine Learning | scikit-learn (Random Forest, Extra Trees, Gradient Boosting y Ridge como referencia), Pandas, NumPy |
| Pruebas | Pytest, HTTPX, Swagger UI, pip-audit, npm audit, Lighthouse |
| Contenedores y despliegue | Docker, Docker Compose, Vercel, Supabase, ngrok |

## Estructura del repositorio

```
Alerta360/
├── src/
│   ├── backend/            # API FastAPI
│   │   ├── core/           # Marco normativo, ETA, zonificación y compañías
│   │   ├── ml/             # Entrenamiento, evaluación y predicción de demanda
│   │   ├── evaluacion/     # Benchmark del algoritmo de asignación
│   │   └── tests/          # Suite Pytest de seguridad
│   └── frontend/           # React + TypeScript + Vite + Leaflet
├── database/               # Conexión a PostgreSQL
├── docker/                 # docker-compose.yml y migraciones SQL
├── deploy/                 # Archivos de despliegue
├── docs/                   # Documentación y evidencias por fase
└── tests/performance/      # Pruebas de rendimiento
```

## Instalación local

Cada paso parte desde la carpeta raíz del repositorio (`Alerta360/`), en una terminal nueva o volviendo a ella antes de ejecutarlo.

### Requisitos previos

- Python 3.12 o superior
- Node.js 20.19 o superior (o 22.12+), con npm
- Docker Desktop (en ejecución)
- Git
- Respaldo de la base de datos: archivo `emergencia` en [`Evidencias de sistema/Base de datos`](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20sistema/Base%20de%20datos)

### 1. Clonar el repositorio

```bash
git clone https://github.com/Ratipok22/Alerta360.git
cd Alerta360
```

### 2. Base de datos (PostgreSQL)

```bash
cd docker
cp .env.example .env        # completar con credenciales locales; nunca subir el .env
docker compose up -d db
```

El contenedor crea una base vacía con el nombre y usuario definidos en `docker/.env` (`POSTGRES_DB` y `POSTGRES_USER`). Restaurar en ella el respaldo, que incluye el esquema, las 281 zonas, compañías, recursos, usuarios y el histórico de emergencias:

```bash
docker cp "docs/FASE 2/EVIDENCIAS PROYECTO/Evidencias de sistema/Base de datos/emergencia" docker-db-1:/tmp/respaldo.dump
docker exec docker-db-1 pg_restore -U <POSTGRES_USER> -d <POSTGRES_DB> --no-owner --no-privileges /tmp/respaldo.dump
```

Reemplazar `<POSTGRES_USER>` y `<POSTGRES_DB>` por los valores de `docker/.env`. Es normal que aparezcan advertencias sobre permisos de owner. Verificar que la consulta devuelva 281:

```bash
docker exec docker-db-1 psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "SELECT count(*) FROM emergencia.zona;"
```

### 3. Motor de rutas (OSRM)

Imagen ya preparada con las calles de la Región de Valparaíso:

```bash
docker run -d --name osrm-valparaiso -p 5001:5000 fruna/osrm-valparaiso:valparaiso-v1
```

### 4. Backend / API

```bash
cd src/backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # agregar POSTGRES_USER, POSTGRES_PASSWORD y POSTGRES_DB (los mismos de docker/.env) y un JWT_SECRET_KEY propio
python -m ml.train_model    # entrena el modelo de predicción a partir del histórico
uvicorn main:app --reload
```

API disponible en http://localhost:8000 y documentación en http://localhost:8000/docs.

### 5. Frontend

```bash
cd src/frontend
npm install
npm run dev
```

Abrir http://localhost:5173. En local el frontend se conecta automáticamente a `http://localhost:8000`; para otro backend, definir la variable `VITE_API_URL`.

### 6. Cuentas de acceso

En desarrollo local, el backend habilita cuentas de prueba para los roles administrador, visualizador y soporte, definidas en `src/backend/core/auth.py`. Las credenciales se entregan al equipo y al evaluador por un canal privado; no se publican en este repositorio. En producción (`APP_ENV=production`) solo se habilitan las cuentas configuradas en `OPERADORES_BCRYPT_JSON`.

### Variables de entorno principales

| Variable | Archivo | Uso |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `docker/.env` y `src/backend/.env` | Credenciales de PostgreSQL; deben coincidir en ambos archivos |
| `DATABASE_URL` | `src/backend/.env` | Conexión a PostgreSQL en una sola URL (alternativa a las variables anteriores; se usa con Supabase) |
| `JWT_SECRET_KEY` | `src/backend/.env` | Clave de firma de las sesiones |
| `OSRM_URL` | `src/backend/.env` | Dirección del motor de rutas (por defecto `http://localhost:5001`) |
| `CORS_ORIGINS` | `src/backend/.env` | Orígenes permitidos (por defecto `http://localhost:5173`) |
| `VITE_API_URL` | Vercel / `src/frontend` | Dirección pública del backend |

## Despliegue web

| Componente | Servicio |
|---|---|
| Frontend | Vercel, vinculado a GitHub: cada push a `main` genera un nuevo despliegue |
| Base de datos | PostgreSQL en Supabase (conexión SSL) |
| Backend y OSRM | Contenedores Docker (`Dockerfile.api`) |
| Acceso público al backend | Túnel HTTPS con ngrok |

Los archivos y el procedimiento de despliegue están en [`deploy/`](deploy/) y en el Manual Técnico.

## Pruebas y evaluación

**Pruebas de seguridad** — automatizan los casos de la matriz de pruebas (autenticación, roles, tickets y adjuntos, inyección, CORS, rutas públicas, errores, límites de uso y dependencias). No usan la base de datos real:

```bash
cd src/backend
pip install -r requirements-dev.txt
python -m pytest -v tests
```

**Pruebas de rendimiento** — carga, concurrencia, roles combinados y transferencia del frontend. Instrucciones en [`tests/performance/README.md`](tests/performance/README.md).

**Benchmark del algoritmo de asignación** — compara la estrategia multicriterio con la de "recurso más cercano" en 1.500 escenarios simulados:

```bash
cd src/backend
python -m evaluacion.benchmark_asignacion
```

| Métrica | Recurso más cercano | Multicriterio |
|---|---|---|
| Cobertura con recurso del tipo adecuado | 46 % | 95 % |
| Tiempo estimado de llegada promedio | 1,4 min | 3,4 min |

La estrategia multicriterio asigna la unidad adecuada en casi todos los casos, a cambio de un tiempo de llegada mayor, ya que esa unidad no siempre es la más cercana. Resultados completos en [`src/backend/evaluacion/resultados_benchmark.json`](src/backend/evaluacion/resultados_benchmark.json).

## Marco normativo (Bomberos de Chile)

`src/backend/core/` centraliza el estándar operativo usado por todo el sistema:

- `radio_codes.py`: claves radiales 10-0 a 10-5 y 10-12, con prioridad y unidades mínimas requeridas por tipo de emergencia.
- `radio_states.py`: estados radiales de las unidades (6-0 a 6-9) y sus transiciones válidas.
- `vehicle_types.py`: nomenclatura de material mayor (B/BX/B-U, BF/BR, R/RX, Q/M, Z, H).
- `eta.py`: distancia Haversine y tiempo estimado de llegada con velocidad limitada según el terreno: 30 km/h urbano (por las pendientes y calles angostas de los cerros) y 50 km/h forestal.
- `companies.py`: compañías reales de los Cuerpos de Bomberos de Valparaíso y Viña del Mar, verificadas con OpenStreetMap/Overpass.
- `zonificacion.py`: asociación automática de cada emergencia a su zona según sus coordenadas.

## Predicción de demanda (Machine Learning)

- **Datos:** el modelo se entrena desde `emergencia.registro_historico`, que se alimenta automáticamente al cerrar cada emergencia junto con el clima del momento (Open-Meteo / ERA5). El histórico de entrenamiento es simulado.
- **Modelos:** se comparan Random Forest, Extra Trees y Gradient Boosting, con una regresión Ridge como referencia, y se selecciona el de menor error.
- **Predicción:** cantidad esperada de emergencias por zona, clave radial y bloque horario de 3 horas. Los resultados se guardan en `emergencia.prediccion` y se muestran como mapa de calor en el Dashboard.
- **Calibración:** la tasa base de incendio forestal está calibrada con la cifra oficial de CONAF para la temporada 2025-2026 en la Región de Valparaíso.
- **Limitación:** la evaluación usa una partición aleatoria; la validación cronológica queda como trabajo futuro.

## Fuentes de datos

| Dato | Fuente |
|---|---|
| 281 zonas de la Región de Valparaíso | INE, cartografía del Censo 2024 |
| Ubicación de los cuarteles de Bomberos | OpenStreetMap / Overpass, cruzado con fuentes públicas de cada Cuerpo |
| Calles para el cálculo de rutas | OpenStreetMap (OSRM) |
| Clima histórico y pronóstico | Open-Meteo (reanálisis ERA5) |
| Calibración de incendios forestales | CONAF, temporada 2025-2026 |
| Histórico de emergencias | Simulado (no se dispone de registros operacionales reales) |

## Documentación del proyecto

| Documento | Ubicación |
|---|---|
| Documentación General del Proyecto APT | [Alerta360_Documentacion_General_Proyecto_APT.docx](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20documentaci%C3%B3n/Alerta360_Documentacion_General_Proyecto_APT.docx) |
| Manual Técnico (instalación local y despliegue) | [Manual_Tecnico_Alerta360.docx](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20documentaci%C3%B3n/Manual_Tecnico_Alerta360.docx) |
| Product Vision y metas de sprint | [Alerta360_Product_Vision_y_metas_de_sprint.docx](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20documentaci%C3%B3n/Alerta360_Product_Vision_y_metas_de_sprint.docx) |
| Diagramas | [Evidencias de documentación/Diagramas](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20documentaci%C3%B3n/Diagramas) |
| Respaldo de la base de datos | [Evidencias de sistema/Base de datos](docs/FASE%202/EVIDENCIAS%20PROYECTO/Evidencias%20de%20sistema/Base%20de%20datos) |
| Evidencias por fase | [`docs/`](docs/) |

## Metodología y retrospectiva

El proyecto se desarrolló con Scrum, en 9 sprints de 2 semanas (18 semanas) organizados en 3 fases, con un Product Backlog priorizado, entregas incrementales y una retrospectiva al cierre de cada sprint.

| Sprint | Semanas | Enfoque | Aprendizaje principal |
|---|---|---|---|
| 1 | 1–2 | Análisis y definición del MVP | Precisar los límites del prototipo y documentar sus supuestos |
| 2 | 3–4 | Requisitos y planificación | Mantener actualizados el Sprint Backlog y la trazabilidad |
| 3 | 5–6 | Arquitectura y diseño | Actualizar los diagramas a medida que evoluciona el sistema |
| 4 | 7–8 | Base técnica (API, JWT, roles) | Probar temprano la conexión a PostgreSQL y el acceso por rol |
| 5 | 9–10 | Gestión operacional y mapa | Verificar el ciclo completo de una emergencia |
| 6 | 11–12 | Asignación multicriterio | Respaldar el algoritmo con evidencia experimental |
| 7 | 13–14 | Predicción con Machine Learning | Incorporar una validación cronológica del modelo |
| 8 | 15–16 | Integración, Docker y pruebas | Verificar los flujos completos tras cada integración |
| 9 | 17–18 | Cierre y despliegue web | Mantener la documentación sincronizada con el código |

El detalle de cada sprint (trabajo realizado, aspectos positivos, dificultades y acciones de mejora) está en la Documentación General del Proyecto APT, sección Retrospectiva.

## Estado actual del avance

**Funcionalidades**
- [x] Dashboard operacional: mapa, recursos, emergencias e historial
- [x] Algoritmo de asignación multicriterio con justificación explicable
- [x] Motor de rutas real (OSRM) sobre calles de la Región de Valparaíso
- [x] Predicción de demanda (Machine Learning) con mapa de calor
- [x] Módulo de Soporte / Tickets con seguimiento por usuario
- [x] Sincronización en tiempo real del rol visualizador

**Plataforma y seguridad**
- [x] Autenticación JWT y control de acceso por roles (administrador, visualizador, soporte)
- [x] Persistencia en PostgreSQL 16
- [x] Despliegue web (Vercel + Supabase + Docker)

**Calidad**
- [x] Pruebas de seguridad automatizadas con Pytest
- [x] Pruebas de rendimiento (carga, concurrencia y frontend)
- [x] Benchmark del algoritmo de asignación frente al baseline
- [x] Diseño responsivo verificado de 360 px a 2560 px
- [x] Accesibilidad: operación por teclado y Lighthouse Accessibility 96/100
- [x] Compatibilidad verificada en Chrome, Edge y Firefox

## Trabajo futuro

1. Validar el sistema con datos reales y en tiempo real, en conjunto con Bomberos.
2. Incorporar una validación cronológica del modelo de Machine Learning.
3. Ampliar la cobertura a otras regiones, hasta abarcar todo Chile.

## Equipo

Equipo 06, sede Valparaíso.

| Integrante | Rol |
|---|---|
| Alexsander Aravena | Backend y arquitectura: API, autenticación, lógica de negocio y despliegue |
| Benjamin Saavedra | Frontend: dashboard, mapas, gestión de emergencias e integración con la API |
| Bruno Molina | Datos y Machine Learning: preparación de datos, modelos predictivos y evaluación |

---

Proyecto académico desarrollado en la asignatura Capstone (APT122, sección 002D) de Ingeniería en Informática, Duoc UC, sede Valparaíso. Uso educativo.
