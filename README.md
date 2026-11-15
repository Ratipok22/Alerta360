# Alerta360

Sistema de apoyo a la decisión para el despacho de recursos de Bomberos en la Región de Valparaíso. Proyecto de Título (APT) de Ingeniería en Informática, Duoc UC. Prototipo académico: no está integrado con instituciones reales (Bomberos, SAMU, SENAPRED); usa datos simulados y públicos.

## Contenido

[Descripción](#descripción) · [Equipo](#equipo-y-roles) · [Metodología](#metodología) · [Arquitectura](#arquitectura) · [Estructura](#estructura-del-repositorio) · [Stack](#stack-tecnológico) · [Cómo ejecutar](#cómo-ejecutar) · [Pruebas y evaluación](#pruebas-y-evaluación) · [Marco normativo](#marco-normativo-bomberos-de-chile) · [Machine Learning](#predicción-de-demanda-machine-learning) · [Fuentes de datos](#fuentes-de-datos) · [Retrospectiva](#retrospectiva-del-proyecto) · [Estado](#estado-actual-del-avance) · [Trabajo futuro](#trabajo-futuro)

## Descripción

Alerta360 centraliza información operacional de emergencias y recursos, visualiza su ubicación geográfica, genera recomendaciones de asignación mediante un algoritmo multicriterio, y predice la demanda horaria de emergencias mediante Machine Learning en 281 zonas de la Región de Valparaíso, basadas en la cartografía del Censo 2024 del INE. El sistema está ambientado exclusivamente a Bomberos y sus ramas: incendio estructural, incendio forestal, rescate vehicular y materiales peligrosos (HazMat). No cubre atención médica ni ambulancias.

## Equipo y roles

| Integrante | Rol |
|---|---|
| Alexsander Aravena | Backend y Arquitectura — API, autenticación, lógica de negocio |
| Benjamin Saavedra | Frontend — dashboard, mapas, gestión de emergencias, integración con la API |
| Bruno Molina | Datos y Machine Learning — preparación de datos, modelos predictivos, evaluación de métricas |

## Metodología

Scrum/ágil, con sprints organizados en un Product Backlog gestionado en Trello, entregas incrementales y revisión continua. El proyecto se desarrolló en 9 sprints de 2 semanas (18 semanas), organizados en 3 fases (ver `docs/`).

## Arquitectura

```
Navegador
   |
Frontend (React + TypeScript + Vite)          -> Vercel
   |  API REST (HTTPS)
Túnel HTTPS (ngrok)
   |
Backend / API (FastAPI, autenticación JWT + Bcrypt, control de acceso por roles)  -> Docker
   |-- Emergencias, recursos (unidades y compañías), asignación multicriterio
   |-- Predicción de demanda (Machine Learning)
   |-- Soporte / Tickets
   |-- Espejo en memoria (/state) para sincronizar en vivo al rol visualizador
   |
   |-- OSRM (rutas por calles de la Región de Valparaíso)  -> Docker
   |-- Open-Meteo (clima histórico y pronóstico)
   |
PostgreSQL 16 (esquema emergencia)            -> Supabase (local: Docker)
```

La comunicación entre frontend y backend es vía API REST, documentada automáticamente con Swagger UI (`/docs`). El cálculo de rutas reales entre unidades y emergencias se realiza mediante OSRM (Open Source Routing Machine), ejecutado en Docker sobre datos reales de calles de la Región de Valparaíso.

**Versión publicada:** https://alerta360-zeta.vercel.app/ — frontend en Vercel, base de datos PostgreSQL en Supabase, y backend + OSRM en contenedores Docker expuestos mediante un túnel HTTPS (ngrok). Archivos de despliegue en `deploy/`.

## Estructura del repositorio

```
Alerta360/
├── src/
│   ├── backend/            # FastAPI, autenticación, lógica de negocio, Machine Learning
│   │   ├── core/           # Marco normativo, ETA, zonificación y compañías
│   │   ├── ml/             # Entrenamiento, evaluación y predicción de demanda
│   │   ├── evaluacion/     # Benchmark del algoritmo de asignación frente al baseline
│   │   └── tests/          # Suite Pytest de seguridad (casos de la matriz de pruebas)
│   └── frontend/           # React + TypeScript + Vite + Leaflet
├── database/               # Conexión a PostgreSQL (psycopg)
├── docker/                 # docker-compose.yml y migraciones SQL
├── deploy/                 # Despliegue (Vercel + Docker + Supabase)
├── docs/                   # Documentación por fase (FASE 1, FASE 2, FASE 3)
└── tests/performance/      # Pruebas de rendimiento (carga y concurrencia)
```

## Stack tecnológico

- **Frontend:** React 19, TypeScript, Vite, Leaflet
- **Backend / API:** Python, FastAPI, Uvicorn, Pydantic, PyJWT, Bcrypt
- **Base de datos:** PostgreSQL 16 (Docker en local, Supabase en la versión publicada), acceso vía `psycopg` 3 — emergencias, recursos, compañías, asignaciones y tickets de soporte persisten de verdad, no solo en memoria.
- **Mapas, ruteo y clima:** Leaflet, OpenStreetMap, Nominatim (geocodificación de direcciones), OSRM (Open Source Routing Machine), Open-Meteo
- **Pruebas:** Pytest, curl, Swagger UI/OpenAPI, pip-audit, npm audit, Lighthouse y Chrome headless (interfaz responsiva)
- **Machine Learning:** scikit-learn (RandomForest, ExtraTrees, GradientBoosting, con Ridge como referencia/baseline), Pandas, NumPy
- **Contenerización y despliegue:** Docker, Docker Compose, Vercel, Supabase, ngrok

## Cómo ejecutar

### 1. Base de datos (PostgreSQL) y motor de ruteo (OSRM)

```bash
cd docker
cp .env.example .env   # completar con credenciales locales, nunca subir el .env real
docker compose up -d db osrm
```

El contenedor de PostgreSQL parte vacío. Restaurar el respaldo del esquema `emergencia` (archivo `alerta360-emergencia.dump`, no versionado por contener datos; solicitarlo al responsable de backend):

```bash
docker compose exec -T db pg_restore -U <POSTGRES_USER> -d <POSTGRES_DB> --no-owner --no-acl < ruta/alerta360-emergencia.dump
```

Usar el mismo usuario y base definidos en `docker/.env`. El respaldo incluye las tablas, las 281 zonas y el histórico usado para entrenar el modelo.

### 2. Backend / API

```bash
cd src/backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # completar con las mismas credenciales de Postgres y un JWT_SECRET_KEY propio
python -m ml.train_model
uvicorn main:app --reload
```

API disponible en http://localhost:8000/docs

### 3. Frontend

```bash
cd src/frontend
npm install
npm run dev
```

Abrir la URL que indique Vite (normalmente http://localhost:5173).

## Pruebas y evaluación

La suite de seguridad automatiza los casos de la matriz de pruebas (autenticación, roles, tickets/adjuntos, inyección, CORS, rutas públicas, errores, límites de uso y dependencias). No usa la base de datos real: toda conexión se reemplaza por una simulada.

```bash
cd src/backend
pip install -r requirements-dev.txt
python -m pytest -v tests
```

Las pruebas de rendimiento (carga, concurrencia y transferencia del frontend) están en `tests/performance/`; ver su `README.md` para la ejecución.

Benchmark del algoritmo de asignación (1.500 escenarios simulados):

```bash
cd src/backend
python -m evaluacion.benchmark_asignacion
```

Resultado: frente a la estrategia de "recurso más cercano", la asignación multicriterio aumentó la cobertura con recursos del tipo adecuado de 46 % a 95 %, con un tiempo estimado de llegada promedio mayor (de 1,4 a 3,4 min), ya que la unidad adecuada no siempre es la más próxima. Los resultados quedan en `src/backend/evaluacion/resultados_benchmark.json`.

## Marco normativo (Bomberos de Chile)

`src/backend/core/` centraliza el estándar operativo real usado por todo el sistema:

- `radio_codes.py`: claves radiales 10-0 a 10-5 y 10-12, con prioridad y unidades mínimas requeridas por tipo de emergencia.
- `vehicle_types.py`: nomenclatura real de material mayor (B/BX/B-U, BF/BR, R/RX, Q/M, Z, H).
- `radio_states.py`: máquina de estados de transmisión radial (6-0 a 6-9) con transiciones válidas.
- `eta.py`: distancia Haversine y tiempo estimado de llegada ajustado por velocidad urbano (30 km/h, por las pendientes y calles angostas de los cerros) o forestal (50 km/h).
- `companies.py`: compañías reales de Cuerpos de Bomberos de Valparaíso y Viña del Mar, verificadas cruzando fuentes oficiales con OpenStreetMap/Overpass.

## Predicción de demanda (Machine Learning)

El entrenamiento compara distintas familias de modelo (RandomForest, ExtraTrees, Gradient Boosting y una regresión Ridge como referencia lineal) y selecciona el de menor error para predecir la demanda esperada por zona, clave radial y bloque horario de 3 horas. El modelo se entrena desde `emergencia.registro_historico` en PostgreSQL, que se alimenta automáticamente al cerrar cada emergencia junto con el clima del momento (Open-Meteo / ERA5). Las predicciones se guardan en `emergencia.prediccion` y se muestran como mapa de calor en el Dashboard. Los datos de entrenamiento son simulados; la evaluación usa una partición aleatoria, y la validación cronológica queda como trabajo futuro.

Las 281 zonas (`src/backend/core/data/zonas_valparaiso.geojson`) provienen de la cartografía del Censo 2024 del INE; cada emergencia se asocia automáticamente a su zona según sus coordenadas. La tasa base de incendio forestal está calibrada contra la cifra oficial reportada por CONAF para la temporada 2025-2026 en la Región de Valparaíso.

## Fuentes de datos

| Dato | Fuente |
|---|---|
| 281 zonas de la Región de Valparaíso | INE, cartografía del Censo 2024 |
| Ubicación de los cuarteles de Bomberos | OpenStreetMap / Overpass, cruzado con fuentes públicas de cada Cuerpo |
| Calles para el cálculo de rutas | OpenStreetMap (OSRM) |
| Clima histórico y pronóstico | Open-Meteo (reanálisis ERA5) |
| Calibración de incendios forestales | CONAF, temporada 2025-2026 |
| Histórico de emergencias | Simulado (no se dispone de registros operacionales reales) |

## Retrospectiva del proyecto

Resumen de los sprints de la metodología Scrum aplicada. El detalle completo de cada sprint (trabajo realizado, aspectos positivos, dificultades y acciones de mejora) se encuentra en la Documentación General del Proyecto APT, sección Retrospectiva.

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

## Estado actual del avance

- [x] Dashboard operacional funcional (mapa, recursos, emergencias, historial)
- [x] Algoritmo de asignación multicriterio con justificación explicable
- [x] Marco normativo de Bomberos de Chile y flota de compañías reales
- [x] Autenticación JWT y control de acceso por roles (RBAC: admin, visualizador, soporte)
- [x] Motor de ruteo real (OSRM) sobre calles de la Región de Valparaíso
- [x] Persistencia en PostgreSQL 16 (emergencias, recursos, compañías, asignaciones)
- [x] Módulo de Soporte / Tickets persistido en Postgres, con seguimiento individual por usuario
- [x] Sincronización en tiempo real del rol visualizador (`/state`)
- [x] Pruebas de seguridad (16 casos) con suite automatizada en Pytest
- [x] Diseño responsivo verificado de 360 px a 2560 px (celular, tablet, notebook y escritorio)
- [x] Accesibilidad: operación completa por teclado y Lighthouse Accessibility 96/100
- [x] Compatibilidad verificada en Chrome, Edge y Firefox
- [x] Predicción de demanda (ML) integrada con PostgreSQL y mapa de calor en el Dashboard
- [x] Benchmark del algoritmo de asignación frente al baseline de "recurso más cercano"
- [x] Pruebas de rendimiento (carga, concurrencia y frontend)
- [x] Despliegue web (Vercel + Supabase + Docker)

## Trabajo futuro

Alerta360 es un prototipo académico con datos simulados. Como trabajo futuro se plantea:

1. Validar el sistema con datos reales y en tiempo real, en conjunto con Bomberos.
2. Incorporar una validación cronológica del modelo de Machine Learning.
3. Ampliar la cobertura a otras regiones, hasta abarcar todo Chile.

