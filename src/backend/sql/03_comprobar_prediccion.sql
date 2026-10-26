-- CONSULTAS DE CONTROL: ejecutar desde pgAdmin DESPUES de importar/entrenar.
-- 1) Debe mostrar 245280 filas, 14 zonas, 6 claves y fechas 2025-09-14/2026-09-13
--    si esta es la unica fuente de historico. Si ya habia datos, cifras mayores.
SELECT COUNT(*) AS registros_historicos,
       COUNT(DISTINCT id_zona) AS zonas,
       COUNT(DISTINCT codigo_emergencia) AS claves,
       MIN(fecha) AS primera_fecha,
       MAX(fecha) AS ultima_fecha,
       SUM(cantidad_emergencias) AS casos_totales
FROM emergencia.registro_historico;

-- 2) Debe identificar la fuente como sintetico_calibrado.
SELECT id_lote,archivo_fuente,tipo_datos,cantidad_filas,importado_en
FROM emergencia.lote_historico ORDER BY id_lote DESC;

-- 3) Resultado real del entrenamiento. Vacio hasta ejecutar train_model.
SELECT id_modelo, entrenado_en, modelo_ganador, mae, baseline_mae,
       n_registros, datos_desde, datos_hasta, fuente_datos,
       comparacion_modelos, importancia_variables, evaluacion_independiente, activo
FROM emergencia.modelo_demanda ORDER BY id_modelo DESC LIMIT 5;

-- 4) Predicciones guardadas. Vacio hasta consultar la API /prediction/demand.
SELECT id_modelo, periodo_inicio, COUNT(*) AS registros_zona_tipo,
       ROUND(SUM(casos_esperados)::numeric,2) AS casos_esperados
FROM emergencia.prediccion GROUP BY id_modelo,periodo_inicio
ORDER BY periodo_inicio DESC LIMIT 20;

-- 5) Datos agregados para el mapa de calor (verde/amarillo/rojo).
SELECT periodo_inicio, codigo_zona, nombre_zona,
       demanda_total, nivel_demanda
FROM emergencia.v_mapa_calor_prediccion
ORDER BY periodo_inicio DESC, demanda_total DESC LIMIT 50;
