# Resultados de pruebas unitarias

Casos unitarios de la matriz: **5** (5 aprobados).

## Suites automatizadas

- Backend: **76/76 aprobadas** con pytest.
- Frontend: **15/15 aprobadas** (EM05: 8; AS01: 4; AS08: 3).
- Compilación de producción: **aprobada**.

## Referencias pendientes

En `Referencias_pendientes/` se conservaron dos pruebas heredadas como texto: dependen de `ml/concurrencia.py` y `core/compresion.py`, módulos que no existen en esta copia del proyecto. No se ejecutaron ni se cuentan como aprobadas.

## Archivos de pruebas

- `test_asignaciones.py`: Recomendación y asignación de recursos compatibles; validación de unidad disponible y concurrencia.
- `test_clima_historico.py`: Respuesta meteorológica reciente y de archivo; tratamiento de datos incompletos.
- `test_idempotencia_emergencias.py`: Creación idempotente de emergencias y reintentos.
- `test_historial_emergencias.py`: Agrupación histórica, recursos distintos y exclusión de cancelaciones.
- `test_mesa_de_ayuda.py`: Validación de tickets, permisos, estados, prioridades y respuestas.
- `test_rutas_osrm.py`: Cálculo de rutas OSRM y alternativa explícita cuando el servicio no responde.
- `test_seguridad.py`: Autenticación, roles, errores, límites, CORS y entradas no confiables.
- `test_validacion_emergencias.py`: Campos, coordenadas, prioridad y reglas de creación de emergencias.
- `comprobaciones_unitarias_frontend.mjs`: Reglas de estructura de emergencia, recomendación y llegadas diferidas.

## Casos unitarios de la matriz

### AUT03 — Normalización

- **Estado:** APROBADO
- **Módulo:** Acceso
- **Resultado observado:** [Revisión 2026-11-15] Suite backend: 76/76 aprobadas. test_AUT03 normalizó espacios y BRU.MOLINA@BOMBEROS.CL al usuario visualizador esperado.

### EM05 — Pisos y estructura

- **Estado:** APROBADO
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] npm run test:matrix-unit: 8/8 comprobaciones aprobadas. Piso 2 omite Escala; pisos 3/4, ausente, 0, negativo y decimal conservan el requisito; vivienda no residencial no añade Escala. npm run build pasó.

### AS01 — Recomendación compatible

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] npm run test:matrix-unit: 4/4 comprobaciones aprobadas; suite backend 76/76. Elige recurso disponible idóneo, explica el tipo ideal, respeta el rechazo y prioriza el tipo pendiente.

### AS08 — Última llegada diferida

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] npm run test:matrix-unit: 3/3 comprobaciones aprobadas. Llegadas simultáneas inician un temporizador; espera si queda una unidad en ruta; la última llegada inicia el trabajo.

### HI05 — Carros repetidos/cancelados

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] test_HI05 pasó dentro de pytest (76/76 suite backend). Cursor aislado verificó COUNT(DISTINCT id_recurso), excluyó estados cancelados/rechazados y guardó 2 recursos distintos.

## Comandos

- Backend, desde la raíz del proyecto: `python -m pytest -q`.
- Frontend, desde `src/frontend`: `npm run test:matrix-unit`.