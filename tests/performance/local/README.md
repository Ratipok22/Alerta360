# Pruebas locales PF04 a PF08

Ejecución original: 14 de noviembre de 2026. Resultados consolidados el 15.
El backend ensayado es el código del proyecto principal, sin cambios de negocio.
La interfaz medida procede de la copia preparada de main y conserva sus mejoras.

## Seguridad del laboratorio

API exclusiva en 127.0.0.1:8011 y PostgreSQL en 127.0.0.1:55432 (usuario perf).
Los ejecutores no leen api.env ni conectan a Supabase. PF05, PF08 y PF06
reemplazan los tickets, respuestas e histórico de ESTA base sintética.
No redirigirlos a una base operacional ni a la API del puerto 8000.
lab/ contiene únicamente la estructura copiada con autorización; está excluida de Git.
Las 14 tablas deben estar vacías antes de perf_bootstrap.py, que se niega a sobrescribir un esquema existente.

## Repetir las pruebas de API

1. Crear un clúster PostgreSQL local de laboratorio, escuchando exclusivamente en
   127.0.0.1:55432, base postgres, usuario perf. Para la corrida se utilizó PostgreSQL 16.15.
2. Instalar requirements.txt de este directorio y las dependencias del backend en un entorno Python.
3. Ejecutar `python tests/performance/local/perf_bootstrap.py` desde la raíz del proyecto.
4. En otra terminal, ejecutar `python tests/performance/local/perf_start_api.py`.
5. Ejecutar secuencialmente (no superponer cargas):

```text
python tests/performance/local/perf_cases.py PF04
python tests/performance/local/perf_cases.py PF08
python tests/performance/local/perf_cases.py PF05
python tests/performance/local/perf_cases.py PF06
```

PF06 tarda 60 minutos, con escalones de 2/5/10/20/40 conexiones y recuperación a 2.
Las nuevas evidencias se guardan en local/lab/results. Los resultados originales
están en ../results/local_2026-11-14. PERF_WORK_DIR permite elegir otro directorio
de laboratorio; debe ser el mismo para bootstrap, API y ejecutor.
La API bloquea proveedores HTTP externos mediante proxy local no disponible;
el enriquecimiento meteorológico queda pendiente sin revertir el cierre.

## Navegador

perf_browser.mjs conserva las rutas exactas usadas en el workspace
C:/Users/alexs/Documents/Codex/2026-11-11/es-x20. Requiere Playwright,
Google Chrome, web-vitals y un build de la interfaz con VITE_API_URL=http://127.0.0.1:8011,
servido en 127.0.0.1:5173. Adaptar las rutas de archivos si se mueve el workspace.
Las teselas externas se bloquearon: PF07 es PARCIAL, no una aprobación de mapas completos.

## Resultado

- PF04: APROBADO en el flujo local; no se validó el proveedor meteorológico.
- PF05: APROBADO como comparación de volúmenes; no existe SLA acordado.
- PF06: PARCIAL. Hora completa y 48.437 solicitudes sin error; capacidad máxima y Docker pendientes.
- PF07: PARCIAL. HTTP y 15 sesiones de navegador medidos; mapas/SLA pendientes.
- PF08: APROBADO tras corregir DEF-PERF-01 el 15 de noviembre. Tres repeticiones: 300 logins sin errores y 600 controles correctos. La corrida inicial fallida se conserva como evidencia histórica.

No confundir conexiones con cuentas independientes: solo hay cuatro cuentas en el catálogo del código.
Se corrigió el orden de bloqueo de filas en el login, conservando las mismas expectativas de prueba. Esta corrección se verificó localmente; no se desplegó en Docker ni se publicó en GitHub.

Para repetir la regresión, con el laboratorio iniciado: `python tests/performance/local/verificar_pf08.py`. Informe: `../PF08_correccion_verificada.md`. Evidencias: `../results/PF08_corregido_2026-11-15`.
