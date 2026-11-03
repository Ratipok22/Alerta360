-- Retiro de las columnas; ejecutar después de adaptar el backend.
SET LOCAL lock_timeout = '5s';
ALTER TABLE emergencia.prediccion DROP COLUMN IF EXISTS contexto_prediccion;
ALTER TABLE emergencia.modelo_demanda DROP COLUMN IF EXISTS contexto_prediccion;
