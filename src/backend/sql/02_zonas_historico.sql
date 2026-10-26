-- Crea/vincula las 14 zonas del historico sintetico, sin reemplazar sus coordenadas existentes.
-- Ejecutar DESPUES de 01_prediccion_postgresql.sql.
BEGIN;
CREATE TEMP TABLE a360_zonas_hist (
 codigo_zona VARCHAR(30), nombre_zona VARCHAR(150), lat_min NUMERIC,
 lat_max NUMERIC, lng_min NUMERIC, lng_max NUMERIC
) ON COMMIT DROP;
INSERT INTO a360_zonas_hist VALUES
    ('VAL-CEN','Valparaíso Centro',-33.05310000,-33.04670000,-71.60630000,-71.59990000),
    ('VAL-ALE','Cerro Alegre / Concepción',-33.04550000,-33.03910000,-71.62970000,-71.62330000),
    ('VAL-PUE','Barrio Puerto',-33.04150000,-33.03510000,-71.63160000,-71.62520000),
    ('VAL-ANC','Playa Ancha',-33.03160000,-33.02520000,-71.64110000,-71.63470000),
    ('VAL-PLA','Cerro Placeres',-33.03980000,-33.03340000,-71.59840000,-71.59200000),
    ('VAL-ROD','Rodelillo',-33.06090000,-33.05450000,-71.57960000,-71.57320000),
    ('VAL-PLC','Placilla',-33.11810000,-33.11170000,-71.57120000,-71.56480000),
    ('VIN-CEN','Viña del Mar Centro',-33.02770000,-33.02130000,-71.55500000,-71.54860000),
    ('VIN-FOR','Forestal / Nueva Aurora',-33.04180000,-33.03540000,-71.54600000,-71.53960000),
    ('VIN-MIR','Miraflores',-33.02950000,-33.02310000,-71.52340000,-71.51700000),
    ('VIN-REN','Reñaca',-32.97620000,-32.96980000,-71.52980000,-71.52340000),
    ('VIN-RAL','Reñaca Alto / Cerros',-33.00000000,-32.99360000,-71.49160000,-71.48520000),
    ('VIN-GOM','Gómez Carreño',-32.99530000,-32.98890000,-71.52560000,-71.51920000),
    ('CON-CEN','Concón',-32.93370000,-32.92730000,-71.50620000,-71.49980000);

-- Si la zona ya existe por nombre pero carece de codigo, se vincula en lugar de duplicarla.
UPDATE emergencia.zona z SET codigo_zona=s.codigo_zona
FROM a360_zonas_hist s
WHERE z.codigo_zona IS NULL
  AND lower(trim(z.nombre_zona)) = lower(trim(s.nombre_zona))
  AND NOT EXISTS (SELECT 1 FROM emergencia.zona x WHERE x.codigo_zona=s.codigo_zona);

-- Agrega solo los sectores que realmente faltan.
INSERT INTO emergencia.zona (
 codigo_zona,nombre_zona,latitud_minima,latitud_maxima,
 longitud_minima,longitud_maxima,actividad
)
SELECT s.codigo_zona,s.nombre_zona,s.lat_min,s.lat_max,s.lng_min,s.lng_max,TRUE
FROM a360_zonas_hist s
WHERE NOT EXISTS (SELECT 1 FROM emergencia.zona z WHERE z.codigo_zona=s.codigo_zona)
ON CONFLICT (codigo_zona) DO NOTHING;

-- Fallar si no quedaron representadas exactamente las 14 zonas.
DO $$
DECLARE faltantes INTEGER;
BEGIN
 SELECT count(*) INTO faltantes FROM a360_zonas_hist s
 LEFT JOIN emergencia.zona z ON z.codigo_zona=s.codigo_zona
 WHERE z.id_zona IS NULL;
 IF faltantes <> 0 THEN
  RAISE EXCEPTION 'Faltan % zonas historicas en emergencia.zona', faltantes;
 END IF;
END $$;
COMMIT;
