# Resultados de pruebas de integración

Casos ejecutados y documentados: **40** (7 parciales, 33 aprobados). Los casos planificados no se incluyen porque aún no se ejecutaron.

Las comprobaciones de integración se ejecutaron contra una copia temporal de PostgreSQL y servicios locales de prueba. La base activa no recibió escrituras.

### AUT01 — Inicio de sesión según rol

- **Estado:** PARCIAL
- **Módulo:** Acceso
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: las tres cuentas de prueba iniciaron sesión (200), /auth/me devolvió 200 e identidad/rol esperado (admin, soporte, visualizador). No se verificó el menú en navegador porque la sesión de navegador no estuvo disponible; se deja PARCIAL por ese criterio visual.

### AUT06 — Cierre de sesión y expiración

- **Estado:** PARCIAL
- **Módulo:** Acceso
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: después de logout, el JWT anterior fue rechazado por /auth/me con 401; login nuevo fue exitoso. No se verificaron navegación atrás ni reautenticación en interfaz; caso PARCIAL.

### AUT07 — Estado de presencia de usuario

- **Estado:** PARCIAL
- **Módulo:** Acceso
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: admin activó/desactivó el usuario visualizador y la lectura reflejó ambos estados. No se verificó en UI la distinción entre usuario inactivo y bloqueo por intentos; caso PARCIAL.

### PER04 — Permisos excepcionales del visualizador

- **Estado:** APROBADO
- **Módulo:** Roles
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: visualizador de compañía 24 cambió recurso propio 6-0↔6-9; cambios de estado de otro titular, movimiento de posición y despacho ajeno respondieron 403. Se revirtió el estado de prueba en el clon; base activa intacta.

### EM01 — Creación válida de emergencia

- **Estado:** APROBADO
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: creación válida respondió 200, estado Activa, zona VAL-PUE y fecha con offset America/Santiago (-03:00).

### EM03 — Validación de coordenadas y prioridad

- **Estado:** APROBADO
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: latitud fuera de rango, longitud fuera de rango y prioridades 0, 4, 99 y -1 rechazadas con 422; prioridad válida predeterminada creó emergencia correctamente (EM01). No se generaron coordenadas imposibles.

### EM04 — Determinación de zona geográfica

- **Estado:** APROBADO
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: punto central y borde asignados a VAL-PUE; punto insular -33.77952,-80.82669 asignado a INE24-05104-01; punto fuera de cobertura rechazado con 422. Las zonas resueltas existen en catálogo.

### EM06 — Prevención de emergencia duplicada

- **Estado:** APROBADO
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: reenvío con la misma Idempotency-Key y payload devolvió el mismo id; payload distinto con la clave existente devolvió 409; consulta SQL confirmó una sola emergencia. Sin duplicado inadvertido.

### EM08 — Contador horario

- **Estado:** PARCIAL
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: fecha de creación conserva offset -03:00 y el mismo instante al recargar /emergencies. No se midieron contador en avance, huso alternativo, cambio verano/invierno ni medianoche; caso PARCIAL.

### EM09 — Transiciones inválidas de estado

- **Estado:** APROBADO
- **Módulo:** Emergencia
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: saltos/retrocesos de estado desde emergencia Activa respondieron 409; GET posterior siguió devolviendo la emergencia, sin pérdida de registro.

### AS02 — Sin recursos compatibles disponibles

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] 3 pruebas de ruta cubren flota vacía, recurso compatible ocupado/6-9 y recurso disponible incompatible: POST /assignment/recommend responde 404 sin inventar unidad. Incluido en suite backend 76/76.

### AS03 — Asignación manual compatible

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: manual Rescate→10-1 fue rechazado con 400 y no cambió recurso; Bomberos→10-1 fue aceptado (200) y cambió a 6-3. Regla de compatibilidad aplicada server-side.

### AS04 — Rechazo de recurso recomendado

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: rechazo RECHAZADO respondió 200 y dejó recurso en 6-0; la recomendación unitaria AS01 respeta recursos rechazados y ofrece alternativa compatible. No se despachó el recurso.

