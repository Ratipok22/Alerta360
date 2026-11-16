# Herramientas de integración y rendimiento

Estos ejecutores miden consultas HTTP, respuestas por rol, transferencia del frontend y escenarios con usuarios concurrentes. No forman parte de los 40 casos de integración del informe hasta que se ejecuten y se documenten sus resultados.

## Ejecutores

- `ejecutar_medicion_http.py`: mide endpoints con una cantidad configurable de usuarios.
- `medir_rendimiento_por_rol.py`: combina consultas de administración, visualización y soporte.
- `ejecutar_escenarios_de_rendimiento.py`: encadena escenarios de carga.
- `medir_transferencia_frontend.py`: mide transferencia HTTP de HTML, JavaScript y CSS.

## Uso

Desde la raíz del proyecto, consulta la ayuda de cada ejecutor antes de medir:

```text
python test/Pruebas_de_integracion/Herramientas_de_rendimiento/ejecutar_medicion_http.py --help
python test/Pruebas_de_integracion/Herramientas_de_rendimiento/medir_rendimiento_por_rol.py --help
python test/Pruebas_de_integracion/Herramientas_de_rendimiento/ejecutar_escenarios_de_rendimiento.py --help
python test/Pruebas_de_integracion/Herramientas_de_rendimiento/medir_transferencia_frontend.py --help
```

Las credenciales se reciben por variables de entorno `PERF_TOKEN`, `PERF_VIEWER_TOKEN` y `PERF_SUPPORT_TOKEN`; no las guardes en archivos del proyecto.

Las consultas de predicción pueden persistir resultados y exigen la opción explícita `--allow-prediction-write` junto con un entorno autorizado. Los resultados se guardan en `resultados/` y no se consideran aprobación automática de casos de la matriz.
