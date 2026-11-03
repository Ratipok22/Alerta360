-- Ampliación aditiva: no borra emergencias ni modifica los históricos existentes.
-- Ejecutar dentro de una transacción.
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_registro_historico_bloque
    ON emergencia.registro_historico (fecha, bloque_horario, id_zona, codigo_emergencia);

ALTER TABLE emergencia.emergencia
    ADD COLUMN IF NOT EXISTS id_registro_historico integer;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'emergencia.emergencia'::regclass
          AND conname = 'fk_emergencia_registro_historico'
    ) THEN
        ALTER TABLE emergencia.emergencia
            ADD CONSTRAINT fk_emergencia_registro_historico
            FOREIGN KEY (id_registro_historico)
            REFERENCES emergencia.registro_historico (id_registro);
    END IF;
END $$;

-- Limpieza solicitada; sin CASCADE ni eliminación de registros.
DROP INDEX IF EXISTS emergencia.ix_emergencia_historico_pendiente;
ALTER TABLE emergencia.emergencia
    DROP COLUMN IF EXISTS historico_ultimo_intento,
    DROP COLUMN IF EXISTS historico_error;
ALTER TABLE emergencia.registro_historico
    DROP COLUMN IF EXISTS origen_datos,
    DROP COLUMN IF EXISTS fuente_clima;
CREATE INDEX IF NOT EXISTS ix_emergencia_historico_pendiente
    ON emergencia.emergencia (id_emergencia) WHERE id_registro_historico IS NULL;
COMMENT ON COLUMN emergencia.emergencia.id_registro_historico IS
    'Bloque histórico al que esta emergencia ya aportó; evita doble contabilización.';
