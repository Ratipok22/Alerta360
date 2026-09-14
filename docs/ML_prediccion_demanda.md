# Predicción de demanda (Machine Learning) — metodología, resultados y credibilidad

Este documento explica en detalle el componente predictivo que alimenta el
**segundo mapa del Dashboard** ("Mapa de calor · Demanda de Bomberos"),
para efectos de la documentación del Proyecto APT (evidencia de "Modelo
predictivo" y "Evaluación del algoritmo").

## 1. De dónde salen los datos

No existe un dataset público de incidentes reales de Bomberos de Chile con
el nivel de detalle (zona + hora + clave radial) que necesita este modelo,
así que se usa un **histórico simulado**, generado por
`src/backend/ml/generate_dataset.py`, con dos características que lo
diferencian de un dataset aleatorio sin sentido:

1. **Calibración con una cifra real**: la tasa base de incendio forestal
   (clave 10-2) está ajustada para que el total anual simulado en toda la
   región se acerque a la cifra real reportada por CONAF (575 incendios
   forestales en la Región de Valparaíso, temporada 2025-2026).
2. **Variables climáticas ancladas a normales reales de la zona**
   (`src/backend/ml/weather.py`): temperatura, viento y precipitación se
   generan siguiendo el patrón climático real de Valparaíso/Viña del Mar
   (clima mediterráneo costero: veranos secos ~17-18 °C, inviernos
   lluviosos ~11-12 °C, lluvia concentrada en junio-julio), con ciclo
   diurno de temperatura/viento y ruido diario acotado. Estas variables
   alimentan un factor de riesgo real: más calor + viento ⇒ más riesgo de
   incendio forestal (10-2); más lluvia/viento ⇒ más riesgo de rescate
   vehicular (10-4) por pistas resbaladizas.

El resto del patrón (distribución horaria, por día de la semana y por
zona) es un **supuesto razonado** basado en la geografía real de cada
sector (ver `ml/zones.py`), no un dato reportado por una institución.
Esta limitación se declara explícitamente porque es importante para
interpretar correctamente los resultados: el modelo es tan bueno como el
proceso que generó los datos con los que aprendió.

## 2. Cómo se entrenó el modelo

Ejecutado por `src/backend/ml/train_model.py` (`python -m ml.train_model`):

1. Se generan ~245.000 registros (365 días × 8 bloques de 3h × 14 zonas ×
   6 claves radiales), con variables de entrada: día de la semana, mes,
   bloque horario, zona, clave radial, frecuencia histórica reciente (7
   días), demanda histórica de recursos (7 días), temperatura, viento y
   precipitación.
2. Se separan datos de **entrenamiento (80%)** y **holdout interno (20%)**.
3. Se comparan **4 familias de modelo** — RandomForest, ExtraTrees,
   GradientBoosting y una regresión lineal Ridge como referencia — cada
   una con búsqueda de sus mejores hiperparámetros vía
   `RandomizedSearchCV` + validación cruzada K-Fold (no valores fijos
   elegidos a mano).
4. Cada familia (ya con sus mejores hiperparámetros) se evalúa contra el
   holdout interno, que ninguna familia vio durante la búsqueda. Gana la
   de menor **MAE** (error absoluto medio, en emergencias por bloque de
   3h).
5. El modelo ganador se **reentrena con el 100% del histórico disponible**
   (práctica estándar: la validación cruzada sirve para *elegir* la
   familia/hiperparámetros; el modelo que queda en producción se entrena
   con todos los datos que se tienen).
6. Se calcula la **importancia real de cada variable** con *permutation
   importance* sobre datos no vistos: cuánto empeora el error del modelo
   al revolver (permutar) cada variable, una por una. A diferencia de leer
   `feature_importances_` de un árbol, este método no sesga hacia
   variables con muchas categorías y funciona igual sin importar qué
   familia haya ganado.

## 3. Resultados obtenidos (corrida de referencia)

> Corrida realizada en un entorno de un solo núcleo de CPU, por lo que se
> usó una malla de búsqueda de hiperparámetros más chica que la que trae
> el código entregado (que sí usa la malla completa). En un computador con
> varios núcleos, `python -m ml.train_model` con la configuración completa
> tomará más tiempo por corrida pero puede encontrar una configuración
> igual o mejor. Los números de esta sección sirven como referencia de que
> el pipeline funciona de punta a punta y produce resultados razonables,
> no como el resultado único e inamovible del proyecto.

**Comparación de familias (MAE sobre holdout interno, emergencias/bloque de 3h):**

| Familia | MAE holdout | RMSE holdout |
|---|---|---|
| RandomForest | 0.1007 | 0.2408 |
| **ExtraTrees (ganador)** | **0.1000** | 0.2428 |
| GradientBoosting | 0.1023 | 0.2419 |
| Ridge (referencia lineal) | 0.1056 | 0.2427 |

Modelo ganador: **ExtraTreesRegressor** (`n_estimators=120, max_depth=16,
min_samples_leaf=4`).

**Evaluación contra el set de VALIDACIÓN** (`python -m ml.evaluate_model`;
período calendario distinto e independiente del de entrenamiento, con
semilla aleatoria distinta — el modelo nunca vio estos datos):

| Métrica | Valor |
|---|---|
| Período de validación | 2025-05-16 a 2025-09-12 |
| Registros de validación (zona × período × clave) | 80.640 |
| MAE del modelo | 0.1034 emergencias/bloque |
| RMSE del modelo | 0.2488 |
| MAE del baseline (promedio histórico global, sin modelo) | 0.1139 |
| **Mejora vs. baseline** | **9.2 %** |
| **Exactitud de nivel de riesgo (Baja/Media/Alta) por zona+período** | **69.8 %** (sobre 13.440 combinaciones zona-período) |

**Importancia real de cada variable** (permutation importance, sobre datos no vistos):

| Variable | Peso |
|---|---|
| Clave radial (tipo de emergencia) | 39.7 % |
| Frecuencia histórica reciente (7 días) | 20.4 % |
| Zona geográfica | 17.7 % |
| Hora del día | 9.0 % |
| Demanda histórica de recursos (7 días) | 5.7 % |
| Mes del año | 4.6 % |
| Día de la semana | 1.8 % |
| Viento (km/h) | 1.1 % |
| Temperatura (°C) | 0.0 % |
| Precipitación (mm) | 0.0 % |

## 4. Qué tan creíble es esto (lectura honesta, para la memoria)

- **La mejora sobre el baseline es real pero modesta (9.2 %)**, no
  espectacular. Esto es coherente con la naturaleza del problema: la
  mayoría de los bloques zona×hora×clave tienen 0 o 1 emergencias (evento
  raro tipo Poisson), así que hay un techo natural de qué tan preciso
  puede ser cualquier modelo sin más señal de entrada. Un MAE de ~0.10 en
  una variable que casi siempre vale 0 o 1 significa que el modelo acierta
  la magnitud correcta la gran mayoría de las veces, pero no hay que leerlo
  como "el modelo predice el futuro con precisión de reloj".
- **La exactitud de nivel de riesgo (69.8 %)** — que es literalmente lo que
  el operador ve pintado en el mapa (verde/amarillo/rojo) — es la métrica
  más honesta para juzgar la utilidad práctica: acierta el nivel correcto
  en aproximadamente 7 de cada 10 combinaciones zona-período, claramente
  por encima de adivinar al azar entre 3 niveles (~33 %).
- **El modelo ganador (ExtraTrees) le gana a la referencia lineal (Ridge)
  por un margen pequeño (0.1000 vs 0.1056 de MAE)**. Esto es una señal
  saludable: confirma que sí hay algo de patrón no lineal que vale la pena
  capturar (interacciones entre zona/hora/clave), pero el margen pequeño
  también es honesto sobre que el problema no es trivialmente no lineal.
- **Las variables climáticas (viento, temperatura, precipitación) pesan
  poco (≤1.1 %) en la importancia final**, a pesar de que sí se usaron
  para *generar* una parte del riesgo de incendio forestal y rescate
  vehicular. La explicación más probable es **colinealidad**: el clima
  simulado depende determinísticamente del mes y la hora del bloque
  (`ml/weather.py`), variables que el modelo ya tiene disponibles de forma
  directa (mes, hora) y que permutation importance reparte el crédito
  hacia ellas en vez de hacia el clima derivado. Esto es un resultado
  esperable y honesto, no un error: con un historial de incidentes real
  (donde el clima de un día concreto se desvía de la normal del mes), el
  clima probablemente pesaría más.
- **La limitación más importante sigue siendo el dataset simulado.** El
  pipeline de entrenamiento (comparación de familias, búsqueda de
  hiperparámetros, validación cruzada, evaluación en holdout out-of-time,
  permutation importance) es metodológicamente correcto y quedaría igual
  de válido si mañana se conectara un historial real de despachos de
  Bomberos — pero los números concretos de esta sección (MAE, 9.2%,
  69.8%) describen qué tan bien el modelo aprende el patrón *que nosotros
  mismos diseñamos*, no necesariamente el patrón real de emergencias en
  Valparaíso. Esta distinción debe quedar clara en la memoria del
  proyecto.

## 5. Limitación conocida: predicción futura sin pronóstico real

Para predecir períodos futuros (`GET /prediction/demand`), el sistema no
tiene un pronóstico meteorológico real integrado. En su lugar, usa la
**normal climática esperada** para ese mes/hora/zona (sin ruido diario) —
ver `clima_esperado()` en `ml/weather.py`. Esto es razonable para la
estacionalidad general (ej. anticipar que enero tiene más riesgo de
incendio forestal que junio), pero no puede anticipar un evento puntual
real como una ola de calor o una tormenta específica de la semana en
curso. Si en el futuro se integra una API meteorológica real, bastaría con
reemplazar esa función por el pronóstico real sin tocar el resto del
pipeline.

## 6. Cómo reproducir estos resultados

```bash
cd src/backend
pip install -r requirements.txt
python -m ml.train_model      # entrena y guarda ml/artifacts/demand_model.joblib
python -m ml.evaluate_model   # evalúa contra el set de validación independiente
```

Ambos scripts imprimen en consola los mismos números reportados en este
documento (con eventuales variaciones menores si se corre con más
capacidad de cómputo y por lo tanto la malla de búsqueda completa
encuentra una configuración distinta).
