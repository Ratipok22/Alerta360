from datetime import datetime

from core import historico_emergencias as historico


class CursorHistorico:
    def __init__(self):
        self.current_sql = ""
        self.queries = []
        self.insercion = None
        self.asignaciones = [
            ("B1", "ASIGNADA"),
            ("B1", "EN_ESCENA"),
            ("B2", "EN_TRAYECTO"),
            ("E1", "CANCELADA"),
            ("E2", "ANULADO"),
            ("E3", "RECHAZADA"),
        ]

    def execute(self, sql, params=None):
        self.current_sql = sql
        self.queries.append((sql, params))

    def fetchone(self):
        sql = self.current_sql
        if "SELECT id_emergencia, codigo_emergencia" in sql:
            return (501, "10-1", 7, datetime(2026, 5, 2, 4, 0), "FINALIZADA", -33.04, -71.6, None)
        if "FROM emergencia.registro_historico" in sql and "FOR UPDATE" in sql:
            return None
        if "COUNT(DISTINCT id_recurso)" in sql:
            excluidos = {"CANCELADA", "CANCELADO", "ANULADA", "ANULADO", "RECHAZADA", "RECHAZADO"}
            activos = {recurso for recurso, estado in self.asignaciones if estado.strip().upper() not in excluidos}
            return (len(activos),)
        if "RETURNING id_registro" in sql:
            self.insercion = self.queries[-1]
            return (8801,)
        return None


def test_HI05_historico_cuenta_recursos_distintos_y_excluye_cancelaciones(monkeypatch):
    monkeypatch.setattr("core.zonificacion.resolver_zona", lambda cursor, lat, lng, zona: zona or 7)
    cursor = CursorHistorico()
    clima = {
        "temperatura_c": 16.0,
        "viento_kmh": 5.0,
        "precipitacion_mm": 0.0,
        "fuente": "fixture",
    }

    resultado = historico.archivar_en_transaccion(cursor, 501, clima)

    consulta = next(sql for sql, _ in cursor.queries if "COUNT(DISTINCT id_recurso)" in sql)
    assert "COUNT(DISTINCT id_recurso)" in consulta
    for estado in ("CANCELADA", "CANCELADO", "ANULADA", "ANULADO", "RECHAZADA", "RECHAZADO"):
        assert estado in consulta
    assert cursor.insercion is not None
    assert cursor.insercion[1][7] == 2
    assert resultado == {"estado": "registrada", "id_registro": 8801, "nueva": True}
