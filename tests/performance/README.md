# Pruebas de rendimiento

Herramientas: Python, HTTPX y ThreadPoolExecutor. Los informes JSON contienen
latencias, percentiles, errores y muestras. No miden renderizado del navegador.

## Archivos que se conservan

- `run.py`: carga de endpoints y predicción con usuarios concurrentes.
- `roles.py`: carga combinada de administrador, visualizador y soporte.
- `suite.py`: ejecuta varios escenarios de `run.py` en secuencia.
- `frontend.py`: mide transferencia HTTP de HTML y recursos del frontend.
- `test_concurrencia.py`: tres regresiones del coordinador de predicción.
- `test_compresion.py`: regresión aislada del componente de compresión; pasar
  esta prueba no demuestra que el componente esté activado en la API.

Todos tienen una función vigente. `results/`, `__pycache__/` y `.pytest_cache/`
son salidas locales y no se publican. Conservar los informes de mediciones como
evidencia; no eliminarlos por considerarlos archivos temporales.

## Ejecución desde la raíz del repositorio

Instalar las dependencias de `src/backend/requirements.txt` en el entorno Python.
Consultar `python tests/performance/run.py --help` y el `--help` de cada ejecutor.
Los tokens se reciben por variables de entorno: `PERF_TOKEN`,
`PERF_VIEWER_TOKEN` y `PERF_SUPPORT_TOKEN`; nunca incluirlos en archivos versionados.
Las consultas de predicción pueden persistir resultados: requieren la opción
explícita `--allow-prediction-write` y un entorno autorizado para las mediciones.

Regresiones aisladas, sin ejecutar carga:

```text
python -m unittest discover -s tests/performance -p "test_*.py" -v
python -m pytest src/backend/tests -q
```

`n` es el número de muestras; `p95 s` es el percentil 95 de latencia en segundos.
Los ejecutores guardan percentiles en milisegundos (`p95_ms`); dividir por 1000
al elaborar tablas en segundos. No interpretar una medición exploratoria como
capacidad máxima ni como aprobación de todos los casos del plan de pruebas.
