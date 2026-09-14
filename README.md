# Alerta360

Sistema de apoyo a la decisión para el despacho de recursos de **Bomberos** en la Región de Valparaíso — Proyecto de Título (APT) de Ingeniería en Informática. Prototipo académico: no está integrado con instituciones reales (Bomberos, SAMU, SINAPRED); usa datos simulados y públicos.

## Alcance

El sistema está ambientado exclusivamente a Bomberos y sus ramas — incendio estructural, incendio forestal, rescate vehicular y materiales peligrosos (HazMat). No cubre atención médica ni ambulancias.

## Equipo y roles (Scrum)

| Integrante | Rol |
|---|---|
| Benjamin Saavedra | Frontend — dashboard, mapas, gestión de emergencias, integración con la API |
| Bruno Molina | Datos y algoritmos — preparación de datos, modelo predictivo de ML, algoritmo de asignación, evaluación de métricas |
| Alexsander Aravena | Coordinación y Backend — diseño de la API, lógica de negocio, integración con base de datos |

Metodología: Scrum/Agile (sprints, backlog, daily, burndown, review/retrospectiva). Duración: 18 semanas en 3 fases (ver `docs/`).

## Estructura del repositorio

```
Alerta360/
├── src/
│   ├── backend/     # FastAPI + modelo de Machine Learning (ver detalle abajo)
│   └── frontend/    # React + TypeScript + Vite + Leaflet
├── docs/            # Documentación por fase (FASE 1, FASE 2, FASE 3)
├── docker/          # docker-compose.yml
└── run.sh           # Script para levantar backend + frontend en local
```

`database/` y `tests/` se removieron por ahora (no se estaban usando en esta fase); se vuelven a crear cuando corresponda según el checklist de abajo (modelo de datos real y pruebas automatizadas).

## Stack

- **Frontend:** React + TypeScript + Vite, mapas con Leaflet + OpenStreetMap.
- **Backend:** FastAPI (Python).
- **Machine Learning:** scikit-learn (RandomForestRegressor) para predicción de demanda.
- **Persistencia preparada:** PostgreSQL vía Docker Compose (`docker/docker-compose.yml`).
- Todo se ejecuta 100% local — sin servicios externos ni de pago.

## Cómo ejecutar

