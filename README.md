# Alerta360

Sistema de apoyo a la decisión para el despacho de recursos de Bomberos en la Región de Valparaíso. Proyecto de Título (APT) de Ingeniería en Informática, Duoc UC. Prototipo académico: no está integrado con instituciones reales (Bomberos, SAMU, SENAPRED); usa datos simulados y públicos.

## Descripción

Alerta360 centraliza información operacional de emergencias y recursos, visualiza su ubicación geográfica, genera recomendaciones de asignación mediante un algoritmo multicriterio, y predice la demanda horaria de emergencias mediante Machine Learning en 19 zonas reales de la Región de Valparaíso. El sistema está ambientado exclusivamente a Bomberos y sus ramas: incendio estructural, incendio forestal, rescate vehicular y materiales peligrosos (HazMat). No cubre atención médica ni ambulancias.

## Equipo y roles

| Integrante | Rol |
|---|---|
| Alexsander Aravena | Backend y Arquitectura — API, autenticación, lógica de negocio |
| Benjamin Saavedra | Frontend — dashboard, mapas, gestión de emergencias, integración con la API |
| Bruno Molina | Datos y Machine Learning — preparación de datos, modelos predictivos, evaluación de métricas |

## Metodología

Scrum/ágil, con sprints organizados en un Product Backlog gestionado en Trello, entregas incrementales y revisión continua. Duración planificada: 18 semanas en 3 fases (ver `docs/`).

## Arquitectura

```
Frontend (React + TypeScript + Vite)
        |
Backend / API (FastAPI, autenticacion JWT + Bcrypt, control de acceso por roles)
        |
Logica de negocio
  - Emergencias
  - Recursos (unidades y companias)
  - Asignacion multicriterio
  - Prediccion de demanda (Machine Learning)
        |
Estado compartido en memoria (/state)
```

La comunicación entre frontend y backend es vía API REST, documentada automáticamente con Swagger UI (`/docs`). El cálculo de rutas reales entre unidades y emergencias se realiza mediante OSRM (Open Source Routing Machine), ejecutado localmente en Docker sobre datos reales de calles de la Región de Valparaíso.

## Estructura del repositorio

```
Alerta360/
├── src/
│   ├── backend/     # FastAPI, autenticacion, logica de negocio, modelos de Machine Learning
│   └── frontend/    # React + TypeScript + Vite + Leaflet
├── docker/          # docker-compose.yml y configuracion de contenedores
├── docs/            # Documentacion por fase (FASE 1, FASE 2, FASE 3)
├── database/        # Esquema de persistencia (en definicion)
└── tests/           # Pruebas automatizadas (en construccion)
```

## Stack tecnológico

- **Frontend:** React 18, TypeScript, Vite
- **Backend / API:** Python, FastAPI, Pydantic, PyJWT, Bcrypt
- **Mapas y ruteo:** Leaflet, OpenStreetMap, OSRM (Open Source Routing Machine)
- **Machine Learning:** scikit-learn (RandomForest, ExtraTrees, GradientBoosting, con Ridge como referencia/baseline), Pandas, NumPy
- **Persistencia:** estado operacional compartido en memoria (`/state`); migración a PostgreSQL 16 planificada para la etapa final
- **Contenerización:** Docker, Docker Compose
- Todo se ejecuta de forma local, sin servicios externos de pago.

## Cómo ejecutar

### Backend / API

```bash
cd src/backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m ml.train_model
uvicorn main:app --reload
```

API disponible en http://localhost:8000/docs

### Frontend

```bash
cd src/frontend
npm install
npm run dev
```

Abrir la URL que indique Vite (normalmente http://localhost:5173).

### Motor de ruteo (OSRM)

```bash
docker run -d --name osrm-valparaiso -p 5001:5000 fruna/osrm-valparaiso
```

## Marco normativo (Bomberos de Chile)

`src/backend/core/` centraliza el estándar operativo real usado por todo el sistema:

- `radio_codes.py`: claves radiales 10-0 a 10-12, con prioridad y unidades mínimas requeridas por tipo de emergencia.
- `vehicle_types.py`: nomenclatura real de material mayor (B/BX/B-U, BF/BR, R/RX, Q/M, Z, H).
- `radio_states.py`: máquina de estados de transmisión radial (6-0 a 6-9) con transiciones válidas.
- `eta.py`: distancia Haversine y tiempo estimado de llegada ajustado por velocidad urbano (35 km/h) o forestal (50 km/h).
- `companies.py`: compañías reales de Cuerpos de Bomberos de Valparaíso y Viña del Mar, verificadas cruzando fuentes oficiales con OpenStreetMap/Overpass.

## Predicción de demanda (Machine Learning)

El entrenamiento compara distintas familias de modelo (RandomForest, ExtraTrees, Gradient Boosting y una regresión Ridge como referencia lineal) y selecciona el de mejor desempeño para predecir la demanda esperada por zona y clave radial. La evaluación se realiza con un conjunto de datos de validación independiente, separado del de entrenamiento.

Las zonas (`src/backend/ml/zones.py`) corresponden a sectores reales de Valparaíso, Viña del Mar y Concón, cada uno con un perfil de riesgo propio basado en su geografía real. La tasa base de incendio forestal está calibrada contra la cifra oficial reportada por CONAF para la temporada 2025-2026 en la Región de Valparaíso.

## Estado actual del avance

- [x] Dashboard operacional funcional (mapa, recursos, emergencias, historial)
- [x] Algoritmo de asignación multicriterio con justificación explicable
- [x] Modelo de Machine Learning de predicción de demanda, entrenado y expuesto vía API
- [x] Marco normativo de Bomberos de Chile y flota de compañías reales
- [x] Autenticación JWT y control de acceso por roles (RBAC)
- [x] Motor de ruteo real (OSRM) sobre calles de la Región de Valparaíso
- [x] Sincronización de estado operacional compartido en tiempo real (`/state`)
- [ ] Persistencia en PostgreSQL (actualmente en memoria)
- [ ] Suite de pruebas automatizadas
- [ ] Documentación final del benchmark del algoritmo de asignación frente al baseline

## Próxima etapa

1. Migrar la persistencia del estado operacional a PostgreSQL.
2. Incorporar la suite de pruebas automatizadas.
3. Documentar los resultados finales de la evaluación experimental y de Machine Learning.
4. Consolidar en esta rama principal el trabajo desarrollado en las ramas de cada integrante.