### AS05 — Asignación simultánea de recursos

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] Dos POST concurrentes intentaron asignar el mismo recurso a emergencias distintas: una respuesta 200 y una 400; GET /assignments/activas confirmó una sola asignación efectiva.

### AS06 — Reintento de asignación duplicada

- **Estado:** APROBADO
- **Módulo:** Asignación
- **Resultado observado:** [Revisión 2026-11-15] Reenvío del mismo recurso ya despachado respondió 400; GET /assignments/activas mantuvo un único par recurso/emergencia, sin duplicar historial efectivo.

### RE02 — Ciclo de estados de recursos

- **Estado:** PARCIAL
- **Módulo:** Recursos
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal recorrió 6-0→6-3→6-7→6-8→6-9→6-0 y cada lectura devolvió el estado persistido. Falta probar la convergencia visual del ciclo radial en navegador; PARCIAL.

### RE03 — Retorno de recurso al cuartel

- **Estado:** PARCIAL
- **Módulo:** Recursos
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: retorno registró fecha (200), quitó la asignación de /assignments/activas y recurso volvió a 6-0 en coordenadas de cuartel. No se probó el ciclo UI completo después del cierre; PARCIAL.

### RE05 — Ruta OSRM y alternativa cuando falla

- **Estado:** APROBADO
- **Módulo:** Recursos
- **Resultado observado:** [Revisión 2026-11-15] RE05: pytest 76/76; OSRM Docker real devolvió ruta osrm_local de 1,76 km, 3,1 min y 92 puntos. test_RE05 aprobó fallback offline rotulado linea_recta_fallback, sin distancia/ETA; el frontend no lo trata como ruta real.

### RE06 — Ubicación de recurso fuera de rango

- **Estado:** PARCIAL
- **Módulo:** Recursos
- **Resultado observado:** [Revisión 2026-11-15] API rechazó latitud 95/longitud 200 con 422 antes de actualizar recurso. No se simuló en UI una ruta sin camino ni el cuartel nulo; PARCIAL.

### HI01 — Registro histórico al cerrar emergencia

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Integración PostgreSQL-clon: cierre FINALIZADA creó registro histórico con FK enlazada; calendario, clima sintético validado y 2 recursos distintos quedaron persistidos.

### HI02 — Agrupación de emergencias históricas

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Dos emergencias sintéticas del mismo día/zona/bloque/clave se agruparon en una fila: cantidad=2, suma de recursos distintos por caso=4 y promedios climáticos correctos.

### HI03 — Separación de registros históricos

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Integración PostgreSQL-clon: cambios independientes de fecha, zona, clave y bloque generaron id_registro distintos; ninguna dimensión colapsó grupos diferentes.

### HI04 — Idempotencia y concurrencia histórica

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Dos workers concurrentes archivaron una misma emergencia: solo una respuesta marcó nueva=true; la otra y el reintento posterior fueron idempotentes (nueva=false).

### HI06 — Asignación al bloque horario correcto

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Emergencia creada a las 02:59:59 y cerrada a las 03:10 quedó en bloque 00–03 (bloque=0, timestamp hora=0), basado en creación.

### HI07 — Clima reciente y datos de archivo

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Open-Meteo real: bloque reciente (14-11) y ERA5 antiguo (08-11) devolvieron temperatura/viento/precipitación agregados y fuente/modelo esperados para Valparaíso.

### HI08 — Respuesta meteorológica incompleta

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Integración PostgreSQL-clon con proveedor que lanzó DatosPendientes: resultado pendiente, emergencia siguió FINALIZADA y no se escribió FK ni fila histórica incompleta. Respuesta/unidades inválidas también cubiertas por pytest.

### HI09 — Histórico importado sin emergencia vinculada

- **Estado:** APROBADO
- **Módulo:** Histórico
- **Resultado observado:** [Revisión 2026-11-15] Bloque histórico sintético sin emergencias vinculadas produjo estado pendiente; no se incrementó cantidad ni se enlazó la emergencia, evitando doble conteo.