### Backend / API
```bash
cd src/backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m ml.train_model   # genera el dataset simulado (si no existe) y entrena el modelo de demanda
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

También existe `run.sh` en la raíz para levantar ambos servicios juntos en un entorno Git Bash/Unix.

## Marco normativo (Bomberos de Chile)

`src/backend/core/` centraliza el estándar operativo real usado por todo el sistema:
- `radio_codes.py`: claves radiales 10-0 a 10-12 (incendio estructural, incendio de vehículo, incendio forestal/pastizales, salvamento, rescate vehicular, HazMat, apoyo/preposicionamiento), con prioridad y unidades mínimas requeridas.
- `vehicle_types.py`: nomenclatura real de material mayor (B/BX/B-U, BF/BR, R/RX, Q/M, Z, H).
- `radio_states.py`: máquina de estados de transmisión radial (6-0 a 6-9) con transiciones válidas.
- `eta.py`: distancia Haversine y ETA ajustado por velocidad urbano (35 km/h) / forestal (50 km/h).
- `companies.py`: **26 compañías reales** — las 16 del Cuerpo de Bomberos de Valparaíso (fundado 1851) y 10 del Cuerpo de Bomberos de Viña del Mar, verificadas cruzando Wikipedia con OpenStreetMap/Overpass (`amenity=fire_station`). Preparado para extender a otras comunas de la región y, a futuro, a todo Chile.

## Predicción de demanda (Machine Learning)

Un modelo entrenado comparando varias familias (RandomForest, ExtraTrees, GradientBoosting y una regresión lineal Ridge como referencia) predice la demanda esperada por zona, bloque de 3 horas y clave radial, usando fecha, hora, día de la semana, mes, zona geográfica, clave radial, historial reciente y **condiciones climáticas (temperatura, viento, precipitación)** como variables de entrada.

Las zonas (`src/backend/ml/zones.py`) son sectores reales de Valparaíso/Viña del Mar/Concón con nombre propio (no una grilla ciega de coordenadas), cada uno con un perfil de riesgo por clave basado en su geografía real (p. ej. Reñaca Alto concentra el riesgo de incendio forestal por sus cerros; Concón concentra el riesgo de materiales peligrosos por la refinería ENAP). La tasa base de incendio forestal (10-2) está calibrada para que el total simulado anual se acerque a la cifra real reportada por CONAF: **575 incendios forestales en la Región de Valparaíso, temporada 2025-2026**. El resto de la distribución (hora, día, zona) es un supuesto razonado, no datos reales de despacho (no existe un dataset público de incidentes de Bomberos de Chile).

Las variables climáticas (`src/backend/ml/weather.py`) están ancladas a las normales climáticas reales de la zona (clima mediterráneo costero: veranos secos ~17-18 °C, inviernos lluviosos ~11-12 °C con lluvia concentrada en junio-julio) y modelan un efecto real y documentado: más calor y viento elevan el riesgo de incendio forestal (10-2); más lluvia/viento elevan el riesgo de rescate vehicular (10-4). Para predicciones futuras se usa la normal climática esperada de esa época del año (no un pronóstico meteorológico real, ya que no hay una API de clima integrada — limitación documentada en `docs/ML_prediccion_demanda.md`).

El propio modelo expone qué variables pesan realmente en sus predicciones (`permutation_importance` de scikit-learn sobre datos no vistos, agregada por variable de entrada) — se calcula en cada entrenamiento y se sirve vía API, no es un texto redactado a mano.

**Metodología de entrenamiento, resultados del modelo ganador y qué tan creíble es la predicción:** ver [`docs/ML_prediccion_demanda.md`](docs/ML_prediccion_demanda.md) — incluye la comparación de las 4 familias de modelo, el MAE en un set de validación independiente (época nunca vista), la exactitud de nivel de riesgo (Baja/Media/Alta) y una lectura honesta de las limitaciones (dataset simulado, colinealidad del clima con mes/hora, etc.).

Endpoints principales (requieren sesión iniciada — login con JWT, ver `src/backend/core/auth.py`):
- `GET /catalog/claves`: catálogo de claves radiales (nombre, prioridad, terreno).
- `GET /zones`: zonas geográficas reales usadas por el modelo.
- `GET /resources`: flota de unidades real, con ETA/distancia calculados en vivo.
- `GET /prediction/demand?horizon=4`: demanda esperada por zona para los próximos `horizon` bloques de 3 horas, incluyendo `importancia_variables` y el `clima_esperado` usado para cada zona/período.

## Dashboard

El dashboard muestra dos mapas: el **mapa operacional** (emergencias y recursos en tiempo real, con estados según la máquina de estados 6-0 a 6-9) y un **mapa de calor tipo choropleth** (cada zona pintada con su propio color sólido verde/amarillo/rojo según su demanda esperada), acompañado de alertas de texto y el detalle del razonamiento del modelo.

El algoritmo de recomendación de recurso es multicriterio: considera tipo de emergencia, tipo/capacidad de la unidad, coincidencia de terreno (urbano/forestal), dotación (ponderada según la criticidad de la clave) y ETA/distancia — y respeta que una compañía ya comprometida con una emergencia no sea recomendada para otra hasta liberarse. Cada recomendación y cada emergencia activa muestra una breve justificación calculada a partir de estos mismos factores.

## Estado actual del avance

- [x] Dashboard operacional funcional (mapa, recursos, emergencias, historial).
- [x] Algoritmo de asignación multicriterio con justificación explicable.
- [x] Modelo de ML de predicción de demanda entrenado y expuesto vía API.
- [x] Capa climática (temperatura/viento/precipitación) integrada como variable de entrada del modelo y en el detalle del mapa de calor.
- [x] Marco normativo de Bomberos de Chile (claves, vehículos, estados, ETA) y flota de compañías reales.
- [ ] Persistencia en PostgreSQL (actualmente todo corre en memoria).
- [ ] Autenticación/roles.
- [ ] Pruebas automatizadas (`tests/`).
- [ ] Benchmark del algoritmo de asignación contra un baseline simple (recurso disponible más cercano), con métricas de tiempo de respuesta, distancia recorrida, cobertura territorial y utilización de recursos.

## Seguridad y manejo de credenciales

Hoy el proyecto corre 100% local (sin usuarios reales, sin datos personales,
sin acceso a internet salvo llamadas explícitas y documentadas como
Overpass/OSM para verificar direcciones reales). Aun así, se sigue la
misma disciplina que se usaría en un despliegue real, para que la base ya
esté lista si este proyecto se termina levantando en un servidor:

- **Ninguna credencial se escribe directo en el código ni en `docker-compose.yml`.**
  Cada servicio que necesita una (hoy solo la base de datos Postgres) la lee
  desde un archivo `.env`, que **nunca se sube al repositorio** (ver
  `.gitignore`). En su lugar se versiona `docker/.env.example`, una
  plantilla sin datos reales que cada persona copia a `.env` y completa con
  sus propios valores locales.
- **Si una credencial llega a subirse por error a un repo público**, la
  respuesta correcta no es solo borrarla del código: hay que asumirla como
  comprometida y **rotarla** (cambiarla por una nueva), porque el valor
  viejo puede seguir visible en el historial de commits. Eso es justamente
  lo que se hizo la primera vez que esto pasó en este proyecto (una clave
  de desarrollo de Postgres quedó en un commit): se reemplazó por una nueva
  generada al azar, guardada solo en el `.env` local de cada quien.
- **Pendiente para cuando esto se despliegue de verdad** (no implementado
  aún, pero la estructura ya está pensada para esto): las credenciales de
  producción no irían en un `.env` a mano en el servidor, sino en el
  gestor de secretos que ofrezca la plataforma de hosting elegida (variables
  de entorno del proveedor, Docker/Kubernetes secrets, etc.), y recién ahí
  correspondería agregar autenticación/roles reales (ver checklist más
  abajo) y HTTPS en vez de HTTP plano.

## Próxima etapa para el APT

1. Conectar `src/frontend` con `src/backend` reemplazando los datos simulados en memoria por la API real.
2. Definir el modelo de datos en `database/` y migrar a PostgreSQL.
3. Construir el dataset histórico de emergencias que use el modelo de ML.
4. Incorporar pruebas (`tests/`) y las métricas de evaluación comparativa exigidas.
5. Documentar cada fase en `docs/` (Fase 1, Fase 2, Fase 3).
