-- ============================================================
-- Asocia cada usuario (operador del sistema / bombero) a una compania.
--
-- La relacion es "un usuario pertenece a una compania, una compania tiene
-- muchos usuarios" -- por eso la FK va en emergencia.usuario apuntando a
-- emergencia.compania (y no al reves). Es opcional (sin NOT NULL): no
-- todas las cuentas necesitan quedar designadas a una compania especifica
-- (p.ej. admin/soporte podrian no tenerla).
-- ============================================================

BEGIN;

ALTER TABLE emergencia.usuario
    ADD COLUMN id_compania integer REFERENCES emergencia.compania(id_compania);

-- Ejemplo pedido: bru.molina@bomberos.cl -> 9a Cia. "Zapadores Freire" (id 24)
UPDATE emergencia.usuario
SET id_compania = 24
WHERE email_usuario = 'bru.molina@bomberos.cl';

COMMIT;
