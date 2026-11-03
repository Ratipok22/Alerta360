# Cierre e histórico
Al finalizar, se confirma el cierre y se intenta registrar el bloque antes de devolver la respuesta. La respuesta incluye `historico.estado` e `id_registro` cuando se logró. Si falla el proveedor o falta información, el cierre se conserva y el trabajador reintenta cada hora; los motivos se registran en los logs, no en columnas adicionales.

`emergencia.id_registro_historico` enlaza el bloque y evita duplicados. No se borran emergencias ni asignaciones. Una fila por zona, clave, fecha y bloque de tres horas de creación; casos +1, recursos distintos por emergencia excluyendo asignaciones canceladas. Calendario de America/Santiago. Se comprueba la zona geográfica.

Clima: Open-Meteo ERA5 para fechas de al menos seis días; API Forecast para fechas recientes (estimaciones de modelos, con pronóstico si el bloque sigue abierto). Temperatura y viento promedio; lluvia acumulada por bloque. Punto representativo de los límites de la zona SQL. No se guardan ceros inventados si falla la API. No se conservan columnas de origen ni fuente. Esta política mixta queda documentada aquí: https://open-meteo.com/en/docs . No debe presentarse como observaciones directas de estaciones.

Los bloques existentes sin ninguna emergencia vinculada se consideran importados y no se suman automáticamente para evitar doble conteo. Los bloques operacionales se identifican mediante la FK de emergencia, sin `origen_datos`.

Controles admin: GET /historical/status y POST /historical/sync. CLI: python -m core.historico_emergencias --sincronizar o --id NUMERO. HISTORICO_WORKER_ACTIVO=0 desactiva solo el trabajador periódico.

El modelo no se modifica ni reentrena. No se crean bloques con cero casos: un futuro entrenamiento exclusivamente operacional necesita definir cobertura y exposición, incluyendo bloques sin emergencias.