### PR01 — Horizonte y caché de predicción

- **Estado:** APROBADO
- **Módulo:** Predicción
- **Resultado observado:** [Revisión 2026-11-15] Entrenamiento real sobre 245.297 registros del clon: modelo ExtraTrees id=2 activo, MAE holdout 0,0997 frente a baseline 0,1081. GET horizon=4 devolvió 4 periodos y persistió 360 filas; segunda llamada leyó origen=postgresql con el mismo generado_en. Horizon=1 devolvió 1 periodo desde caché. La base activa no se modificó.

### PR02 — Validación de parámetros de predicción

- **Estado:** APROBADO
- **Módulo:** Predicción
- **Resultado observado:** [Revisión 2026-11-15] TestClient sobre clon: horizon 0, -1 y 9 devuelven 409; fecha mal formada devuelve 400. Con modelo activo, horizon=1 y 4 devuelven 200 con exactamente 1 y 4 periodos.

### PR03 — Catálogo y estado del modelo

- **Estado:** APROBADO
- **Módulo:** Predicción
- **Resultado observado:** [Revisión 2026-11-15] Entrenamiento y catálogo verificados: /prediction/models respondió 200 con 2 modelos y el id=2 activo. ExtraTrees ganó la comparación (MAE holdout 0,0997); importancia de variables calculada sobre datos no vistos. Predicción con horizon=1/4 respondió 200.

### PR08 — Cobertura geográfica del modelo

- **Estado:** APROBADO
- **Módulo:** Predicción
- **Resultado observado:** [Revisión 2026-11-15] Cobertura medida en el clon: catálogo con 281 zonas; modelo e inferencia usan 20 zonas y 7 claves entrenadas (10-0, 10-1, 10-2, 10-3, 10-4, 10-5, 10-7). Las 360 filas de 4 periodos corresponden solo a esas zonas/tipos; no se atribuye cobertura a las 261 zonas sin datos de entrenamiento.

### TK01 — Creación de ticket de ayuda

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: ticket válido de visualizador persistió con código SOP único y estado Abierto; aparece en lista propia y en soporte.

### TK02 — Validación de datos del ticket

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] Backend rechaza vacío/solo espacios y título >100 con 422; tipos/apartados inexistentes o inactivos devuelven 404 antes del INSERT. UI comprueba título/descripción y tipo y muestra aviso explícito. 76 pruebas backend aprobadas.

### TK04 — Creación simultánea de tickets

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: dos POST simultáneos respondieron 200; ambos devolvieron ids y códigos SOP distintos, sin colisión por el valor temporal.

### TK05 — Privacidad de tickets por usuario

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: soporte vio 9 tickets de 2 autores; visualizador vio 3 propios y 0 ajenos. Después del ticket sintético, visibilidad continuó limitada al autor; suite backend 76/76.

### TK06 — Seguimiento del autor del ticket

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: autor pudo responder en Abierto y En proceso; otro usuario recibió 403; autor recibió 409 tras quedar Resuelto.

### TK07 — Respuesta oficial de soporte

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: soporte insertó respuesta oficial y el ticket Abierto pasó automáticamente a En proceso; autoría quedó asociada a soporte.

### TK08 — Prioridad y estado del ticket

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: Baja/Media/Alta y Abierto/En proceso/Resuelto persistieron al recargar; estado/prioridad inválidos devolvieron 422; suite backend 76/76.

### TK09 — Respuesta a identificadores inexistentes

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: responder/cambiar estado/cambiar prioridad para id inexistente devuelven 404. Backend corrigió respuestas falsas 200 y error FK 500; 76 pruebas backend aprobadas.

### TK10 — Historial concurrente de respuestas

- **Estado:** APROBADO
- **Módulo:** Soporte
- **Resultado observado:** [Revisión 2026-11-15] API sobre clon temporal: dos respuestas concurrentes se guardaron junto con las previas (4/4 visibles); autoría Usuario/soporte correcta y orden temporal no decreciente.
