from uuid import uuid4

import main
from conftest import ADMIN, headers_de


def test_EM06_reenvio_con_misma_clave_no_duplica_emergencia(client, monkeypatch):
    llamadas = []

    def crear(datos):
        llamadas.append(datos)
        return {
            "id_emergencia": 9021,
            "codigo_emergencia": datos.codigo_emergencia,
            "estado_emergencia": "Activa",
        }

    monkeypatch.setattr(main, "_crear_emergencia_en_bd", crear)
    encabezados = {**headers_de(ADMIN), "Idempotency-Key": f"em06-{uuid4()}"}
    payload = {
        "codigo_emergencia": "10-1",
        "direccion_emergencia": "CODEX-EM06",
        "latitud_emergencia": -33.037,
        "longitud_emergencia": -71.629,
        "prioridad_emergencia": 3,
    }

    primero = client.post("/emergencies", headers=encabezados, json=payload)
    reintento = client.post("/emergencies", headers=encabezados, json=payload)
    payload_distinto = {**payload, "direccion_emergencia": "CODEX-EM06-OTRO"}
    reutilizada = client.post("/emergencies", headers=encabezados, json=payload_distinto)

    assert primero.status_code == 200
    assert reintento.status_code == 200
    assert primero.json()["id_emergencia"] == reintento.json()["id_emergencia"]
    assert reintento.json()["idempotente_reutilizada"] is True
    assert reutilizada.status_code == 409
    assert len(llamadas) == 1
