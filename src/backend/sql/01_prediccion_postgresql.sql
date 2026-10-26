-- Alerta360 - ampliacion NO destructiva de PostgreSQL para ML y mapa de calor.
-- Ejecutar una sola vez desde pgAdmin/psql, en la misma BD usada por FastAPI.
-- Requiere las tablas operacionales emergencia.zona y emergencia.tipo_emergencia.
-- No borra emergencias, recursos, companias, asignaciones ni tickets.
BEGIN;
CREATE SCHEMA IF NOT EXISTS emergencia;
ALTER TABLE emergencia.zona ADD COLUMN IF NOT EXISTS codigo_zona VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS uq_a360_zona_codigo ON emergencia.zona(codigo_zona);

CREATE TABLE IF NOT EXISTS emergencia.lote_historico (
    id_lote BIGSERIAL PRIMARY KEY,
    sha256_archivo CHAR(64) NOT NULL UNIQUE,
    archivo_fuente TEXT NOT NULL,
    tipo_datos VARCHAR(60) NOT NULL,
    descripcion TEXT,
    cantidad_filas INTEGER NOT NULL DEFAULT 0,
    importado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emergencia.registro_historico (
    id_registro BIGSERIAL PRIMARY KEY,
    fecha DATE NOT NULL,
    dia_semana SMALLINT NOT NULL,
    mes SMALLINT NOT NULL,
    bloque_horario SMALLINT NOT NULL,
    id_zona BIGINT NOT NULL REFERENCES emergencia.zona(id_zona),
    codigo_emergencia VARCHAR(20) NOT NULL REFERENCES emergencia.tipo_emergencia(codigo_emergencia),
    cantidad_emergencias INTEGER NOT NULL,
    recursos_utilizados INTEGER NOT NULL DEFAULT 0,
    temperatura_c NUMERIC(10,3),
    viento_kmh NUMERIC(10,3),
    precipitacion_mm NUMERIC(10,3),
    timestamp_registro TIMESTAMP WITHOUT TIME ZONE,
    id_lote BIGINT REFERENCES emergencia.lote_historico(id_lote)
);
-- Para instalaciones donde registro_historico ya existia:
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS dia_semana SMALLINT;
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS mes SMALLINT;
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS bloque_horario SMALLINT;
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS recursos_utilizados INTEGER DEFAULT 0;
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS temperatura_c NUMERIC(10,3);
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS viento_kmh NUMERIC(10,3);
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS precipitacion_mm NUMERIC(10,3);
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS timestamp_registro TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE emergencia.registro_historico ADD COLUMN IF NOT EXISTS id_lote BIGINT REFERENCES emergencia.lote_historico(id_lote);
-- Impide cargas duplicadas de mismo bloque / zona / clave.
-- Si existian duplicados previos, revisarlos antes de crear este indice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_a360_historico_periodo_zona_tipo
  ON emergencia.registro_historico(fecha,bloque_horario,id_zona,codigo_emergencia);
CREATE INDEX IF NOT EXISTS ix_a360_historico_zona_fecha
  ON emergencia.registro_historico(id_zona,fecha,bloque_horario);

CREATE TABLE IF NOT EXISTS emergencia.modelo_demanda (
    id_modelo BIGSERIAL PRIMARY KEY,
    entrenado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    mae DOUBLE PRECISION NOT NULL,
    baseline_mae DOUBLE PRECISION NOT NULL,
    modelo_ganador VARCHAR(100) NOT NULL,
    importancia_variables JSONB NOT NULL DEFAULT '{}'::jsonb,
    comparacion_modelos JSONB NOT NULL DEFAULT '{}'::jsonb,
    ruta_artefacto TEXT NOT NULL,
    n_registros BIGINT NOT NULL,
    datos_desde DATE NOT NULL,
    datos_hasta DATE NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    fuente_datos VARCHAR(60) NOT NULL DEFAULT 'sin_clasificar',
    evaluacion_independiente JSONB
);
ALTER TABLE emergencia.modelo_demanda ADD COLUMN IF NOT EXISTS fuente_datos VARCHAR(60) NOT NULL DEFAULT 'sin_clasificar';
ALTER TABLE emergencia.modelo_demanda ADD COLUMN IF NOT EXISTS evaluacion_independiente JSONB;
CREATE INDEX IF NOT EXISTS ix_a360_modelo_activo
  ON emergencia.modelo_demanda(activo,entrenado_en DESC);

CREATE TABLE IF NOT EXISTS emergencia.prediccion (
    id_prediccion BIGSERIAL PRIMARY KEY,
    id_modelo BIGINT NOT NULL REFERENCES emergencia.modelo_demanda(id_modelo),
    id_zona BIGINT NOT NULL REFERENCES emergencia.zona(id_zona),
    codigo_emergencia VARCHAR(20) NOT NULL REFERENCES emergencia.tipo_emergencia(codigo_emergencia),
    periodo_inicio TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    periodo_fin TIMESTAMP WITHOUT TIME ZONE,
    generado_en TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    casos_esperados DOUBLE PRECISION NOT NULL,
    temperatura_c DOUBLE PRECISION,
    viento_kmh DOUBLE PRECISION,
    precipitacion_mm DOUBLE PRECISION
);
ALTER TABLE emergencia.prediccion ADD COLUMN IF NOT EXISTS periodo_fin TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE emergencia.prediccion ADD COLUMN IF NOT EXISTS temperatura_c DOUBLE PRECISION;
ALTER TABLE emergencia.prediccion ADD COLUMN IF NOT EXISTS viento_kmh DOUBLE PRECISION;
ALTER TABLE emergencia.prediccion ADD COLUMN IF NOT EXISTS precipitacion_mm DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS uq_a360_prediccion_modelo_zona_tipo_periodo
  ON emergencia.prediccion(id_modelo,id_zona,codigo_emergencia,periodo_inicio);
CREATE INDEX IF NOT EXISTS ix_a360_prediccion_periodo
  ON emergencia.prediccion(id_modelo,periodo_inicio, generado_en DESC);
-- Vista lista para inspeccion desde pgAdmin y futuros tableros.
-- Los umbrales replican frontend/src/main.tsx (0.8 y 1.8 casos/bloque).
CREATE OR REPLACE VIEW emergencia.v_mapa_calor_prediccion AS
SELECT v.id_modelo, v.periodo_inicio, v.id_zona, v.codigo_zona,
       v.nombre_zona, v.latitud_minima, v.latitud_maxima,
       v.longitud_minima, v.longitud_maxima, v.demanda_total,
       CASE WHEN v.demanda_total < 0.8 THEN 'Baja'
            WHEN v.demanda_total < 1.8 THEN 'Media'
            ELSE 'Alta' END AS nivel_demanda
FROM (
  SELECT p.id_modelo, p.periodo_inicio, z.id_zona, z.codigo_zona,
         z.nombre_zona, z.latitud_minima, z.latitud_maxima,
         z.longitud_minima, z.longitud_maxima,
         ROUND(SUM(p.casos_esperados)::numeric,2) AS demanda_total
  FROM emergencia.prediccion p
  JOIN emergencia.zona z ON z.id_zona=p.id_zona
  JOIN emergencia.modelo_demanda m ON m.id_modelo=p.id_modelo AND m.activo=TRUE
  GROUP BY p.id_modelo,p.periodo_inicio,z.id_zona,z.codigo_zona,z.nombre_zona,
           z.latitud_minima,z.latitud_maxima,z.longitud_minima,z.longitud_maxima
) v;
COMMIT;
